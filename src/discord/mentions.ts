import type { MessageCreateDispatchData } from "./gateway-types";

/** Whether a message @-mentions the given user id. */
export function mentionsUser(message: MessageCreateDispatchData, userId: string): boolean {
	return message.mentions.some((mention) => mention.id === userId);
}

/** Strips every `<@id>` / `<@!id>` mention token for the given user id out of the content, trimmed. */
export function stripMention(content: string, userId: string): string {
	const pattern = new RegExp(`<@!?${userId}>`, "g");
	return content
		.replace(pattern, "")
		.replace(/\s+/g, " ")
		.trim();
}
