import { describe, it, expect } from "vitest";
import { LogLevel, getLogLevel, isDebugEnabled } from "../src/log-level";

describe("getLogLevel", () => {
	it("returns Debug when LOG_LEVEL is \"debug\"", () => {
		expect(getLogLevel({ LOG_LEVEL: "debug" })).toBe(LogLevel.Debug);
	});

	it("defaults to Info for any other value", () => {
		expect(getLogLevel({ LOG_LEVEL: "info" })).toBe(LogLevel.Info);
		expect(getLogLevel({ LOG_LEVEL: "" })).toBe(LogLevel.Info);
		expect(getLogLevel({ LOG_LEVEL: "verbose" })).toBe(LogLevel.Info);
	});
});

describe("isDebugEnabled", () => {
	it("is true only when LOG_LEVEL is \"debug\"", () => {
		expect(isDebugEnabled({ LOG_LEVEL: "debug" })).toBe(true);
		expect(isDebugEnabled({ LOG_LEVEL: "info" })).toBe(false);
	});
});
