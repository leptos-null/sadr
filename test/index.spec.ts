import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("health check", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("responds ok without waiting on the Gateway connection to settle", async () => {
		// The background ensureConnected() call would otherwise reach out to the real Discord API.
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled in tests"));

		const request = new IncomingRequest("http://example.com");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);

		expect(await response.text()).toBe("ok");
		await waitOnExecutionContext(ctx);
	});
});
