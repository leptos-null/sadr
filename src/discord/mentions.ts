import type { MessageCreateDispatchData } from "./gateway-types";

/** Whether a message @-mentions the given user id. */
export function mentionsUser(message: MessageCreateDispatchData, userId: string): boolean {
	return message.mentions.some((mention) => mention.id === userId);
}

/** Whether the bot should treat this message as directed at it: any DM, or an @-mention in a guild channel. */
export function isAddressedToBot(message: MessageCreateDispatchData, botUserId: string): boolean {
	const isDirectMessage = !message.guild_id;
	return isDirectMessage || mentionsUser(message, botUserId);
}
