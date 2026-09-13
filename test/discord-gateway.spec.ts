import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("DiscordGateway keep-alive alarm", () => {
	it("schedules an alarm when ensureConnected is called", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled in tests"));
		const stub = env.DISCORD_GATEWAY.getByName("keep-alive-schedule-test");

		await stub.ensureConnected().catch(() => {});

		const alarmTime = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
		expect(alarmTime).not.toBeNull();
	});

	it("reschedules the alarm after it fires, even if ensureConnected fails", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled in tests"));
		const stub = env.DISCORD_GATEWAY.getByName("keep-alive-reschedule-test");
		await stub.ensureConnected().catch(() => {});

		const ran = await runDurableObjectAlarm(stub);

		expect(ran).toBe(true);
		const alarmTime = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
		expect(alarmTime).not.toBeNull();
	});
});

describe("DiscordGateway reconnect pause", () => {
	it("does not connect while a reconnect pause is in effect", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled in tests"));
		const stub = env.DISCORD_GATEWAY.getByName("reconnect-pause-active-test");
		await runInDurableObject(stub, (_instance, state) => state.storage.put("reconnectPausedUntil", Date.now() + 60_000));

		await stub.ensureConnected();

		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("pauses instead of connecting when the IDENTIFY limit is exhausted", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
			if (path === "/api/v10/users/@me") return Response.json({ id: "bot-1", username: "sadr" });
			if (path === "/api/v10/gateway/bot") {
				return Response.json({
					url: "wss://gateway.discord.gg",
					shards: 1,
					session_start_limit: { total: 1000, remaining: 0, reset_after: 60_000, max_concurrency: 1 },
				});
			}
			throw new Error(`Unexpected fetch in test: ${path}`);
		});
		const stub = env.DISCORD_GATEWAY.getByName("identify-limit-exhausted-test");

		await stub.ensureConnected();

		const pausedUntil = await runInDurableObject(stub, (_instance, state) => state.storage.get<number>("reconnectPausedUntil"));
		expect(pausedUntil).toBeGreaterThan(Date.now());
	});

	it("connects again once the reconnect pause has expired", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled in tests"));
		const stub = env.DISCORD_GATEWAY.getByName("reconnect-pause-expired-test");
		await runInDurableObject(stub, (_instance, state) => state.storage.put("reconnectPausedUntil", Date.now() - 1));

		await stub.ensureConnected().catch(() => {});

		expect(fetchSpy).toHaveBeenCalled();
	});
});
