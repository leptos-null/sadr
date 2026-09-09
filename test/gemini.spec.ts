import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { generateReply, type ChannelInfo, type GuildInfo, type HistoryMessage, type UserInfo } from "../src/gemini";

const BOT_USER_ID = "999";
const BOT_USERNAME = "sadr-bot";

const TRIGGER: HistoryMessage = {
	id: "1",
	userId: "111",
	author: { username: "alice", globalName: null },
	content: "hello?",
	date: "2024-01-01T00:00:00.000Z",
	replyToId: null,
};

/** Mirrors gemini.ts's own transform: what a HistoryMessage looks like once name info moves to `users`. */
function payloadMessage({ author: _author, mentionedUsers: _mentionedUsers, ...rest }: HistoryMessage) {
	return rest;
}

/** Mirrors gemini.ts's own transform: the `users` map a set of messages should produce. */
function usersOf(...messages: HistoryMessage[]): Record<string, UserInfo> {
	const users: Record<string, UserInfo> = {};
	for (const message of messages) {
		users[message.userId] = message.author;
		for (const { id, ...info } of message.mentionedUsers ?? []) users[id] = info;
	}
	return users;
}

const GUILD: GuildInfo = { name: "sadr's server", description: "a place to chat" };
const CHANNEL: ChannelInfo = { name: "general", topic: "chat about anything" };
// Most tests don't care about guild/channel info; plain functions (not vi.fn) keep them from
// having to assert on or reset mocks they never look at.
const fetchGuild = () => Promise.resolve<GuildInfo | null>(GUILD);
const fetchChannel = () => Promise.resolve(CHANNEL);

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
		const fetchAround = vi.fn().mockResolvedValue([]);

		const reply = await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround);

		expect(reply).toEqual({ content: "hi there", replyToMessageId: null });
		// The automatic seed fetch around the trigger, not a model-issued call.
		expect(fetchAround).toHaveBeenCalledTimes(1);
		expect(fetchAround).toHaveBeenCalledWith(TRIGGER.id, 100);
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
		expect(JSON.parse(body.contents[0].parts[0].text)).toEqual({
			guild: GUILD,
			channel: CHANNEL,
			trigger: payloadMessage(TRIGGER),
			messages: [payloadMessage(TRIGGER)],
			users: usersOf(TRIGGER),
		});
	});

	it("includes attachments on a message that has them, and omits the key otherwise", async () => {
		const withAttachment: HistoryMessage = {
			...TRIGGER,
			id: "2",
			attachments: ["screenshot.png"],
		};
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([withAttachment]);

		await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround);

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		const { messages } = JSON.parse(body.contents[0].parts[0].text);
		expect(messages).toContainEqual(payloadMessage(withAttachment));
		// TRIGGER itself has none, so the key shouldn't appear at all.
		expect(messages.find((message: HistoryMessage) => message.id === TRIGGER.id)).not.toHaveProperty(
			"attachments",
		);
	});

	it("includes editedDate on a message that's been edited, and omits the key otherwise", async () => {
		const edited: HistoryMessage = { ...TRIGGER, id: "2", editedDate: "2024-01-01T00:05:00.000Z" };
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([edited]);

		await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround);

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		const { messages } = JSON.parse(body.contents[0].parts[0].text);
		expect(messages).toContainEqual(payloadMessage(edited));
		// TRIGGER itself was never edited, so the key shouldn't appear at all.
		expect(messages.find((message: HistoryMessage) => message.id === TRIGGER.id)).not.toHaveProperty("editedDate");
	});

	it("includes a mentioned user's name in \"users\" even if they've never posted in view", async () => {
		const withMention: HistoryMessage = {
			...TRIGGER,
			mentionedUsers: [{ id: "555", username: "carol", globalName: "Carol C." }],
		};
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT_USER_ID, BOT_USERNAME, withMention, fetchGuild, fetchChannel, fetchAround);

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		const { users } = JSON.parse(body.contents[0].parts[0].text);
		expect(users["555"]).toEqual({ username: "carol", globalName: "Carol C." });
	});

	it("trims oldest context first when the payload would exceed the size budget", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		// 30 messages of 1000 chars each, all before TRIGGER's date, comfortably exceeds gemini.ts's
		// 15k-char MAX_PAYLOAD_CHARS.
		const bulky: HistoryMessage[] = Array.from({ length: 30 }, (_, index) => ({
			id: `bulk-${index}`,
			userId: "222",
			author: { username: "bob", globalName: null },
			content: "x".repeat(1000),
			date: new Date(Date.parse("2023-12-01T00:00:00.000Z") + index * 60_000).toISOString(),
			replyToId: null,
		}));
		const fetchAround = vi.fn().mockResolvedValue(bulky);

		await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround);

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		const text = body.contents[0].parts[0].text as string;
		const { messages } = JSON.parse(text);

		expect(text.length).toBeLessThanOrEqual(15_000);
		// Dropped from the oldest end first...
		expect(messages.some((message: HistoryMessage) => message.id === "bulk-0")).toBe(false);
		// ...but the trigger and the most recent context survive.
		expect(messages.some((message: HistoryMessage) => message.id === TRIGGER.id)).toBe(true);
		expect(messages.some((message: HistoryMessage) => message.id === "bulk-29")).toBe(true);
	});

	it("passes a channel with a null topic through as-is", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const noTopic: ChannelInfo = { name: "general", topic: null };
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, () => Promise.resolve(noTopic), fetchAround);

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		expect(JSON.parse(body.contents[0].parts[0].text).channel).toEqual(noTopic);
	});

	it("omits channel entirely for a DM, rather than sending it as null", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, () => Promise.resolve(null), fetchAround);

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		expect(JSON.parse(body.contents[0].parts[0].text)).not.toHaveProperty("channel");
	});

	it("fetches channel info only once per reply, reused across every Gemini call", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", {}))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);
		const fetchChannelSpy = vi.fn().mockResolvedValue(CHANNEL);

		await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannelSpy, fetchAround);

		expect(fetchChannelSpy).toHaveBeenCalledTimes(1);
	});

	it("omits guild entirely for a DM, rather than sending it as null", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, () => Promise.resolve(null), fetchChannel, fetchAround);

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		expect(JSON.parse(body.contents[0].parts[0].text)).not.toHaveProperty("guild");
	});

	it("fetches guild info only once per reply, reused across every Gemini call", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", {}))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);
		const fetchGuildSpy = vi.fn().mockResolvedValue(GUILD);

		await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuildSpy, fetchChannel, fetchAround);

		expect(fetchGuildSpy).toHaveBeenCalledTimes(1);
	});

	it("seeds context around the trigger before asking the model anything", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const earlier: HistoryMessage = {
			id: "0",
			userId: "222",
			author: { username: "bob", globalName: null },
			content: "earlier message",
			date: "2023-12-31T00:00:00.000Z",
			replyToId: null,
		};
		const fetchAround = vi.fn().mockResolvedValue([earlier]);

		const reply = await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround);

		expect(reply).toEqual({ content: "hi there", replyToMessageId: null });
		expect(fetchAround).toHaveBeenCalledTimes(1);
		expect(fetchAround).toHaveBeenCalledWith(TRIGGER.id, 100);
		// The seeded message actually reached the model on its very first call, not just the fetch itself.
		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		expect(JSON.parse(body.contents[0].parts[0].text).messages).toEqual([
			payloadMessage(earlier),
			payloadMessage(TRIGGER),
		]);
	});

	it("also seeds context around the reply target when the trigger is itself a reply", async () => {
		const replyTrigger: HistoryMessage = { ...TRIGGER, replyToId: "42" };
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }),
		);
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT_USER_ID, BOT_USERNAME, replyTrigger, fetchGuild, fetchChannel, fetchAround);

		expect(fetchAround).toHaveBeenCalledTimes(2);
		expect(fetchAround).toHaveBeenCalledWith(replyTrigger.id, 100);
		expect(fetchAround).toHaveBeenCalledWith("42", 100);
	});

	it("skips the reply-target fetch when the trigger's own window already contains it", async () => {
		const replyTrigger: HistoryMessage = { ...TRIGGER, replyToId: "42" };
		const replyTarget: HistoryMessage = {
			id: "42",
			userId: "222",
			author: { username: "bob", globalName: null },
			content: "original message",
			date: "2023-12-31T00:00:00.000Z",
			replyToId: null,
		};
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }),
		);
		const fetchAround = vi.fn().mockResolvedValue([replyTarget]);

		await generateReply(env, BOT_USER_ID, BOT_USERNAME, replyTrigger, fetchGuild, fetchChannel, fetchAround);

		// Only the trigger's own seed fetch — "42" already came back in that window, so the
		// second round-trip is skipped entirely.
		expect(fetchAround).toHaveBeenCalledTimes(1);
		expect(fetchAround).toHaveBeenCalledWith(replyTrigger.id, 100);
	});

	it("treats a model-issued fetch of an already-seeded anchor as a no-op", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", {}))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround);

		// Once for the automatic seed fetch; the model's own (redundant) request for the trigger — via
		// an omitted message_id, which falls back to it — is deduped rather than fetched again.
		expect(fetchAround).toHaveBeenCalledTimes(1);
	});

	it("gives the next call a clean, chronologically merged view with no function-call scaffolding", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", { message_id: "77" }))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const earlier: HistoryMessage = {
			id: "0",
			userId: "222",
			author: { username: "bob", globalName: null },
			content: "earlier message",
			date: "2023-12-31T00:00:00.000Z",
			replyToId: null,
		};
		// Keyed by anchor so the automatic trigger seed comes back empty and only the model's explicit
		// fetch of "77" brings "earlier" in — isolating what actually changes between the two calls.
		const fetchAround = vi.fn((anchor: string) => Promise.resolve(anchor === "77" ? [earlier] : []));

		await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround);

		const secondBody = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string);
		// One plain "here's what's known" turn — no functionCall/functionResponse parts anywhere.
		expect(secondBody.contents).toHaveLength(1);
		expect(secondBody.contents[0].parts[0].functionCall).toBeUndefined();
		expect(secondBody.contents[0].parts[0].functionResponse).toBeUndefined();
		expect(JSON.parse(secondBody.contents[0].parts[0].text)).toEqual({
			guild: GUILD,
			channel: CHANNEL,
			trigger: payloadMessage(TRIGGER),
			messages: [payloadMessage(earlier), payloadMessage(TRIGGER)], // chronological order
			users: usersOf(earlier, TRIGGER),
		});
	});

	it("follows a reply chain by fetching around a specific message id", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", { message_id: "77" }))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround);

		expect(fetchAround).toHaveBeenCalledWith("77", 20);
	});

	it("falls back to the trigger id when the model passes an empty string instead of omitting message_id", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", { message_id: "" }))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround);

		expect(fetchAround).toHaveBeenCalledWith(TRIGGER.id, 100);
		// Only the automatic seed fetch — the fallback resolves to an already-seeded anchor, not a
		// spurious fetch for the literal empty string.
		expect(fetchAround).toHaveBeenCalledTimes(1);
	});

	it("dedupes overlapping fetches by message id", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", {}))
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", { message_id: "77" }))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const earlier: HistoryMessage = {
			id: "0",
			userId: "222",
			author: { username: "bob", globalName: null },
			content: "earlier message",
			date: "2023-12-31T00:00:00.000Z",
			replyToId: null,
		};
		// Same message returned by both (differently anchored) fetches.
		const fetchAround = vi.fn().mockResolvedValue([earlier]);

		const fetchSpy = vi.mocked(fetch);
		await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround);

		expect(fetchAround).toHaveBeenCalledTimes(2);
		const thirdBody = JSON.parse(fetchSpy.mock.calls[2][1]?.body as string);
		expect(JSON.parse(thirdBody.contents[0].parts[0].text).messages).toEqual([
			payloadMessage(earlier),
			payloadMessage(TRIGGER),
		]);
	});

	it("skips the round-trip when the model re-fetches an anchor it already asked for", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", { message_id: "77" }))
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", { message_id: "77" }))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround);

		// The automatic seed fetch, plus one for "77" the first time it's asked for — the repeat is deduped.
		expect(fetchAround).toHaveBeenCalledTimes(2);
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

		await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround);

		// The automatic seed fetch, plus "77" and "88".
		expect(fetchAround).toHaveBeenCalledTimes(3);
		expect(fetchAround).toHaveBeenCalledWith("77", 20);
		expect(fetchAround).toHaveBeenCalledWith("88", 20);
	});

	it("takes send_reply and drops fetches the model paired with it", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			multiCallResponse(
				{ name: "fetch_message_history", args: { message_id: "77" } },
				{ name: "send_reply", args: { content: "hi there", replyToMessageId: null } },
			),
		);
		const fetchAround = vi.fn().mockResolvedValue([]);

		const reply = await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround);

		expect(reply).toEqual({ content: "hi there", replyToMessageId: null });
		// Only the automatic seed fetch — send_reply wins outright, so the paired "77" fetch never runs.
		expect(fetchAround).toHaveBeenCalledTimes(1);
		expect(fetchAround).toHaveBeenCalledWith(TRIGGER.id, 100);
	});

	it("passes through a replyToMessageId that matches a known message id", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			functionCallResponse("send_reply", { content: "hi", replyToMessageId: TRIGGER.id }),
		);

		const fetchAround = vi.fn().mockResolvedValue([]);
		const reply = await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround);

		expect(reply).toEqual({ content: "hi", replyToMessageId: TRIGGER.id });
	});

	it("nulls out a replyToMessageId that doesn't match any known message id", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			functionCallResponse("send_reply", { content: "hi", replyToMessageId: "some-unknown-id" }),
		);

		const fetchAround = vi.fn().mockResolvedValue([]);
		const reply = await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround);

		expect(reply).toEqual({ content: "hi", replyToMessageId: null });
	});

	it("accepts a replyToMessageId that was learned via fetch_message_history", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", {}))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi", replyToMessageId: "0" }));
		const earlier: HistoryMessage = {
			id: "0",
			userId: "222",
			author: { username: "bob", globalName: null },
			content: "earlier message",
			date: "2023-12-31T00:00:00.000Z",
			replyToId: null,
		};
		const fetchAround = vi.fn().mockResolvedValue([earlier]);

		const reply = await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround);

		expect(reply).toEqual({ content: "hi", replyToMessageId: "0" });
	});

	it("throws after exceeding the max Gemini calls without a send_reply call", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => functionCallResponse("fetch_message_history", {}));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await expect(generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround)).rejects.toThrow(/exceeded/);

		expect(fetchSpy).toHaveBeenCalledTimes(5); // MAX_GEMINI_CALLS
	});

	it("withholds fetch_message_history on the final call, forcing a conclusion", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => functionCallResponse("fetch_message_history", {}));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await expect(generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround)).rejects.toThrow();

		const finalCallBody = JSON.parse(fetchSpy.mock.calls[4][1]?.body as string);
		expect(finalCallBody.tools[0].functionDeclarations.map((d: { name: string }) => d.name)).toEqual(["send_reply"]);
		// The final-call system instruction shouldn't reference a tool it never declares.
		const instructionText = finalCallBody.systemInstruction.parts.map((p: { text: string }) => p.text).join(" ");
		expect(instructionText).not.toContain("fetch_message_history");
	});

	it("counts the gathering budget down per call, then drops it once the tool is withheld", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => functionCallResponse("fetch_message_history", {}));

		const fetchAround = vi.fn().mockResolvedValue([]);
		await expect(generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround)).rejects.toThrow();

		const instructionFor = (call: number) =>
			JSON.parse(fetchSpy.mock.calls[call][1]?.body as string)
				.systemInstruction.parts.map((part: { text: string }) => part.text)
				.join(" ");

		// Four gathering turns, not MAX_GEMINI_CALLS: the fifth call only offers send_reply.
		expect(instructionFor(0)).toContain("You have 4 turns left to gather context");
		expect(instructionFor(2)).toContain("You have 2 turns left to gather context");
		expect(instructionFor(3)).toContain("This is your last turn to gather context");
		expect(instructionFor(4)).toContain("Answer now");
		expect(instructionFor(4)).not.toContain("gather context");
	});

	it("throws when the model doesn't call a function", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse("no function call"));

		const fetchAround = vi.fn().mockResolvedValue([]);
		await expect(generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround)).rejects.toThrow(
			/didn't call a function/,
		);
	});

	it("throws when send_reply is called without content", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(functionCallResponse("send_reply", { replyToMessageId: null }));

		const fetchAround = vi.fn().mockResolvedValue([]);
		await expect(generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround)).rejects.toThrow(/without content/);
	});

	it("treats whitespace-only content as no content, rather than letting Discord reject it", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			functionCallResponse("send_reply", { content: "  \n ", replyToMessageId: null }),
		);

		const fetchAround = vi.fn().mockResolvedValue([]);
		await expect(generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround)).rejects.toThrow(/without content/);
	});

	it("trims the reply content it returns", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			functionCallResponse("send_reply", { content: "  hi there\n", replyToMessageId: null }),
		);

		const fetchAround = vi.fn().mockResolvedValue([]);
		const reply = await generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround);

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

		const fetchAround = vi.fn().mockResolvedValue([]);
		await expect(generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround)).rejects.toThrow(
			/no content parts.*MAX_TOKENS.*SAFETY/,
		);
	});

	it("throws with response detail on failure", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad key", { status: 403 }));

		const fetchAround = vi.fn().mockResolvedValue([]);
		await expect(generateReply(env, BOT_USER_ID, BOT_USERNAME, TRIGGER, fetchGuild, fetchChannel, fetchAround)).rejects.toThrow(/403/);
	});
});
