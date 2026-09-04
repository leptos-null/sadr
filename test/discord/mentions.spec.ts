import { describe, it, expect } from "vitest";
import { mentionsUser, stripMention } from "../../src/discord/mentions";
import type { MessageCreateDispatchData } from "../../src/discord/gateway-types";

const BOT_ID = "42";

function message(overrides: Partial<MessageCreateDispatchData>): MessageCreateDispatchData {
	return {
		id: "1",
		channel_id: "chan",
		content: "",
		author: { id: "user" },
		mentions: [],
		...overrides,
	};
}

describe("mentionsUser", () => {
	it("is true when the given user id is among the mentions", () => {
		expect(mentionsUser(message({ mentions: [{ id: BOT_ID }] }), BOT_ID)).toBe(true);
	});

	it("is false when the given user id is not mentioned", () => {
		expect(mentionsUser(message({ mentions: [{ id: "someone-else" }] }), BOT_ID)).toBe(false);
	});
});

describe("stripMention", () => {
	it("removes both mention token forms and trims whitespace", () => {
		expect(stripMention(`<@${BOT_ID}> hello`, BOT_ID)).toBe("hello");
		expect(stripMention(`<@!${BOT_ID}> hello`, BOT_ID)).toBe("hello");
	});

	it("removes a mention anywhere in the message, not just a leading one", () => {
		expect(stripMention(`hey <@${BOT_ID}>, what's up`, BOT_ID)).toBe("hey , what's up");
	});

	it("leaves other users' mentions untouched", () => {
		expect(stripMention(`<@999> and <@${BOT_ID}> hi`, BOT_ID)).toBe("<@999> and hi");
	});
});
