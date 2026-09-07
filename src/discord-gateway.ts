import { DurableObject } from "cloudflare:workers";
import {
	getChannel,
	getChannelMessages,
	getCurrentUser,
	getGatewayBotUrl,
	sendMessage,
	triggerTyping,
} from "./discord/rest";
import { isAddressedToBot } from "./discord/mentions";
import {
	GatewayOpcode,
	type GatewayPayload,
	type HelloData,
	type IdentifyData,
	type MessageCreateDispatchData,
	type ReadyDispatchData,
	type ResumeData,
} from "./discord/gateway-types";
import type { DiscordChannel, DiscordMessage } from "./discord/types";
import { generateReply, type ChannelInfo, type HistoryMessage } from "./gemini";
import { delay } from "./delay";
import { debugLog, errorMessage } from "./log-level";

// GUILDS (1 << 0) + GUILD_MESSAGES (1 << 9) + DIRECT_MESSAGES (1 << 12) + MESSAGE_CONTENT (1 << 15).
// MESSAGE_CONTENT is privileged: without it, content/embeds/attachments come back empty for any
// message that doesn't mention the bot, isn't a DM, and wasn't sent by the bot — which is nearly
// everything fetch_message_history's `around` fetch pulls in (see gemini.ts). Must also be enabled
// under the bot's Privileged Gateway Intents in the Discord Developer Portal, or Discord rejects the
// connection with a non-resumable invalid session.
const INTENTS = 1 | (1 << 9) | (1 << 12) | (1 << 15);

// An outbound connection (our Gateway WebSocket) only keeps a Durable Object alive for a maximum
// of 15 minutes — after that, the DO is evicted (killing the socket) after 70-140s with no
// incoming request/RPC/event. The 5-min scheduled cron alone is too infrequent to prevent that, so
// a self-rescheduling alarm (comfortably under 70s, with margin) keeps the DO — and therefore the
// connection — alive indefinitely.
const KEEPALIVE_INTERVAL_MS = 60_000;

// Discord's typing indicator only lasts ~10s; refreshed comfortably before it expires so it stays
// up for the whole time a reply is being generated (generateReply can take multiple Gemini calls).
const TYPING_REFRESH_MS = 8_000;

/** Sent to the user when generating or delivering a real reply failed — silence is worse. */
const FALLBACK_REPLY = "Sorry — something went wrong while I was working on a reply. Mind trying again?";

/** Maps either transport's message shape — both extend `DiscordMessage` — to what Gemini is given. */
function toHistoryMessage(message: DiscordMessage): HistoryMessage {
	return {
		id: message.id,
		user: message.author.username,
		userId: message.author.id,
		content: message.content,
		date: message.timestamp,
		replyToId: message.message_reference?.message_id ?? null,
	};
}

/** As `toHistoryMessage`, for the channel metadata Gemini is given. */
function toChannelInfo(channel: DiscordChannel): ChannelInfo {
	return { name: channel.name ?? null, topic: channel.topic ?? null };
}

export class DiscordGateway extends DurableObject<Env> {
	private ws?: WebSocket;
	private heartbeatIntervalId?: ReturnType<typeof setInterval>;
	private sessionId?: string;
	private resumeGatewayUrl?: string;
	private sequence: number | null = null;
	private botUserId?: string;
	private botUsername?: string;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.sessionId = await ctx.storage.get<string>("sessionId");
			this.resumeGatewayUrl = await ctx.storage.get<string>("resumeGatewayUrl");
			this.sequence = (await ctx.storage.get<number>("sequence")) ?? null;
			this.botUserId = await ctx.storage.get<string>("botUserId");
			this.botUsername = await ctx.storage.get<string>("botUsername");
		});
	}

	/** Called by the Worker's fetch/scheduled handlers; connects only if not already connected. */
	async ensureConnected(): Promise<void> {
		// Bootstraps (or self-heals) the keep-alive alarm loop — alarm() reschedules itself on every
		// firing, so this only matters here for the first call ever, or if the alarm was ever lost.
		if (!(await this.ctx.storage.getAlarm())) {
			await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS);
		}
		await this.connectIfNeeded();
	}

	/** Keeps this DO (and its outbound Gateway connection) alive past the 15-min outbound-connection grace period. */
	async alarm(): Promise<void> {
		try {
			await this.connectIfNeeded();
		} catch (error) {
			console.error(`Gateway: alarm's connect attempt failed: ${errorMessage(error)}`, error);
		} finally {
			await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS);
		}
	}

	private async connectIfNeeded(): Promise<void> {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
		await this.connectToGateway();
	}

	private async connectToGateway(): Promise<void> {
		// A RESUME never triggers a READY dispatch, so a session that only ever resumes (e.g. a DO
		// restarted after this field was added) would otherwise never learn its own identity.
		if (!this.botUserId || !this.botUsername) {
			const me = await getCurrentUser(this.env);
			this.botUserId = me.id;
			this.botUsername = me.username;
			await this.ctx.storage.put({ botUserId: me.id, botUsername: me.username });
		}
		const resuming = Boolean(this.resumeGatewayUrl && this.sessionId);
		const url = resuming ? this.resumeGatewayUrl! : await getGatewayBotUrl(this.env);
		console.log(`Gateway: connecting (${resuming ? "resume" : "fresh"}) to ${url}`);
		const ws = new WebSocket(`${url}?v=10&encoding=json`);
		// Guard every handler against events from a socket this DO has since moved on from
		// (e.g. the old socket's belated "close" after a Reconnect already opened a new one).
		ws.addEventListener("message", (event) => {
			if (this.ws !== ws) return;
			this.handleMessage(event).catch((error) =>
				console.error(`Gateway: error handling message: ${errorMessage(error)}`, error),
			);
		});
		ws.addEventListener("close", (event) => {
			if (this.ws !== ws) return;
			console.warn(`Gateway: closed (code ${event.code}, reason "${event.reason}")`);
			this.handleClose();
		});
		ws.addEventListener("error", (event) => {
			if (this.ws !== ws) return;
			console.error("Gateway: socket error", event);
			this.handleClose();
		});
		this.ws = ws;
	}

	private handleClose(): void {
		if (this.heartbeatIntervalId) {
			clearInterval(this.heartbeatIntervalId);
			this.heartbeatIntervalId = undefined;
		}
		this.ws = undefined;
	}

	private async handleMessage(event: MessageEvent): Promise<void> {
		const payload = JSON.parse(event.data as string) as GatewayPayload;
		debugLog(this.env, () => `Gateway: recv ${JSON.stringify(payload)}`);
		// `!= null`, not `!== null`: a frame that omits `s` entirely would otherwise set the sequence
		// to undefined, which then passes identifyOrResume's null check and RESUMEs with seq: undefined.
		if (payload.s != null) {
			this.sequence = payload.s;
			await this.ctx.storage.put("sequence", payload.s);
		}

		switch (payload.op) {
			case GatewayOpcode.Hello:
				console.log("Gateway: received Hello");
				this.startHeartbeat((payload.d as HelloData).heartbeat_interval);
				await this.identifyOrResume();
				break;
			case GatewayOpcode.Heartbeat:
				this.sendHeartbeat();
				break;
			case GatewayOpcode.Reconnect:
				console.log("Gateway: told to reconnect");
				this.ws?.close();
				await this.connectToGateway();
				break;
			case GatewayOpcode.InvalidSession: {
				const resumable = payload.d as boolean;
				if (resumable) {
					console.warn("Gateway: invalid session, will resume");
				} else {
					console.error("Gateway: invalid session, not resumable (likely a bad token or invalid intents)");
				}
				if (!resumable) {
					this.sessionId = undefined;
					this.resumeGatewayUrl = undefined;
					this.sequence = null;
					await this.ctx.storage.delete(["sessionId", "resumeGatewayUrl", "sequence"]);
				}
				// Discord recommends a short random delay before re-identifying after an invalid session.
				await delay(1000 + Math.random() * 4000);
				await this.identifyOrResume();
				break;
			}
			case GatewayOpcode.Dispatch:
				await this.handleDispatch(payload);
				break;
			// HeartbeatAck: nothing to do.
		}
	}

	private async handleDispatch(payload: GatewayPayload): Promise<void> {
		switch (payload.t) {
			case "READY": {
				const ready = payload.d as ReadyDispatchData;
				console.log(`Gateway: READY as user ${ready.user.id}`);
				this.sessionId = ready.session_id;
				this.resumeGatewayUrl = ready.resume_gateway_url;
				this.botUserId = ready.user.id;
				this.botUsername = ready.user.username;
				await this.ctx.storage.put({
					sessionId: ready.session_id,
					resumeGatewayUrl: ready.resume_gateway_url,
					botUserId: ready.user.id,
					botUsername: ready.user.username,
				});
				break;
			}
			case "MESSAGE_CREATE": {
				const message = payload.d as MessageCreateDispatchData;
				if (message.author.bot) return;
				if (!this.botUserId || !this.botUsername) {
					// Shouldn't happen in practice — connectToGateway() resolves identity via REST before
					// the socket even opens — but kept as defense-in-depth.
					console.warn("Gateway: MESSAGE_CREATE with no bot identity resolved yet, skipping");
					return;
				}
				if (!isAddressedToBot(message, this.botUserId)) return;
				debugLog(this.env, () => `Gateway: received message '${message.content}'`);
				const stopTyping = this.startTyping(message.channel_id);
				try {
					const reply = await generateReply(
						this.env,
						this.botUserId,
						this.botUsername,
						toHistoryMessage(message),
						// A DM channel never carries a name/topic, so skip the REST round-trip entirely for one —
						// guild_id's absence is the same DM check mentions.ts's isAddressedToBot relies on.
						async () =>
							message.guild_id
								? toChannelInfo(await getChannel(this.env, message.channel_id))
								: { name: null, topic: null },
						async (messageId, limit) => {
							const around = await getChannelMessages(this.env, message.channel_id, { around: messageId, limit });
							return around.map(toHistoryMessage);
						},
					);
					console.log(`Gateway: generated reply, sending to channel ${message.channel_id}`);
					await sendMessage(this.env, message.channel_id, reply.content, reply.replyToMessageId ?? undefined);
				} catch (error) {
					// Whoever addressed the bot can't tell silence from "still thinking", so always say
					// something back — but never let the fallback's own failure escape past this log.
					console.error(`Gateway: failed to reply to message ${message.id}: ${errorMessage(error)}`, error);
					await sendMessage(this.env, message.channel_id, FALLBACK_REPLY, message.id).catch((fallbackError) =>
						console.error(`Gateway: fallback reply also failed: ${errorMessage(fallbackError)}`, fallbackError),
					);
				} finally {
					stopTyping();
				}
				break;
			}
		}
	}

	/**
	 * Starts Discord's typing indicator and keeps refreshing it until the returned callback is
	 * called. A single failed refresh is logged and skipped rather than aborting the loop — the next
	 * tick tries again, and a reply is still coming either way.
	 */
	private startTyping(channelId: string): () => void {
		const fire = () =>
			triggerTyping(this.env, channelId).catch((error) =>
				console.warn(`Gateway: typing indicator failed: ${errorMessage(error)}`),
			);
		fire();
		const intervalId = setInterval(fire, TYPING_REFRESH_MS);
		return () => clearInterval(intervalId);
	}

	private async identifyOrResume(): Promise<void> {
		if (this.sessionId && this.sequence !== null) {
			const resume: ResumeData = {
				token: this.env.DISCORD_TOKEN,
				session_id: this.sessionId,
				seq: this.sequence,
			};
			this.send({ op: GatewayOpcode.Resume, d: resume });
			return;
		}
		const identify: IdentifyData = {
			token: this.env.DISCORD_TOKEN,
			intents: INTENTS,
			properties: { os: "cloudflare-workers", browser: "sadr", device: "sadr" },
		};
		this.send({ op: GatewayOpcode.Identify, d: identify });
	}

	private startHeartbeat(intervalMs: number): void {
		if (this.heartbeatIntervalId) clearInterval(this.heartbeatIntervalId);
		this.sendHeartbeat();
		this.heartbeatIntervalId = setInterval(() => this.sendHeartbeat(), intervalMs);
	}

	private sendHeartbeat(): void {
		this.send({ op: GatewayOpcode.Heartbeat, d: this.sequence });
	}

	private send(payload: { op: GatewayOpcode; d: unknown }): void {
		this.ws?.send(JSON.stringify(payload));
	}
}
