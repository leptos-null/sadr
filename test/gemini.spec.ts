import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { generateReply, type HistoryMessage } from "../src/gemini";

const BOT_USER_ID = "999";
const BOT_USERNAME = "sadr-bot";

const TRIGGER: HistoryMessage = {
	id: "1",
	user: "alice",
	userId: "111",
	content: "hello?",
	date: "2024-01-01T00:00:00.000Z",
	replyToId: null,
};

function textResponse(text: string): Response {
	return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] } }] }), {
		status: 200,
	});
}

/** A single candidate carrying one or more function calls, as Gemini's parallel calling returns. */
function multiCallResponse(...calls: Array<{ name: string; args?: Record<string, unknown> }>): Response {
	return new Response(
		JSON.stringify({
			candidates: [
				{
					content: {
						role: "model",
						parts: calls.map(({ name, args = {} }) => ({ functionCall: { name, args } })),
					},
				},
			],
		}),
		{ status: 200 },
	);
}

function functionCallResponse(name: string, args: Record<string, unknown> = {}): Response {
	return multiCallResponse({ name, args });
}

describe("generateReply", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends both tools and returns the answer once the model calls send_reply", async () => {
		env.GEMINI_API_KEY = "test-gemini-key";
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn();

		const reply = await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchAround);

		expect(reply).toEqual({ content: "hi there", replyToMessageId: null });
		expect(fetchAround).not.toHaveBeenCalled();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		const [requestUrl, init] = fetchSpy.mock.calls[0];
		expect(requestUrl).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
		);
		expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("test-gemini-key");
		const body = JSON.parse(init?.body as string);
		expect(body.tools[0].functionDeclarations.map((declaration: { name: string }) => declaration.name)).toEqual([
			"fetch_message_history",
			"send_reply",
		]);
		expect(body.toolConfig.functionCallingConfig.mode).toBe("ANY");
		expect(body.systemInstruction.parts[0].text).toContain(BOT_USER_ID);
		expect(body.systemInstruction.parts[0].text).toContain(BOT_USERNAME);
		expect(body.contents).toHaveLength(1);
		expect(JSON.parse(body.contents[0].parts[0].text)).toEqual({ trigger: TRIGGER, messages: [TRIGGER] });
	});

	it("fetches history around the trigger by default, then answers with the merged context", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", {}))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const earlier: HistoryMessage = {
			id: "0",
			user: "bob",
			userId: "222",
			content: "earlier message",
			date: "2023-12-31T00:00:00.000Z",
			replyToId: null,
		};
		const fetchAround = vi.fn().mockResolvedValue([earlier]);

		const reply = await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchAround);

		expect(reply).toEqual({ content: "hi there", replyToMessageId: null });
		expect(fetchAround).toHaveBeenCalledWith(TRIGGER.id, 10);
	});

	it("gives the second call a clean, chronologically merged view with no function-call scaffolding", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", { message_id: "1" }))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const earlier: HistoryMessage = {
			id: "0",
			user: "bob",
			userId: "222",
			content: "earlier message",
			date: "2023-12-31T00:00:00.000Z",
			replyToId: null,
		};
		const fetchAround = vi.fn().mockResolvedValue([earlier]);

		await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchAround);

		const secondBody = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string);
		// One plain "here's what's known" turn — no functionCall/functionResponse parts anywhere.
		expect(secondBody.contents).toHaveLength(1);
		expect(secondBody.contents[0].parts[0].functionCall).toBeUndefined();
		expect(secondBody.contents[0].parts[0].functionResponse).toBeUndefined();
		expect(JSON.parse(secondBody.contents[0].parts[0].text)).toEqual({
			trigger: TRIGGER,
			messages: [earlier, TRIGGER], // chronological order
		});
	});

	it("follows a reply chain by fetching around a specific message id", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", { message_id: "77" }))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchAround);

		expect(fetchAround).toHaveBeenCalledWith("77", 10);
	});

	it("falls back to the trigger id when the model passes an empty string instead of omitting message_id", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", { message_id: "" }))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchAround);

		expect(fetchAround).toHaveBeenCalledWith(TRIGGER.id, 10);
	});

	it("dedupes overlapping fetches by message id", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", {}))
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", { message_id: "77" }))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const earlier: HistoryMessage = {
			id: "0",
			user: "bob",
			userId: "222",
			content: "earlier message",
			date: "2023-12-31T00:00:00.000Z",
			replyToId: null,
		};
		// Same message returned by both (differently anchored) fetches.
		const fetchAround = vi.fn().mockResolvedValue([earlier]);

		const fetchSpy = vi.mocked(fetch);
		await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchAround);

		expect(fetchAround).toHaveBeenCalledTimes(2);
		const thirdBody = JSON.parse(fetchSpy.mock.calls[2][1]?.body as string);
		expect(JSON.parse(thirdBody.contents[0].parts[0].text).messages).toEqual([earlier, TRIGGER]);
	});

	it("skips the round-trip when the model re-fetches an anchor it already asked for", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", { message_id: "77" }))
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", { message_id: "77" }))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchAround);

		expect(fetchAround).toHaveBeenCalledTimes(1);
	});

	it("honours every anchor when the model asks for several in one turn", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				multiCallResponse(
					{ name: "fetch_message_history", args: { message_id: "77" } },
					{ name: "fetch_message_history", args: { message_id: "88" } },
				),
			)
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchAround);

		expect(fetchAround).toHaveBeenCalledTimes(2);
		expect(fetchAround).toHaveBeenCalledWith("77", 10);
		expect(fetchAround).toHaveBeenCalledWith("88", 10);
	});

	it("takes send_reply and drops fetches the model paired with it", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			multiCallResponse(
				{ name: "fetch_message_history", args: { message_id: "77" } },
				{ name: "send_reply", args: { content: "hi there", replyToMessageId: null } },
			),
		);
		const fetchAround = vi.fn().mockResolvedValue([]);

		const reply = await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchAround);

		expect(reply).toEqual({ content: "hi there", replyToMessageId: null });
		expect(fetchAround).not.toHaveBeenCalled();
	});

	it("passes through a replyToMessageId that matches a known message id", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			functionCallResponse("send_reply", { content: "hi", replyToMessageId: TRIGGER.id }),
		);

		const reply = await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, vi.fn());

		expect(reply).toEqual({ content: "hi", replyToMessageId: TRIGGER.id });
	});

	it("nulls out a replyToMessageId that doesn't match any known message id", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			functionCallResponse("send_reply", { content: "hi", replyToMessageId: "some-unknown-id" }),
		);

		const reply = await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, vi.fn());

		expect(reply).toEqual({ content: "hi", replyToMessageId: null });
	});

	it("accepts a replyToMessageId that was learned via fetch_message_history", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", {}))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi", replyToMessageId: "0" }));
		const earlier: HistoryMessage = {
			id: "0",
			user: "bob",
			userId: "222",
			content: "earlier message",
			date: "2023-12-31T00:00:00.000Z",
			replyToId: null,
		};
		const fetchAround = vi.fn().mockResolvedValue([earlier]);

		const reply = await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchAround);

		expect(reply).toEqual({ content: "hi", replyToMessageId: "0" });
	});

	it("throws after exceeding the max Gemini calls without a send_reply call", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => functionCallResponse("fetch_message_history", {}));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await expect(generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchAround)).rejects.toThrow(/exceeded/);

		expect(fetchSpy).toHaveBeenCalledTimes(6); // MAX_GEMINI_CALLS
	});

	it("withholds fetch_message_history on the final call, forcing a conclusion", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => functionCallResponse("fetch_message_history", {}));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await expect(generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchAround)).rejects.toThrow();

		const finalCallBody = JSON.parse(fetchSpy.mock.calls[5][1]?.body as string);
		expect(finalCallBody.tools[0].functionDeclarations.map((d: { name: string }) => d.name)).toEqual(["send_reply"]);
		// The final-call system instruction shouldn't reference a tool it never declares.
		const instructionText = finalCallBody.systemInstruction.parts.map((p: { text: string }) => p.text).join(" ");
		expect(instructionText).not.toContain("fetch_message_history");
	});

	it("counts the gathering budget down per call, then drops it once the tool is withheld", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => functionCallResponse("fetch_message_history", {}));

		await expect(generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, vi.fn().mockResolvedValue([]))).rejects.toThrow();

		const instructionFor = (call: number) =>
			JSON.parse(fetchSpy.mock.calls[call][1]?.body as string)
				.systemInstruction.parts.map((part: { text: string }) => part.text)
				.join(" ");

		// Five gathering turns, not MAX_GEMINI_CALLS: the sixth call only offers send_reply.
		expect(instructionFor(0)).toContain("You have 5 turns left to gather context");
		expect(instructionFor(3)).toContain("You have 2 turns left to gather context");
		expect(instructionFor(4)).toContain("This is your last turn to gather context");
		expect(instructionFor(5)).toContain("Answer now");
		expect(instructionFor(5)).not.toContain("gather context");
	});

	it("throws when the model doesn't call a function", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse("no function call"));

		await expect(generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, vi.fn())).rejects.toThrow(/didn't call a function/);
	});

	it("throws when send_reply is called without content", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(functionCallResponse("send_reply", { replyToMessageId: null }));

		await expect(generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, vi.fn())).rejects.toThrow(/without content/);
	});

	it("treats whitespace-only content as no content, rather than letting Discord reject it", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			functionCallResponse("send_reply", { content: "  \n ", replyToMessageId: null }),
		);

		await expect(generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, vi.fn())).rejects.toThrow(/without content/);
	});

	it("trims the reply content it returns", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			functionCallResponse("send_reply", { content: "  hi there\n", replyToMessageId: null }),
		);

		const reply = await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, vi.fn());

		expect(reply.content).toBe("hi there");
	});

	it("names the finish and block reasons when a candidate comes back with no parts", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					candidates: [{ content: { role: "model" }, finishReason: "MAX_TOKENS" }],
					promptFeedback: { blockReason: "SAFETY" },
				}),
				{ status: 200 },
			),
		);

		await expect(generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, vi.fn())).rejects.toThrow(
			/no content parts.*MAX_TOKENS.*SAFETY/,
		);
	});

	it("throws with response detail on failure", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad key", { status: 403 }));

		await expect(generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, vi.fn())).rejects.toThrow(/403/);
	});
});
