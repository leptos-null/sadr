import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";

describe("DiscordGateway keep-alive alarm", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

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
