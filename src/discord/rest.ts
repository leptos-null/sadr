const API_BASE = "https://discord.com/api/v10";

function authHeaders(env: Env): HeadersInit {
	return {
		Authorization: `Bot ${env.DISCORD_TOKEN}`,
		"Content-Type": "application/json",
	};
}

/** Fetches a fresh Gateway WebSocket URL for a new (non-resumed) connection. */
export async function getGatewayBotUrl(env: Env): Promise<string> {
	const response = await fetch(`${API_BASE}/gateway/bot`, {
		headers: authHeaders(env),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new Error(`GET /gateway/bot failed: ${response.status} ${await response.text()}`);
	}
	const { url } = (await response.json()) as { url: string };
	return url;
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
	const response = await fetch(`${API_BASE}/users/@me`, {
		headers: authHeaders(env),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new Error(`GET /users/@me failed: ${response.status} ${await response.text()}`);
	}
	return (await response.json()) as CurrentUser;
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
	const response = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
		method: "POST",
		headers: authHeaders(env),
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new Error(`POST /channels/${channelId}/messages failed: ${response.status} ${await response.text()}`);
	}
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
	const response = await fetch(`${API_BASE}/channels/${channelId}/messages?${params}`, {
		headers: authHeaders(env),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new Error(`GET /channels/${channelId}/messages failed: ${response.status} ${await response.text()}`);
	}
	return (await response.json()) as ChannelMessage[];
}
