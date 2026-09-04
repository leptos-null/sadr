import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { generateReply } from "../src/gemini";

describe("generateReply", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends the prompt as a single-turn request and returns the generated text", async () => {
		env.GEMINI_API_KEY = "test-gemini-key";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi there" }] } }] }), {
				status: 200,
			}),
		);

		const reply = await generateReply(env, "hello?");

		expect(reply).toBe("hi there");
		const [requestUrl, init] = fetchSpy.mock.calls[0];
		expect(requestUrl).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
		);
		expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("test-gemini-key");
		expect(JSON.parse(init?.body as string)).toEqual({
			contents: [{ parts: [{ text: "hello?" }] }],
		});
	});

	it("throws when the response has no candidate text", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

		await expect(generateReply(env, "hello?")).rejects.toThrow(/no text/);
	});

	it("throws with response detail on failure", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad key", { status: 403 }));

		await expect(generateReply(env, "hello?")).rejects.toThrow(/403/);
	});
});
