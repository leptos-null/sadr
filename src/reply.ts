import {
	DiscordApiError,
	getChannel,
	getChannelMessages,
	getGuild,
	getGuildMember,
	getThreadMember,
	sendMessage,
	triggerTyping,
} from "./discord/rest";
import type { MessageCreateDispatchData } from "./discord/gateway-types";
import { canReadChannel, isAtLeastAsReadableAs } from "./discord/permissions";
import {
	ChannelType,
	isThread,
	MessageType,
	type DiscordChannel,
	type DiscordGuild,
	type DiscordGuildMember,
	type DiscordMessage,
	type DiscordUser,
} from "./discord/types";
import {
	generateReply,
	type BotIdentity,
	type ChannelInfo,
	type DiscordReader,
	type ForwardedMessage,
	type GuildInfo,
	type HistoryMessage,
	type UserInfo,
} from "./gemini";
import { errorMessage } from "./log-level";

// Discord's typing indicator only lasts ~10s; refreshed comfortably before it expires so it stays
// up for the whole time a reply is being generated (generateReply can take multiple Gemini calls).
const TYPING_REFRESH_MS = 8_000;

/** Sent to the user when generating or delivering a real reply failed — silence is worse. */
const FALLBACK_REPLY = "Sorry — something went wrong while I was working on a reply. Mind trying again?";

/** As `toHistoryMessage`, for a single Discord user's name info. */
function toUserInfo(user: DiscordUser): UserInfo {
	return { username: user.username, globalName: user.global_name ?? null };
}

/** As `toHistoryMessage`, for the original a forward carries — nothing for a message that isn't one. */
function toForwardedMessage(message: DiscordMessage): ForwardedMessage | undefined {
	const snapshot = message.message_snapshots?.[0]?.message;
	if (!snapshot) return undefined;
	// Only a forward has a snapshot, so its reference is the original's location, not a reply target.
	const reference = message.message_reference;
	return {
		origin:
			reference?.channel_id && reference.message_id
				? { channelId: reference.channel_id, messageId: reference.message_id }
				: undefined,
		content: snapshot.content,
		date: snapshot.timestamp,
		editedDate: snapshot.edited_timestamp ?? undefined,
		attachments: snapshot.attachments?.length ? snapshot.attachments.map((attachment) => attachment.filename) : undefined,
	};
}

/**
 * Everyone a message mentions, deduped. A forward's snapshot carries its own `mentions` while the
 * outer array is empty (verified live), so both are merged; otherwise a `<@id>` in forwarded content
 * resolves to nothing.
 */
function toMentionedUsers(message: DiscordMessage): Array<{ id: string } & UserInfo> | undefined {
	const mentioned = new Map<string, { id: string } & UserInfo>();
	for (const user of [...(message.mentions ?? []), ...(message.message_snapshots?.[0]?.message.mentions ?? [])]) {
		mentioned.set(user.id, { id: user.id, ...toUserInfo(user) });
	}
	return mentioned.size ? [...mentioned.values()] : undefined;
}

/** Maps either transport's message shape — both extend `DiscordMessage` — to what Gemini is given. */
export function toHistoryMessage(message: DiscordMessage): HistoryMessage {
	return {
		id: message.id,
		channelId: message.channel_id,
		userId: message.author.id,
		author: toUserInfo(message.author),
		content: message.content,
		date: message.timestamp,
		// Only a reply's reference is a reply target — see `DiscordMessage.message_reference`.
		replyToId: message.type === MessageType.Reply ? (message.message_reference?.message_id ?? null) : null,
		editedDate: message.edited_timestamp ?? undefined,
		attachments: message.attachments?.length ? message.attachments.map((attachment) => attachment.filename) : undefined,
		mentionedUsers: toMentionedUsers(message),
		forwarded: toForwardedMessage(message),
	};
}

/** As `toHistoryMessage`, for the channel metadata Gemini is given. */
function toChannelInfo(channel: DiscordChannel): ChannelInfo {
	return { name: channel.name ?? null, topic: channel.topic ?? null };
}

/** As `toHistoryMessage`, for the guild metadata Gemini is given. */
function toGuildInfo(guild: DiscordGuild): GuildInfo {
	return { name: guild.name, description: guild.description };
}

/**
 * Generates a reply to `message` — already known to be addressed to `bot` — and posts it, with the
 * typing indicator up meanwhile. Never throws: any failure posts FALLBACK_REPLY instead.
 */
export async function replyToMessage(env: Env, bot: BotIdentity, message: MessageCreateDispatchData): Promise<void> {
	const stopTyping = startTyping(env, message.channel_id);
	try {
		const reply = await generateReply(env, bot, toHistoryMessage(message), createDiscordReader(env, message));
		console.log({ message: "Reply generated, sending to channel", channelId: message.channel_id });
		await sendMessage(env, message.channel_id, reply.content, reply.replyToMessageId);
	} catch (error) {
		// Whoever addressed the bot can't tell silence from "still thinking", so always say
		// something back — but never let the fallback's own failure escape past this log.
		console.error(
			{ message: "Reply failed, sending fallback", messageId: message.id, error: errorMessage(error) },
			error,
		);
		await sendMessage(env, message.channel_id, FALLBACK_REPLY, message.id).catch((fallbackError) =>
			console.error(
				{ message: "Reply fallback also failed", error: errorMessage(fallbackError) },
				fallbackError,
			),
		);
	} finally {
		stopTyping();
	}
}

/** The Discord reads `generateReply` makes while replying to `message`, message-link permission check included. */
function createDiscordReader(env: Env, message: MessageCreateDispatchData): DiscordReader {
	// Both caches are scoped to this one reply, so nothing is assumed fresh across replies, and
	// hold the in-flight promise rather than the settled value: the permission checks run
	// concurrently, and caching only settled values would let them all race past an empty
	// cache. memberCache: links into the same guild look the asker up once. channelCache: the
	// permission check and generateReply's channel-info fetch share one REST call per channel.
	const memberCache = new Map<string, Promise<DiscordGuildMember | null>>();
	const channelCache = new Map<string, Promise<DiscordChannel>>();
	const getChannelCached = (channelId: string): Promise<DiscordChannel> => {
		let channelPromise = channelCache.get(channelId);
		if (!channelPromise) {
			channelPromise = getChannel(env, channelId);
			channelCache.set(channelId, channelPromise);
		}
		return channelPromise;
	};
	// The channel whose overwrites actually govern `channel` — itself, or for a thread its parent
	// (see `DiscordChannel.parent_id`), since a thread has none of its own and would otherwise
	// read as world-visible — paired with that channel's category. Null for a thread with no
	// parent: nothing to check against, so nothing is relayed. Neither fetch swallows a failure:
	// a missing category would quietly turn `effectiveOverwrites`' over-denial into no
	// restriction at all, past both checks. A throw denies the link instead.
	const governingChannels = async (
		channel: DiscordChannel,
	): Promise<{ governing: DiscordChannel; category: DiscordChannel | null } | null> => {
		let governing = channel;
		if (isThread(channel)) {
			if (!channel.parent_id) return null;
			governing = await getChannelCached(channel.parent_id);
		}
		const category = governing.parent_id ? await getChannelCached(governing.parent_id) : null;
		return { governing, category };
	};

	return {
		// A DM has no guild to fetch.
		fetchGuild: async () => (message.guild_id ? toGuildInfo(await getGuild(env, message.guild_id)) : null),
		fetchChannel: async (channelId) => {
			// A DM home channel is known to have no name/topic; a linked channel always gets a real call.
			if (channelId === message.channel_id && !message.guild_id) return null;
			return toChannelInfo(await getChannelCached(channelId));
		},
		fetchAround: async (channelId, messageId, limit) => {
			const around = await getChannelMessages(env, channelId, { around: messageId, limit });
			return around.map(toHistoryMessage);
		},
		canReadLinkedChannel: async (channelId, userId) => {
			try {
				const channel = await getChannelCached(channelId);
				// A link into a DM is never resolved: there's no membership/overwrite model to check it against.
				if (!channel.guild_id) return false;
				// A private thread's audience is an explicit member list, never as wide as a channel's, so
				// it's never relayed into a guild reply — decided here, before paying for the round-trips below.
				if (message.guild_id && channel.type === ChannelType.PrivateThread) return false;
				const memberCacheKey = `${channel.guild_id}:${userId}`;
				let memberPromise = memberCache.get(memberCacheKey);
				if (!memberPromise) {
					memberPromise = getGuildMember(env, channel.guild_id, userId);
					memberCache.set(memberCacheKey, memberPromise);
				}
				const member = await memberPromise;
				if (!member) return false;
				const linked = await governingChannels(channel);
				if (!linked) return false;
				if (!canReadChannel(linked.governing, linked.category, userId, member.roles)) return false;
				// Reading the parent isn't enough for a private thread: the asker must also be a member, and
				// vice versa (see getThreadMember). Only reachable for a DM reply; the guild case returned above.
				if (channel.type === ChannelType.PrivateThread) {
					const threadMember = await getThreadMember(env, channel.id, userId);
					if (!threadMember) return false;
				}
				// A DM reply's only audience is the asker, already cleared above. A guild reply's is the
				// whole home channel, so the linked channel must be no narrower (see isAtLeastAsReadableAs).
				if (!message.guild_id) return true;
				const home = await governingChannels(await getChannelCached(message.channel_id));
				if (!home) return false;
				// A home channel that's itself a thread gets compared as its parent channel, i.e. as
				// a wider audience than it really has. That over-denies rather than over-shares.
				return isAtLeastAsReadableAs(linked.governing, linked.category, home.governing, home.category);
			} catch (error) {
				// A channel (or its parent/category) the bot itself can't see — 403 Missing Access, or
				// 404 Unknown Channel when the bot isn't in that guild — is an ordinary denial, not a fault.
				// The member lookups already answer null for a 404, so in practice these come from getChannel.
				if (error instanceof DiscordApiError && (error.status === 403 || error.status === 404)) {
					return false;
				}
				throw error;
			}
		},
	};
}

/**
 * Starts Discord's typing indicator and keeps refreshing it until the returned callback is
 * called. A single failed refresh is logged and skipped rather than aborting the loop — the next
 * tick tries again, and a reply is still coming either way.
 */
function startTyping(env: Env, channelId: string): () => void {
	const fire = () =>
		triggerTyping(env, channelId).catch((error) =>
			console.warn({ message: "Reply typing indicator failed", error: errorMessage(error) }),
		);
	fire();
	const intervalId = setInterval(fire, TYPING_REFRESH_MS);
	return () => clearInterval(intervalId);
}
