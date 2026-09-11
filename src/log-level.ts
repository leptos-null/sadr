export const LogLevel = {
	Debug: "debug",
	Info: "info",
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

// Takes `{ LOG_LEVEL: string }` rather than `Env` directly: `wrangler types` infers a string
// *literal* for `vars.LOG_LEVEL` from wrangler.jsonc, which would make a `===` comparison against
// another literal fail to type-check. `Env` still satisfies this looser shape at call sites.

/** Reads LOG_LEVEL, defaulting to Info for any unset/unrecognized value. */
export function getLogLevel(env: { LOG_LEVEL: string }): LogLevel {
	return env.LOG_LEVEL === LogLevel.Debug ? LogLevel.Debug : LogLevel.Info;
}

export function isDebugEnabled(env: { LOG_LEVEL: string }): boolean {
	return getLogLevel(env) === LogLevel.Debug;
}

/**
 * Verbose, local-only tracing — gated behind LOG_LEVEL="debug" (set via .dev.vars, never in
 * production). Takes a factory rather than a value so it's only built when needed. The factory
 * should return a structured object (e.g. `{ message: "...", ...fields }`), not a pre-formatted
 * string, so Workers Logs can index the individual fields — see the Workers Logs best-practices
 * doc on structured JSON logging.
 */
export function debugLog(env: { LOG_LEVEL: string }, valueFactory: () => unknown): void {
	if (isDebugEnabled(env)) {
		console.log(valueFactory());
	}
}

/**
 * Extracts a displayable message from a caught value, for embedding directly in a log line's
 * text rather than passing the error as a separate console.error argument — Cloudflare's log
 * capture doesn't reliably surface an Error's own message that way, only its stack frames.
 */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
