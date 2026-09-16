import { extractMessageLinks, type MessageLink } from "./discord/message-links";
import { debugLog, errorMessage } from "./log-level";

const MODEL = "gemini-3.5-flash-lite";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Bounds worst-case latency/cost: the max Gemini round-trips per reply. */
const MAX_GEMINI_CALLS = 5;
/**
 * For the automatic seed fetch around the trigger itself — not model-issued.
 * Discord splits this roughly evenly before/after the anchor message; its own max is 100.
 */
const SEED_FETCH_LIMIT = 50;
/**
 * For a model-issued `fetch_message_history` call, and for the automatic fetch around the reply
 * target when the trigger is itself a reply — context around either is about equally relevant, and
 * both are kept well under SEED_FETCH_LIMIT so a model that keeps asking for more can't run up
 * latency/cost the way the free initial seed can.
 */
const TOOL_FETCH_LIMIT = 20;
/** Caps how many links (and a forward's origin) in a single trigger get resolved, so a link-spammed message can't turn into an unbounded fan-out of fetches. */
const MAX_MESSAGE_LINKS = 3;
/**
 * Discord's hard cap on message content. Not enforced locally: the model is asked to stay within it,
 * and anything longer is rejected by Discord as a failed send.
 */
const MAX_REPLY_LENGTH = 2000;

const FETCH_HISTORY_FUNCTION = "fetch_message_history";
const SEND_REPLY_FUNCTION = "send_reply";

/** A user's name info, as given to Gemini via the shared `users` map rather than repeated per message. */
export interface UserInfo {
	username: string;
	/** Discord's account-wide display name; null if the user hasn't set one, in which case Discord itself falls back to showing `username`. */
	globalName: string | null;
}

/** The original message a forward carries, as given to Gemini. Discord's copy of it has no author and no id of its own. */
export interface ForwardedMessage {
	/**
	 * Where the original lives. Resolved like a message link when this is the trigger's own forward
	 * (see `generateReply`); on a message from history it's an unresolved label.
	 */
	origin?: MessageLink;
	content: string;
	/** ISO 8601 — when the *original* was sent, which can long predate the forward. */
	date: string;
	/** As `HistoryMessage.editedDate`, for the original. */
	editedDate?: string;
	/** As `HistoryMessage.attachments`, for the original. */
	attachments?: string[];
}

/**
 * A Discord system message, as given to Gemini. Discord posts these itself rather than a person
 * writing them, so they carry no content of their own — `kind` is what happened, and `origin` is
 * the message it happened to, which still exists where it was.
 */
export interface MessageNotice {
	kind: "pinned" | "threadStarted";
	/** Where that message lives. Resolved like `ForwardedMessage.origin`, and absent on the same terms. */
	origin?: MessageLink;
}

/** A Discord message as given to Gemini. */
export interface HistoryMessage {
	id: string;
	/** Which Discord channel this message is in — messages are grouped by this in the wire payload. */
	channelId: string;
	userId: string;
	/** This message's author. Folded into the payload's shared `users` map, not repeated on the message itself. */
	author: UserInfo;
	content: string;
	/** ISO 8601 timestamp, as Discord provides it. */
	date: string;
	/** id of the message this one is a Discord reply to, or null if it isn't a reply. */
	replyToId: string | null;
	/** ISO 8601 timestamp of the message's last edit. Omitted entirely for a message never edited. */
	editedDate?: string;
	/** Filenames of files/images attached to the message. Omitted entirely when there are none. */
	attachments?: string[];
	/**
	 * The message someone forwarded, when this message is a forward. The message's own `content` is
	 * then only whatever its author wrote alongside the forward — usually empty.
	 */
	forwarded?: ForwardedMessage;
	/** What happened, when Discord posted this message itself as a notice rather than someone writing it. */
	notice?: MessageNotice;
	/**
	 * Other users `content` mentions, beyond the author — folded into `users` the same way, so a
	 * mention of someone who hasn't posted in view can still be resolved to a name.
	 */
	mentionedUsers?: Array<{ id: string } & UserInfo>;
}

/** A Discord channel's metadata, keyed by channel id in the wire payload's `channels` map. */
export interface ChannelInfo {
	name: string | null;
	topic: string | null;
}

/** The Discord guild (server) a reply is being generated for, or null for a DM (which has none). */
export interface GuildInfo {
	name: string;
	description: string | null;
}

export interface ReplyResult {
	content: string;
	replyToMessageId: string | null;
}

/** The bot's own user, so the model can recognize its own messages and mention tokens. */
export interface BotIdentity {
	id: string;
	username: string;
}

/** How `generateReply` reads Discord — passed in rather than imported, keeping REST out of this module. */
export interface DiscordReader {
	/** Null for a DM, which has no guild. */
	fetchGuild: () => Promise<GuildInfo | null>;
	fetchChannel: (channelId: string) => Promise<ChannelInfo | null>;
	/** `messageId: null` fetches the channel's most recent messages instead. */
	fetchAround: (channelId: string, messageId: string | null, limit: number) => Promise<HistoryMessage[]>;
	/**
	 * Whether a link into `channelId` may be resolved for `userId` (the trigger's author) — checked
	 * before the channel is ever fetched. Answers false for every expected denial, the bot itself
	 * not being able to see the channel included, so a throw is a genuine fault: logged, and
	 * counted as a denial.
	 */
	canReadLinkedChannel: (channelId: string, userId: string) => Promise<boolean>;
}

interface FunctionCall {
	name: string;
	args?: Record<string, unknown>;
	/** Not used — this project's calls are stateless, so there's no functionResponse to correlate it with. */
	id?: string;
}

interface ContentPart {
	text?: string;
	functionCall?: FunctionCall;
}

interface Content {
	role: "user" | "model";
	/** Optional on responses: Gemini omits it entirely when a candidate is cut short or blocked. */
	parts?: ContentPart[];
}

interface GenerateContentRequest {
	contents: Content[];
	systemInstruction: { parts: Array<{ text: string }> };
	tools: Array<{ functionDeclarations: unknown[] }>;
	toolConfig: { functionCallingConfig: { mode: "ANY" } };
}

interface UsageMetadata {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	totalTokenCount?: number;
}

interface GenerateContentResponse {
	candidates?: Array<{ content?: Content; finishReason?: string }>;
	promptFeedback?: { blockReason?: string };
	usageMetadata?: UsageMetadata;
}

const fetchHistoryDeclaration = {
	name: FETCH_HISTORY_FUNCTION,
	description:
		`Fetch up to ${TOOL_FETCH_LIMIT} messages from a channel already present in "channels". Given "message_id", centres the fetch on it (both before and after); omitted, fetches the channel's most recent messages instead. Use it to follow a reply chain, or to widen context around any message you already know about.`,
	parameters: {
		type: "object",
		properties: {
			channel_id: {
				type: "string",
				description: `Which channel (a key of "channels") to search. Omit to use "trigger.channelId".`,
			},
			message_id: {
				type: "string",
				description: `An id from that channel's "messages" to centre the fetch on. Omit to fetch the channel's most recent messages instead.`,
			},
		},
	},
};

const sendReplyDeclaration = {
	name: SEND_REPLY_FUNCTION,
	description: "Send your reply to Discord. This ends your turn.",
	parameters: {
		type: "object",
		properties: {
			content: {
				type: "string",
				// Schema's int64-format fields are strings in the JSON representation, per
				// <https://ai.google.dev/api/generate-content#schema>.
				maxLength: String(MAX_REPLY_LENGTH),
				description:
					`Your reply text. Must be at most ${MAX_REPLY_LENGTH} characters; Discord rejects longer messages. For a line break, use an actual newline character — not the two-character sequence "\\n". Avoid mentioning tool names explicitly in the message.`,
			},
			replyToMessageId: {
				type: "string",
				nullable: true,
				description:
					`An id from "trigger.channelId"'s messages (in "channels") to quote, when it isn't obvious which message you're answering — Discord renders your reply attached to it. Null to not attach to any message. An id not from that channel, or not in "messages" there, is ignored.`,
			},
		},
		required: ["content", "replyToMessageId"],
	},
};

function buildSystemInstruction(
	bot: BotIdentity,
	guild: GuildInfo | null,
	gatherTurnsLeft: number,
): { parts: Array<{ text: string }> } {
	// Only the trailing instruction differs: the 0 branch can't name the withheld tool (see callGemini).
	const inaccessibleDescription = `A "channels" entry can also be just {"inaccessible": true} — access to it was denied, so no name/topic/messages are available for it.`;
	const lines = [
		`You are "${bot.username}", a Discord bot with user id "${bot.id}". Every response must be a function call.`,
		`"trigger" is {"channelId", "messageId"} identifying the message that prompted this reply — look it up in "channels" for its content. That channel is the one you'll reply in; the remaining fields serve only as context.`,
		guild
			? '"guild" is {"name", "description"} for the Discord server this is happening in.'
			: "This conversation is in a direct message — just you and the other person.",
		'"channels" maps a Discord channel id to {"name", "topic", "messages"}: "messages" is every message you currently know from that channel, oldest first, including "trigger" itself.',
		`Any other "channels" entry is a different channel with its own separate conversation — don't assume shared context with it, and you can't reply-quote a message from it.`,
		gatherTurnsLeft > 0
			? `${inaccessibleDescription} Don't call ${FETCH_HISTORY_FUNCTION} on it again, and don't guess at what it might contain.`
			: `${inaccessibleDescription} Don't guess at what it might contain.`,
		`Each message is {"id", "userId", "content", "date", "replyToId"}: "date" is ISO 8601, and "replyToId" is the id of the message it replies to, or null if the message is not a reply. A message whose "userId" is "${bot.id}" is one you sent.`,
		`"users" maps every user id you might see — a message's "userId", or an id inside a raw "<@id>" or "<@!id>" mention token in "content" — to {"username", "globalName"}. Prefer "globalName" when it isn't null; otherwise use "username".`,
		`A message may also have "attachments": ["filename", ...] for files or images it carries. You can't view them, but you can acknowledge them.`,
		`A message may also have "editedDate" (ISO 8601) if it's been edited since it was first sent. There's no way to see what it originally said, so don't guess at the change — just be aware it happened.`,
		`A message may also have "forwarded": {"content", "date", "origin"?, "editedDate"?, "attachments"?} — its author forwarded someone else's message instead of writing it, so the message's own "content" is only what they added alongside, usually nothing, and "forwarded.content" is the text they forwarded. You don't know who wrote it. "origin" is {"channelId", "messageId"} locating the original, which you can look up in "channels" if it's there.`,
		`A message with "notice": {"kind", "origin"?} is one Discord posted itself, which is why its "content" is empty: "pinned" means "userId" pinned a message, "threadStarted" means "userId" started a thread from one (someone else may have written it). Either way "origin" is {"channelId", "messageId"} for the message it's about — look it up in "channels" if it's there.`,
	];

	// Counts down per call, so the model is told what it actually has left. At 0 the fetch tool is
	// withheld and must not be named (see callGemini).
	let guidance: string;
	if (gatherTurnsLeft > 0) {
		const budget =
			gatherTurnsLeft === 1
				? "This is your last turn to gather context."
				: `You have ${gatherTurnsLeft} turns left to gather context.`;
		guidance = `If "channels" isn't enough to answer, call ${FETCH_HISTORY_FUNCTION} — e.g. on a replyToId you want to see. ${budget} Then answer with ${SEND_REPLY_FUNCTION}. Reply naturally and concisely.`;
	} else {
		guidance = `Answer now with ${SEND_REPLY_FUNCTION}. Reply naturally and concisely.`;
	}

	return {
		parts: [
			{ text: lines.join("\n") },
			{ text: guidance },
		],
	};
}

/**
 * Every call forces a function call via `mode: "ANY"`. `gatherTurnsLeft` drives both the declared
 * tools and the system instruction from one number, so they can't disagree: at 0, `fetch_message_history`
 * is left undeclared (and unnamed in the instruction, since each call is stateless), leaving
 * `send_reply` as the only option — guaranteeing the model concludes instead of looping forever.
 */
async function callGemini(
	env: Env,
	contents: Content[],
	bot: BotIdentity,
	guild: GuildInfo | null,
	gatherTurnsLeft: number,
): Promise<GenerateContentResponse> {
	const functionDeclarations =
		gatherTurnsLeft > 0 ? [fetchHistoryDeclaration, sendReplyDeclaration] : [sendReplyDeclaration];
	const requestBody: GenerateContentRequest = {
		contents,
		systemInstruction: buildSystemInstruction(bot, guild, gatherTurnsLeft),
		tools: [{ functionDeclarations }],
		toolConfig: { functionCallingConfig: { mode: "ANY" } },
	};
	debugLog(env, () => ({ message: "Gemini request", requestBody }));
	const response = await fetch(`${API_BASE}/${MODEL}:generateContent`, {
		method: "POST",
		headers: {
			"x-goog-api-key": env.GEMINI_API_KEY,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(requestBody),
		signal: AbortSignal.timeout(60_000),
	});
	if (!response.ok) {
		throw new Error(`Gemini generateContent failed: ${response.status} ${await response.text()}`);
	}
	const data = (await response.json()) as GenerateContentResponse;
	debugLog(env, () => ({ message: "Gemini response", data }));
	return data;
}

/**
 * A `HistoryMessage` as it actually goes on the wire. `channelId`, `author` and `mentionedUsers`
 * are deliberately absent: the first groups the message in `channels`, the other two are folded into
 * `users`. Spelled out rather than derived from `HistoryMessage`, so a new field there reaches the
 * model only by being added here too — and `buildSystemInstruction` must describe whatever does.
 */
interface PayloadMessage {
	id: string;
	userId: string;
	content: string;
	date: string;
	replyToId: string | null;
	editedDate?: string;
	attachments?: string[];
	forwarded?: ForwardedMessage;
	notice?: MessageNotice;
}

function toPayloadMessage(message: HistoryMessage): PayloadMessage {
	return {
		id: message.id,
		userId: message.userId,
		content: message.content,
		date: message.date,
		replyToId: message.replyToId,
		editedDate: message.editedDate,
		attachments: message.attachments,
		forwarded: message.forwarded,
		notice: message.notice,
	};
}

/** Every user any of `messages` names — as an author or a mention — keyed by id for `content` to look up. */
function collectUsers(messages: HistoryMessage[]): Record<string, UserInfo> {
	const users: Record<string, UserInfo> = {};
	for (const message of messages) {
		users[message.userId] = message.author;
		for (const { id, ...info } of message.mentionedUsers ?? []) users[id] = info;
	}
	return users;
}

/** Builds a single fresh turn reflecting everything currently known — no function-call scaffolding. */
function buildContents(
	trigger: HistoryMessage,
	resolved: Map<string, HistoryMessage>,
	guild: GuildInfo | null,
	channelInfoById: Map<string, ChannelInfo | null>,
	inaccessibleChannelIds: Set<string>,
): Content[] {
	// Parsed rather than compared as strings, so ordering doesn't depend on Discord rendering every
	// timestamp at identical precision. Same-millisecond messages fall back to their snowflake ids,
	// which Discord assigns in order — compared by length then text, since a longer decimal is larger.
	const sorted = [...resolved.values()].sort(
		(a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id.length - b.id.length || (a.id < b.id ? -1 : 1),
	);

	/** An accessible channel's "channels" entry. An inaccessible one is exactly `{inaccessible: true}` instead — never a mix. */
	type AccessibleChannelEntry = { name: string | null; topic: string | null; messages: PayloadMessage[] };

	// Seeded from every accessible channel, not just those with messages: a linked channel that fetched
	// empty still needs an entry, or it's indistinguishable from a link the model was never shown.
	const accessibleChannels: Record<string, AccessibleChannelEntry> = {};
	for (const [channelId, info] of channelInfoById) {
		accessibleChannels[channelId] = { name: info?.name ?? null, topic: info?.topic ?? null, messages: [] };
	}
	for (const message of sorted) {
		const channel = accessibleChannels[message.channelId];
		// Only accessible channels are ever fetched, so this shouldn't drop anything; it's the safety net if it ever does.
		if (!channel) continue;
		channel.messages.push(toPayloadMessage(message));
	}
	const channels: Record<string, AccessibleChannelEntry | { inaccessible: true }> = { ...accessibleChannels };
	for (const channelId of inaccessibleChannelIds) {
		channels[channelId] = { inaccessible: true };
	}
	const payloadText = JSON.stringify({
		...(guild ? { guild } : {}),
		channels,
		trigger: { channelId: trigger.channelId, messageId: trigger.id },
		users: collectUsers(sorted),
	});

	return [{ role: "user", parts: [{ text: payloadText }] }];
}

/**
 * Turns `send_reply`'s arguments into the result handed back to the caller, rejecting empty content
 * and downgrading a reply id the model never actually saw — or one that isn't from `homeChannelId`,
 * since Discord can't reply-quote across channels.
 */
function toReplyResult(
	functionCall: FunctionCall,
	resolved: Map<string, HistoryMessage>,
	homeChannelId: string,
): ReplyResult {
	const args = functionCall.args as { content?: string; replyToMessageId?: string | null } | undefined;
	// Trimmed, so whitespace-only content is caught here rather than as a 400 from Discord, which
	// rejects an empty message body.
	const content = args?.content?.trim();
	if (!content) {
		throw new Error(`Gemini called ${SEND_REPLY_FUNCTION} without content: ${JSON.stringify(functionCall)}`);
	}
	const target = args?.replyToMessageId ? resolved.get(args.replyToMessageId) : undefined;
	const replyToMessageId = target && target.channelId === homeChannelId ? target.id : null;
	return { content, replyToMessageId };
}

/**
 * Generates a reply to `trigger`. Before the model is asked anything, the context it would almost
 * always ask for is seeded up front: the messages around the trigger, around its reply target if it's
 * a reply, and around each Discord message link in its content — the last only for channels
 * `discord.canReadLinkedChannel` clears, with a denied channel marked `inaccessible` instead. Each
 * channel's name/topic and the guild's name/description are fetched too; there are no tools for
 * those, so this is the model's only way to see them.
 *
 * From there the model can call `fetch_message_history` for more context in any accessible channel,
 * and `send_reply` once ready. Every fetched message lands in one `resolved` map, and each Gemini call
 * gets a freshly rebuilt view of it (grouped by channel in `buildContents`) rather than a growing
 * transcript of past tool calls.
 */
export async function generateReply(
	env: Env,
	bot: BotIdentity,
	trigger: HistoryMessage,
	discord: DiscordReader,
): Promise<ReplyResult> {
	const resolved = new Map<string, HistoryMessage>([[trigger.id, trigger]]);
	// Tracks every (channel, anchor) pair already fetched, so a repeat request — model-issued or a
	// coincidental rediscovery of a seed fetch — is skipped rather than costing another round-trip.
	// Channel-scoped even though a real message id alone would already be globally unique (Discord
	// snowflakes never collide across channels), since a null anchor ("most recent messages") isn't:
	// "most recent in channel A" and "most recent in channel B" are different requests.
	const fetchKey = (channelId: string, messageId: string | null) => `${channelId}:${messageId ?? ""}`;
	const fetchedAnchors = new Set<string>([fetchKey(trigger.channelId, trigger.id)]);
	// The message a forward or a notice points at is resolved exactly like a link in the content: same
	// permission check, same seed fetch. Put first, so the cap can't drop the message the trigger is
	// actually about. A message is one or the other, never both — a forward is an ordinary message.
	const links = extractMessageLinks(trigger.content);
	const triggerOrigin = trigger.forwarded?.origin ?? trigger.notice?.origin;
	if (triggerOrigin && !links.some((link) => link.messageId === triggerOrigin.messageId)) {
		links.unshift(triggerOrigin);
	}
	const candidateLinks = links.slice(0, MAX_MESSAGE_LINKS);
	// Checked per channel, not per link: saves round-trips, and two links into one channel can't get
	// different answers (e.g. from one transient failure).
	const candidateChannelIds = [...new Set(candidateLinks.map((link) => link.channelId))];
	// The guild and seed fetches don't depend on which channels pass the checks, so all three run
	// together — a single check can cost several sequential round-trips that would otherwise sit in
	// front of the seed fetch.
	const [guild, triggerAround, channelChecks] = await Promise.all([
		discord.fetchGuild(),
		discord.fetchAround(trigger.channelId, trigger.id, SEED_FETCH_LIMIT),
		Promise.all(
			candidateChannelIds.map(async (channelId) => ({
				channelId,
				// The trigger's own channel needs no check — the bot is already conversing there (and for a
				// DM, the check would always deny).
				allowed:
					channelId === trigger.channelId ||
					(await discord.canReadLinkedChannel(channelId, trigger.userId).catch((error) => {
						console.error(
							{ message: "Gemini message-link permission check failed, treating as denied", channelId, error: errorMessage(error) },
							error,
						);
						return false;
					})),
			})),
		),
	]);
	const allowedChannelIds = new Set(channelChecks.filter((check) => check.allowed).map((check) => check.channelId));
	// Only a denial makes a channel inaccessible — a fetch that fails below just leaves that data out.
	// The trigger's own channel is never in here, since it skips the check above.
	const inaccessibleChannelIds = new Set(channelChecks.filter((check) => !check.allowed).map((check) => check.channelId));
	const allowedLinks = candidateLinks.filter((link) => allowedChannelIds.has(link.channelId));
	const channelIds = [...new Set([trigger.channelId, ...allowedChannelIds])];

	// Neither kind of failure here fails the whole reply — it only leaves out what that fetch would have
	// added: a channel's name/topic, or the messages around one link.
	const [channelResults, linkResults] = await Promise.all([
		Promise.all(
			channelIds.map(async (id) => {
				try {
					return { id, info: await discord.fetchChannel(id) };
				} catch (error) {
					console.error({ message: "Gemini failed to fetch channel", channelId: id, error: errorMessage(error) }, error);
					return { id, info: null };
				}
			}),
		),
		Promise.all(
			allowedLinks.map(async (link) => {
				try {
					return { link, messages: await discord.fetchAround(link.channelId, link.messageId, 10) };
				} catch (error) {
					console.error(
						{
							message: "Gemini failed to fetch linked message",
							channelId: link.channelId,
							messageId: link.messageId,
							error: errorMessage(error),
						},
						error,
					);
					return null;
				}
			}),
		),
	]);
	const channelInfoById = new Map(channelResults.map((result) => [result.id, result.info] as const));
	for (const message of triggerAround) {
		resolved.set(message.id, message);
	}
	// A failed link fetch records no anchor, so the model can still ask for that message itself.
	for (const linkResult of linkResults) {
		if (!linkResult) continue;
		fetchedAnchors.add(fetchKey(linkResult.link.channelId, linkResult.link.messageId));
		for (const message of linkResult.messages) {
			resolved.set(message.id, message);
		}
	}

	// Verified live against Discord: `around` returns the anchor message itself, not just its
	// neighbors, so `resolved` gains the reply target's id whichever fetch below ends up supplying it.
	if (trigger.replyToId && !resolved.has(trigger.replyToId)) {
		fetchedAnchors.add(fetchKey(trigger.channelId, trigger.replyToId));
		const replyToAround = await discord.fetchAround(trigger.channelId, trigger.replyToId, TOOL_FETCH_LIMIT);
		for (const message of replyToAround) {
			resolved.set(message.id, message);
		}
	}

	for (let call = 0; call < MAX_GEMINI_CALLS; call++) {
		// Hits 0 on the final call, which is what withholds the fetch tool and forces a conclusion.
		const gatherTurnsLeft = MAX_GEMINI_CALLS - 1 - call;
		const geminiResponse = await callGemini(
			env,
			buildContents(trigger, resolved, guild, channelInfoById, inaccessibleChannelIds),
			bot,
			guild,
			gatherTurnsLeft,
		);

		console.log({
			message: "Gemini call completed",
			call,
			promptTokenCount: geminiResponse.usageMetadata?.promptTokenCount,
			candidatesTokenCount: geminiResponse.usageMetadata?.candidatesTokenCount,
			totalTokenCount: geminiResponse.usageMetadata?.totalTokenCount,
		});

		const responseCandidates = geminiResponse.candidates ?? [];
		const candidateCount = responseCandidates.length;

		if (candidateCount === 0) {
			throw new Error(`Gemini generateContent returned no candidates: ${JSON.stringify(geminiResponse)}`);
		}
		if (candidateCount !== 1) {
			console.warn({ message: "Gemini generateContent returned unexpected candidate count, using the first", candidateCount });
		}

		const responseCandidate = responseCandidates[0];
		const parts = responseCandidate.content?.parts;
		if (!parts?.length) {
			// A candidate can come back with no parts at all
			// (finishReason MAX_TOKENS/SAFETY/RECITATION, or a blocked prompt) —
			// name the reason here, or this throws an undiagnosable TypeError instead.
			throw new Error(
				`Gemini generateContent returned no content parts (finishReason: ${responseCandidate.finishReason ?? "none"}, blockReason: ${geminiResponse.promptFeedback?.blockReason ?? "none"})`,
			);
		}

		// Gemini can return several function calls in one candidate, so take every one rather than
		// the first — dropping the rest would leave the model believing it had asked for context it
		// never receives, and re-requesting it next turn.
		const functionCalls = parts.flatMap((part) => (part.functionCall ? [part.functionCall] : []));
		if (functionCalls.length === 0) {
			throw new Error(`Gemini didn't call a function despite mode "ANY": ${JSON.stringify(parts)}`);
		}

		// send_reply ends the turn, so it wins outright if the model paired it with fetches.
		const sendReply = functionCalls.find((functionCall) => functionCall.name === SEND_REPLY_FUNCTION);
		if (sendReply) {
			return toReplyResult(sendReply, resolved, trigger.channelId);
		}

		for (const functionCall of functionCalls) {
			if (functionCall.name !== FETCH_HISTORY_FUNCTION) {
				console.error({ message: "Gemini called an unknown function", functionCall });
				continue;
			}

			// Only an accessible channel already in "channels" is reachable; anything else (hallucinated,
			// unknown, inaccessible) falls back to the trigger's own channel.
			const requestedChannelId = functionCall.args?.channel_id as string | undefined;
			const channelId =
				requestedChannelId && channelIds.includes(requestedChannelId) ? requestedChannelId : trigger.channelId;
			// `|| null`, not `??`: an empty string is treated as omitted, since Discord's `around` needs a real id.
			const messageId = (functionCall.args?.message_id as string | undefined) || null;
			// Re-fetching the same (channel, anchor) pair can only return what's already in `resolved`.
			const key = fetchKey(channelId, messageId);
			if (fetchedAnchors.has(key)) {
				console.warn({ message: "Gemini re-requested an already-fetched anchor", channelId, messageId });
				continue;
			}
			fetchedAnchors.add(key);
			const around = await discord.fetchAround(channelId, messageId, TOOL_FETCH_LIMIT);
			for (const message of around) {
				resolved.set(message.id, message);
			}
		}
	}

	// Unreachable in practice: the final call only offers send_reply, so mode "ANY" forces the model
	// to call it. Kept as a defensive fallback (and to satisfy the return type) in case that ever
	// stops holding true.
	throw new Error(`Gemini exceeded ${MAX_GEMINI_CALLS} calls without calling ${SEND_REPLY_FUNCTION}`);
}
