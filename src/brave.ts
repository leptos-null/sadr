import type { WebSearchResult } from "./gemini";
import { debugLog } from "./log-level";

const API_URL = "https://api.search.brave.com/res/v1/llm/context";

/** A page's extracted content, in `grounding.generic`. */
interface LlmContextGenericResult {
	url: string;
	title: string;
	/** Relevant chunks of the page. Plain text, or JSON-serialized structured data (a table, schema or code block). */
	snippets: string[];
}

/** Metadata for one URL referenced anywhere in `grounding`. */
interface LlmContextSource {
	title: string;
	hostname: string;
	/** [full date, YYYY-MM-DD, relative age, ISO 8601], or empty when the page has no known date. */
	age: string[];
	/** The page's own description, independent of the query. Only with `enable_source_metadata`. */
	description?: string;
	/** Only with `enable_source_metadata`. */
	site_name?: string;
	/** Favicon URL. Only with `enable_source_metadata`. */
	favicon?: string;
	/** Only with `enable_source_metadata`. */
	thumbnail?: { src: string; original: string } | null;
}

/** <https://api-dashboard.search.brave.com/documentation/services/llm-context#response-format> */
interface LlmContextResponse {
	grounding: {
		generic: LlmContextGenericResult[];
	};
	/** Keyed by URL. */
	sources: Record<string, LlmContextSource>;
}

/** One Brave LLM Context search: pages relevant to `query`, with their text already extracted. */
export async function searchWeb(env: Env, query: string): Promise<WebSearchResult[]> {
	// docs: https://api-dashboard.search.brave.com/documentation/services/llm-context

	const url = new URL(API_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("count", "10");
	url.searchParams.set("safesearch", "moderate");

	debugLog(env, () => ({ message: "Brave request", query }));
	const response = await fetch(url, {
		headers: {
			Accept: "application/json",
			"X-Subscription-Token": env.BRAVE_SEARCH_API_KEY,
		},
		// Brave's own recommendation for this endpoint.
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		throw new Error(`Brave LLM Context search failed: ${response.status} ${await response.text()}`);
	}
	const data = (await response.json()) as LlmContextResponse;
	debugLog(env, () => ({ message: "Brave response", data }));
	// Picked field by field, so anything else Brave adds to a result never reaches the model unreviewed.
	return data.grounding.generic.map((page) => {
		const result: WebSearchResult = { url: page.url, title: page.title, snippets: page.snippets };
		const date = data.sources[page.url]?.age[3];
		if (date) {
			result.date = date;
		}
		return result;
	});
}
