import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { getGatewayBotUrl, sendMessage } from "../../src/discord/rest";

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
		expect(JSON.parse(init?.body as string)).toEqual({ content: "hello" });
	});

	it("throws with response detail on failure", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad token", { status: 401 }));

		await expect(sendMessage(env, "123", "hello")).rejects.toThrow(/401/);
	});
});
