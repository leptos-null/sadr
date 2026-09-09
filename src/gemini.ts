import { debugLog } from "./log-level";

const MODEL = "gemini-3.5-flash-lite";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Bounds worst-case latency/cost: the max Gemini round-trips per reply. */
const MAX_GEMINI_CALLS = 5;
/**
 * For the automatic seed fetches (trigger and, if it's a reply, the reply target) — not model-issued.
 * Discord splits this roughly evenly before/after the anchor message; 100 is Discord's own max.
 */
const SEED_FETCH_LIMIT = 100;
/** For a model-issued `fetch_message_history` call — kept well under SEED_FETCH_LIMIT so a model that
 *  keeps asking for more context can't run up latency/cost the way the free initial seed can. */
const TOOL_FETCH_LIMIT = 20;
/**
 * Soft cap on the JSON payload's serialized length — see `buildContents`, which drops the oldest
 * messages first until it fits, or only the newest message is left. Not a hard guarantee: `trigger`
 * is always sent as its own payload field regardless, but that one message alone (with its own
 * attachments/mentions) could still exceed this.
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

/** The Discord channel a reply is being generated for, null for a DM. Topic alone can also be null, for a channel with none set. */
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
		`Fetch up to ${TOOL_FETCH_LIMIT} messages surrounding a message id — both before and after it. ` +
		`Use it to follow a reply chain, or to widen context around the trigger. Fetch each id at most once.`,
	parameters: {
		type: "object",
		properties: {
			message_id: {
				type: "string",
				description: `An id from "messages" to centre the fetch on. Omit to centre on the trigger message.`,
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
					`Your reply text. Must be at most ${MAX_REPLY_LENGTH} characters; Discord rejects longer messages. ` +
					`For a line break, use an actual newline character — not the two-character sequence "\\n".`,
			},
			replyToMessageId: {
				type: "string",
				nullable: true,
				description:
					`An id from "messages" to quote, when it isn't obvious which message you're answering — Discord ` +
					`renders your reply attached to it. Null for a plain message. An id not in "messages" is ignored.`,
			},
		},
		required: ["content", "replyToMessageId"],
	},
};

function buildSystemInstruction(
	botUserId: string,
	botUsername: string,
	guild: GuildInfo | null,
	channel: ChannelInfo | null,
	gatherTurnsLeft: number,
): { parts: Array<{ text: string }> } {
	const lines: Array<string> = [
		`You are "${botUsername}", a Discord bot with user id "${botUserId}". Every response must be a function call.`,
		'"trigger" is the request made to you. The remaining fields serve only as context.',
	];

	if (guild) {
		lines.push('"guild" is {"name", "description"} for the Discord server this is happening in.');
	}

	lines.push(
		channel
			? '"channel" is {"name", "topic"} for the Discord channel this is happening in.'
			: "This conversation is in a direct message — just you and the other person.",
	);

	lines.push('"messages" is every message you currently know, oldest first, including "trigger".');

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
		guidance = `If "messages" isn't enough to answer, call ${FETCH_HISTORY_FUNCTION} — e.g. on a replyToId you want to see. ${budget} Then answer with ${SEND_REPLY_FUNCTION}. Reply naturally and concisely.`;
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
	channel: ChannelInfo | null,
	gatherTurnsLeft: number,
): Promise<ContentPart[]> {
	const functionDeclarations =
		gatherTurnsLeft > 0 ? [fetchHistoryDeclaration, sendReplyDeclaration] : [sendReplyDeclaration];
	const requestBody: GenerateContentRequest = {
		contents,
		systemInstruction: buildSystemInstruction(botUserId, botUsername, guild, channel, gatherTurnsLeft),
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

/** A `HistoryMessage` as it actually goes on the wire: `author`/`mentionedUsers` live in `users` instead. */
function toPayloadMessage({ author: _author, mentionedUsers: _mentionedUsers, ...rest }: HistoryMessage) {
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

/** Builds a single fresh turn reflecting everything currently known — no function-call scaffolding. */
function buildContents(
	trigger: HistoryMessage,
	resolved: Map<string, HistoryMessage>,
	guild: GuildInfo | null,
	channel: ChannelInfo | null,
): Content[] {
	// Parsed rather than compared as strings, so ordering doesn't depend on Discord rendering every
	// timestamp at identical precision.
	const messages = [...resolved.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

	// Serialized size only shrinks as more of the oldest messages are cut from the front, so binary
	// search `dropCount` for the fewest cuts that bring it under MAX_PAYLOAD_CHARS (see that constant).
	const payloadText = (dropCount: number) => {
		const kept = messages.slice(dropCount);
		return JSON.stringify({
			...(guild ? { guild } : {}),
			...(channel ? { channel } : {}),
			// The full trigger message, not just its id — no lookup into a (possibly large) list
			// required to know what's actually being responded to.
			trigger: toPayloadMessage(trigger),
			messages: kept.map(toPayloadMessage),
			users: collectUsers(kept),
		});
	};
	let lo = 0;
	let hi = messages.length - 1; // always keep at least the newest message
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
 * and downgrading a reply id the model never actually saw.
 */
function toReplyResult(functionCall: FunctionCall, resolved: Map<string, HistoryMessage>): ReplyResult {
	const args = functionCall.args as { content?: string; replyToMessageId?: string | null } | undefined;
	// Trimmed, so whitespace-only content is caught here rather than as a 400 from Discord, which
	// rejects an empty message body.
	const content = args?.content?.trim();
	if (!content) {
		throw new Error(`Gemini called ${SEND_REPLY_FUNCTION} without content: ${JSON.stringify(functionCall)}`);
	}
	// Only ever reply to a message id this call actually resolved — never trust an unverified id
	// straight from the model (hallucinated or misremembered).
	const replyToMessageId = args?.replyToMessageId && resolved.has(args.replyToMessageId) ? args.replyToMessageId : null;
	return { content, replyToMessageId };
}

/**
 * Generates a reply to `trigger`. Before asking the model anything, the messages surrounding the
 * trigger are fetched and seeded into context — what a model would almost always ask for anyway,
 * done up front instead of costing it a turn. If the trigger is itself a reply, a second fetch
 * centred on the reply target follows, skipped when that target already turned up in the trigger's
 * own window. The guild's name/description and the channel's name/topic (both null for a DM) are
 * fetched alongside that seeding too — there's no `fetch_guild`/`fetch_channel` tool, so this is the
 * model's only way to get them.
 *
 * From there the model can call `fetch_message_history` (around a message id) for further context
 * and `send_reply` once ready. Fetched messages accumulate in a resolved map keyed by id, and each
 * Gemini call gets a freshly rebuilt, deduped, chronological view of that map rather than an
 * ever-growing transcript of past tool calls. `fetch_message_history` is withheld on the final
 * allowed call, forcing the model to conclude with `send_reply` rather than looping forever.
 */
export async function generateReply(
	env: Env,
	botUserId: string,
	botUsername: string,
	trigger: HistoryMessage,
	fetchGuild: () => Promise<GuildInfo | null>,
	fetchChannel: () => Promise<ChannelInfo | null>,
	fetchAround: (messageId: string, limit: number) => Promise<HistoryMessage[]>,
): Promise<ReplyResult> {
	const resolved = new Map<string, HistoryMessage>([[trigger.id, trigger]]);
	const fetchedAnchors = new Set<string>([trigger.id]);

	// Run alongside the trigger's seed fetch, not after, so neither adds its own round-trip latency.
	const [guild, channel, triggerAround] = await Promise.all([
		fetchGuild(),
		fetchChannel(),
		fetchAround(trigger.id, SEED_FETCH_LIMIT),
	]);
	for (const message of triggerAround) resolved.set(message.id, message);

	// Verified live against Discord: `around` returns the anchor message itself, not just its
	// neighbors, so `resolved` gains the reply target's id whichever fetch below ends up supplying it.
	if (trigger.replyToId) {
		fetchedAnchors.add(trigger.replyToId);
		if (!resolved.has(trigger.replyToId)) {
			const replyToAround = await fetchAround(trigger.replyToId, SEED_FETCH_LIMIT);
			for (const message of replyToAround) resolved.set(message.id, message);
		}
	}

	for (let call = 0; call < MAX_GEMINI_CALLS; call++) {
		// Hits 0 on the final call, which is what withholds the fetch tool and forces a conclusion.
		const gatherTurnsLeft = MAX_GEMINI_CALLS - 1 - call;
		const parts = await callGemini(
			env,
			buildContents(trigger, resolved, guild, channel),
			botUserId,
			botUsername,
			guild,
			channel,
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
		if (sendReply) return toReplyResult(sendReply, resolved);

		// Checked before any fetch runs, so an unrecognised call can't leave a Discord round-trip
		// behind on its way out.
		const unknownCall = functionCalls.find((functionCall) => functionCall.name !== FETCH_HISTORY_FUNCTION);
		if (unknownCall) {
			throw new Error(`Gemini called an unknown function: ${JSON.stringify(unknownCall)}`);
		}

		for (const functionCall of functionCalls) {
			// `||`, not `??`: also falls back to trigger.id if the model passes an empty string
			// instead of omitting the argument.
			const messageId = (functionCall.args?.message_id as string | undefined) || trigger.id;
			// Re-fetching an anchor can only return what's already in `resolved` — skip the round-trip.
			// The final call withholds this tool, so a model that keeps re-asking still terminates.
			if (fetchedAnchors.has(messageId)) continue;
			fetchedAnchors.add(messageId);
			const around = await fetchAround(messageId, TOOL_FETCH_LIMIT);
			for (const message of around) resolved.set(message.id, message);
		}
	}

	// Unreachable in practice: the final call only offers send_reply, so mode "ANY" forces the model
	// to call it. Kept as a defensive fallback (and to satisfy the return type) in case that ever
	// stops holding true.
	throw new Error(`Gemini exceeded ${MAX_GEMINI_CALLS} calls without calling ${SEND_REPLY_FUNCTION}`);
}
