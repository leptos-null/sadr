/** Resolves after `ms` — for the backoffs Discord prescribes (invalid session, rate limits). */
export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
