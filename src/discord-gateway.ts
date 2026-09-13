import { DurableObject } from "cloudflare:workers";
import { getCurrentUser, getGatewayBot } from "./discord/rest";
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

// After an unexpected close, that alarm is pulled forward to this capped exponential backoff rather
// than waiting out its full interval — recovery in seconds, while a socket that fails on every
// attempt slows down instead of hot-looping through the daily IDENTIFY budget.
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

// Closing with 1000/1001 invalidates the session; any other code leaves it resumable.
const RESUMABLE_CLOSE_CODE = 4000;

// Bad token, sharding, API version, or intents: Discord says stop reconnecting. Retrying every
// minute would exhaust the 1000/day IDENTIFY limit, at which point Discord resets the bot token.
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const FATAL_CLOSE_PAUSE_MS = 60 * 60_000;

// Invalid seq, session timed out: Discord says start a new session, so a RESUME would only be rejected.
const NON_RESUMABLE_CLOSE_CODES = new Set([4007, 4009]);

/** A resumable Gateway session — the three facts needed to RESUME rather than fresh-IDENTIFY, always set (and cleared) together. */
interface Session {
	id: string;
	resumeUrl: string;
	sequence: number;
}

export class DiscordGateway extends DurableObject<Env> {
	private ws?: WebSocket;
	private isConnecting = false;
	/** The initial jitter timeout, then the interval; clearTimeout clears either. */
	private heartbeatTimerId?: ReturnType<typeof setTimeout>;
	private heartbeatAcked = true;
	private session: Session | null = null;
	private botUserId?: string;
	private botUsername?: string;
	/** Unexpected closes since the connection was last healthy (READY/RESUMED reset it); drives the reconnect backoff. */
	private reconnectAttempts = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			const sessionId = await ctx.storage.get<string>("sessionId");
			const resumeGatewayUrl = await ctx.storage.get<string>("resumeGatewayUrl");
			const sequence = await ctx.storage.get<number>("sequence");
			// The three are always written and cleared together, so a partial read means no session — a
			// fresh IDENTIFY, the safe direction to be wrong in.
			if (sessionId != null && resumeGatewayUrl != null && sequence != null) {
				this.session = { id: sessionId, resumeUrl: resumeGatewayUrl, sequence };
			}
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
		// A connect attempt awaiting REST has no socket yet, but is still in flight.
		if (this.isConnecting) return;
		const pausedUntil = await this.ctx.storage.get<number>("reconnectPausedUntil");
		if (pausedUntil !== undefined && Date.now() < pausedUntil) {
			console.warn({ message: "Gateway reconnect paused after a fatal close code", until: new Date(pausedUntil).toISOString() });
			return;
		}
		await this.connectToGateway();
	}

	private async connectToGateway(): Promise<void> {
		const previous = this.ws;
		// Clearing this.ws first makes the old socket's close event a no-op (see the guards below).
		this.handleClose();
		previous?.close(RESUMABLE_CLOSE_CODE);

		// Nothing after the try yields, so the flag only needs to cover the awaits inside it.
		let url: string;
		this.isConnecting = true;
		try {
			// A RESUME never triggers a READY dispatch, so a session that only ever resumes (e.g. a DO
			// restarted after this field was added) would otherwise never learn its own identity.
			if (!this.botUserId || !this.botUsername) {
				const me = await getCurrentUser(this.env);
				this.botUserId = me.id;
				this.botUsername = me.username;
				await this.ctx.storage.put({ botUserId: me.id, botUsername: me.username });
			}
			if (this.session) {
				url = this.session.resumeUrl;
			} else {
				const gateway = await getGatewayBot(this.env);
				// One IDENTIFY past the daily limit resets the bot token, so stop short of it.
				if (gateway.session_start_limit.remaining <= 0) {
					const until = Date.now() + gateway.session_start_limit.reset_after;
					console.error({ message: "Gateway IDENTIFY limit reached, pausing reconnects", until: new Date(until).toISOString() });
					await this.ctx.storage.put("reconnectPausedUntil", until);
					return;
				}
				url = gateway.url;
			}
		} finally {
			this.isConnecting = false;
		}
		console.log({ message: "Gateway connecting", mode: this.session ? "resume" : "fresh", url });
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
			if (NON_RESUMABLE_CLOSE_CODES.has(event.code)) {
				this.clearSession().catch((error) =>
					console.error({ message: "Gateway failed to clear the session", error: errorMessage(error) }, error),
				);
			}
			if (FATAL_CLOSE_CODES.has(event.code)) {
				const until = Date.now() + FATAL_CLOSE_PAUSE_MS;
				console.error({ message: "Gateway closed with a fatal code, pausing reconnects", code: event.code, until: new Date(until).toISOString() });
				this.ctx.storage
					.put("reconnectPausedUntil", until)
					.catch((error) => console.error({ message: "Gateway failed to persist reconnect pause", error: errorMessage(error) }, error));
				return;
			}
			this.scheduleReconnect();
		});
		// Logging only: the close that follows an error owns teardown and reconnect scheduling. Dropping
		// this.ws here would make that close's guard ignore it, code and all (a fatal code would never pause).
		ws.addEventListener("error", (event) => {
			if (this.ws !== ws) return;
			console.error({ message: "Gateway socket error" }, event);
		});
		this.ws = ws;
	}

	/** Pulls the keep-alive alarm forward; alarm() then reconnects and reschedules itself as usual. */
	private scheduleReconnect(): void {
		const delayMs = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts);
		this.reconnectAttempts++;
		console.warn({ message: "Gateway scheduling reconnect", delayMs, attempt: this.reconnectAttempts });
		this.ctx.storage
			.setAlarm(Date.now() + delayMs)
			.catch((error) => console.error({ message: "Gateway failed to schedule reconnect", error: errorMessage(error) }, error));
	}

	private handleClose(): void {
		if (this.heartbeatTimerId) {
			clearTimeout(this.heartbeatTimerId);
			this.heartbeatTimerId = undefined;
		}
		this.ws = undefined;
	}

	private async handleMessage(event: MessageEvent): Promise<void> {
		const payload = JSON.parse(event.data as string) as GatewayPayload;
		debugLog(this.env, () => ({ message: "Gateway received payload", payload }));
		// Persisted on every frame, not batched: a RESUME replays every dispatch after the stored
		// sequence, and a replayed MESSAGE_CREATE after an eviction would be replied to twice. Only
		// updates an existing session — READY (below) sets the session's starting sequence itself, since
		// this runs before a fresh connect's session exists yet.
		if (payload.s != null && this.session) {
			this.session.sequence = payload.s;
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
				await this.clearSession();
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

	private async clearSession(): Promise<void> {
		this.session = null;
		await this.ctx.storage.delete(["sessionId", "resumeGatewayUrl", "sequence"]);
	}

	private async handleDispatch(payload: GatewayPayload): Promise<void> {
		switch (payload.t) {
			case "READY": {
				const ready = payload.d as ReadyDispatchData;
				console.log({ message: "Gateway READY", userId: ready.user.id });
				// READY is itself a Dispatch, so `payload.s` is this session's starting sequence — the
				// `?? 0` fallback only guards the envelope's looser `number | null` type, since Discord
				// always sends a real sequence on a Dispatch.
				this.session = { id: ready.session_id, resumeUrl: ready.resume_gateway_url, sequence: payload.s ?? 0 };
				this.botUserId = ready.user.id;
				this.botUsername = ready.user.username;
				this.reconnectAttempts = 0;
				await this.ctx.storage.put({
					sessionId: this.session.id,
					resumeGatewayUrl: this.session.resumeUrl,
					sequence: this.session.sequence,
					botUserId: ready.user.id,
					botUsername: ready.user.username,
				});
				break;
			}
			case "RESUMED":
				console.log({ message: "Gateway RESUMED" });
				this.reconnectAttempts = 0;
				break;
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
		if (this.session) {
			const resume: ResumeData = {
				token: this.env.DISCORD_TOKEN,
				session_id: this.session.id,
				seq: this.session.sequence,
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
		if (this.heartbeatTimerId) clearTimeout(this.heartbeatTimerId);
		this.heartbeatAcked = true;
		// Discord asks for a random offset before the first heartbeat, to spread reconnect load:
		// <https://docs.discord.com/developers/events/gateway#heartbeat-interval>
		this.heartbeatTimerId = setTimeout(() => {
			this.sendHeartbeat();
			this.heartbeatTimerId = setInterval(() => {
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
		}, intervalMs * Math.random());
	}

	private sendHeartbeat(): void {
		this.send({ op: GatewayOpcode.Heartbeat, d: this.session?.sequence ?? null });
	}

	private send(payload: { op: GatewayOpcode; d: unknown }): void {
		this.ws?.send(JSON.stringify(payload));
	}
}
