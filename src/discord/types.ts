/**
 * Discord entities as this bot consumes them. The same user and the same message both arrive over
 * the Gateway and over REST, so their common fields are described once here and extended per source
 * rather than restated per transport. Only fields this bot actually reads are modelled.
 */

export interface DiscordUser {
	id: string;
	username: string;
	/** Discord sends this on both transports; only the Gateway path reads it, to ignore other bots. */
	bot?: boolean;
}

export interface DiscordMessage {
	id: string;
	content: string;
	/** ISO 8601, as Discord provides it. */
	timestamp: string;
	author: DiscordUser;
	/** Present when this message is a Discord reply to another message. */
	message_reference?: { message_id?: string };
}
