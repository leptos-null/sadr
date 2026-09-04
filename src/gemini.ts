import { debugLog } from "./log-level";

const MODEL = "gemini-3.5-flash-lite";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Caps worst-case latency/cost: bounds the total number of Gemini round-trips per reply. */
const MAX_GEMINI_CALLS = 6;
/** Discord splits this roughly evenly before/after the anchor message. */
const AROUND_FETCH_LIMIT = 10;

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
	parts: ContentPart[];
}

interface GenerateContentRequest {
	contents: Content[];
	systemInstruction: { parts: Array<{ text: string }> };
	tools: Array<{ functionDeclarations: unknown[] }>;
	toolConfig: { functionCallingConfig: { mode: "ANY" } };
}

interface GenerateContentResponse {
	candidates?: Array<{ content?: Content }>;
}

const fetchHistoryDeclaration = {
	name: FETCH_HISTORY_FUNCTION,
	description:
		"Fetch nearby messages from this Discord channel around a specific message id — both earlier and later messages. Useful for general context (pass the trigger message's id) or to follow a reply chain (pass a replyToId you want to see in full). Fetched messages are merged into what you already know, so it's safe to call this more than once.",
	parameters: {
		type: "object",
		properties: {
			message_id: {
				type: "string",
				description: "Fetch messages from around this message id. Omit to fetch more context around the trigger message.",
			},
		},
	},
};

const sendReplyDeclaration = {
	name: SEND_REPLY_FUNCTION,
	description: "Send your final reply to Discord. Call this once you're ready to answer.",
	parameters: {
		type: "object",
		properties: {
			content: { type: "string", description: "The reply text to send to Discord." },
			replyToMessageId: {
				type: "string",
				nullable: true,
				description:
					"The id of a specific message to reply to (Discord will show your message as a reply/quote of it) when directly responding to or quoting that message helps disambiguate what you're addressing. Null for a plain message.",
			},
		},
		required: ["content", "replyToMessageId"],
	},
};

function buildSystemInstruction(botUserId: string, botUsername: string): { parts: Array<{ text: string }> } {
	return {
		parts: [
			{
				text: `You are a Discord bot named "${botUsername}" (your Discord user id is "${botUserId}"), replying to messages. Every response you give must be a function call.

You're given JSON of the shape {"trigger", "messages"}. "trigger" is the complete message that addressed you — that is what you're responding to, regardless of anything else in "messages". "messages" is every message currently known to you (including trigger itself), in chronological order, each shaped {"id", "user", "userId", "content", "date", "replyToId"}. replyToId is set when a message is itself a Discord reply to another message. If a message's "userId" is "${botUserId}", that's a message you sent yourself. Message content may contain raw Discord mention tokens like <@userId> or <@!userId> — cross-reference the id against "userId" in "messages" to know who's being mentioned.

If that context isn't enough to reply well, call ${FETCH_HISTORY_FUNCTION} to pull in nearby messages — e.g. a replyToId you want to see, or more context around trigger.id. Newly fetched messages are merged into "messages" on your next turn.

Once you have enough context, call ${SEND_REPLY_FUNCTION} with your reply text. Reply naturally and concisely.`,
			},
		],
	};
}

/** Every call has the same shape — both tools are always offered, and the model must always call one. */
async function callGemini(
	env: Env,
	contents: Content[],
	systemInstruction: { parts: Array<{ text: string }> },
): Promise<Content> {
	const requestBody: GenerateContentRequest = {
		contents,
		systemInstruction,
		tools: [{ functionDeclarations: [fetchHistoryDeclaration, sendReplyDeclaration] }],
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
	const content = data.candidates?.[0]?.content;
	if (!content) {
		throw new Error(`Gemini generateContent returned no candidate: ${JSON.stringify(data)}`);
	}
	return content;
}

/** Builds a single fresh turn reflecting everything currently known — no function-call scaffolding. */
function buildContents(trigger: HistoryMessage, resolved: Map<string, HistoryMessage>): Content[] {
	const messages = [...resolved.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	// The full trigger message, not just its id — no lookup into a (possibly large) list required
	// to know what's actually being responded to.
	return [{ role: "user", parts: [{ text: JSON.stringify({ trigger, messages }) }] }];
}

/**
 * Generates a reply to `trigger`. The model calls `fetch_message_history` (around a message id) to
 * pull in more context and `send_reply` once ready; fetched messages accumulate in a resolved map
 * keyed by id, and each Gemini call is given a freshly rebuilt, deduped, chronological view of that
 * map rather than an ever-growing transcript of past tool calls.
 */
export async function generateReply(
	env: Env,
	botUserId: string,
	botUsername: string,
	trigger: HistoryMessage,
	fetchAround: (messageId: string, limit: number) => Promise<HistoryMessage[]>,
): Promise<ReplyResult> {
	const resolved = new Map<string, HistoryMessage>([[trigger.id, trigger]]);
	const systemInstruction = buildSystemInstruction(botUserId, botUsername);

	for (let call = 0; call < MAX_GEMINI_CALLS; call++) {
		const modelTurn = await callGemini(env, buildContents(trigger, resolved), systemInstruction);

		const functionCall = modelTurn.parts.find((part) => part.functionCall)?.functionCall;
		if (!functionCall) {
			throw new Error(`Gemini didn't call a function despite mode "ANY": ${JSON.stringify(modelTurn)}`);
		}

		switch (functionCall.name) {
			case SEND_REPLY_FUNCTION: {
				const args = functionCall.args as { content?: string; replyToMessageId?: string | null } | undefined;
				if (!args?.content) {
					throw new Error(`Gemini called ${SEND_REPLY_FUNCTION} without content: ${JSON.stringify(functionCall)}`);
				}
				// Only ever reply to a message id this call actually resolved — never trust an
				// unverified id straight from the model (hallucinated or misremembered).
				const replyToMessageId =
					args.replyToMessageId && resolved.has(args.replyToMessageId) ? args.replyToMessageId : null;
				return { content: args.content, replyToMessageId };
			}
			case FETCH_HISTORY_FUNCTION: {
				// `||`, not `??`: also falls back to trigger.id if the model passes an empty string
				// instead of omitting the argument.
				const messageId = (functionCall.args?.message_id as string | undefined) || trigger.id;
				const around = await fetchAround(messageId, AROUND_FETCH_LIMIT);
				for (const message of around) resolved.set(message.id, message);
				break;
			}
			default:
				throw new Error(`Gemini called an unknown function: ${JSON.stringify(functionCall)}`);
		}
	}

	throw new Error(`Gemini exceeded ${MAX_GEMINI_CALLS} calls without calling ${SEND_REPLY_FUNCTION}`);
}
