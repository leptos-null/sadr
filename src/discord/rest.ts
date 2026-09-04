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

/** Posts a message to a channel as the bot. */
export async function sendMessage(env: Env, channelId: string, content: string): Promise<void> {
	const response = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
		method: "POST",
		headers: authHeaders(env),
		body: JSON.stringify({ content }),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new Error(`POST /channels/${channelId}/messages failed: ${response.status} ${await response.text()}`);
	}
}
