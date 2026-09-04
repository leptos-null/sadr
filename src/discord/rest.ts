import { debugLog } from "../log-level";

const API_BASE = "https://discord.com/api/v10";

function authHeaders(env: Env): HeadersInit {
	return {
		Authorization: `Bot ${env.DISCORD_TOKEN}`,
		"Content-Type": "application/json",
	};
}

/**
 * Makes a Discord REST call with bot auth, logging the request at debug level and throwing with
 * response detail on failure. `path` is relative to `API_BASE` and should include any query string.
 */
async function discordFetch(env: Env, method: string, path: string, body?: unknown): Promise<Response> {
	debugLog(env, () => `Discord REST: ${method} ${path}${body ? ` ${JSON.stringify(body)}` : ""}`);
	const response = await fetch(`${API_BASE}${path}`, {
		method,
		headers: authHeaders(env),
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
	}
	return response;
}

/** Fetches a fresh Gateway WebSocket URL for a new (non-resumed) connection. */
export async function getGatewayBotUrl(env: Env): Promise<string> {
	const response = await discordFetch(env, "GET", "/gateway/bot");
	const data = (await response.json()) as { url: string };
	debugLog(env, () => `Discord REST: response ${JSON.stringify(data)}`);
	return data.url;
}

export interface CurrentUser {
	id: string;
	username: string;
}

/**
 * Fetches the bot's own user id/username via REST, independent of the Gateway's READY dispatch
 * (which a RESUME never re-sends) — so identity is resolvable even for a session that only ever
 * resumes.
 */
export async function getCurrentUser(env: Env): Promise<CurrentUser> {
	const response = await discordFetch(env, "GET", "/users/@me");
	const data = (await response.json()) as CurrentUser;
	debugLog(env, () => `Discord REST: response ${JSON.stringify(data)}`);
	return data;
}

/** Posts a message to a channel as the bot, optionally as a reply to an earlier message. */
export async function sendMessage(
	env: Env,
	channelId: string,
	content: string,
	replyToMessageId?: string,
): Promise<void> {
	const body: Record<string, unknown> = { content };
	if (replyToMessageId) {
		// fail_if_not_exists: false falls back to a plain send if the referenced message was
		// deleted or the id is otherwise invalid, rather than erroring the whole request.
		body.message_reference = { message_id: replyToMessageId, fail_if_not_exists: false };
	}
	const response = await discordFetch(env, "POST", `/channels/${channelId}/messages`, body);
	debugLog(env, () => `Discord REST: response ${response.status}`);
}

export interface ChannelMessage {
	id: string;
	content: string;
	timestamp: string;
	author: {
		id: string;
		username: string;
		bot?: boolean;
	};
	/** Present when this message is a Discord reply to another message. */
	message_reference?: { message_id?: string };
}

/** Fetches messages from a channel around a given message id (both earlier and later messages). */
export async function getChannelMessages(
	env: Env,
	channelId: string,
	options: { around: string; limit?: number },
): Promise<ChannelMessage[]> {
	const params = new URLSearchParams({ around: options.around, limit: String(options.limit ?? 25) });
	const response = await discordFetch(env, "GET", `/channels/${channelId}/messages?${params}`);
	const data = (await response.json()) as ChannelMessage[];
	debugLog(env, () => `Discord REST: response ${JSON.stringify(data)}`);
	return data;
}
