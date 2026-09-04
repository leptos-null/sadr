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
