import type { DiscordChannel, DiscordPermissionOverwrite } from "./types";

// <https://docs.discord.com/developers/topics/permissions#permissions-bitwise-permission-flags>
const VIEW_CHANNEL = 1n << 10n;
const READ_MESSAGE_HISTORY = 1n << 16n;

function hasBit(permissions: string, bit: bigint): boolean {
	return (BigInt(permissions) & bit) !== 0n;
}

/**
 * The overwrites this bot treats as governing `channel`: its own `permission_overwrites` when it has
 * any, and `parentChannel`'s only when it has none at all.
 *
 * That fallback is deliberately *not* Discord's rule: Discord has no category term at all
 * (<https://docs.discord.com/developers/topics/permissions#permission-overwrites>), and a "synced"
 * channel carries its own copy of its category's overwrites, so it never reaches the fallback
 * (<https://docs.discord.com/developers/topics/permissions#permission-syncing>). Only a channel
 * de-synced down to an empty list does — one Discord applies no restrictions to — so borrowing the
 * category's overwrites can only over-deny, never over-share.
 *
 * Shared by both exported functions so they can't disagree about which overwrites apply.
 */
function effectiveOverwrites(
	channel: DiscordChannel,
	parentChannel: DiscordChannel | null,
): readonly DiscordPermissionOverwrite[] {
	if (channel.permission_overwrites && channel.permission_overwrites.length > 0) {
		return channel.permission_overwrites;
	}
	return parentChannel?.permission_overwrites ?? [];
}

/**
 * Whether `bit` survives Discord's overwrite precedence for `userId` — the `@everyone` overwrite,
 * then the combined overwrites of every role in `userRoleIds` the channel has one for, then a
 * member-specific overwrite for `userId` — each tier able to override the one before it, matching
 * Discord's own resolution order
 * (<https://docs.discord.com/developers/topics/permissions#permission-overwrites>).
 *
 * Granted unless denied: Discord grants both bits this module checks to `@everyone` at the guild
 * level in virtually every real server, so that base case is assumed rather than fetched — see
 * `canReadChannel` below.
 */
function isGranted(
	overwrites: readonly DiscordPermissionOverwrite[],
	bit: bigint,
	guildId: string,
	userId: string,
	userRoleIds: readonly string[],
): boolean {
	let granted = true;

	const everyoneOverwrite = overwrites.find((overwrite) => overwrite.id === guildId);
	if (everyoneOverwrite) {
		if (hasBit(everyoneOverwrite.deny, bit)) granted = false;
		if (hasBit(everyoneOverwrite.allow, bit)) granted = true;
	}

	// Combined across every matching role, not applied one at a time — Discord ORs all the applicable
	// roles' deny/allow bits together first, so one role's allow can restore what another role's deny
	// took away at this same tier, and either way still overrides `@everyone` above.
	const roleOverwrites = overwrites.filter((overwrite) => overwrite.type === 0 && userRoleIds.includes(overwrite.id));
	if (roleOverwrites.some((overwrite) => hasBit(overwrite.deny, bit))) granted = false;
	if (roleOverwrites.some((overwrite) => hasBit(overwrite.allow, bit))) granted = true;

	const memberOverwrite = overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === userId);
	if (memberOverwrite) {
		if (hasBit(memberOverwrite.deny, bit)) granted = false;
		if (hasBit(memberOverwrite.allow, bit)) granted = true;
	}

	return granted;
}

/**
 * Whether `userId` — a guild member holding `userRoleIds` — can read `channel`'s messages. Both
 * VIEW_CHANNEL and READ_MESSAGE_HISTORY, resolved independently, because reading needs each: without
 * the latter, Get Channel Messages returns nothing at all
 * (<https://docs.discord.com/developers/resources/message#get-channel-messages>) — and that backlog
 * is exactly what relaying a link would hand over. Denying VIEW_CHANNEL implicitly denies the other
 * (<https://docs.discord.com/developers/topics/permissions#implicit-permissions>), so the second
 * check only ever narrows the first.
 *
 * Never fetches the member's role *permissions*, so there's no guild-level Administrator bypass — an
 * admin might be wrongly denied. That's the intended direction to be wrong in: this exists to keep the
 * bot from relaying a channel a user can't read, not to reproduce Discord's rules exactly.
 *
 * On the guild path `isAtLeastAsReadableAs` subsumes this — see there before removing either.
 */
export function canReadChannel(
	channel: DiscordChannel,
	parentChannel: DiscordChannel | null,
	userId: string,
	userRoleIds: readonly string[],
): boolean {
	const guildId = channel.guild_id;
	if (!guildId) return false; // no guild means no @everyone role or member roles to check against
	const overwrites = effectiveOverwrites(channel, parentChannel);
	return (
		isGranted(overwrites, VIEW_CHANNEL, guildId, userId, userRoleIds) &&
		isGranted(overwrites, READ_MESSAGE_HISTORY, guildId, userId, userRoleIds)
	);
}

/**
 * Whether the `@everyone` tier alone leaves `bit` granted — the outcome for a guild member named by
 * no overwrite of their own, which is what `isAtLeastAsGrantedAs` compares as its base case.
 */
function everyoneIsGranted(overwrites: readonly DiscordPermissionOverwrite[], bit: bigint, guildId: string): boolean {
	const everyoneOverwrite = overwrites.find((overwrite) => overwrite.id === guildId);
	if (!everyoneOverwrite) return true;
	if (hasBit(everyoneOverwrite.allow, bit)) return true;
	if (hasBit(everyoneOverwrite.deny, bit)) return false;
	return true;
}

/**
 * Whether `overwrites` grants `bit` to literally everyone — `@everyone` itself granted, and no role
 * or member overwrite carves out a deny. A channel like that can't exclude anyone `referenceOverwrites`
 * lets in, so it's always at least as readable, without needing the per-id comparison below at all.
 * This is the realistic "public channel linked from a private one" case: a wide-open channel usually
 * has no overwrites whatsoever, so it would otherwise fail the per-id loop for lack of an explicit
 * allow entry matching whatever role the private channel names.
 */
function grantedToEveryone(overwrites: readonly DiscordPermissionOverwrite[], bit: bigint, guildId: string): boolean {
	if (!everyoneIsGranted(overwrites, bit, guildId)) return false;
	return !overwrites.some((overwrite) => hasBit(overwrite.deny, bit));
}

/**
 * `isAtLeastAsReadableAs` for one permission bit: `overwrites` passes outright when it's granted to
 * everyone (`grantedToEveryone`); otherwise, three comparisons, each rejecting a way `overwrites`
 * could be the narrower of the two — the `@everyone` base case, an id `referenceOverwrites` grants
 * `bit` that `overwrites` doesn't, and an id `overwrites` denies it that `referenceOverwrites` doesn't.
 */
function isAtLeastAsGrantedAs(
	overwrites: readonly DiscordPermissionOverwrite[],
	referenceOverwrites: readonly DiscordPermissionOverwrite[],
	bit: bigint,
	guildId: string,
): boolean {
	if (grantedToEveryone(overwrites, bit, guildId)) return true;

	if (everyoneIsGranted(referenceOverwrites, bit, guildId) && !everyoneIsGranted(overwrites, bit, guildId)) {
		return false;
	}

	// Compared by id alone, without the `@everyone` entry the base case above already covers: a
	// snowflake identifies one role or one member, so the same id on both channels is the same viewer.
	const overwrittenIds = new Set([
		...overwrites.map((overwrite) => overwrite.id),
		...referenceOverwrites.map((overwrite) => overwrite.id),
	]);
	overwrittenIds.delete(guildId);

	for (const id of overwrittenIds) {
		const channelOverwrite = overwrites.find((overwrite) => overwrite.id === id);
		const referenceOverwrite = referenceOverwrites.find((overwrite) => overwrite.id === id);
		// Anyone the reference channel explicitly grants `bit` has to be granted it here too —
		// otherwise a role allowed into the reference channel alone could read the relayed content.
		if (referenceOverwrite && hasBit(referenceOverwrite.allow, bit)) {
			if (!channelOverwrite || !hasBit(channelOverwrite.allow, bit)) return false;
		}
		// And anyone shut out of this channel has to be shut out of the reference channel too, or the
		// relay is exactly what lets them around the denial.
		if (channelOverwrite && hasBit(channelOverwrite.deny, bit)) {
			if (!referenceOverwrite || !hasBit(referenceOverwrite.deny, bit)) return false;
		}
	}

	return true;
}

/**
 * Whether every guild member who can read `referenceChannel` can also read `channel` — i.e. relaying
 * `channel`'s content into `referenceChannel` exposes it to nobody who couldn't already read it. This
 * is the audience-wide half of the link check: a guild reply is posted for the whole channel, not
 * just whoever asked, so the asker being able to read `channel` (`canReadChannel`) isn't enough.
 *
 * Needs no Discord round-trips: a role named in neither channel's `effectiveOverwrites` resolves to
 * the `@everyone` outcome on both, so only the ids one of them names can tell them apart. Each of the
 * two bits is compared on its own — a role could be granted one on both channels and the other only
 * on the reference.
 *
 * Conservative rather than exact: Discord combines a member's roles into one tier (see `isGranted`),
 * so an id-by-id comparison can reject a pair no real combination of roles could tell apart, but it
 * can never accept one that a combination could.
 *
 * On the guild path this makes `canReadChannel` (and the roles lookup feeding it) redundant: the
 * reference channel allows nobody this one doesn't, denies nobody this one doesn't, and is no more
 * open to `@everyone` — and the asker proved they can read the reference channel by posting in it.
 * That argument only holds for audiences described by overwrites; a private thread's explicit member
 * list breaks it. Both checks are kept anyway: the redundant one costs one cached round-trip, backs up
 * this argument if it's ever outgrown, and is the only one that applies to a DM reply.
 */
export function isAtLeastAsReadableAs(
	channel: DiscordChannel,
	parentChannel: DiscordChannel | null,
	referenceChannel: DiscordChannel,
	referenceParentChannel: DiscordChannel | null,
): boolean {
	// Different guilds (or a DM on either side) means two different populations entirely — nothing
	// here can compare them, so nothing is relayed between them.
	const guildId = channel.guild_id;
	if (!guildId || !referenceChannel.guild_id) return false;
	if (guildId !== referenceChannel.guild_id) return false;

	const overwrites = effectiveOverwrites(channel, parentChannel);
	const referenceOverwrites = effectiveOverwrites(referenceChannel, referenceParentChannel);

	return (
		isAtLeastAsGrantedAs(overwrites, referenceOverwrites, VIEW_CHANNEL, guildId) &&
		isAtLeastAsGrantedAs(overwrites, referenceOverwrites, READ_MESSAGE_HISTORY, guildId)
	);
}
