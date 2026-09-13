import { env, runInDurableObject } from "cloudflare:test";
import { http, HttpResponse, ws } from "msw";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { network } from "./network";

const GATEWAY_URL = "wss://gateway.discord.gg";
const RESUME_URL = "wss://resume.discord.gg";
const BOT_USER = { id: "bot-1", username: "sadr" };
const INTENTS = 1 | (1 << 9) | (1 << 12) | (1 << 15);

interface Payload {
	op: number;
	d: unknown;
	s?: number | null;
	t?: string | null;
}

interface Connection {
	client: { send(data: string): void; close(code?: number, reason?: string): void };
	received: Payload[];
	closeCode?: number;
}

/**
 * Mocks the two REST calls a fresh connect makes, counting them so a test can prove a resume skips
 * them. `gate` holds the Gateway URL response until it resolves, to widen the window before a socket exists.
 */
function mockRest(gate: Promise<void> = Promise.resolve()): { identity: number; gatewayBot: number } {
	const calls = { identity: 0, gatewayBot: 0 };
	network.use(
		http.get("https://discord.com/api/v10/users/@me", () => {
			calls.identity++;
			return HttpResponse.json(BOT_USER);
		}),
		http.get("https://discord.com/api/v10/gateway/bot", async () => {
			calls.gatewayBot++;
			await gate;
			return HttpResponse.json({
				url: GATEWAY_URL,
				shards: 1,
				session_start_limit: { total: 1000, remaining: 999, reset_after: 3_600_000, max_concurrency: 1 },
			});
		}),
	);
	return calls;
}

/** Every connection any scripted Gateway accepted in the current test, for teardown. */
const openConnections: Connection[] = [];

interface GatewayOptions {
	heartbeatInterval?: number;
	ackHeartbeats?: (connectionIndex: number) => boolean;
	/** Sent in READY; defaults to the served URL so reconnects land on the same scripted Gateway. */
	resumeUrl?: string;
}

/**
 * A scripted Gateway at `url`: sends Hello on connect, READY for an IDENTIFY, RESUMED for a RESUME,
 * and an ACK for each heartbeat. Returns every connection in order so a test can inspect or drive them.
 */
function serveGateway(url: string, options: GatewayOptions = {}): Connection[] {
	const { heartbeatInterval = 45_000, ackHeartbeats = () => true, resumeUrl = url } = options;
	const connections: Connection[] = [];
	network.use(
		ws.link(`${url}/*`).addEventListener("connection", ({ client }) => {
			const index = connections.length;
			const connection: Connection = { client, received: [] };
			connections.push(connection);
			openConnections.push(connection);
			const send = (payload: Payload) => client.send(JSON.stringify({ s: null, t: null, ...payload }));
			client.addEventListener("close", (event) => {
				connection.closeCode = event.code;
			});
			client.addEventListener("message", (event) => {
				const payload = JSON.parse(String(event.data)) as Payload;
				connection.received.push(payload);
				switch (payload.op) {
					case 1:
						if (ackHeartbeats(index)) send({ op: 11, d: null });
						break;
					case 2:
						send({ op: 0, s: 1, t: "READY", d: { session_id: "session-1", resume_gateway_url: resumeUrl, user: BOT_USER } });
						break;
					case 6:
						send({ op: 0, s: 2, t: "RESUMED", d: {} });
						break;
				}
			});
			send({ op: 10, d: { heartbeat_interval: heartbeatInterval } });
		}),
	);
	return connections;
}

const received = (connection: Connection | undefined, op: number) => connection?.received.find((payload) => payload.op === op);

describe("DiscordGateway connection", () => {
	let stub: ReturnType<typeof env.DISCORD_GATEWAY.getByName>;

	/**
	 * Runs a server-side action (a message or close pushed at the bot) inside the DO's I/O context.
	 * The bot's handlers touch DO storage, which the runtime refuses from the test's own context.
	 */
	const fromServer = (action: () => void) => runInDurableObject(stub, action);
	const storedSessionId = () => runInDurableObject(stub, (_instance, state) => state.storage.get<string>("sessionId"));
	const waitForSession = () => vi.waitFor(async () => expect(await storedSessionId()).toBe("session-1"));

	beforeEach(() => {
		env.DISCORD_TOKEN = "test-discord-token";
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		// Closing from the server side runs the bot's close handler, which clears its heartbeat timer.
		// Evicting the instance instead would wait on the open socket and leave its listeners pointing at
		// a dead instance. The alarm goes too, so this instance can't reconnect into a later test.
		await runInDurableObject(stub, (_instance, state) => {
			for (const connection of openConnections) {
				if (connection.closeCode === undefined) connection.client.close(1000);
			}
			return state.storage.deleteAlarm();
		});
		openConnections.length = 0;
	});

	it("identifies after Hello and stores the session and identity from READY", async () => {
		mockRest();
		const connections = serveGateway(GATEWAY_URL);
		stub = env.DISCORD_GATEWAY.getByName("fresh-connect-test");

		await stub.ensureConnected();

		await vi.waitFor(() => expect(received(connections[0], 2)).toBeDefined());
		expect(received(connections[0], 2)?.d).toMatchObject({ token: "test-discord-token", intents: INTENTS });
		await waitForSession();
		const stored = await runInDurableObject(stub, (_instance, state) =>
			state.storage.get<string | number>(["resumeGatewayUrl", "sequence", "botUserId", "botUsername"]),
		);
		expect(Object.fromEntries(stored)).toEqual({ resumeGatewayUrl: GATEWAY_URL, sequence: 1, botUserId: "bot-1", botUsername: "sadr" });
	});

	it("resumes from the stored session on the resume URL, without the REST calls a fresh connect makes", async () => {
		const calls = mockRest();
		const connections = serveGateway(GATEWAY_URL, { resumeUrl: RESUME_URL });
		const resumeConnections = serveGateway(RESUME_URL);
		stub = env.DISCORD_GATEWAY.getByName("resume-test");
		await stub.ensureConnected();
		await waitForSession();

		await fromServer(() => connections[0].client.close(1006));
		await stub.ensureConnected();

		await vi.waitFor(() => expect(received(resumeConnections[0], 6)).toBeDefined());
		expect(received(resumeConnections[0], 6)?.d).toEqual({ token: "test-discord-token", session_id: "session-1", seq: 1 });
		expect(calls).toEqual({ identity: 1, gatewayBot: 1 });
	});

	it("resumes on a new socket when told to Reconnect, closing the old one with a resumable code", async () => {
		mockRest();
		const connections = serveGateway(GATEWAY_URL);
		stub = env.DISCORD_GATEWAY.getByName("reconnect-test");
		await stub.ensureConnected();
		await waitForSession();
		const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

		await fromServer(() => connections[0].client.send(JSON.stringify({ op: 7, d: null, s: null, t: null })));

		await vi.waitFor(() => expect(received(connections[1], 6)).toBeDefined());
		expect(connections[0].closeCode).toBe(4000);
		expect(clearTimeoutSpy).toHaveBeenCalled();
	});

	it("resumes on a new socket when a heartbeat goes unacknowledged", async () => {
		mockRest();
		// Only the first socket withholds ACKs, so the replacement doesn't zombie too.
		const connections = serveGateway(GATEWAY_URL, { heartbeatInterval: 10, ackHeartbeats: (index) => index > 0 });
		stub = env.DISCORD_GATEWAY.getByName("zombie-test");

		await stub.ensureConnected();

		await vi.waitFor(() => expect(received(connections[1], 6)).toBeDefined());
		expect(connections[0].closeCode).toBe(4000);
	});

	it("resumes on a new socket after a resumable Invalid Session", async () => {
		mockRest();
		const connections = serveGateway(GATEWAY_URL);
		stub = env.DISCORD_GATEWAY.getByName("invalid-session-resumable-test");
		await stub.ensureConnected();
		await waitForSession();

		await fromServer(() => connections[0].client.send(JSON.stringify({ op: 9, d: true, s: null, t: null })));

		await vi.waitFor(() => expect(received(connections[1], 6)).toBeDefined());
		expect(connections[0].closeCode).toBe(4000);
	});

	it("pauses reconnects after a fatal close code", async () => {
		mockRest();
		const connections = serveGateway(GATEWAY_URL);
		stub = env.DISCORD_GATEWAY.getByName("fatal-close-test");
		await stub.ensureConnected();
		await waitForSession();

		await fromServer(() => connections[0].client.close(4014)); // Disallowed intent(s)

		await vi.waitFor(async () => {
			const pausedUntil = await runInDurableObject(stub, (_instance, state) => state.storage.get<number>("reconnectPausedUntil"));
			expect(pausedUntil).toBeGreaterThan(Date.now());
		});
		await stub.ensureConnected();
		expect(connections).toHaveLength(1);
	});

	it("re-identifies instead of resuming after a close code that ends the session", async () => {
		const calls = mockRest();
		const connections = serveGateway(GATEWAY_URL);
		stub = env.DISCORD_GATEWAY.getByName("session-ending-close-test");
		await stub.ensureConnected();
		await waitForSession();

		await fromServer(() => connections[0].client.close(4009)); // Session timed out

		await vi.waitFor(async () => expect(await storedSessionId()).toBeUndefined());
		await stub.ensureConnected();
		await vi.waitFor(() => expect(received(connections[1], 2)).toBeDefined());
		expect(received(connections[1], 6)).toBeUndefined();
		expect(calls.gatewayBot).toBe(2);
	});

	it("opens one socket when connect attempts overlap during the REST calls", async () => {
		let release!: () => void;
		mockRest(new Promise<void>((resolve) => (release = resolve)));
		const connections = serveGateway(GATEWAY_URL);
		stub = env.DISCORD_GATEWAY.getByName("overlapping-connect-test");

		const first = stub.ensureConnected();
		const second = stub.ensureConnected();
		release();
		await Promise.all([first, second]);

		await vi.waitFor(() => expect(received(connections[0], 2)).toBeDefined());
		expect(connections).toHaveLength(1);
	});
});
