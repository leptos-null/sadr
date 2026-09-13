import { DurableObject } from "cloudflare:workers";
import { getCurrentUser, getGatewayBotUrl } from "./discord/rest";
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
import { delay } from "./delay";
import { debugLog, errorMessage } from "./log-level";
import { replyToMessage } from "./reply";

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

// Closing with 1000/1001 invalidates the session; any other code leaves it resumable.
const RESUMABLE_CLOSE_CODE = 4000;

export class DiscordGateway extends DurableObject<Env> {
	private ws?: WebSocket;
	private heartbeatIntervalId?: ReturnType<typeof setInterval>;
	private heartbeatAcked = true;
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
			console.error({ message: "Gateway alarm's connect attempt failed", error: errorMessage(error) }, error);
		} finally {
			await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS);
		}
	}

	private async connectIfNeeded(): Promise<void> {
		// CONNECTING counts as connected: replacing a socket mid-handshake leaks it, since the
		// `this.ws !== ws` guards below then drop its events without closing it.
		const state = this.ws?.readyState;
		if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;
		await this.connectToGateway();
	}

	private async connectToGateway(): Promise<void> {
		const previous = this.ws;
		// Clearing this.ws first makes the old socket's close event a no-op (see the guards below).
		this.handleClose();
		previous?.close(RESUMABLE_CLOSE_CODE);

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
		console.log({ message: "Gateway connecting", mode: resuming ? "resume" : "fresh", url });
		const ws = new WebSocket(`${url}?v=10&encoding=json`);
		// Guard every handler against events from a socket this DO has since moved on from
		// (e.g. the old socket's belated "close" after a Reconnect already opened a new one).
		ws.addEventListener("message", (event) => {
			if (this.ws !== ws) return;
			this.handleMessage(event).catch((error) =>
				console.error({ message: "Gateway error handling message", error: errorMessage(error) }, error),
			);
		});
		ws.addEventListener("close", (event) => {
			if (this.ws !== ws) return;
			console.warn({ message: "Gateway closed", code: event.code, reason: event.reason });
			this.handleClose();
		});
		ws.addEventListener("error", (event) => {
			if (this.ws !== ws) return;
			console.error({ message: "Gateway socket error" }, event);
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
		debugLog(this.env, () => ({ message: "Gateway received payload", payload }));
		// Persisted on every frame, not batched: a RESUME replays every dispatch after the stored
		// sequence, and a replayed MESSAGE_CREATE after an eviction would be replied to twice.
		if (payload.s != null) {
			this.sequence = payload.s;
			await this.ctx.storage.put("sequence", payload.s);
		}

		switch (payload.op) {
			case GatewayOpcode.Hello:
				console.log({ message: "Gateway received Hello" });
				this.startHeartbeat((payload.d as HelloData).heartbeat_interval);
				await this.identifyOrResume();
				break;
			case GatewayOpcode.Heartbeat:
				this.sendHeartbeat();
				break;
			case GatewayOpcode.Reconnect:
				console.log({ message: "Gateway told to reconnect" });
				await this.connectToGateway();
				break;
			case GatewayOpcode.InvalidSession: {
				const resumable = payload.d as boolean;
				if (resumable) {
					console.warn({ message: "Gateway invalid session, will resume" });
					await this.connectToGateway();
					break;
				}
				console.error({ message: "Gateway invalid session, not resumable (likely a bad token or invalid intents)" });
				this.sessionId = undefined;
				this.resumeGatewayUrl = undefined;
				this.sequence = null;
				await this.ctx.storage.delete(["sessionId", "resumeGatewayUrl", "sequence"]);
				// Discord recommends a short random delay before re-identifying after an invalid session.
				await delay(1000 + Math.random() * 4000);
				await this.identifyOrResume();
				break;
			}
			case GatewayOpcode.Dispatch:
				await this.handleDispatch(payload);
				break;
			case GatewayOpcode.HeartbeatAck:
				this.heartbeatAcked = true;
				break;
		}
	}

	private async handleDispatch(payload: GatewayPayload): Promise<void> {
		switch (payload.t) {
			case "READY": {
				const ready = payload.d as ReadyDispatchData;
				console.log({ message: "Gateway READY", userId: ready.user.id });
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
					console.warn({ message: "Gateway MESSAGE_CREATE with no bot identity resolved yet, skipping" });
					return;
				}
				if (!isAddressedToBot(message, this.botUserId)) return;
				debugLog(this.env, () => ({ message: "Gateway received message", content: message.content }));
				await replyToMessage(this.env, { id: this.botUserId, username: this.botUsername }, message);
				break;
			}
		}
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
		this.heartbeatAcked = true;
		this.sendHeartbeat();
		this.heartbeatIntervalId = setInterval(() => {
			// No ACK since the last interval heartbeat means a zombied connection. Only this path
			// clears the flag, so a Discord-requested heartbeat's in-flight ACK can't look like one.
			if (!this.heartbeatAcked) {
				console.warn({ message: "Gateway heartbeat not acknowledged, reconnecting" });
				this.connectToGateway().catch((error) =>
					console.error({ message: "Gateway reconnect after missed heartbeat ACK failed", error: errorMessage(error) }, error),
				);
				return;
			}
			this.heartbeatAcked = false;
			this.sendHeartbeat();
		}, intervalMs);
	}

	private sendHeartbeat(): void {
		this.send({ op: GatewayOpcode.Heartbeat, d: this.sequence });
	}

	private send(payload: { op: GatewayOpcode; d: unknown }): void {
		this.ws?.send(JSON.stringify(payload));
	}
}
