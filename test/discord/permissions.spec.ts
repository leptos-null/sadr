import { describe, it, expect } from "vitest";
import { canReadChannel, isAtLeastAsReadableAs } from "../../src/discord/permissions";
import type { DiscordChannel } from "../../src/discord/types";

const GUILD_ID = "111";
const USER_ID = "555";

/** `type: 0` is GUILD_TEXT — an ordinary channel, which is what every case here is unless overridden. */
function channel(overrides: Partial<DiscordChannel> = {}): DiscordChannel {
	return { id: "222", type: 0, guild_id: GUILD_ID, ...overrides };
}

describe("canReadChannel", () => {
	it("is true when the channel has no permission overwrites at all", () => {
		expect(canReadChannel(channel(), null, USER_ID, [])).toBe(true);
	});

	it("is true when @everyone's own overwrite doesn't deny VIEW_CHANNEL", () => {
		const withOverwrite = channel({
			permission_overwrites: [{ id: GUILD_ID, type: 0, allow: "1024", deny: "0" }],
		});

		expect(canReadChannel(withOverwrite, null, USER_ID, [])).toBe(true);
	});

	it("is false when @everyone's own overwrite denies VIEW_CHANNEL", () => {
		const restricted = channel({
			permission_overwrites: [{ id: GUILD_ID, type: 0, allow: "0", deny: "1024" }],
		});

		expect(canReadChannel(restricted, null, USER_ID, [])).toBe(false);
	});

	it("ignores another member's member-specific overwrite when deciding this user's visibility", () => {
		const memberOnly = channel({
			// Some other member (not this user), denied — irrelevant here.
			permission_overwrites: [{ id: "999", type: 1, allow: "0", deny: "1024" }],
		});

		expect(canReadChannel(memberOnly, null, USER_ID, [])).toBe(true);
	});

	it("is false for a DM channel (no guild_id, so no @everyone role exists)", () => {
		expect(canReadChannel(channel({ guild_id: undefined }), null, USER_ID, [])).toBe(false);
	});

	it("falls back to the parent category's overwrites when the channel has none of its own", () => {
		const restrictedParent = channel({
			id: "333",
			permission_overwrites: [{ id: GUILD_ID, type: 0, allow: "0", deny: "1024" }],
		});
		const child = channel({ id: "222", parent_id: "333" });

		expect(canReadChannel(child, restrictedParent, USER_ID, [])).toBe(false);
	});

	it("uses only the channel's own overwrites, never the parent's, once the channel has any of its own", () => {
		const restrictedParent = channel({
			id: "333",
			permission_overwrites: [{ id: GUILD_ID, type: 0, allow: "0", deny: "1024" }],
		});
		const openChild = channel({
			id: "222",
			parent_id: "333",
			permission_overwrites: [{ id: GUILD_ID, type: 0, allow: "1024", deny: "0" }],
		});

		expect(canReadChannel(openChild, restrictedParent, USER_ID, [])).toBe(true);
	});

	// The gap this function used to have: @everyone isn't denied, but a role the user actually holds
	// is — a real, common Discord setup (a channel hidden from one role without touching @everyone).
	it("is false when @everyone is allowed but a role the user holds is denied", () => {
		const roleRestricted = channel({
			permission_overwrites: [
				{ id: GUILD_ID, type: 0, allow: "1024", deny: "0" },
				{ id: "role-1", type: 0, allow: "0", deny: "1024" },
			],
		});

		expect(canReadChannel(roleRestricted, null, USER_ID, ["role-1"])).toBe(false);
	});

	it("is true when @everyone is denied but a role the user holds is allowed", () => {
		const roleAllowed = channel({
			permission_overwrites: [
				{ id: GUILD_ID, type: 0, allow: "0", deny: "1024" },
				{ id: "role-1", type: 0, allow: "1024", deny: "0" },
			],
		});

		expect(canReadChannel(roleAllowed, null, USER_ID, ["role-1"])).toBe(true);
	});

	it("ignores a role overwrite for a role the user doesn't hold", () => {
		const roleRestricted = channel({
			permission_overwrites: [{ id: "role-1", type: 0, allow: "0", deny: "1024" }],
		});

		expect(canReadChannel(roleRestricted, null, USER_ID, ["role-2"])).toBe(true);
	});

	it("combines every role the user holds: one role's allow beats another role's deny at the same tier", () => {
		const mixedRoles = channel({
			permission_overwrites: [
				{ id: "role-1", type: 0, allow: "0", deny: "1024" },
				{ id: "role-2", type: 0, allow: "1024", deny: "0" },
			],
		});

		expect(canReadChannel(mixedRoles, null, USER_ID, ["role-1", "role-2"])).toBe(true);
	});

	it("lets a member-specific overwrite override every role the user holds", () => {
		const memberDenied = channel({
			permission_overwrites: [
				{ id: "role-1", type: 0, allow: "1024", deny: "0" },
				{ id: USER_ID, type: 1, allow: "0", deny: "1024" },
			],
		});

		expect(canReadChannel(memberDenied, null, USER_ID, ["role-1"])).toBe(false);
	});

	it("lets a member-specific overwrite re-grant access a role denied", () => {
		const memberAllowed = channel({
			permission_overwrites: [
				{ id: "role-1", type: 0, allow: "0", deny: "1024" },
				{ id: USER_ID, type: 1, allow: "1024", deny: "0" },
			],
		});

		expect(canReadChannel(memberAllowed, null, USER_ID, ["role-1"])).toBe(true);
	});

	// Seeing a channel and being able to read its backlog are separate bits. A user denied only
	// READ_MESSAGE_HISTORY ("1024" allowed, "65536" denied) sees the channel in their sidebar but gets
	// nothing back from Get Channel Messages — so the bot must not fetch that backlog on their behalf.
	it("is false when VIEW_CHANNEL is allowed but @everyone is denied READ_MESSAGE_HISTORY", () => {
		const noHistory = channel({
			permission_overwrites: [{ id: GUILD_ID, type: 0, allow: "1024", deny: "65536" }],
		});

		expect(canReadChannel(noHistory, null, USER_ID, [])).toBe(false);
	});

	it("is false when a role the user holds is denied READ_MESSAGE_HISTORY", () => {
		const roleNoHistory = channel({
			permission_overwrites: [{ id: "role-1", type: 0, allow: "0", deny: "65536" }],
		});

		expect(canReadChannel(roleNoHistory, null, USER_ID, ["role-1"])).toBe(false);
	});

	it("resolves the two bits independently: a role re-granting only VIEW_CHANNEL isn't enough", () => {
		const historyStillDenied = channel({
			permission_overwrites: [
				{ id: GUILD_ID, type: 0, allow: "0", deny: "66560" }, // both bits denied to @everyone
				{ id: "role-1", type: 0, allow: "1024", deny: "0" }, // ...but only VIEW_CHANNEL restored
			],
		});

		expect(canReadChannel(historyStillDenied, null, USER_ID, ["role-1"])).toBe(false);
		expect(canReadChannel(historyStillDenied, null, USER_ID, ["role-1", "role-2"])).toBe(false);
	});

	it("is true once a role restores both bits", () => {
		const bothRestored = channel({
			permission_overwrites: [
				{ id: GUILD_ID, type: 0, allow: "0", deny: "66560" },
				{ id: "role-1", type: 0, allow: "66560", deny: "0" },
			],
		});

		expect(canReadChannel(bothRestored, null, USER_ID, ["role-1"])).toBe(true);
	});

	it("ignores a READ_MESSAGE_HISTORY denial aimed at a role the user doesn't hold", () => {
		const otherRoleDenied = channel({
			permission_overwrites: [{ id: "role-1", type: 0, allow: "0", deny: "65536" }],
		});

		expect(canReadChannel(otherRoleDenied, null, USER_ID, ["role-2"])).toBe(true);
	});
});

/** A second channel in the same guild — the one a reply would be posted into. */
function homeChannel(overrides: Partial<DiscordChannel> = {}): DiscordChannel {
	return { id: "333", type: 0, guild_id: GUILD_ID, ...overrides };
}

describe("isAtLeastAsReadableAs", () => {
	it("is true when neither channel has any overwrites", () => {
		expect(isAtLeastAsReadableAs(channel(), null, homeChannel(), null)).toBe(true);
	});

	it("is false for a channel hidden from @everyone relayed into one that isn't", () => {
		const hidden = channel({
			permission_overwrites: [{ id: GUILD_ID, type: 0, allow: "0", deny: "1024" }],
		});

		expect(isAtLeastAsReadableAs(hidden, null, homeChannel(), null)).toBe(false);
	});

	it("is true when both channels are hidden from @everyone and opened to the same role", () => {
		const overwrites = [
			{ id: GUILD_ID, type: 0 as const, allow: "0", deny: "1024" },
			{ id: "role-1", type: 0 as const, allow: "1024", deny: "0" },
		];

		expect(
			isAtLeastAsReadableAs(channel({ permission_overwrites: overwrites }), null, homeChannel({ permission_overwrites: overwrites }), null),
		).toBe(true);
	});

	it("is true relaying a public channel into a private one — a narrower audience is fine", () => {
		const hiddenHome = homeChannel({
			permission_overwrites: [{ id: GUILD_ID, type: 0, allow: "0", deny: "1024" }],
		});

		expect(isAtLeastAsReadableAs(channel(), null, hiddenHome, null)).toBe(true);
	});

	// A private home: @everyone denied, opened back up to one role. Shared by the two tests below.
	const staffOnly = homeChannel({
		permission_overwrites: [
			{ id: GUILD_ID, type: 0, allow: "0", deny: "1024" },
			{ id: "role-1", type: 0, allow: "1024", deny: "0" },
		],
	});

	// The realistic version of the "public into private" case above: the private home isn't just
	// @everyone-denied, it also opens itself to one role. The linked channel has no overwrites naming
	// that role at all — it doesn't need one, since it's wide open to everyone including that role's
	// members.
	it("is true relaying a wide-open channel into a private one opened to a specific role", () => {
		expect(isAtLeastAsReadableAs(channel(), null, staffOnly, null)).toBe(true);
	});

	// Same as above, but the linked channel isn't overwrite-free — it has its own (redundant, allow-only)
	// overwrites. `grantedToEveryone` has to actually scan them for a deny rather than short-circuiting
	// on an empty list.
	it("is true relaying a channel with allow-only overwrites into a private one opened to a specific role", () => {
		const openWithOverwrites = channel({
			permission_overwrites: [
				{ id: GUILD_ID, type: 0, allow: "1024", deny: "0" },
				{ id: "role-2", type: 0, allow: "1024", deny: "0" },
			],
		});

		expect(isAtLeastAsReadableAs(openWithOverwrites, null, staffOnly, null)).toBe(true);
	});

	it("is false when a role allowed into the home channel isn't allowed into the linked one", () => {
		const linked = channel({
			permission_overwrites: [{ id: GUILD_ID, type: 0, allow: "0", deny: "1024" }],
		});
		const home = homeChannel({
			permission_overwrites: [
				{ id: GUILD_ID, type: 0, allow: "0", deny: "1024" },
				{ id: "role-1", type: 0, allow: "1024", deny: "0" },
			],
		});

		expect(isAtLeastAsReadableAs(linked, null, home, null)).toBe(false);
	});

	it("is false when the linked channel denies a role the home channel doesn't", () => {
		const linked = channel({
			permission_overwrites: [{ id: "role-1", type: 0, allow: "0", deny: "1024" }],
		});

		expect(isAtLeastAsReadableAs(linked, null, homeChannel(), null)).toBe(false);
	});

	it("is false when the linked channel shuts out a single member the home channel doesn't", () => {
		const linked = channel({
			permission_overwrites: [{ id: USER_ID, type: 1, allow: "0", deny: "1024" }],
		});

		expect(isAtLeastAsReadableAs(linked, null, homeChannel(), null)).toBe(false);
	});

	it("is false for the role pair a per-id comparison can only reject conservatively", () => {
		// role-2 is denied on both, role-1 is allowed on the home channel only. Discord would let
		// someone holding both see the home channel (allow wins at the role tier) but not the linked
		// one — the case a naive single-role probe misses.
		const linked = channel({
			permission_overwrites: [{ id: "role-2", type: 0, allow: "0", deny: "1024" }],
		});
		const home = homeChannel({
			permission_overwrites: [
				{ id: "role-1", type: 0, allow: "1024", deny: "0" },
				{ id: "role-2", type: 0, allow: "0", deny: "1024" },
			],
		});

		expect(isAtLeastAsReadableAs(linked, null, home, null)).toBe(false);
	});

	it("compares the parent category's overwrites for a channel with none of its own", () => {
		const category = channel({
			id: "444",
			permission_overwrites: [{ id: GUILD_ID, type: 0, allow: "0", deny: "1024" }],
		});

		expect(isAtLeastAsReadableAs(channel({ parent_id: "444" }), category, homeChannel(), null)).toBe(false);
	});

	it("is false across two different guilds", () => {
		expect(isAtLeastAsReadableAs(channel({ guild_id: "999" }), null, homeChannel(), null)).toBe(false);
	});

	it("is false when either side is a DM", () => {
		expect(isAtLeastAsReadableAs(channel({ guild_id: undefined }), null, homeChannel(), null)).toBe(false);
		expect(isAtLeastAsReadableAs(channel(), null, homeChannel({ guild_id: undefined }), null)).toBe(false);
	});

	it("is false for a linked channel that hides its history from @everyone, relayed into one that doesn't", () => {
		const noHistory = channel({
			permission_overwrites: [{ id: GUILD_ID, type: 0, allow: "1024", deny: "65536" }],
		});

		expect(isAtLeastAsReadableAs(noHistory, null, homeChannel(), null)).toBe(false);
	});

	it("is false when the linked channel denies READ_MESSAGE_HISTORY to a role the home channel doesn't", () => {
		const linked = channel({
			permission_overwrites: [{ id: "role-1", type: 0, allow: "0", deny: "65536" }],
		});

		expect(isAtLeastAsReadableAs(linked, null, homeChannel(), null)).toBe(false);
	});

	// The bit-by-bit comparison earning its keep. Projected onto VIEW_CHANNEL alone the two channels
	// are identical — @everyone denied, role-1 allowed — so comparing only that bit would pass this
	// pair. They differ solely in whether role-1 gets its history back.
	it("is false when the home channel grants a role history the linked channel withholds", () => {
		const home = homeChannel({
			permission_overwrites: [
				{ id: GUILD_ID, type: 0, allow: "0", deny: "66560" }, // both bits denied to @everyone
				{ id: "role-1", type: 0, allow: "66560", deny: "0" }, // ...both restored for role-1
			],
		});
		const viewOnly = channel({
			permission_overwrites: [
				{ id: GUILD_ID, type: 0, allow: "0", deny: "66560" },
				{ id: "role-1", type: 0, allow: "1024", deny: "0" }, // ...only VIEW_CHANNEL restored
			],
		});

		expect(isAtLeastAsReadableAs(viewOnly, null, home, null)).toBe(false);

		// ...and true once the linked channel opens the same role to both bits.
		const bothBits = channel({
			permission_overwrites: [
				{ id: GUILD_ID, type: 0, allow: "0", deny: "66560" },
				{ id: "role-1", type: 0, allow: "66560", deny: "0" },
			],
		});

		expect(isAtLeastAsReadableAs(bothBits, null, home, null)).toBe(true);
	});
});
