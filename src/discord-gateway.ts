import { DurableObject } from "cloudflare:workers";
import { getGatewayBotUrl, sendMessage } from "./discord/rest";
import { mentionsUser, stripMention } from "./discord/mentions";
import {
	GatewayOpcode,
	type GatewayPayload,
	type HelloData,
	type IdentifyData,
	type MessageCreateDispatchData,
	type ReadyDispatchData,
	type ResumeData,
} from "./discord/gateway-types";
import { generateReply } from "./gemini";
import { isDebugEnabled } from "./log-level";

// GUILDS (1 << 0) + GUILD_MESSAGES (1 << 9): enough to receive MESSAGE_CREATE in guilds
// without requesting the privileged MESSAGE_CONTENT intent (mentions include content regardless).
const INTENTS = 1 | (1 << 9);

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DiscordGateway extends DurableObject<Env> {
	private ws?: WebSocket;
	private heartbeatIntervalId?: ReturnType<typeof setInterval>;
	private sessionId?: string;
	private resumeGatewayUrl?: string;
	private sequence: number | null = null;
	private botUserId?: string;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.sessionId = await ctx.storage.get<string>("sessionId");
			this.resumeGatewayUrl = await ctx.storage.get<string>("resumeGatewayUrl");
			this.sequence = (await ctx.storage.get<number>("sequence")) ?? null;
			this.botUserId = await ctx.storage.get<string>("botUserId");
		});
	}

	/** Called by the Worker's fetch/scheduled handlers; connects only if not already connected. */
	async ensureConnected(): Promise<void> {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
		await this.connectToGateway();
	}

	private async connectToGateway(): Promise<void> {
		const resuming = Boolean(this.resumeGatewayUrl && this.sessionId);
		const url = resuming ? this.resumeGatewayUrl! : await getGatewayBotUrl(this.env);
		console.log(`Gateway: connecting (${resuming ? "resume" : "fresh"}) to ${url}`);
		const ws = new WebSocket(`${url}?v=10&encoding=json`);
		// Guard every handler against events from a socket this DO has since moved on from
		// (e.g. the old socket's belated "close" after a Reconnect already opened a new one).
		ws.addEventListener("message", (event) => {
			if (this.ws !== ws) return;
			this.handleMessage(event).catch((error) => console.error("Gateway: error handling message", error));
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

	/**
	 * Verbose, local-only tracing — gated behind LOG_LEVEL="debug" (set via .dev.vars, never in
	 * production). Takes a factory rather than a string so the message is only built when needed.
	 */
	private debug(messageFactory: () => string): void {
		if (isDebugEnabled(this.env)) {
			console.log(messageFactory());
		}
	}

	private async handleMessage(event: MessageEvent): Promise<void> {
		const payload = JSON.parse(event.data as string) as GatewayPayload;
		this.debug(() => `Gateway: recv ${JSON.stringify(payload)}`);
		if (payload.s !== null) {
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
				await this.ctx.storage.put({
					sessionId: ready.session_id,
					resumeGatewayUrl: ready.resume_gateway_url,
					botUserId: ready.user.id,
				});
				break;
			}
			case "MESSAGE_CREATE": {
				const message = payload.d as MessageCreateDispatchData;
				if (message.author.bot) return;
				if (!this.botUserId) {
					console.warn("Gateway: MESSAGE_CREATE before READY (no bot user id yet), skipping");
					return;
				}
				if (!mentionsUser(message, this.botUserId)) return;
				console.log(`Gateway: received message: ${message.content.length} chars`);
				const prompt = stripMention(message.content, this.botUserId);
				if (!prompt) {
					console.log("Gateway: mention had no content after stripping, skipping");
					return;
				}
				const reply = await generateReply(this.env, prompt);
				console.log(`Gateway: generated reply, sending to channel ${message.channel_id}`);
				await sendMessage(this.env, message.channel_id, reply);
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
		this.sendHeartbeat();
		this.heartbeatIntervalId = setInterval(() => this.sendHeartbeat(), intervalMs);
	}

	private sendHeartbeat(): void {
		this.send({ op: GatewayOpcode.Heartbeat, d: this.sequence });
	}

	private send(payload: unknown): void {
		this.ws?.send(JSON.stringify(payload));
	}
}
