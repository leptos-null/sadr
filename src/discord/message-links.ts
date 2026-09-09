/** A message referenced by a Discord message-link URL (`.../channels/{guild|@me}/{channel}/{message}`). */
export interface MessageLink {
	channelId: string;
	messageId: string;
}

// The leading guild segment is either a guild id or "@me" (a DM link) — irrelevant here since
// GET /channels/{channel}/messages/{message} doesn't need it. It's also not validated by Discord
// itself against the channel it precedes (checked live on iOS, Discord build 343.0 (110587)): a link
// with a mismatched or arbitrary guild segment still opens the real channel. So even where a guild id
// is wanted later (e.g. a permissions check), it must come from the fetched channel's own reported
// guild_id — never from this segment.
const MESSAGE_LINK_PATTERN =
	/https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(?:\d+|@me)\/(\d+)\/(\d+)/g;

/** Every distinct message link in `content`, in the order each first appears. */
export function extractMessageLinks(content: string): MessageLink[] {
	const seen = new Set<string>();
	const links: MessageLink[] = [];
	for (const [, channelId, messageId] of content.matchAll(MESSAGE_LINK_PATTERN)) {
		if (seen.has(messageId)) continue;
		seen.add(messageId);
		links.push({ channelId, messageId });
	}
	return links;
}
