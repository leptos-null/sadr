/**
 * Discord entities as this bot consumes them. The same user and the same message both arrive over
 * the Gateway and over REST, so their common fields are described once here and extended per source
 * rather than restated per transport. Only fields this bot actually reads are modelled.
 */

export interface DiscordUser {
	id: string;
	username: string;
	/** Discord's account-wide display name; null (or absent) when unset, in which case Discord itself falls back to showing `username`. */
	global_name?: string | null;
	/** Discord sends this on both transports; only the Gateway path reads it, to ignore other bots. */
	bot?: boolean;
}

/**
 * A role- or member-specific permission overwrite on a channel.
 * <https://docs.discord.com/developers/resources/channel#overwrite-object>
 */
export interface DiscordPermissionOverwrite {
	/** A role id, or (when `type` is 1) a member id. The `@everyone` role's id always equals the guild's own id. */
	id: string;
	/** 0 = role, 1 = member. */
	type: 0 | 1;
	/** Permission bitfields, as decimal strings (too wide for a safe `number`) — parse with `BigInt`. */
	allow: string;
	deny: string;
}

/**
 * The <https://docs.discord.com/developers/resources/channel#channel-object-channel-types> this bot
 * distinguishes. Only the thread types are listed: everything else this bot handles identically, and
 * a thread is the one shape whose permissions don't live on the channel object it arrives as.
 */
export const ChannelType = {
	AnnouncementThread: 10,
	PublicThread: 11,
	PrivateThread: 12,
} as const;

/**
 * Whether `channel` is a thread — meaning its `permission_overwrites` are empty and its `parent_id`
 * points at the text/forum channel it was created in (not a category), whose permissions it inherits.
 * <https://docs.discord.com/developers/topics/threads#thread-fields>
 */
export function isThread(channel: DiscordChannel): boolean {
	return (
		channel.type === ChannelType.AnnouncementThread ||
		channel.type === ChannelType.PublicThread ||
		channel.type === ChannelType.PrivateThread
	);
}

/** <https://docs.discord.com/developers/resources/channel#channel-object>; only the fields this bot reads. */
export interface DiscordChannel {
	id: string;
	/** Compare against `ChannelType` for the few this bot distinguishes. Deliberately not narrowed to those — Discord sends plenty of types this bot doesn't model, which is also why `ChannelType` has no matching type alias. */
	type: number;
	/** Absent for a DM channel; present (though possibly null) for a guild channel or group DM. */
	name?: string | null;
	/** Only guild text/announcement/forum/media channels carry this; absent for DMs, and possibly null if unset. */
	topic?: string | null;
	/** The guild this channel belongs to. Absent for a DM channel — the one signal that it is one. */
	guild_id?: string;
	/** For an ordinary channel, the category it belongs to, if any. For a thread this is instead the text/forum channel it was created in, so its category is one further hop up. What, if anything, a channel takes from its `parent_id` when resolving permissions is `effectiveOverwrites`' call, not Discord's — see that function. */
	parent_id?: string | null;
	permission_overwrites?: DiscordPermissionOverwrite[];
}

/** <https://docs.discord.com/developers/resources/guild#guild-object>; only the fields this bot reads. */
export interface DiscordGuild {
	name: string;
	/** Always present in the payload, though frequently null when no description is set. */
	description: string | null;
}

/** <https://docs.discord.com/developers/resources/guild#guild-member-object>; only the fields this bot reads. */
export interface DiscordGuildMember {
	/** Role ids the member holds — the implicit `@everyone` role is never included here. */
	roles: string[];
}

/**
 * <https://docs.discord.com/developers/resources/channel#thread-member-object>; this bot only reads
 * whether the object exists at all, so only the two fields Discord always sends are declared (`id`
 * and `user_id` are omitted on the copies inside a GUILD_CREATE dispatch).
 */
export interface DiscordThreadMember {
	/** ISO 8601 — when the user last joined the thread. */
	join_timestamp: string;
	/** Notification settings; nothing here reads them. */
	flags: number;
}

export interface DiscordAttachment {
	filename: string;
	url: string;
}

export interface DiscordMessage {
	id: string;
	/** Always present on both transports. */
	channel_id: string;
	content: string;
	/** ISO 8601, as Discord provides it. */
	timestamp: string;
	author: DiscordUser;
	/** Present when this message is a Discord reply to another message. */
	message_reference?: { message_id?: string };
	/** Files/images the message carries. Always sent as an array (possibly empty) by Discord. */
	attachments?: DiscordAttachment[];
	/** Users mentioned in `content`; Discord resolves this itself, independent of who's actually posted. */
	mentions?: DiscordUser[];
	/** ISO 8601, or null if the message has never been edited. */
	edited_timestamp?: string | null;
}
