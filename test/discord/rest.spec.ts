import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
	DiscordApiError,
	getChannelMessages,
	getCurrentUser,
	getGatewayBot,
	getGuildMember,
	getThreadMember,
	sendMessage,
	triggerTyping,
} from "../../src/discord/rest";

describe("getGatewayBot", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("requests the bot gateway endpoint with bot auth and returns the url and session start limit", async () => {
		env.DISCORD_TOKEN = "test-discord-token";
		const gatewayBot = {
			url: "wss://gateway.discord.gg",
			shards: 1,
			session_start_limit: { total: 1000, remaining: 999, reset_after: 14_400_000, max_concurrency: 1 },
		};
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(gatewayBot), { status: 200 }));

		const gateway = await getGatewayBot(env);

		expect(gateway).toEqual(gatewayBot);
		const [requestUrl, init] = fetchSpy.mock.calls[0];
		expect(requestUrl).toBe("https://discord.com/api/v10/gateway/bot");
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bot test-discord-token");
	});

	it("throws with response detail on failure", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad token", { status: 401 }));

		await expect(getGatewayBot(env)).rejects.toThrow(/401/);
	});

	it("throws a DiscordApiError carrying the status, so a caller can recognize an expected failure", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Missing Access", { status: 403 }));

		const error = await getGatewayBot(env).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(DiscordApiError);
		expect((error as DiscordApiError).status).toBe(403);
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

		await getGatewayBot(env);

		expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ method: "GET", path: "/gateway/bot", durationMs: 3001 }));
	});

	it("doesn't warn for a call under the threshold", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ url: "wss://gateway.discord.gg" }), { status: 200 }),
		);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		await getGatewayBot(env);

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

		await sendMessage(env, "123", "hello", null);

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

		await expect(sendMessage(env, "123", "hello", null)).rejects.toThrow(/401/);
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

		await sendMessage(env, "123", "hello", null);

		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("fails rather than retrying instantly on a malformed retry-after", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("slow down", { status: 429, headers: { "retry-after": "" } }));

		await expect(sendMessage(env, "123", "hello", null)).rejects.toThrow(/429/);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("gives up rather than sitting on a long retry-after", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("slow down", { status: 429, headers: { "retry-after": "600" } }));

		await expect(sendMessage(env, "123", "hello", null)).rejects.toThrow(/429/);
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

describe("getGuildMember", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns the member's roles when the lookup succeeds", async () => {
		env.DISCORD_TOKEN = "test-discord-token";
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ roles: ["10", "20"] }), { status: 200 }));

		const result = await getGuildMember(env, "111", "999");

		expect(result).toEqual({ roles: ["10", "20"] });
		const [requestUrl, init] = fetchSpy.mock.calls[0];
		expect(requestUrl).toBe("https://discord.com/api/v10/guilds/111/members/999");
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bot test-discord-token");
	});

	it("returns null, rather than throwing, on a 404 (not a member)", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Unknown Member", { status: 404 }));

		await expect(getGuildMember(env, "111", "999")).resolves.toBeNull();
	});

	it("still throws on a failure other than 404", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad token", { status: 401 }));

		await expect(getGuildMember(env, "111", "999")).rejects.toThrow(/401/);
	});
});

describe("getThreadMember", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("requests the single-user thread-members route and returns the membership", async () => {
		env.DISCORD_TOKEN = "test-discord-token";
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify({ join_timestamp: "2024-01-01T00:00:00.000Z", flags: 0 }), { status: 200 }),
			);

		const result = await getThreadMember(env, "222", "999");

		expect(result).toEqual({ join_timestamp: "2024-01-01T00:00:00.000Z", flags: 0 });
		const [requestUrl, init] = fetchSpy.mock.calls[0];
		expect(requestUrl).toBe("https://discord.com/api/v10/channels/222/thread-members/999");
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bot test-discord-token");
	});

	it("returns null, rather than throwing, on a 404 (never added to the thread)", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Unknown Member", { status: 404 }));

		await expect(getThreadMember(env, "222", "999")).resolves.toBeNull();
	});

	it("still throws on a failure other than 404", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("missing access", { status: 403 }));

		await expect(getThreadMember(env, "222", "999")).rejects.toThrow(/403/);
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

	it("omits the around param entirely when given null, fetching the channel's most recent messages", async () => {
		env.DISCORD_TOKEN = "test-discord-token";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

		await getChannelMessages(env, "123", { around: null, limit: 10 });

		const [requestUrl] = fetchSpy.mock.calls[0];
		expect(requestUrl).toBe("https://discord.com/api/v10/channels/123/messages?limit=10");
	});

	it("throws with response detail on failure", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad token", { status: 401 }));

		await expect(getChannelMessages(env, "123", { around: "456", limit: 10 })).rejects.toThrow(/401/);
	});
});
