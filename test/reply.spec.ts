import { describe, it, expect } from "vitest";
import { toHistoryMessage } from "../src/reply";
import type { DiscordMessage } from "../src/discord/types";

function message(overrides: Partial<DiscordMessage>): DiscordMessage {
	return {
		id: "1",
		channel_id: "1000",
		type: 0,
		content: "hello?",
		timestamp: "2024-01-01T00:00:00.000Z",
		author: { id: "111", username: "alice" },
		...overrides,
	};
}

describe("toHistoryMessage", () => {
	it("maps a reply's message_reference to replyToId", () => {
		const reply = message({ type: 19, message_reference: { type: 0, message_id: "777", channel_id: "1000" } });

		expect(toHistoryMessage(reply).replyToId).toBe("777");
	});

	// A pin notice (6) and a thread starter (21) both carry a message_reference, and a thread starter's
	// points at another channel entirely — read as a reply target, it anchors a seed fetch on a foreign id.
	it.each([6, 21])("ignores the message_reference on a message of type %i", (type) => {
		const notice = message({ type, content: "", message_reference: { type: 0, message_id: "777", channel_id: "2000" } });

		expect(toHistoryMessage(notice).replyToId).toBeNull();
	});

	it("maps a forward's snapshot to forwarded, leaving replyToId null", () => {
		const forward = message({
			content: "",
			message_reference: { type: 1, message_id: "777", channel_id: "2000" },
			message_snapshots: [
				{ message: { type: 0, content: "the original message", timestamp: "2023-12-31T00:00:00.000Z" } },
			],
		});

		const history = toHistoryMessage(forward);

		expect(history.replyToId).toBeNull();
		// The forward's own content is whatever its author added alongside — here, nothing.
		expect(history.content).toBe("");
		expect(history.forwarded).toEqual({
			origin: { channelId: "2000", messageId: "777" },
			content: "the original message",
			date: "2023-12-31T00:00:00.000Z",
			editedDate: undefined,
			attachments: undefined,
		});
	});

	it("maps a forwarded original's edit and attachments from the snapshot, not the forward", () => {
		const forward = message({
			content: "",
			attachments: [],
			message_reference: { type: 1, message_id: "777", channel_id: "2000" },
			message_snapshots: [
				{
					message: {
						type: 0,
						content: "look at this",
						timestamp: "2023-12-31T00:00:00.000Z",
						edited_timestamp: "2023-12-31T00:05:00.000Z",
						attachments: [{ filename: "screenshot.png", url: "https://cdn.discordapp.com/screenshot.png" }],
					},
				},
			],
		});

		const history = toHistoryMessage(forward);

		expect(history.forwarded?.editedDate).toBe("2023-12-31T00:05:00.000Z");
		expect(history.forwarded?.attachments).toEqual(["screenshot.png"]);
		expect(history.attachments).toBeUndefined();
		expect(history.editedDate).toBeUndefined();
	});

	it("folds a forwarded original's mentions into mentionedUsers, deduped with the forward's own", () => {
		const forward = message({
			content: "<@555> seen this?",
			mentions: [{ id: "555", username: "carol", global_name: "Carol C." }],
			message_reference: { type: 1, message_id: "777", channel_id: "2000" },
			message_snapshots: [
				{
					message: {
						type: 0,
						content: "<@555> <@666>",
						timestamp: "2023-12-31T00:00:00.000Z",
						mentions: [
							{ id: "555", username: "carol", global_name: "Carol C." },
							{ id: "666", username: "dave" },
						],
					},
				},
			],
		});

		expect(toHistoryMessage(forward).mentionedUsers).toEqual([
			{ id: "555", username: "carol", globalName: "Carol C." },
			{ id: "666", username: "dave", globalName: null },
		]);
	});

	it("omits forwarded entirely for a message that isn't a forward", () => {
		expect(toHistoryMessage(message({})).forwarded).toBeUndefined();
	});

	it("omits a forwarded original's origin when Discord didn't identify it", () => {
		const forward = message({
			content: "",
			message_snapshots: [{ message: { type: 0, content: "no reference", timestamp: "2023-12-31T00:00:00.000Z" } }],
		});

		expect(toHistoryMessage(forward).forwarded?.origin).toBeUndefined();
	});
});
