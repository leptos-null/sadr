import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { searchWeb } from "../src/brave";

/** A search that found nothing, in the documented response shape. */
const EMPTY_RESPONSE = JSON.stringify({ grounding: { generic: [], map: [] }, sources: {} });

describe("searchWeb", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("queries Brave's LLM Context endpoint with the subscription token", async () => {
		env.BRAVE_SEARCH_API_KEY = "test-brave-key";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(EMPTY_RESPONSE, { status: 200 }));

		await searchWeb(env, "tallest mountain");

		const [requestUrl, init] = fetchSpy.mock.calls[0];
		const url = new URL(requestUrl as URL);
		expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/llm/context");
		expect(url.searchParams.get("q")).toBe("tallest mountain");
		expect(new Headers(init?.headers).get("X-Subscription-Token")).toBe("test-brave-key");
	});

	it("maps each page to its url, title and snippets, adding its ISO date only when Brave knows one", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					grounding: {
						generic: [
							{ url: "https://a.example", title: "A", snippets: ["a1", "a2"] },
							{ url: "https://b.example", title: "B", snippets: ["b1"] },
						],
						map: [],
					},
					sources: {
						"https://a.example": {
							title: "A",
							hostname: "a.example",
							age: ["Wednesday, January 15, 2025", "2025-01-15", "392 days ago", "2025-01-15T13:45:02Z"],
						},
						"https://b.example": { title: "B", hostname: "b.example", age: [] },
					},
				}),
				{ status: 200 },
			),
		);

		const results = await searchWeb(env, "q");

		expect(results).toEqual([
			{ url: "https://a.example", title: "A", snippets: ["a1", "a2"], date: "2025-01-15T13:45:02Z" },
			{ url: "https://b.example", title: "B", snippets: ["b1"] },
		]);
	});

	it("throws with the status on a non-2xx response", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("rate limited", { status: 429 }));

		await expect(searchWeb(env, "q")).rejects.toThrow(/429 rate limited/);
	});
});
