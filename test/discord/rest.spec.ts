import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { getChannelMessages, getCurrentUser, getGatewayBotUrl, sendMessage, triggerTyping } from "../../src/discord/rest";

describe("getGatewayBotUrl", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("requests the bot gateway endpoint with bot auth and returns the url", async () => {
		env.DISCORD_TOKEN = "test-discord-token";
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ url: "wss://gateway.discord.gg" }), { status: 200 }));

		const url = await getGatewayBotUrl(env);

		expect(url).toBe("wss://gateway.discord.gg");
		const [requestUrl, init] = fetchSpy.mock.calls[0];
		expect(requestUrl).toBe("https://discord.com/api/v10/gateway/bot");
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bot test-discord-token");
	});

	it("throws with response detail on failure", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad token", { status: 401 }));

		await expect(getGatewayBotUrl(env)).rejects.toThrow(/401/);
	});
});

describe("slow Discord REST call warning", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("warns (regardless of LOG_LEVEL) when a call exceeds the slow-call threshold", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		// Advance the (fake) clock inside the mocked fetch itself, simulating a slow network call,
		// rather than trying to time individual Date.now() calls relative to each other.
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			vi.advanceTimersByTime(3001);
			return new Response(JSON.stringify({ url: "wss://gateway.discord.gg" }), { status: 200 });
		});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		await getGatewayBotUrl(env);

		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("took 3001ms"));
	});

	it("doesn't warn for a call under the threshold", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ url: "wss://gateway.discord.gg" }), { status: 200 }),
		);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		await getGatewayBotUrl(env);

		expect(warnSpy).not.toHaveBeenCalled();
	});
});

describe("getCurrentUser", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("requests the bot's own user with bot auth and returns id/username", async () => {
		env.DISCORD_TOKEN = "test-discord-token";
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ id: "999", username: "sadr-bot" }), { status: 200 }));

		const me = await getCurrentUser(env);

		expect(me).toEqual({ id: "999", username: "sadr-bot" });
		const [requestUrl, init] = fetchSpy.mock.calls[0];
		expect(requestUrl).toBe("https://discord.com/api/v10/users/@me");
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bot test-discord-token");
	});

	it("throws with response detail on failure", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad token", { status: 401 }));

		await expect(getCurrentUser(env)).rejects.toThrow(/401/);
	});
});

describe("sendMessage", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("posts content to the channel with bot auth", async () => {
		env.DISCORD_TOKEN = "test-discord-token";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

		await sendMessage(env, "123", "hello");

		const [requestUrl, init] = fetchSpy.mock.calls[0];
		expect(requestUrl).toBe("https://discord.com/api/v10/channels/123/messages");
		expect(init?.method).toBe("POST");
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bot test-discord-token");
		expect(JSON.parse(init?.body as string)).toEqual({
			content: "hello",
			allowed_mentions: { parse: ["users"], replied_user: true },
		});
	});

	it("includes a message_reference when replying to a message", async () => {
		env.DISCORD_TOKEN = "test-discord-token";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

		await sendMessage(env, "123", "hello", "999");

		const [, init] = fetchSpy.mock.calls[0];
		expect(JSON.parse(init?.body as string)).toEqual({
			content: "hello",
			allowed_mentions: { parse: ["users"], replied_user: true },
			message_reference: { message_id: "999", fail_if_not_exists: false },
		});
	});

	it("throws with response detail on failure", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad token", { status: 401 }));

		await expect(sendMessage(env, "123", "hello")).rejects.toThrow(/401/);
	});
});

describe("rate limit retries", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("retries a 429 once Discord's short retry-after has elapsed", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "0.01" } }))
			.mockResolvedValueOnce(new Response(null, { status: 200 }));
		vi.spyOn(console, "warn").mockImplementation(() => {});

		await sendMessage(env, "123", "hello");

		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("fails rather than retrying instantly on a malformed retry-after", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("slow down", { status: 429, headers: { "retry-after": "" } }));

		await expect(sendMessage(env, "123", "hello")).rejects.toThrow(/429/);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("gives up rather than sitting on a long retry-after", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("slow down", { status: 429, headers: { "retry-after": "600" } }));

		await expect(sendMessage(env, "123", "hello")).rejects.toThrow(/429/);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});

describe("triggerTyping", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("posts to the channel's typing endpoint with bot auth", async () => {
		env.DISCORD_TOKEN = "test-discord-token";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

		await triggerTyping(env, "123");

		const [requestUrl, init] = fetchSpy.mock.calls[0];
		expect(requestUrl).toBe("https://discord.com/api/v10/channels/123/typing");
		expect(init?.method).toBe("POST");
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bot test-discord-token");
	});

	it("throws with response detail on failure", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad token", { status: 401 }));

		await expect(triggerTyping(env, "123")).rejects.toThrow(/401/);
	});
});

describe("getChannelMessages", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("requests channel messages with bot auth, around, and limit", async () => {
		env.DISCORD_TOKEN = "test-discord-token";
		const messages = [
			{ id: "1", content: "hi", timestamp: "2024-01-01T00:00:00.000Z", author: { id: "u1", username: "alice" } },
		];
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify(messages), { status: 200 }));

		const result = await getChannelMessages(env, "123", { around: "456", limit: 10 });

		expect(result).toEqual(messages);
		const [requestUrl, init] = fetchSpy.mock.calls[0];
		expect(requestUrl).toBe("https://discord.com/api/v10/channels/123/messages?around=456&limit=10");
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bot test-discord-token");
	});

	it("throws with response detail on failure", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad token", { status: 401 }));

		await expect(getChannelMessages(env, "123", { around: "456", limit: 10 })).rejects.toThrow(/401/);
	});
});
