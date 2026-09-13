import { delay } from "../delay";
import { debugLog } from "../log-level";
import type {
	DiscordChannel,
	DiscordGuild,
	DiscordGuildMember,
	DiscordMessage,
	DiscordThreadMember,
	DiscordUser,
} from "./types";

const API_BASE = "https://discord.com/api/v10";

// Not debug-gated: unlike the request/response trace below, this needs to be visible in
// production, since that's where a pathologically slow call (well past what the 10s
// AbortSignal.timeout should normally allow) actually matters.
const SLOW_CALL_THRESHOLD_MS = 3_000;

// A 429 is worth waiting out only if Discord says the wait is short — a long (or global) rate limit
// is better surfaced as a failure than sat on, since the caller is a user waiting on a reply.
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_RATE_LIMIT_WAIT_MS = 2_000;

/** A non-2xx Discord response, with the status kept inspectable so a caller can recognize an expected one (e.g. a 403 for a channel the bot can't see). */
export class DiscordApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "DiscordApiError";
	}
}

function authHeaders(env: Env, hasBody: boolean): HeadersInit {
	const headers: Record<string, string> = { Authorization: `Bot ${env.DISCORD_TOKEN}` };
	// Only meaningful when there's actually a body to describe.
	if (hasBody) headers["Content-Type"] = "application/json";
	return headers;
}

/**
 * Extracts the rate-limit headers Discord attaches to most responses. `scope`/`global` are only
 * ever sent on a 429 (<https://docs.discord.com/developers/topics/rate-limits>), so only included there.
 */
function rateLimitHeaders(response: Response): Record<string, string | null> {
	const headers = response.headers;
	const summary: Record<string, string | null> = {
		limit: headers.get("x-ratelimit-limit"),
		remaining: headers.get("x-ratelimit-remaining"),
		resetAfterSeconds: headers.get("x-ratelimit-reset-after"),
		bucket: headers.get("x-ratelimit-bucket"),
	};
	if (response.status === 429) {
		summary.scope = headers.get("x-ratelimit-scope");
		summary.global = headers.get("x-ratelimit-global");
	}
	return summary;
}

/** One request attempt, warning if it took pathologically long. */
async function sendOnce(env: Env, method: string, path: string, body?: unknown): Promise<Response> {
	// One predicate for both the header and the payload, so they can't disagree about whether this
	// request has a body.
	const hasBody = body !== undefined;
	const start = Date.now();
	const response = await fetch(`${API_BASE}${path}`, {
		method,
		headers: authHeaders(env, hasBody),
		body: hasBody ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(10_000),
	});
	const durationMs = Date.now() - start;
	if (durationMs > SLOW_CALL_THRESHOLD_MS) {
		console.warn({ message: "Discord REST slow call", method, path, durationMs });
	}
	debugLog(env, () => ({ message: "Discord REST rate limit", method, path, rateLimit: rateLimitHeaders(response) }));
	return response;
}

/**
 * How long to wait before retrying, or null if this response shouldn't be retried at all — not a
 * 429, no usable `retry-after` (missing, or a malformed value that `Number()` turns into something
 * non-positive), or a wait longer than we're willing to sit on.
 */
function rateLimitRetryMs(response: Response): number | null {
	if (response.status !== 429) return null;
	const header = response.headers.get("retry-after");
	const waitMs = header === null ? NaN : Math.ceil(Number(header) * 1000);
	if (!Number.isFinite(waitMs) || waitMs <= 0 || waitMs > MAX_RATE_LIMIT_WAIT_MS) return null;
	return waitMs;
}

/**
 * Makes a Discord REST call with bot auth, logging the request at debug level, retrying a
 * short-lived 429, and throwing a `DiscordApiError` on failure. `path` is relative to `API_BASE`
 * and should include any query string. With `allowMissing`, a 404 is treated as "doesn't exist"
 * rather than a failure — returns null instead of throwing, for a lookup where that's a normal,
 * expected outcome (e.g. checking whether a user is a member of a guild) rather than an error.
 */
async function discordFetch(env: Env, method: string, path: string, body?: unknown): Promise<Response>;
async function discordFetch(
	env: Env,
	method: string,
	path: string,
	body: unknown,
	options: { allowMissing: true },
): Promise<Response | null>;
async function discordFetch(
	env: Env,
	method: string,
	path: string,
	body?: unknown,
	options?: { allowMissing?: boolean },
): Promise<Response | null> {
	debugLog(env, () => ({ message: "Discord REST request", method, path, body }));
	// Unbounded on purpose: the retry budget is spent via `attempt` below, and bounding the loop
	// itself would add a tail the compiler demands but nothing can reach.
	for (let attempt = 0; ; attempt++) {
		const response = await sendOnce(env, method, path, body);
		const retryMs = attempt < MAX_RATE_LIMIT_RETRIES ? rateLimitRetryMs(response) : null;
		if (retryMs === null) {
			if (options?.allowMissing && response.status === 404) return null;
			if (!response.ok) {
				throw new DiscordApiError(response.status, `${method} ${path} failed: ${response.status} ${await response.text()}`);
			}
			return response;
		}
		// Not debug-gated: like the slow-call warning, being rate limited is worth seeing in production.
		console.warn({ message: "Discord REST rate limited, retrying", method, path, retryMs });
		await delay(retryMs);
	}
}

/** As `discordFetch`, for the endpoints that return a JSON body worth tracing. */
async function discordJson<T>(env: Env, method: string, path: string, body?: unknown): Promise<T>;
async function discordJson<T>(
	env: Env,
	method: string,
	path: string,
	body: unknown,
	options: { allowMissing: true },
): Promise<T | null>;
async function discordJson<T>(
	env: Env,
	method: string,
	path: string,
	body?: unknown,
	options?: { allowMissing: true },
): Promise<T | null> {
	const response = options ? await discordFetch(env, method, path, body, options) : await discordFetch(env, method, path, body);
	if (!response) return null;
	const data = (await response.json()) as T;
	debugLog(env, () => ({ message: "Discord REST response", method, path, data }));
	return data;
}

/** Fetches a fresh Gateway WebSocket URL for a new (non-resumed) connection. */
export async function getGatewayBotUrl(env: Env): Promise<string> {
	const { url } = await discordJson<{ url: string }>(env, "GET", "/gateway/bot");
	return url;
}

/**
 * Fetches the bot's own user id/username via REST, independent of the Gateway's READY dispatch
 * (which a RESUME never re-sends) — so identity is resolvable even for a session that only ever
 * resumes.
 */
export function getCurrentUser(env: Env): Promise<DiscordUser> {
	return discordJson<DiscordUser>(env, "GET", "/users/@me");
}

/**
 * Posts a message to a channel as the bot, optionally as a reply to an earlier message. Content
 * over Discord's 2000-character limit is rejected by Discord; keeping replies short is the model's
 * job (see gemini.ts's system instruction), and a rejection surfaces as a failed send.
 */
export async function sendMessage(
	env: Env,
	channelId: string,
	content: string,
	replyToMessageId: string | null,
): Promise<void> {
	const body: Record<string, unknown> = {
		content,
		// The model is handed raw mention tokens and can echo them back — including an @everyone it
		// picked up from fetched history. "users" keeps deliberate user pings working while making an
		// @everyone or role ping impossible to trigger from generated content. replied_user restores
		// Discord's default-for-replies behavior, which sending an allowed_mentions object at all
		// would otherwise turn off.
		allowed_mentions: { parse: ["users"], replied_user: true },
	};
	if (replyToMessageId) {
		// fail_if_not_exists: false falls back to a plain send if the referenced message was
		// deleted or the id is otherwise invalid, rather than erroring the whole request.
		body.message_reference = { message_id: replyToMessageId, fail_if_not_exists: false };
	}
	const method = "POST";
	const path = `/channels/${channelId}/messages`;
	const response = await discordFetch(env, method, path, body);
	debugLog(env, () => ({ message: "Discord REST response", method, path, status: response.status }));
}

/** Triggers Discord's typing indicator in a channel; it shows for ~10s or until a message is sent. */
export async function triggerTyping(env: Env, channelId: string): Promise<void> {
	await discordFetch(env, "POST", `/channels/${channelId}/typing`);
}

/**
 * Fetches a channel's metadata — used to give Gemini the channel's name/topic for context.
 * Observed rate-limit bucket: 1000 per 0.001s.
 */
export function getChannel(env: Env, channelId: string): Promise<DiscordChannel> {
	return discordJson<DiscordChannel>(env, "GET", `/channels/${channelId}`);
}

/**
 * Fetches a guild's metadata — used to give Gemini the guild's name/description for context.
 * Observed rate-limit bucket: 1000 per 0.001s.
 */
export function getGuild(env: Env, guildId: string): Promise<DiscordGuild> {
	return discordJson<DiscordGuild>(env, "GET", `/guilds/${guildId}`);
}

/**
 * Fetches a guild member — for their roles, which the message-link permission check resolves channel
 * overwrites against. Null if `userId` isn't a member of `guildId`.
 */
export function getGuildMember(env: Env, guildId: string, userId: string): Promise<DiscordGuildMember | null> {
	return discordJson<DiscordGuildMember>(env, "GET", `/guilds/${guildId}/members/${userId}`, undefined, { allowMissing: true });
}

/**
 * Fetches a thread member — used only to check whether `userId` was actually added to a private
 * thread, whose audience is that explicit list rather than anything in its parent channel's
 * overwrites. Null if they aren't a member.
 *
 * Membership alone doesn't prove they can still see the thread: losing access to the parent channel
 * doesn't remove anyone from it (<https://docs.discord.com/developers/topics/threads#losing-access-to-channels>),
 * so `canReadChannel` has to pass against the parent as well. Unlike `List Thread Members`, this
 * single-user route needs no `GUILD_MEMBERS` privileged intent.
 */
export function getThreadMember(env: Env, threadId: string, userId: string): Promise<DiscordThreadMember | null> {
	return discordJson<DiscordThreadMember>(env, "GET", `/channels/${threadId}/thread-members/${userId}`, undefined, { allowMissing: true });
}

/**
 * Fetches messages from a channel around a given message id (both earlier and later messages), or,
 * with `around: null`, the channel's most recent messages instead — Discord's own behavior when no
 * `around`/`before`/`after` param is given at all.
 * <https://docs.discord.com/developers/resources/message#get-channel-messages>
 * Observed rate-limit bucket: 5 per 1s, per channel.
 */
export function getChannelMessages(
	env: Env,
	channelId: string,
	options: { around: string | null; limit: number },
): Promise<DiscordMessage[]> {
	const params = new URLSearchParams();
	if (options.around !== null) params.set("around", options.around);
	params.set("limit", String(options.limit));
	return discordJson<DiscordMessage[]>(env, "GET", `/channels/${channelId}/messages?${params}`);
}
