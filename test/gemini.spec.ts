import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { generateReply, type BotIdentity, type ChannelInfo, type GuildInfo, type HistoryMessage, type UserInfo } from "../src/gemini";

const BOT_USER_ID = "999";
const BOT_USERNAME = "sadr-bot";
const BOT: BotIdentity = { id: BOT_USER_ID, username: BOT_USERNAME };

// Numeric, like a real Discord snowflake — extractMessageLinks' regex only matches digits there.
const HOME_CHANNEL_ID = "1000";
const LINK_CHANNEL_ID = "2000";

const TRIGGER: HistoryMessage = {
	id: "1",
	channelId: HOME_CHANNEL_ID,
	userId: "111",
	author: { username: "alice", globalName: null },
	content: "hello?",
	date: "2024-01-01T00:00:00.000Z",
	replyToId: null,
};

/** Mirrors gemini.ts's own transform: what a HistoryMessage looks like once channel/name info moves elsewhere. */
function payloadMessage({ channelId: _channelId, author: _author, mentionedUsers: _mentionedUsers, ...rest }: HistoryMessage) {
	return rest;
}

/** Mirrors gemini.ts's own transform: the top-level "trigger" pointer for a given message. */
function triggerPointer(message: HistoryMessage) {
	return { channelId: message.channelId, messageId: message.id };
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

/** Mirrors gemini.ts's own transform: the `channels` map a set of messages, grouped by channelId, should produce. */
function channelsOf(messages: HistoryMessage[], infoByChannel: Record<string, ChannelInfo | null> = {}) {
	const channels: Record<string, { name: string | null; topic: string | null; messages: unknown[] }> = {};
	for (const message of messages) {
		const info = infoByChannel[message.channelId] ?? null;
		const entry = (channels[message.channelId] ??= { name: info?.name ?? null, topic: info?.topic ?? null, messages: [] });
		entry.messages.push(payloadMessage(message));
	}
	return channels;
}

const GUILD: GuildInfo = { name: "sadr's server", description: "a place to chat" };
const CHANNEL: ChannelInfo = { name: "general", topic: "chat about anything" };
// Most tests don't care about guild/channel info; plain functions (not vi.fn) keep them from
// having to assert on or reset mocks they never look at.
const fetchGuild = () => Promise.resolve<GuildInfo | null>(GUILD);
const fetchChannel = () => Promise.resolve<ChannelInfo | null>(CHANNEL);
// Most tests either have no links in "trigger" (so this never gets called) or aren't testing access
// control — default to "allowed" so they don't have to think about it.
const canReadLinkedChannel = () => Promise.resolve(true);

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

		const reply = await generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		expect(reply).toEqual({ content: "hi there", replyToMessageId: null });
		// The automatic seed fetch around the trigger, not a model-issued call.
		expect(fetchAround).toHaveBeenCalledTimes(1);
		expect(fetchAround).toHaveBeenCalledWith(HOME_CHANNEL_ID, TRIGGER.id, 50);
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
			channels: channelsOf([TRIGGER], { [HOME_CHANNEL_ID]: CHANNEL }),
			trigger: triggerPointer(TRIGGER),
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

		await generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		const { messages } = JSON.parse(body.contents[0].parts[0].text).channels[HOME_CHANNEL_ID];
		expect(messages).toContainEqual(payloadMessage(withAttachment));
		// TRIGGER itself has none, so the key shouldn't appear at all.
		expect(messages.find((message: HistoryMessage) => message.id === TRIGGER.id)).not.toHaveProperty("attachments");
	});

	it("includes editedDate on a message that's been edited, and omits the key otherwise", async () => {
		const edited: HistoryMessage = { ...TRIGGER, id: "2", editedDate: "2024-01-01T00:05:00.000Z" };
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([edited]);

		await generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		const { messages } = JSON.parse(body.contents[0].parts[0].text).channels[HOME_CHANNEL_ID];
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

		await generateReply(env, BOT, withMention, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		const { users } = JSON.parse(body.contents[0].parts[0].text);
		expect(users["555"]).toEqual({ username: "carol", globalName: "Carol C." });
	});

	it("passes a channel with a null topic through as-is", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const noTopic: ChannelInfo = { name: "general", topic: null };
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel: () => Promise.resolve(noTopic), fetchAround, canReadLinkedChannel });

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		const channel = JSON.parse(body.contents[0].parts[0].text).channels[HOME_CHANNEL_ID];
		expect(channel).toMatchObject(noTopic);
	});

	it("gives a channel null name/topic when fetchChannel returns null (e.g. a DM)", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel: () => Promise.resolve(null), fetchAround, canReadLinkedChannel });

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		const channel = JSON.parse(body.contents[0].parts[0].text).channels[HOME_CHANNEL_ID];
		expect(channel).toMatchObject({ name: null, topic: null });
	});

	it("fetches channel info only once per reply, reused across every Gemini call", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", {}))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);
		const fetchChannelSpy = vi.fn().mockResolvedValue(CHANNEL);

		await generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel: fetchChannelSpy, fetchAround, canReadLinkedChannel });

		expect(fetchChannelSpy).toHaveBeenCalledTimes(1);
	});

	it("omits guild entirely for a DM, rather than sending it as null", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT, TRIGGER, { fetchGuild: () => Promise.resolve(null), fetchChannel, fetchAround, canReadLinkedChannel });

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		expect(JSON.parse(body.contents[0].parts[0].text)).not.toHaveProperty("guild");
	});

	it("fetches guild info only once per reply, reused across every Gemini call", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", {}))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);
		const fetchGuildSpy = vi.fn().mockResolvedValue(GUILD);

		await generateReply(env, BOT, TRIGGER, { fetchGuild: fetchGuildSpy, fetchChannel, fetchAround, canReadLinkedChannel });

		expect(fetchGuildSpy).toHaveBeenCalledTimes(1);
	});

	it("seeds context around the trigger before asking the model anything", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const earlier: HistoryMessage = {
			id: "0",
			channelId: HOME_CHANNEL_ID,
			userId: "222",
			author: { username: "bob", globalName: null },
			content: "earlier message",
			date: "2023-12-31T00:00:00.000Z",
			replyToId: null,
		};
		const fetchAround = vi.fn().mockResolvedValue([earlier]);

		const reply = await generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		expect(reply).toEqual({ content: "hi there", replyToMessageId: null });
		expect(fetchAround).toHaveBeenCalledTimes(1);
		expect(fetchAround).toHaveBeenCalledWith(HOME_CHANNEL_ID, TRIGGER.id, 50);
		// The seeded message actually reached the model on its very first call, not just the fetch itself.
		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		expect(JSON.parse(body.contents[0].parts[0].text).channels).toEqual(
			channelsOf([earlier, TRIGGER], { [HOME_CHANNEL_ID]: CHANNEL }),
		);
	});

	it("also seeds context around the reply target when the trigger is itself a reply", async () => {
		const replyTrigger: HistoryMessage = { ...TRIGGER, replyToId: "42" };
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }),
		);
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT, replyTrigger, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		expect(fetchAround).toHaveBeenCalledTimes(2);
		expect(fetchAround).toHaveBeenCalledWith(HOME_CHANNEL_ID, replyTrigger.id, 50);
		expect(fetchAround).toHaveBeenCalledWith(HOME_CHANNEL_ID, "42", 20);
	});

	it("skips the reply-target fetch when the trigger's own window already contains it", async () => {
		const replyTrigger: HistoryMessage = { ...TRIGGER, replyToId: "42" };
		const replyTarget: HistoryMessage = {
			id: "42",
			channelId: HOME_CHANNEL_ID,
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

		await generateReply(env, BOT, replyTrigger, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		// Only the trigger's own seed fetch — "42" already came back in that window, so the
		// second round-trip is skipped entirely.
		expect(fetchAround).toHaveBeenCalledTimes(1);
		expect(fetchAround).toHaveBeenCalledWith(HOME_CHANNEL_ID, replyTrigger.id, 50);
	});

	it("resolves a Discord message link in the trigger's content from its linked channel", async () => {
		const linkTrigger: HistoryMessage = {
			...TRIGGER,
			content: `what's this? https://discord.com/channels/999/${LINK_CHANNEL_ID}/777`,
		};
		const linked: HistoryMessage = {
			id: "777",
			channelId: LINK_CHANNEL_ID,
			userId: "222",
			author: { username: "bob", globalName: null },
			content: "the original message",
			date: "2023-12-31T00:00:00.000Z",
			replyToId: null,
		};
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn(async (_channelId: string, messageId: string | null) => (messageId === "777" ? [linked] : []));

		await generateReply(env, BOT, linkTrigger, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		// Resolved from the link's own channel, not the trigger's.
		expect(fetchAround).toHaveBeenCalledWith(LINK_CHANNEL_ID, "777", 10);
		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		const payload = JSON.parse(body.contents[0].parts[0].text);
		expect(payload.channels[LINK_CHANNEL_ID].messages).toEqual([payloadMessage(linked)]);
		// Not folded into the trigger's own channel.
		expect(payload.channels[HOME_CHANNEL_ID].messages.some((message: HistoryMessage) => message.id === "777")).toBe(
			false,
		);
	});

	it("keeps an entry for an accessible linked channel that resolved no messages", async () => {
		const linkTrigger: HistoryMessage = {
			...TRIGGER,
			content: `what's this? https://discord.com/channels/999/${LINK_CHANNEL_ID}/777`,
		};
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		// Allowed and fetched without error, but nothing came back — e.g. the linked message was since
		// deleted out from under the link.
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT, linkTrigger, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		const payload = JSON.parse(body.contents[0].parts[0].text);
		// Still present, with its name/topic and an empty list — which says something different to the
		// model than being absent entirely (a link it was never shown) or {inaccessible: true} (one it
		// isn't allowed to read).
		expect(payload.channels[LINK_CHANNEL_ID]).toEqual({ name: CHANNEL.name, topic: CHANNEL.topic, messages: [] });
	});

	it("nulls out a replyToMessageId pointing at a linked (cross-channel) message", async () => {
		const linkTrigger: HistoryMessage = {
			...TRIGGER,
			content: `what's this? https://discord.com/channels/999/${LINK_CHANNEL_ID}/777`,
		};
		const linked: HistoryMessage = {
			id: "777",
			channelId: LINK_CHANNEL_ID,
			userId: "222",
			author: { username: "bob", globalName: null },
			content: "the original message",
			date: "2023-12-31T00:00:00.000Z",
			replyToId: null,
		};
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			functionCallResponse("send_reply", { content: "hi there", replyToMessageId: "777" }),
		);
		const fetchAround = vi.fn(async (_channelId: string, messageId: string | null) => (messageId === "777" ? [linked] : []));

		const reply = await generateReply(env, BOT, linkTrigger, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		// "777" is known, but from a different channel — Discord can't reply-quote across channels.
		expect(reply).toEqual({ content: "hi there", replyToMessageId: null });
	});

	it("doesn't fail the reply when a linked channel can't be fetched", async () => {
		const linkTrigger: HistoryMessage = {
			...TRIGGER,
			content: `what's this? https://discord.com/channels/999/${LINK_CHANNEL_ID}/777`,
		};
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }),
		);
		const fetchAround = vi.fn(async (_channelId: string, messageId: string | null) => {
			if (messageId === "777") throw new Error("403 Missing Access");
			return [];
		});

		const reply = await generateReply(env, BOT, linkTrigger, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		expect(reply).toEqual({ content: "hi there", replyToMessageId: null });
	});

	it("marks a denied link's channel inaccessible rather than fetching it", async () => {
		const linkTrigger: HistoryMessage = {
			...TRIGGER,
			content: `what's this? https://discord.com/channels/999/${LINK_CHANNEL_ID}/777`,
		};
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);
		const denyAll = () => Promise.resolve(false);

		await generateReply(env, BOT, linkTrigger, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel: denyAll });

		// Only the trigger's own seed fetch — the link's channel/message fetches never happen at all.
		expect(fetchAround).toHaveBeenCalledTimes(1);
		expect(fetchAround).toHaveBeenCalledWith(HOME_CHANNEL_ID, linkTrigger.id, 50);
		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		const payload = JSON.parse(body.contents[0].parts[0].text);
		// Present so the model knows it isn't allowed to read the link, rather than silently absent — which
		// would look no different to the model than a link it hadn't asked about at all.
		expect(payload.channels[LINK_CHANNEL_ID]).toEqual({ inaccessible: true });
	});

	it("logs a permission check that throws and marks the channel inaccessible, since the check answers every expected denial itself", async () => {
		const linkTrigger: HistoryMessage = {
			...TRIGGER,
			content: `what's this? https://discord.com/channels/999/${LINK_CHANNEL_ID}/777`,
		};
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const fetchAround = vi.fn().mockResolvedValue([]);
		const throwing = () => Promise.reject(new Error("503 Service Unavailable"));

		const reply = await generateReply(env, BOT, linkTrigger, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel: throwing });

		expect(reply).toEqual({ content: "hi there", replyToMessageId: null });
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy.mock.calls[0][0]).toMatchObject({ channelId: LINK_CHANNEL_ID, error: "503 Service Unavailable" });
		expect(fetchAround).toHaveBeenCalledTimes(1);
		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		const payload = JSON.parse(body.contents[0].parts[0].text);
		expect(payload.channels[LINK_CHANNEL_ID]).toEqual({ inaccessible: true });
	});

	it("falls back to the trigger's own channel rather than retrying a model-issued fetch for a denied link", async () => {
		const linkTrigger: HistoryMessage = {
			...TRIGGER,
			content: `what's this? https://discord.com/channels/999/${LINK_CHANNEL_ID}/777`,
		};
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				functionCallResponse("fetch_message_history", { channel_id: LINK_CHANNEL_ID, message_id: "888" }),
			)
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);
		const denyAll = () => Promise.resolve(false);

		await generateReply(env, BOT, linkTrigger, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel: denyAll });

		// The model's request lands on the trigger's own channel instead — a real fetch, just redirected
		// away from the denied one, not a dedup (the requested message_id "888" is still unknown).
		expect(fetchAround).not.toHaveBeenCalledWith(LINK_CHANNEL_ID, "888", 20);
		expect(fetchAround).toHaveBeenCalledWith(HOME_CHANNEL_ID, "888", 20);
	});

	it("keeps a channel accessible, and still reachable, when a link's message fetch fails", async () => {
		const linkTrigger: HistoryMessage = {
			...TRIGGER,
			content: `https://discord.com/channels/999/${LINK_CHANNEL_ID}/777`,
		};
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				functionCallResponse("fetch_message_history", { channel_id: LINK_CHANNEL_ID, message_id: "888" }),
			)
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn(async (_channelId: string, messageId: string | null) => {
			if (messageId === "777") throw new Error("500 Internal Server Error");
			return [];
		});

		await generateReply(env, BOT, linkTrigger, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		// A fetch error isn't a denial: the channel keeps its entry, and the model's own follow-up
		// fetch goes to it rather than being redirected.
		const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
		const payload = JSON.parse(body.contents[0].parts[0].text);
		expect(payload.channels[LINK_CHANNEL_ID]).toEqual({ name: CHANNEL.name, topic: CHANNEL.topic, messages: [] });
		expect(fetchAround).toHaveBeenCalledWith(LINK_CHANNEL_ID, "888", 20);
	});

	it("lets the model re-request a link's message itself when the seed fetch for it failed", async () => {
		const linkTrigger: HistoryMessage = {
			...TRIGGER,
			content: `https://discord.com/channels/999/${LINK_CHANNEL_ID}/777`,
		};
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				functionCallResponse("fetch_message_history", { channel_id: LINK_CHANNEL_ID, message_id: "777" }),
			)
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		let linkSeedAttempted = false;
		const fetchAround = vi.fn(async (_channelId: string, messageId: string | null) => {
			if (messageId === "777" && !linkSeedAttempted) {
				linkSeedAttempted = true;
				throw new Error("500 Internal Server Error");
			}
			return [];
		});

		await generateReply(env, BOT, linkTrigger, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		// The failed seed never recorded its anchor, so the model's request for the same id is a
		// real fetch — not skipped as an already-fetched anchor.
		expect(fetchAround).toHaveBeenCalledWith(LINK_CHANNEL_ID, "777", 20);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("keeps the messages one link fetched when another link into the same channel fails", async () => {
		const linkTrigger: HistoryMessage = {
			...TRIGGER,
			content: `https://discord.com/channels/999/${LINK_CHANNEL_ID}/777 and https://discord.com/channels/999/${LINK_CHANNEL_ID}/778`,
		};
		const linked: HistoryMessage = {
			id: "777",
			channelId: LINK_CHANNEL_ID,
			userId: "222",
			author: { username: "bob", globalName: null },
			content: "the original message",
			date: "2023-12-31T00:00:00.000Z",
			replyToId: null,
		};
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn(async (_channelId: string, messageId: string | null) => {
			if (messageId === "778") throw new Error("500 Internal Server Error");
			return messageId === "777" ? [linked] : [];
		});

		await generateReply(env, BOT, linkTrigger, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		const payload = JSON.parse(body.contents[0].parts[0].text);
		expect(payload.channels[LINK_CHANNEL_ID].messages).toEqual([payloadMessage(linked)]);
		expect(payload.users).toHaveProperty("222");
	});

	it("still fetches a linked channel's messages when its channel-info fetch fails", async () => {
		const linkTrigger: HistoryMessage = {
			...TRIGGER,
			content: `https://discord.com/channels/999/${LINK_CHANNEL_ID}/777`,
		};
		const linked: HistoryMessage = {
			id: "777",
			channelId: LINK_CHANNEL_ID,
			userId: "222",
			author: { username: "bob", globalName: null },
			content: "the original message",
			date: "2023-12-31T00:00:00.000Z",
			replyToId: null,
		};
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const failingFetchChannel = vi.fn((id: string) =>
			id === LINK_CHANNEL_ID ? Promise.reject(new Error("500 Internal Server Error")) : Promise.resolve(CHANNEL),
		);
		const fetchAround = vi.fn(async (_channelId: string, messageId: string | null) => (messageId === "777" ? [linked] : []));

		await generateReply(env, BOT, linkTrigger, { fetchGuild, fetchChannel: failingFetchChannel, fetchAround, canReadLinkedChannel });

		// Only the name/topic is missing — the messages are still sent.
		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		const payload = JSON.parse(body.contents[0].parts[0].text);
		expect(payload.channels[LINK_CHANNEL_ID]).toEqual({ name: null, topic: null, messages: [payloadMessage(linked)] });
	});

	it("never marks the trigger's own channel inaccessible, even when a self-link would otherwise be denied", async () => {
		// A link into the trigger's own DM channel would fail canReadLinkedChannel for real (no guild_id
		// to check membership/overwrites against) — simulated here by a check that denies everything.
		const linkTrigger: HistoryMessage = {
			...TRIGGER,
			content: `https://discord.com/channels/@me/${HOME_CHANNEL_ID}/2`,
		};
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);
		const denyAll = () => Promise.resolve(false);

		await generateReply(env, BOT, linkTrigger, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel: denyAll });

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		const payload = JSON.parse(body.contents[0].parts[0].text);
		expect(payload.channels[HOME_CHANNEL_ID]).not.toHaveProperty("inaccessible");
	});

	it("treats a canReadLinkedChannel failure as a denial rather than crashing the reply", async () => {
		const linkTrigger: HistoryMessage = {
			...TRIGGER,
			content: `what's this? https://discord.com/channels/999/${LINK_CHANNEL_ID}/777`,
		};
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }),
		);
		const fetchAround = vi.fn().mockResolvedValue([]);
		const throwingCheck = () => Promise.reject(new Error("network error"));

		const reply = await generateReply(env, BOT, linkTrigger, {
			fetchGuild,
			fetchChannel,
			fetchAround,
			canReadLinkedChannel: throwingCheck,
		});

		expect(reply).toEqual({ content: "hi there", replyToMessageId: null });
		expect(fetchAround).toHaveBeenCalledTimes(1); // just the trigger's own seed fetch
	});

	it("checks access using the trigger's own author, not the bot", async () => {
		const linkTrigger: HistoryMessage = {
			...TRIGGER,
			userId: "555",
			content: `what's this? https://discord.com/channels/999/${LINK_CHANNEL_ID}/777`,
		};
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }),
		);
		const fetchAround = vi.fn().mockResolvedValue([]);
		const canReadLinkedChannelSpy = vi.fn().mockResolvedValue(true);

		await generateReply(env, BOT, linkTrigger, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel: canReadLinkedChannelSpy });

		expect(canReadLinkedChannelSpy).toHaveBeenCalledWith(LINK_CHANNEL_ID, "555");
	});

	it("checks channel access only once when multiple links point into the same channel", async () => {
		const linkTrigger: HistoryMessage = {
			...TRIGGER,
			content: `https://discord.com/channels/999/${LINK_CHANNEL_ID}/777 https://discord.com/channels/999/${LINK_CHANNEL_ID}/778`,
		};
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }),
		);
		const fetchAround = vi.fn().mockResolvedValue([]);
		const canReadLinkedChannelSpy = vi.fn().mockResolvedValue(true);

		await generateReply(env, BOT, linkTrigger, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel: canReadLinkedChannelSpy });

		// One permission check per channel, not per link — both links share LINK_CHANNEL_ID.
		expect(canReadLinkedChannelSpy).toHaveBeenCalledTimes(1);
	});

	it("merges a message link that points back into the trigger's own channel", async () => {
		const linkTrigger: HistoryMessage = { ...TRIGGER, content: `https://discord.com/channels/999/${HOME_CHANNEL_ID}/2` };
		const already: HistoryMessage = {
			id: "2",
			channelId: HOME_CHANNEL_ID,
			userId: "222",
			author: { username: "bob", globalName: null },
			content: "already known",
			date: "2023-12-31T00:00:00.000Z",
			replyToId: null,
		};
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([already]);

		await generateReply(env, BOT, linkTrigger, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		const payload = JSON.parse(body.contents[0].parts[0].text);
		// One bucket for the home channel, not a separate entry for the "linked" fetch of the same channel.
		expect(Object.keys(payload.channels)).toEqual([HOME_CHANNEL_ID]);
		expect(payload.channels[HOME_CHANNEL_ID].messages).toContainEqual(payloadMessage(already));
	});

	it("caps how many message links in one trigger get resolved", async () => {
		const links = Array.from(
			{ length: 6 },
			(_, index) => `https://discord.com/channels/999/${LINK_CHANNEL_ID}/${700 + index}`,
		).join(" ");
		const linkTrigger: HistoryMessage = { ...TRIGGER, content: links };
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }),
		);
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT, linkTrigger, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		// The trigger's own seed fetch, plus at most 3 (MAX_MESSAGE_LINKS) of the 6 links.
		expect(fetchAround).toHaveBeenCalledTimes(4);
	});

	it("lets a model-issued fetch target a channel other than the trigger's own via channel_id", async () => {
		const linkTrigger: HistoryMessage = {
			...TRIGGER,
			content: `https://discord.com/channels/999/${LINK_CHANNEL_ID}/777`,
		};
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				functionCallResponse("fetch_message_history", { channel_id: LINK_CHANNEL_ID, message_id: "888" }),
			)
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT, linkTrigger, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		expect(fetchAround).toHaveBeenCalledWith(LINK_CHANNEL_ID, "888", 20);
	});

	it("falls back to the trigger's own channel when the model's channel_id isn't one already known", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", { channel_id: "some-other-channel", message_id: "77" }))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		expect(fetchAround).toHaveBeenCalledWith(HOME_CHANNEL_ID, "77", 20);
	});

	it("omitting message_id for a known channel fetches that channel's most recent messages, not a re-fetch of the link", async () => {
		const linkTrigger: HistoryMessage = {
			...TRIGGER,
			content: `https://discord.com/channels/999/${LINK_CHANNEL_ID}/777`,
		};
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", { channel_id: LINK_CHANNEL_ID }))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT, linkTrigger, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		// The trigger's own seed fetch, the link's own seed fetch (around "777"), and a third, distinct
		// fetch for the model's own call — "most recent messages in that channel" isn't the same request
		// as "around 777", so it isn't deduped against it.
		expect(fetchAround).toHaveBeenCalledTimes(3);
		expect(fetchAround).toHaveBeenCalledWith(LINK_CHANNEL_ID, null, 20);
	});

	it("treats a model-issued fetch of an already-seeded anchor as a no-op", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", { message_id: TRIGGER.id }))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		// Once for the automatic seed fetch; the model's own (redundant) request explicitly re-asking
		// for the trigger's own id is deduped rather than fetched again.
		expect(fetchAround).toHaveBeenCalledTimes(1);
	});

	it("treats an omitted message_id as a genuinely new request, not a fallback to the trigger", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", {}))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		// The automatic seed fetch (anchored on the trigger), plus a real second fetch for "the
		// channel's most recent messages" — a different query from "around the trigger", so it isn't
		// deduped against the seed even though both concern the same channel.
		expect(fetchAround).toHaveBeenCalledTimes(2);
		expect(fetchAround).toHaveBeenCalledWith(HOME_CHANNEL_ID, null, 20);
	});

	it("gives the next call a clean, chronologically merged view with no function-call scaffolding", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", { message_id: "77" }))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const earlier: HistoryMessage = {
			id: "0",
			channelId: HOME_CHANNEL_ID,
			userId: "222",
			author: { username: "bob", globalName: null },
			content: "earlier message",
			date: "2023-12-31T00:00:00.000Z",
			replyToId: null,
		};
		// Keyed by anchor so the automatic trigger seed comes back empty and only the model's explicit
		// fetch of "77" brings "earlier" in — isolating what actually changes between the two calls.
		const fetchAround = vi.fn((_channelId: string, anchor: string | null) => Promise.resolve(anchor === "77" ? [earlier] : []));

		await generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		const secondBody = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string);
		// One plain "here's what's known" turn — no functionCall/functionResponse parts anywhere.
		expect(secondBody.contents).toHaveLength(1);
		expect(secondBody.contents[0].parts[0].functionCall).toBeUndefined();
		expect(secondBody.contents[0].parts[0].functionResponse).toBeUndefined();
		expect(JSON.parse(secondBody.contents[0].parts[0].text)).toEqual({
			guild: GUILD,
			channels: channelsOf([earlier, TRIGGER], { [HOME_CHANNEL_ID]: CHANNEL }), // chronological order
			trigger: triggerPointer(TRIGGER),
			users: usersOf(earlier, TRIGGER),
		});
	});

	it("orders same-millisecond messages by snowflake id, not by the order Discord returned them", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const sameInstant = "2024-01-02T00:00:00.000Z";
		const earlier: HistoryMessage = { ...TRIGGER, id: "1001", content: "first", date: sameInstant };
		const later: HistoryMessage = { ...TRIGGER, id: "1002", content: "second", date: sameInstant };
		// Newest first, as Discord's Get Channel Messages returns them.
		const fetchAround = vi.fn().mockResolvedValue([later, earlier]);

		await generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		const payload = JSON.parse(body.contents[0].parts[0].text);
		expect(payload.channels[HOME_CHANNEL_ID].messages.map((message: { id: string }) => message.id)).toEqual([
			TRIGGER.id,
			earlier.id,
			later.id,
		]);
	});

	it("follows a reply chain by fetching around a specific message id", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", { message_id: "77" }))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		expect(fetchAround).toHaveBeenCalledWith(HOME_CHANNEL_ID, "77", 20);
	});

	it("treats an empty message_id the same as an omitted one, not as the literal string", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", { message_id: "" }))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		// Resolves to null (the channel's most recent messages), same as omitting the argument
		// entirely — never fetched as the literal empty string.
		expect(fetchAround).toHaveBeenCalledWith(HOME_CHANNEL_ID, null, 20);
		expect(fetchAround).toHaveBeenCalledTimes(2);
	});

	it("dedupes overlapping fetches by message id", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", { message_id: TRIGGER.id }))
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", { message_id: "77" }))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const earlier: HistoryMessage = {
			id: "0",
			channelId: HOME_CHANNEL_ID,
			userId: "222",
			author: { username: "bob", globalName: null },
			content: "earlier message",
			date: "2023-12-31T00:00:00.000Z",
			replyToId: null,
		};
		// Only the "77" fetch is real — the explicit request for the trigger's own id, already
		// seeded, is a no-op and never reaches fetchAround.
		const fetchAround = vi.fn().mockResolvedValue([earlier]);

		const fetchSpy = vi.mocked(fetch);
		await generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		expect(fetchAround).toHaveBeenCalledTimes(2);
		const thirdBody = JSON.parse(fetchSpy.mock.calls[2][1]?.body as string);
		expect(JSON.parse(thirdBody.contents[0].parts[0].text).channels).toEqual(
			channelsOf([earlier, TRIGGER], { [HOME_CHANNEL_ID]: CHANNEL }),
		);
	});

	it("skips the round-trip when the model re-fetches an anchor it already asked for", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", { message_id: "77" }))
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", { message_id: "77" }))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi there", replyToMessageId: null }));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

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

		await generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		// The automatic seed fetch, plus "77" and "88".
		expect(fetchAround).toHaveBeenCalledTimes(3);
		expect(fetchAround).toHaveBeenCalledWith(HOME_CHANNEL_ID, "77", 20);
		expect(fetchAround).toHaveBeenCalledWith(HOME_CHANNEL_ID, "88", 20);
	});

	it("takes send_reply and drops fetches the model paired with it", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			multiCallResponse(
				{ name: "fetch_message_history", args: { message_id: "77" } },
				{ name: "send_reply", args: { content: "hi there", replyToMessageId: null } },
			),
		);
		const fetchAround = vi.fn().mockResolvedValue([]);

		const reply = await generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		expect(reply).toEqual({ content: "hi there", replyToMessageId: null });
		// Only the automatic seed fetch — send_reply wins outright, so the paired "77" fetch never runs.
		expect(fetchAround).toHaveBeenCalledTimes(1);
		expect(fetchAround).toHaveBeenCalledWith(HOME_CHANNEL_ID, TRIGGER.id, 50);
	});

	it("passes through a replyToMessageId that matches a known message id", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			functionCallResponse("send_reply", { content: "hi", replyToMessageId: TRIGGER.id }),
		);

		const fetchAround = vi.fn().mockResolvedValue([]);
		const reply = await generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		expect(reply).toEqual({ content: "hi", replyToMessageId: TRIGGER.id });
	});

	it("nulls out a replyToMessageId that doesn't match any known message id", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			functionCallResponse("send_reply", { content: "hi", replyToMessageId: "some-unknown-id" }),
		);

		const fetchAround = vi.fn().mockResolvedValue([]);
		const reply = await generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		expect(reply).toEqual({ content: "hi", replyToMessageId: null });
	});

	it("accepts a replyToMessageId that was learned via fetch_message_history", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(functionCallResponse("fetch_message_history", {}))
			.mockResolvedValueOnce(functionCallResponse("send_reply", { content: "hi", replyToMessageId: "0" }));
		const earlier: HistoryMessage = {
			id: "0",
			channelId: HOME_CHANNEL_ID,
			userId: "222",
			author: { username: "bob", globalName: null },
			content: "earlier message",
			date: "2023-12-31T00:00:00.000Z",
			replyToId: null,
		};
		const fetchAround = vi.fn().mockResolvedValue([earlier]);

		const reply = await generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

		expect(reply).toEqual({ content: "hi", replyToMessageId: "0" });
	});

	it("throws after exceeding the max Gemini calls without a send_reply call", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => functionCallResponse("fetch_message_history", {}));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await expect(generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel })).rejects.toThrow(/exceeded/);

		expect(fetchSpy).toHaveBeenCalledTimes(5); // MAX_GEMINI_CALLS
	});

	it("withholds fetch_message_history on the final call, forcing a conclusion", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => functionCallResponse("fetch_message_history", {}));
		const fetchAround = vi.fn().mockResolvedValue([]);

		await expect(generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel })).rejects.toThrow();

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
		await expect(generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel })).rejects.toThrow();

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
		await expect(generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel })).rejects.toThrow(
			/didn't call a function/,
		);
	});

	it("throws when send_reply is called without content", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(functionCallResponse("send_reply", { replyToMessageId: null }));

		const fetchAround = vi.fn().mockResolvedValue([]);
		await expect(generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel })).rejects.toThrow(/without content/);
	});

	it("treats whitespace-only content as no content, rather than letting Discord reject it", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			functionCallResponse("send_reply", { content: "  \n ", replyToMessageId: null }),
		);

		const fetchAround = vi.fn().mockResolvedValue([]);
		await expect(generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel })).rejects.toThrow(/without content/);
	});

	it("trims the reply content it returns", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			functionCallResponse("send_reply", { content: "  hi there\n", replyToMessageId: null }),
		);

		const fetchAround = vi.fn().mockResolvedValue([]);
		const reply = await generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel });

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
		await expect(generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel })).rejects.toThrow(
			/no content parts.*MAX_TOKENS.*SAFETY/,
		);
	});

	it("throws with response detail on failure", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad key", { status: 403 }));

		const fetchAround = vi.fn().mockResolvedValue([]);
		await expect(generateReply(env, BOT, TRIGGER, { fetchGuild, fetchChannel, fetchAround, canReadLinkedChannel })).rejects.toThrow(/403/);
	});
});
