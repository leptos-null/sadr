import { describe, it, expect, vi, afterEach } from "vitest";
import { LogLevel, debugLog, errorMessage, getLogLevel, isDebugEnabled } from "../src/log-level";

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

describe("debugLog", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("logs the factory's message when LOG_LEVEL is debug", () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const messageFactory = vi.fn(() => "hi");

		debugLog({ LOG_LEVEL: "debug" }, messageFactory);

		expect(logSpy).toHaveBeenCalledWith("hi");
	});

	it("doesn't call the factory (or log) when LOG_LEVEL isn't debug", () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const messageFactory = vi.fn(() => "hi");

		debugLog({ LOG_LEVEL: "info" }, messageFactory);

		expect(messageFactory).not.toHaveBeenCalled();
		expect(logSpy).not.toHaveBeenCalled();
	});
});

describe("errorMessage", () => {
	it("extracts the message from an Error", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
	});

	it("stringifies a non-Error value", () => {
		expect(errorMessage("boom")).toBe("boom");
		expect(errorMessage(42)).toBe("42");
	});
});
