import { extractMessageLinks } from "./discord/message-links";
import { debugLog, errorMessage } from "./log-level";

const MODEL = "gemini-3.5-flash-lite";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Bounds worst-case latency/cost: the max Gemini round-trips per reply. */
const MAX_GEMINI_CALLS = 5;
/**
 * For the automatic seed fetches (trigger, and the reply target if it's a reply) — not model-issued.
 * Discord splits this roughly evenly before/after the anchor message; 100 is Discord's own max.
 */
const SEED_FETCH_LIMIT = 100;
/**
 * For a model-issued `fetch_message_history` call, and for each Discord message-link URL resolved
 * out of the trigger's content — kept well under SEED_FETCH_LIMIT so neither a model that keeps
 * asking for more context, nor a message packed with links, can run up latency/cost the way the
 * free initial seed can.
 */
const TOOL_FETCH_LIMIT = 20;
/** Caps how many message links in a single trigger get resolved, so a link-spammed message can't turn into an unbounded fan-out of fetches. */
const MAX_MESSAGE_LINKS = 3;
/**
 * Soft cap on the JSON payload's serialized length — see `buildContents`, which drops ambient
 * context first, then the reply target/linked messages if it still doesn't fit, but never the
 * trigger itself.
 */
const MAX_PAYLOAD_CHARS = 15_000;
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

interface FunctionCall {
	name: string;
	args?: Record<string, unknown>;
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

interface GenerateContentResponse {
	candidates?: Array<{ content?: Content; finishReason?: string }>;
	promptFeedback?: { blockReason?: string };
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
					`Your reply text. Must be at most ${MAX_REPLY_LENGTH} characters; Discord rejects longer messages. For a line break, use an actual newline character — not the two-character sequence "\\n".`,
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
	botUserId: string,
	botUsername: string,
	guild: GuildInfo | null,
	gatherTurnsLeft: number,
): { parts: Array<{ text: string }> } {
	const lines: Array<string> = [
		`You are "${botUsername}", a Discord bot with user id "${botUserId}". Every response must be a function call.`,
		`"trigger" is {"channelId", "messageId"} identifying the message that prompted this reply — look it up in "channels" for its content. That channel is the one you'll reply in; the remaining fields serve only as context.`,
	];

	lines.push(
		guild
			? '"guild" is {"name", "description"} for the Discord server this is happening in.'
			: "This conversation is in a direct message — just you and the other person.",
	);

	lines.push(
		'"channels" maps a Discord channel id to {"name", "topic", "messages"}: "messages" is every message you currently know from that channel, oldest first, including "trigger" itself.',
	);

	lines.push(
		`A "channels" entry other than the one "trigger" points to came from a Discord message-link URL you were sent — a different channel with its own separate conversation, so don't assume shared context with it, and you can't reply-quote a message from it.`,
	);

	// Split so the shared description can't drift between the two branches — only the instruction that
	// follows it differs. Naming the tool is only safe while it's actually declared this call, so the
	// 0 branch leaves it out entirely — see the withheld-tool note below, which applies here too.
	const inaccessibleDescription = `A "channels" entry can also be just {"inaccessible": true} — access was denied or the fetch failed, so no name/topic/messages are available for it.`;
	lines.push(
		gatherTurnsLeft > 0
			? `${inaccessibleDescription} Don't call ${FETCH_HISTORY_FUNCTION} on it again, and don't guess at what it might contain.`
			: `${inaccessibleDescription} Don't guess at what it might contain.`,
	);

	lines.push(`Each message is {"id", "userId", "content", "date", "replyToId"}: "date" is ISO 8601, and "replyToId" is the id of the message it replies to, or null if the message is not a reply. A message whose "userId" is "${botUserId}" is one you sent.`);

	lines.push(
		`"users" maps every user id you might see — a message's "userId", or an id inside a raw "<@id>" or "<@!id>" mention token in "content" — to {"username", "globalName"}. Prefer "globalName" when it isn't null; otherwise use "username".`,
	);

	lines.push(
		`A message may also have "attachments": ["filename", ...] for files or images it carries. You can't view them, but you can acknowledge them.`,
	);

	lines.push(
		`A message may also have "editedDate" (ISO 8601) if it's been edited since it was first sent. There's no way to see what it originally said, so don't guess at the change — just be aware it happened.`,
	);

	// The budget counts down per call, so the model is told what it actually has left rather than a
	// constant it can't act on. At 0 the wording must never name the withheld tool: each call is
	// stateless, so the model on that call has never seen it declared.
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
	botUserId: string,
	botUsername: string,
	guild: GuildInfo | null,
	gatherTurnsLeft: number,
): Promise<ContentPart[]> {
	const functionDeclarations =
		gatherTurnsLeft > 0 ? [fetchHistoryDeclaration, sendReplyDeclaration] : [sendReplyDeclaration];
	const requestBody: GenerateContentRequest = {
		contents,
		systemInstruction: buildSystemInstruction(botUserId, botUsername, guild, gatherTurnsLeft),
		tools: [{ functionDeclarations }],
		toolConfig: { functionCallingConfig: { mode: "ANY" } },
	};
	debugLog(env, () => `Gemini: request ${JSON.stringify(requestBody)}`);
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
	debugLog(env, () => `Gemini: response ${JSON.stringify(data)}`);
	const candidate = data.candidates?.[0];
	// A candidate can come back with no parts at all (finishReason MAX_TOKENS/SAFETY/RECITATION, or a
	// blocked prompt) — name the reason here, or this throws an undiagnosable TypeError instead.
	if (!candidate?.content?.parts?.length) {
		throw new Error(
			`Gemini generateContent returned no content parts ` +
			`(finishReason: ${candidate?.finishReason ?? "none"}, blockReason: ${data.promptFeedback?.blockReason ?? "none"}): ` +
			JSON.stringify(data),
		);
	}
	return candidate.content.parts;
}

/** A `HistoryMessage` as it actually goes on the wire: `channelId`/`author`/`mentionedUsers` live elsewhere in the payload. */
function toPayloadMessage({ channelId: _channelId, author: _author, mentionedUsers: _mentionedUsers, ...rest }: HistoryMessage) {
	return rest;
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

/**
 * A "channels" map entry as it goes on the wire. When a channel is inaccessible, its name/topic/
 * messages are meaningless — omitted entirely rather than sent as null/empty alongside the flag.
 */
type ChannelPayloadEntry = { name: string | null; topic: string | null; messages: unknown[] } | { inaccessible: true };

/** Builds a single fresh turn reflecting everything currently known — no function-call scaffolding. */
function buildContents(
	trigger: HistoryMessage,
	resolved: Map<string, HistoryMessage>,
	guild: GuildInfo | null,
	channelInfoById: Map<string, ChannelInfo | null>,
	priorityIds: Set<string>,
	inaccessibleChannelIds: Set<string>,
): Content[] {
	// Parsed rather than compared as strings, so ordering doesn't depend on Discord rendering every
	// timestamp at identical precision.
	const messages = [...resolved.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

	// Anchors: trigger plus whichever priority ids actually resolved, grouped by channel — an ambient
	// message is only ranked against anchors in its *own* channel, never another channel's, so an
	// unrelated channel's anchor landing on a similar date can't make it look more relevant than it is.
	// Within its own channel, distance is to the *nearest* anchor, not raw date — a linked channel's own
	// local context sits close in time to that link's anchor even if the two channels' clocks read
	// totally differently (e.g. trigger's channel today, the linked channel two days ago), so this keeps
	// a linked channel's context from being wiped out purely for looking "old" next to today's
	// conversation.
	const anchorDatesByChannel = new Map<string, number[]>();
	for (const id of [trigger.id, ...priorityIds]) {
		const anchor = resolved.get(id);
		if (!anchor) continue;
		const dates = anchorDatesByChannel.get(anchor.channelId) ?? [];
		dates.push(Date.parse(anchor.date));
		anchorDatesByChannel.set(anchor.channelId, dates);
	}
	const distanceToNearestAnchor = (message: HistoryMessage) => {
		// Every channel a message can come from already has its own anchor — the trigger for its own
		// channel, or a link's own message for a linked one — so the empty-list fallback (Math.min()
		// spread over nothing is Infinity, per spec) is defensive only.
		const anchorDates = anchorDatesByChannel.get(message.channelId) ?? [];
		return Math.min(...anchorDates.map((anchorDate) => Math.abs(Date.parse(message.date) - anchorDate)));
	};

	// Everyone but the trigger, ranked from most to least droppable: ambient messages (farthest from
	// any anchor first), then `priorityIds` (the reply target and linked messages — oldest first) only
	// once every ambient message is already gone. `trigger` itself never appears here — it's always
	// kept, since the wire payload's `trigger` pointer would dangle otherwise. An id/tier pair rather
	// than a numeric score, so there's no float-precision drift to worry about over a long list.
	const droppable = messages
		.filter((message) => message.id !== trigger.id)
		.sort((a, b) => {
			const tierA = priorityIds.has(a.id) ? 1 : 0;
			const tierB = priorityIds.has(b.id) ? 1 : 0;
			if (tierA !== tierB) return tierA - tierB;
			return tierA === 0
				? distanceToNearestAnchor(b) - distanceToNearestAnchor(a)
				: Date.parse(a.date) - Date.parse(b.date);
		});

	// Serialized size only shrinks as more of `droppable`'s front (its most droppable end) is cut, so
	// binary search `dropCount` for the fewest cuts that bring it under MAX_PAYLOAD_CHARS.
	const payloadText = (dropCount: number) => {
		const droppedIds = new Set(droppable.slice(0, dropCount).map((message) => message.id));
		// Filtered from the already-chronological `messages`, not reassembled from `droppable`, so each
		// channel's messages stay oldest-first despite the drop order being tier-first. A message from an
		// inaccessible channel is dropped here too — that channel's entry omits messages entirely below,
		// whether or not some of its messages happened to resolve before it was marked inaccessible.
		const kept = messages.filter(
			(message) => !droppedIds.has(message.id) && !inaccessibleChannelIds.has(message.channelId),
		);
		// Seeded from every channel known to be accessible rather than only the ones with messages left
		// after trimming: a linked channel that fetched empty, or whose messages were all trimmed away,
		// still needs an entry. Without one it vanishes from the payload entirely — indistinguishable to
		// the model from a link it was never shown, and not at all the same claim as `inaccessible`.
		const accessibleChannels: Record<string, { name: string | null; topic: string | null; messages: unknown[] }> = {};
		for (const [channelId, info] of channelInfoById) {
			if (inaccessibleChannelIds.has(channelId)) continue;
			accessibleChannels[channelId] = { name: info?.name ?? null, topic: info?.topic ?? null, messages: [] };
		}
		for (const message of kept) {
			const channel = accessibleChannels[message.channelId];
			// Defensive only: messages are fetched from exactly the channels `channelInfoById` covers, and
			// `kept` has already dropped every inaccessible channel's.
			if (!channel) continue;
			channel.messages.push(toPayloadMessage(message));
		}
		const channels: Record<string, ChannelPayloadEntry> = { ...accessibleChannels };
		for (const channelId of inaccessibleChannelIds) {
			channels[channelId] = { inaccessible: true };
		}
		return JSON.stringify({
			...(guild ? { guild } : {}),
			channels,
			trigger: { channelId: trigger.channelId, messageId: trigger.id },
			users: collectUsers(kept),
		});
	};

	let lo = 0;
	let hi = droppable.length; // can drop everything droppable — the trigger alone is the floor
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (payloadText(mid).length <= MAX_PAYLOAD_CHARS) {
			hi = mid;
		} else {
			lo = mid + 1;
		}
	}

	return [{ role: "user", parts: [{ text: payloadText(lo) }] }];
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
 * Generates a reply to `trigger`. Before asking the model anything, the messages surrounding the
 * trigger are fetched and seeded into context — what a model would almost always ask for anyway,
 * done up front instead of costing it a turn. If the trigger is itself a reply, a second fetch
 * centred on the reply target follows, skipped when that target already turned up in the trigger's
 * own window. Any Discord message-link URL in the trigger's content is resolved the same way, in
 * whatever channel it points to — possibly not this one — but only once `canReadLinkedChannel` says
 * the trigger's own author can actually see that channel; a denied link's channel never gets fetched,
 * just marked as below. Every resolved message, regardless of channel, lands in one `resolved` map
 * keyed by id; `buildContents` groups them back out by `channelId` into the wire payload's `channels`.
 * Each channel's name/topic is fetched alongside that seeding too — there's no `fetch_guild`/
 * `fetch_channel` tool, so this is the model's only way to get them (the guild's name/description,
 * similarly, only ever covers the trigger's own guild).
 *
 * A channel a link named — whether denied outright, or whose channel-info/message fetch failed after
 * being allowed — is marked `inaccessible` in the payload rather than silently omitted, and further
 * `fetch_message_history` calls naming it fall back to the trigger's own channel instead of retrying:
 * the model needs to see that it can't be read so it doesn't keep spending turns on it.
 *
 * From there the model can call `fetch_message_history` — around a message id, or, omitted, the most
 * recent messages instead — in any channel already present in `channels`, for further context, and
 * `send_reply` once ready. Fetched messages accumulate in `resolved`, and each Gemini call gets a
 * freshly rebuilt, deduped view of it rather than an ever-growing transcript of past tool calls.
 * `fetch_message_history` is withheld on the final allowed call, forcing the model to conclude with
 * `send_reply` rather than looping forever.
 */
export async function generateReply(
	env: Env,
	botUserId: string,
	botUsername: string,
	trigger: HistoryMessage,
	fetchGuild: () => Promise<GuildInfo | null>,
	fetchChannel: (channelId: string) => Promise<ChannelInfo | null>,
	// `messageId: null` centres on nothing — fetches the channel's most recent messages instead,
	// mirroring fetch_message_history's own "omitted" semantics.
	fetchAround: (channelId: string, messageId: string | null, limit: number) => Promise<HistoryMessage[]>,
	// Whether a link into `channelId` can be resolved at all — checked before that channel is ever
	// fetched, so the bot's own broader access can't be used to relay a channel the person who asked
	// couldn't see themselves (`userId` is the trigger's own author), nor to repeat it in front of an
	// audience that couldn't. A failure to verify (thrown, or simply false) denies: erring toward not
	// resolving the link rather than risking a leak.
	canReadLinkedChannel: (channelId: string, userId: string) => Promise<boolean>,
): Promise<ReplyResult> {
	const resolved = new Map<string, HistoryMessage>([[trigger.id, trigger]]);
	// Tracks every (channel, anchor) pair already fetched, so a repeat request — model-issued or a
	// coincidental rediscovery of a seed fetch — is skipped rather than costing another round-trip.
	// Channel-scoped even though a real message id alone would already be globally unique (Discord
	// snowflakes never collide across channels), since a null anchor ("most recent messages") isn't:
	// "most recent in channel A" and "most recent in channel B" are different requests.
	const fetchKey = (channelId: string, messageId: string | null) => `${channelId}:${messageId ?? ""}`;
	const fetchedAnchors = new Set<string>([fetchKey(trigger.channelId, trigger.id)]);
	const candidateLinks = extractMessageLinks(trigger.content).slice(0, MAX_MESSAGE_LINKS);
	// The permission checks gate the channel-set-dependent batch further down, but neither the guild
	// fetch nor the trigger's own seed fetch depends on which links survive them — so all three run
	// together rather than the checks running first. A single check can cost several *sequential*
	// Discord round-trips (the linked channel, the asker's guild membership, a thread's parent and then
	// that parent's category), every one of which would otherwise sit in front of the seed fetch.
	const [guild, triggerAround, linkChecks] = await Promise.all([
		fetchGuild(),
		fetchAround(trigger.channelId, trigger.id, SEED_FETCH_LIMIT),
		Promise.all(
			candidateLinks.map(async (link) => ({
				link,
				// A link back into the trigger's own channel needs no permission check — the bot is already
				// conversing there (and, for a DM, there's no guild for canReadLinkedChannel to check against,
				// so without this it would wrongly deny a self-link every time).
				allowed:
					link.channelId === trigger.channelId ||
					(await canReadLinkedChannel(link.channelId, trigger.userId).catch(() => false)),
			})),
		),
	]);
	const links = linkChecks.filter((check) => check.allowed).map((check) => check.link);
	const deniedChannelIds = new Set(linkChecks.filter((check) => !check.allowed).map((check) => check.link.channelId));
	const channelIds = [...new Set([trigger.channelId, ...links.map((link) => link.channelId)])];
	// What the trigger is a reply to, and what it links to — see buildContents' trimming, which keeps
	// these over ambient context once the payload needs to shrink.
	const priorityIds = new Set(links.map((link) => link.messageId));
	if (trigger.replyToId) priorityIds.add(trigger.replyToId);

	// The two that genuinely needed the surviving channel set, run as one batch. A channel the bot
	// can't see (wrong guild, no permission, deleted message) shouldn't fail the whole reply — that
	// channel/link just contributes nothing, but (unlike a denied link) does still need to be flagged
	// inaccessible below, since its channelId already passed the permission check and stays reachable
	// via a model-issued channel_id.
	const [channelResults, linkResults] = await Promise.all([
		Promise.all(
			channelIds.map(async (id) => {
				try {
					return { id, info: await fetchChannel(id), failed: false };
				} catch (error) {
					console.error(`Gemini: failed to fetch channel ${id}: ${errorMessage(error)}`, error);
					return { id, info: null, failed: true };
				}
			}),
		),
		Promise.all(
			links.map(async (link) => {
				try {
					return { channelId: link.channelId, messages: await fetchAround(link.channelId, link.messageId, TOOL_FETCH_LIMIT), failed: false };
				} catch (error) {
					console.error(`Gemini: failed to fetch linked message ${link.messageId} in channel ${link.channelId}: ${errorMessage(error)}`, error);
					return { channelId: link.channelId, messages: [] as HistoryMessage[], failed: true };
				}
			}),
		),
	]);
	const channelInfoById = new Map(channelResults.map((result) => [result.id, result.info] as const));
	for (const message of triggerAround) resolved.set(message.id, message);

	for (const link of links) fetchedAnchors.add(fetchKey(link.channelId, link.messageId));
	for (const result of linkResults) {
		for (const message of result.messages) resolved.set(message.id, message);
	}

	// A channel is inaccessible if its link was denied outright, or if either its channel-info or its
	// message fetch failed after passing the permission check — except the trigger's own channel, which
	// is always resolved via the primary seed fetch above regardless of these auxiliary calls (e.g. a
	// DM self-link, or a transient failure fetching its own name/topic).
	const inaccessibleChannelIds = new Set([
		...deniedChannelIds,
		...channelResults.filter((result) => result.failed).map((result) => result.id),
		...linkResults.filter((result) => result.failed).map((result) => result.channelId),
	]);
	inaccessibleChannelIds.delete(trigger.channelId);

	// Verified live against Discord: `around` returns the anchor message itself, not just its
	// neighbors, so `resolved` gains the reply target's id whichever fetch below ends up supplying it.
	if (trigger.replyToId) {
		fetchedAnchors.add(fetchKey(trigger.channelId, trigger.replyToId));
		if (!resolved.has(trigger.replyToId)) {
			const replyToAround = await fetchAround(trigger.channelId, trigger.replyToId, SEED_FETCH_LIMIT);
			for (const message of replyToAround) resolved.set(message.id, message);
		}
	}

	for (let call = 0; call < MAX_GEMINI_CALLS; call++) {
		// Hits 0 on the final call, which is what withholds the fetch tool and forces a conclusion.
		const gatherTurnsLeft = MAX_GEMINI_CALLS - 1 - call;
		const parts = await callGemini(
			env,
			buildContents(trigger, resolved, guild, channelInfoById, priorityIds, inaccessibleChannelIds),
			botUserId,
			botUsername,
			guild,
			gatherTurnsLeft,
		);

		// Gemini can return several function calls in one candidate, so take every one rather than
		// the first — dropping the rest would leave the model believing it had asked for context it
		// never receives, and re-requesting it next turn.
		const functionCalls = parts.flatMap((part) => (part.functionCall ? [part.functionCall] : []));
		if (functionCalls.length === 0) {
			throw new Error(`Gemini didn't call a function despite mode "ANY": ${JSON.stringify(parts)}`);
		}

		// send_reply ends the turn, so it wins outright if the model paired it with fetches.
		const sendReply = functionCalls.find((functionCall) => functionCall.name === SEND_REPLY_FUNCTION);
		if (sendReply) return toReplyResult(sendReply, resolved, trigger.channelId);

		// Checked before any fetch runs, so an unrecognised call can't leave a Discord round-trip
		// behind on its way out.
		const unknownCall = functionCalls.find((functionCall) => functionCall.name !== FETCH_HISTORY_FUNCTION);
		if (unknownCall) {
			throw new Error(`Gemini called an unknown function: ${JSON.stringify(unknownCall)}`);
		}

		for (const functionCall of functionCalls) {
			// Only a channel already introduced via "channels" is reachable — a hallucinated or
			// otherwise unknown id falls back to the trigger's own channel rather than reaching
			// somewhere the model was never actually shown. An inaccessible channel falls back the same
			// way: retrying it would just repeat the same failure.
			const requestedChannelId = functionCall.args?.channel_id as string | undefined;
			const channelId =
				requestedChannelId && channelIds.includes(requestedChannelId) && !inaccessibleChannelIds.has(requestedChannelId)
					? requestedChannelId
					: trigger.channelId;
			// `|| null`, not `??`: an empty string (rather than actually omitting the argument) is
			// treated the same as omitted — Discord's `around` REST param needs a real id, so there's no
			// other sensible value to pass through. null itself means "no anchor" — see fetchAround.
			const messageId = (functionCall.args?.message_id as string | undefined) || null;
			// Re-fetching the same (channel, anchor) pair can only return what's already in `resolved` —
			// skip the round-trip. The final call withholds this tool, so a model that keeps re-asking
			// still terminates.
			const key = fetchKey(channelId, messageId);
			if (fetchedAnchors.has(key)) continue;
			fetchedAnchors.add(key);
			const around = await fetchAround(channelId, messageId, TOOL_FETCH_LIMIT);
			for (const message of around) resolved.set(message.id, message);
		}
	}

	// Unreachable in practice: the final call only offers send_reply, so mode "ANY" forces the model
	// to call it. Kept as a defensive fallback (and to satisfy the return type) in case that ever
	// stops holding true.
	throw new Error(`Gemini exceeded ${MAX_GEMINI_CALLS} calls without calling ${SEND_REPLY_FUNCTION}`);
}
