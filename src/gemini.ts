import { debugLog } from "./log-level";

const MODEL = "gemini-3.5-flash-lite";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Caps worst-case latency/cost: bounds the total number of Gemini round-trips per reply. */
const MAX_GEMINI_CALLS = 6;
/** Discord splits this roughly evenly before/after the anchor message. */
const AROUND_FETCH_LIMIT = 10;
/**
 * Discord's hard cap on message content. Not enforced locally: the model is asked to stay under it,
 * and anything longer is rejected by Discord as a failed send.
 */
const MAX_REPLY_LENGTH = 2000;

const FETCH_HISTORY_FUNCTION = "fetch_message_history";
const SEND_REPLY_FUNCTION = "send_reply";

/** A Discord message as given to Gemini. */
export interface HistoryMessage {
	id: string;
	user: string;
	userId: string;
	content: string;
	/** ISO 8601 timestamp, as Discord provides it. */
	date: string;
	/** id of the message this one is a Discord reply to, or null if it isn't a reply. */
	replyToId: string | null;
}

export interface ReplyResult {
	content: string;
	replyToMessageId: string | null;
}

interface ContentPart {
	text?: string;
	functionCall?: { name: string; args?: Record<string, unknown> };
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
		`Fetch up to ${AROUND_FETCH_LIMIT} messages surrounding a message id — both before and after it. ` +
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
				description: `Your reply text. Must be under ${MAX_REPLY_LENGTH} characters; Discord rejects longer messages.`,
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
	gatherTurnsLeft: number,
): { parts: Array<{ text: string }> } {
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
			{
				text: `You are "${botUsername}", a Discord bot with user id "${botUserId}". Every response must be a function call.

Each turn you receive JSON of the shape {"trigger", "messages"}.
- "trigger" is the message addressed to you. Reply to it, whatever else "messages" contains.
- "messages" is every message you currently know, oldest first, including "trigger".

Each message is {"id", "user", "userId", "content", "date", "replyToId"}: "user" is a display name, "date" is ISO 8601, and "replyToId" is the id of the message it replies to, or null if the message is not a reply. A message whose "userId" is "${botUserId}" is one you sent.

"content" may contain raw mention tokens like <@userId> or <@!userId>. Match the id against "userId" in "messages" to see who is meant.`,
			},
			{ text: guidance },
		],
	};
}

/**
 * Every call forces a function call via `mode: "ANY"`. `gatherTurnsLeft` is how many turns still
 * offer `fetch_message_history`; at 0 it isn't declared at all (and the system instruction adjusts
 * to match, without naming it), leaving `send_reply` as the only function the model can call — which
 * is what guarantees it concludes instead of looping on fetches forever. One number drives both the
 * tool list and the instruction, so they can't disagree.
 */
async function callGemini(
	env: Env,
	contents: Content[],
	botUserId: string,
	botUsername: string,
	gatherTurnsLeft: number,
): Promise<ContentPart[]> {
	const functionDeclarations =
		gatherTurnsLeft > 0 ? [fetchHistoryDeclaration, sendReplyDeclaration] : [sendReplyDeclaration];
	const requestBody: GenerateContentRequest = {
		contents,
		systemInstruction: buildSystemInstruction(botUserId, botUsername, gatherTurnsLeft),
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
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		throw new Error(`Gemini generateContent failed: ${response.status} ${await response.text()}`);
	}
	const data = (await response.json()) as GenerateContentResponse;
	debugLog(env, () => `Gemini: response ${JSON.stringify(data)}`);
	const candidate = data.candidates?.[0];
	// A candidate can come back with no parts at all (finishReason MAX_TOKENS/SAFETY/RECITATION, or a
	// blocked prompt). Naming the reason here is the difference between a diagnosable log line and a
	// bare TypeError from reading .parts of undefined.
	if (!candidate?.content?.parts?.length) {
		throw new Error(
			`Gemini generateContent returned no content parts ` +
			`(finishReason: ${candidate?.finishReason ?? "none"}, blockReason: ${data.promptFeedback?.blockReason ?? "none"}): ` +
			JSON.stringify(data),
		);
	}
	return candidate.content.parts;
}

/** Builds a single fresh turn reflecting everything currently known — no function-call scaffolding. */
function buildContents(trigger: HistoryMessage, resolved: Map<string, HistoryMessage>): Content[] {
	// Parsed rather than compared as strings, so ordering doesn't depend on Discord rendering every
	// timestamp at identical precision.
	const messages = [...resolved.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
	// The full trigger message, not just its id — no lookup into a (possibly large) list required
	// to know what's actually being responded to.
	return [{ role: "user", parts: [{ text: JSON.stringify({ trigger, messages }) }] }];
}

/**
 * Generates a reply to `trigger`. The model calls `fetch_message_history` (around a message id) to
 * pull in more context and `send_reply` once ready; fetched messages accumulate in a resolved map
 * keyed by id, and each Gemini call is given a freshly rebuilt, deduped, chronological view of that
 * map rather than an ever-growing transcript of past tool calls. `fetch_message_history` is
 * withheld on the final allowed call, forcing the model to conclude with `send_reply` rather than
 * looping on fetches and never answering.
 */
export async function generateReply(
	env: Env,
	botUserId: string,
	botUsername: string,
	trigger: HistoryMessage,
	fetchAround: (messageId: string, limit: number) => Promise<HistoryMessage[]>,
): Promise<ReplyResult> {
	const resolved = new Map<string, HistoryMessage>([[trigger.id, trigger]]);
	const fetchedAnchors = new Set<string>();

	for (let call = 0; call < MAX_GEMINI_CALLS; call++) {
		// Hits 0 on the final call, which is what withholds the fetch tool and forces a conclusion.
		const gatherTurnsLeft = MAX_GEMINI_CALLS - 1 - call;
		const parts = await callGemini(env, buildContents(trigger, resolved), botUserId, botUsername, gatherTurnsLeft);

		const functionCall = parts.find((part) => part.functionCall)?.functionCall;
		if (!functionCall) {
			throw new Error(`Gemini didn't call a function despite mode "ANY": ${JSON.stringify(parts)}`);
		}

		switch (functionCall.name) {
			case SEND_REPLY_FUNCTION: {
				const args = functionCall.args as { content?: string; replyToMessageId?: string | null } | undefined;
				// Trimmed, so whitespace-only content is caught here rather than as a 400 from Discord,
				// which rejects an empty message body.
				const content = args?.content?.trim();
				if (!content) {
					throw new Error(`Gemini called ${SEND_REPLY_FUNCTION} without content: ${JSON.stringify(functionCall)}`);
				}
				// Only ever reply to a message id this call actually resolved — never trust an
				// unverified id straight from the model (hallucinated or misremembered).
				const replyToMessageId =
					args?.replyToMessageId && resolved.has(args.replyToMessageId) ? args.replyToMessageId : null;
				return { content, replyToMessageId };
			}
			case FETCH_HISTORY_FUNCTION: {
				// `||`, not `??`: also falls back to trigger.id if the model passes an empty string
				// instead of omitting the argument.
				const messageId = (functionCall.args?.message_id as string | undefined) || trigger.id;
				// Re-fetching an anchor can only return what's already in `resolved`, so skip the
				// Discord round-trip. The final call withholds this tool, so a model that keeps
				// asking for the same anchor still terminates.
				if (fetchedAnchors.has(messageId)) break;
				fetchedAnchors.add(messageId);
				const around = await fetchAround(messageId, AROUND_FETCH_LIMIT);
				for (const message of around) resolved.set(message.id, message);
				break;
			}
			default:
				throw new Error(`Gemini called an unknown function: ${JSON.stringify(functionCall)}`);
		}
	}

	// Unreachable in practice: the final call only offers send_reply, so mode "ANY" forces the model
	// to call it. Kept as a defensive fallback (and to satisfy the return type) in case that ever
	// stops holding true.
	throw new Error(`Gemini exceeded ${MAX_GEMINI_CALLS} calls without calling ${SEND_REPLY_FUNCTION}`);
}
