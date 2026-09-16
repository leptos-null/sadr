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
 * Whether `channel` is a thread — one with no `permission_overwrites` of its own, inheriting its
 * parent channel's (see `parent_id`). <https://docs.discord.com/developers/topics/threads#thread-fields>
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
	/** For an ordinary channel, the category it belongs to, if any. For a thread, the text/forum channel it was created in — so its category is one further hop up. */
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

/**
 * The <https://docs.discord.com/developers/resources/message#message-object-message-types> this bot
 * distinguishes. `Reply` is the only one whose `message_reference` is a reply target (see below); the
 * other two are system notices whose reference is the message they're about.
 */
export const MessageType = {
	ChannelPinnedMessage: 6,
	Reply: 19,
	/**
	 * A thread's first message, pointing back at the message it was started from. Verified live: its
	 * `author` is whoever started the thread, not that message's author, and its `channel_id` is the
	 * thread — which Discord gives the same id as the message it was started from, while
	 * `message_reference.channel_id` is the parent channel that message is in.
	 */
	ThreadStarterMessage: 21,
} as const;

/**
 * What a message says, shared by a whole message and by a forward's copy of one (`message_snapshots`,
 * which carries this subset and notably no `id` or `author`).
 */
export interface DiscordMessageCore {
	/** Compare against `MessageType`. On a forward's copy this is the *original* message's type. */
	type: number;
	content: string;
	/** ISO 8601, as Discord provides it. */
	timestamp: string;
	/** ISO 8601, or null if the message has never been edited. */
	edited_timestamp?: string | null;
	/** Files/images the message carries. Always sent as an array (possibly empty) by Discord. */
	attachments?: DiscordAttachment[];
	/** Users mentioned in `content`; Discord resolves this itself, independent of who's actually posted. */
	mentions?: DiscordUser[];
}

export interface DiscordMessage extends DiscordMessageCore {
	id: string;
	/** Always present on both transports. */
	channel_id: string;
	author: DiscordUser;
	/**
	 * Generic attribution, not reply-only: replies (`type` 19), pin notices (6), thread starters
	 * (21), crossposts and forwards all carry one, and only a reply's points at a message in this
	 * same channel. For a forward, it locates the original of `message_snapshots[0]`.
	 * <https://docs.discord.com/developers/resources/message#message-reference-content-attribution>
	 */
	message_reference?: { type?: number; message_id?: string; channel_id?: string; guild_id?: string };
	/**
	 * A forward's immutable copy of the original. Discord currently sends at most one.
	 * <https://docs.discord.com/developers/resources/message#message-snapshot-structure>
	 */
	message_snapshots?: Array<{ message: DiscordMessageCore }>;
}
