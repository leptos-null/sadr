import { describe, it, expect } from "vitest";
import { extractMessageLinks } from "../../src/discord/message-links";

describe("extractMessageLinks", () => {
	it("extracts the channel and message id from a guild message link", () => {
		expect(extractMessageLinks("what's this? https://discord.com/channels/111/222/333")).toEqual([
			{ channelId: "222", messageId: "333" },
		]);
	});

	it("extracts a DM message link, ignoring the leading @me segment", () => {
		expect(extractMessageLinks("https://discord.com/channels/@me/222/333")).toEqual([
			{ channelId: "222", messageId: "333" },
		]);
	});

	it("extracts links from the ptb and canary subdomains", () => {
		expect(extractMessageLinks("https://ptb.discord.com/channels/111/222/333")).toEqual([
			{ channelId: "222", messageId: "333" },
		]);
		expect(extractMessageLinks("https://canary.discord.com/channels/111/222/333")).toEqual([
			{ channelId: "222", messageId: "333" },
		]);
	});

	it("extracts links from the legacy discordapp.com domain", () => {
		expect(extractMessageLinks("https://discordapp.com/channels/111/222/333")).toEqual([
			{ channelId: "222", messageId: "333" },
		]);
	});

	it("extracts multiple distinct links in order", () => {
		expect(
			extractMessageLinks("see https://discord.com/channels/111/222/333 and https://discord.com/channels/111/444/555"),
		).toEqual([
			{ channelId: "222", messageId: "333" },
			{ channelId: "444", messageId: "555" },
		]);
	});

	it("dedupes a message id linked more than once", () => {
		expect(
			extractMessageLinks("https://discord.com/channels/111/222/333 again: https://discord.com/channels/111/222/333"),
		).toEqual([{ channelId: "222", messageId: "333" }]);
	});

	it("returns an empty array when content has no message link", () => {
		expect(extractMessageLinks("just a normal message, no links here")).toEqual([]);
	});

	it("ignores an unrelated discord.com URL that isn't a message link", () => {
		expect(extractMessageLinks("https://discord.com/invite/abc123")).toEqual([]);
	});

	it("ignores a lookalike host that merely contains discord.com", () => {
		// The literal "https://" is what stops the optional ptb./canary. group from absorbing an
		// attacker-controlled label, and "/channels/" has to come straight off the real host — so
		// neither a prefixed nor a suffixed domain can pass itself off as Discord's.
		expect(extractMessageLinks("https://evildiscord.com/channels/111/222/333")).toEqual([]);
		expect(extractMessageLinks("https://discord.com.evil.com/channels/111/222/333")).toEqual([]);
	});

	it("extracts a link wrapped in angle brackets, as posted to suppress Discord's own embed", () => {
		expect(extractMessageLinks("<https://discord.com/channels/111/222/333>")).toEqual([
			{ channelId: "222", messageId: "333" },
		]);
	});
});
