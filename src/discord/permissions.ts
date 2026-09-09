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
 * That fallback is deliberately *not* Discord's own rule. Discord computes a channel's permissions
 * from that channel's overwrite list and nothing else — there is no category term in the calculation
 * (<https://docs.discord.com/developers/topics/permissions#permission-overwrites>). A channel that
 * looks like it inherits from its category is "synced": it carries its own copy of the category's
 * overwrites, so it never reaches this fallback at all
 * (<https://docs.discord.com/developers/topics/permissions#permission-syncing>). What does reach it
 * is a channel de-synced down to an empty list — one Discord itself applies no restrictions to. So
 * borrowing the category's overwrites there can only invent a restriction Discord wouldn't, never
 * drop one it would: the same direction everything else here errs in, over-denying rather than
 * over-sharing.
 *
 * Shared by both exported functions deliberately: they compare readability against each other, so a
 * disagreement about which overwrites apply would make one contradict the other.
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
 * VIEW_CHANNEL and READ_MESSAGE_HISTORY, resolved independently, because they are independent bits
 * and reading needs each: without the latter, Get Channel Messages returns nothing at all
 * (<https://docs.discord.com/developers/resources/message#get-channel-messages>). Seeing a channel
 * without being able to read its backlog is an ordinary server setup, and that backlog is exactly
 * what relaying a link would hand over. Denying VIEW_CHANNEL implicitly denies the other
 * (<https://docs.discord.com/developers/topics/permissions#implicit-permissions>), so the second
 * check only ever narrows the first.
 *
 * Which overwrites apply — `channel`'s own, or its category's — is `effectiveOverwrites` above.
 *
 * Deliberately not full permission resolution: this never fetches the member's role *permissions*, so
 * it can't know about a guild-level Administrator bypass (which ignores channel overwrites entirely)
 * — an admin who should see everything might still be treated as denied here. That's the intended,
 * safer direction to be wrong in — this exists to keep the bot from relaying a channel a user can't
 * read, not to perfectly reproduce Discord's own rules.
 *
 * Only load-bearing on its own for a DM: `isAtLeastAsReadableAs` below is strictly stronger wherever
 * it applies, and a guild reply runs both. See that function for why the redundant one is kept.
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
 * `isAtLeastAsReadableAs` for one permission bit: three comparisons, each rejecting a way
 * `overwrites` could be the narrower of the two — the `@everyone` base case, an id
 * `referenceOverwrites` grants `bit` that `overwrites` doesn't, and an id `overwrites` denies it
 * that `referenceOverwrites` doesn't.
 */
function isAtLeastAsGrantedAs(
	overwrites: readonly DiscordPermissionOverwrite[],
	referenceOverwrites: readonly DiscordPermissionOverwrite[],
	bit: bigint,
	guildId: string,
): boolean {
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
 * `channel`'s content into `referenceChannel` exposes it to nobody who couldn't already read it.
 *
 * `canReadChannel` above answers a different question: whether *one* person can read a channel. That
 * isn't enough on its own for a guild reply, because the reply is posted for the whole channel to
 * read, not just whoever asked — someone with access to a private channel could otherwise get the
 * bot to repeat its contents somewhere everyone can see. This is that second, audience-wide half.
 *
 * Answered without any extra Discord round-trips, by comparing the two channels' `effectiveOverwrites`
 * directly: a role named in neither channel's overwrites resolves to the `@everyone` outcome on both,
 * so only the ids one of them actually names can distinguish the two, and the guild's full role list
 * is never needed. Each of the two bits `canReadChannel` requires is compared on its own, which is
 * stronger than comparing the pair together — a role could be granted one on both channels and the
 * other on only the reference.
 *
 * Deliberately conservative rather than exact. Discord resolves a member's roles as a combined tier
 * (see `isGranted`), so an id-by-id comparison can reject a pair that no *actual* combination of
 * roles could tell apart — but it can never accept one that a combination could, which is the half
 * that matters. Same direction to be wrong in as `canReadChannel`'s missing Administrator bypass.
 *
 * Strong enough that it makes `canReadChannel` — and the `getGuildMember` roles lookup feeding it —
 * redundant on the guild path, which is worth knowing before anyone tries to simplify one away.
 * Passing every comparison means the reference channel allows nobody this one doesn't, denies nobody
 * this one doesn't already deny, and is no more open to `@everyone`; the asker, meanwhile, has proven
 * they can read the reference channel by posting the message that triggered this. So whichever tier
 * let them read the reference channel carries over to this one, and checking them individually can
 * only reach the same answer. That argument covers exactly the comparisons `isAtLeastAsGrantedAs`
 * makes and no others — a channel whose audience isn't described by overwrites at all (a private
 * thread, whose members are an explicit list) would break it, so it has to be re-made, not assumed,
 * if one is added.
 *
 * Both checks are kept anyway. The redundant one costs a single already-cached round-trip, and it's
 * the only thing standing behind that argument if it's ever quietly outgrown — and, unlike this
 * function, it still applies when the reply is going to a DM, where there's no audience to compare
 * against and no `guild_id` here to compare with.
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
