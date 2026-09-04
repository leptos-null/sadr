import { describe, it, expect } from "vitest";
import { isAddressedToBot } from "../../src/discord/mentions";
import type { MessageCreateDispatchData } from "../../src/discord/gateway-types";

const BOT_ID = "42";

function message(overrides: Partial<MessageCreateDispatchData>): MessageCreateDispatchData {
	return {
		id: "1",
		channel_id: "chan",
		content: "",
		timestamp: "2024-01-01T00:00:00.000Z",
		author: { id: "user", username: "user" },
		mentions: [],
		...overrides,
	};
}

describe("isAddressedToBot", () => {
	it("is true for any DM (no guild_id), even without a mention", () => {
		expect(isAddressedToBot(message({ guild_id: undefined, mentions: [] }), BOT_ID)).toBe(true);
	});

	it("is true for a guild message that mentions the bot", () => {
		expect(isAddressedToBot(message({ guild_id: "guild", mentions: [{ id: BOT_ID }] }), BOT_ID)).toBe(true);
	});

	it("is false for a guild message that doesn't mention the bot", () => {
		expect(isAddressedToBot(message({ guild_id: "guild", mentions: [] }), BOT_ID)).toBe(false);
	});

	it("is false for a guild message that mentions someone else", () => {
		expect(isAddressedToBot(message({ guild_id: "guild", mentions: [{ id: "someone-else" }] }), BOT_ID)).toBe(false);
	});
});
