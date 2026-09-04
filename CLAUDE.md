# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **bun** (`bun.lock` is the lockfile — don't use npm/yarn).

- `bun install` — install deps
- `bun run dev` — `wrangler dev`, local dev server on `http://localhost:8787`
- `bun run test` — full vitest suite (`@cloudflare/vitest-plugin`, runs in a real Miniflare Workers runtime, not plain Node)
  - single file: `bunx vitest run test/gemini.spec.ts`
  - single test: `bunx vitest run -t "test name"`
- `bunx tsc --noEmit` — typecheck (no package.json script wraps this)
- `bun run cf-typegen` — `wrangler types`; **re-run after any binding/secret change in `wrangler.jsonc`** to regenerate `worker-configuration.d.ts`
- `bun run deploy` — `wrangler deploy`

### Local dev gotchas

- Secrets (`DISCORD_TOKEN`, `GEMINI_API_KEY`) come from a git-ignored `.dev.vars` in the repo root, not `wrangler.jsonc`.
- Nothing auto-triggers the bot's Gateway connection in local dev. Hit `curl localhost:8787` once after starting `wrangler dev` to fire `ensureConnected()`. The cron (`scheduled` handler) doesn't run locally either — trigger it manually with `curl "http://localhost:8787/cdn-cgi/local/scheduled"` if you need to test the self-heal path.
- Running `wrangler dev` / `vitest` may need a local loopback listener that a process sandbox can block (`EPERM` on `listen`) — that's an environment restriction, not an app bug.

### Cloudflare docs

`AGENTS.md` in this repo instructs: always fetch current Cloudflare docs before touching Workers/Durable Objects code, since platform APIs and limits change (e.g. this project's DO class lifecycle already moved from `migrations` to the newer `exports` field, and new DO namespaces now require the SQLite storage backend). Use the `cloudflare-docs` MCP server (configured in `.mcp.json`), not prior/training knowledge, for anything Workers/DO/KV/R2/D1/Queues/Vectorize/Workers AI/Agents-SDK related.

`docs/` in this repo is a small local mirror of external doc pages (currently Gemini API docs) the user has dropped in deliberately. Treat these as authoritative over general knowledge or other example snippets that conflict with them — e.g. `docs/ai.google.dev/api.md.txt`'s Authentication section (`x-goog-api-key` header) is correct; the `?key=` query-param form shown in some other Gemini doc examples is not what this project uses.

## Architecture

sadr is a Discord bot that replies to `@mention`s in guild channels and to any message in a DM, using the Gemini API, running as a single Cloudflare Worker.

**Gateway connection, not Interactions webhooks.** The bot holds a persistent outbound WebSocket to Discord's Gateway rather than registering slash commands / an HTTP interactions endpoint. This is a deliberate choice (free-text mention chat needs the Gateway; Interactions only supports slash commands) — don't reach for slash commands without revisiting that decision.

- `src/index.ts` — the Worker entry. Re-exports the `DiscordGateway` Durable Object class (required for `wrangler.jsonc`'s `exports` binding) and defines `fetch`/`scheduled`. Both handlers just call `ensureConnected()` on the **one** singleton DO instance (`env.DISCORD_GATEWAY.getByName("default")`) — `fetch` is a health check that fires it via `ctx.waitUntil()` without blocking the response, `scheduled` (5-min cron) awaits it directly as a secondary self-heal in case the socket dropped (the DO's own alarm loop, below, is the primary keep-alive mechanism).
- `src/discord-gateway.ts` — the `DiscordGateway` DO. This is where almost all the bot logic lives: raw Discord Gateway protocol handling (HELLO → IDENTIFY/RESUME → heartbeat loop → dispatch events), session state (`sessionId`/`resumeGatewayUrl`/`sequence`/`botUserId`/`botUsername`) persisted to DO storage so a restart can RESUME instead of re-IDENTIFY, and the `MESSAGE_CREATE` → mention check → Gemini → Discord REST reply pipeline. Logs at each lifecycle step (connect, Hello, READY, close code/reason, mention handling) — check these first when the bot isn't responding.
  - The outbound socket is a plain `new WebSocket(url)` client connection. **Do not call `.accept()` on it** — that method is only valid on the server side of a `WebSocketPair()` (an inbound connection a Worker/DO accepts), and throws on a client-constructed socket.
  - **A self-rescheduling DO alarm (`alarm()`, every `KEEPALIVE_INTERVAL_MS` = 60s) is what actually keeps the bot connected long-term.** An outbound connection (our Gateway WebSocket) only keeps a Durable Object alive for a maximum of 15 minutes; after that, the DO is evicted — killing the socket — after just 70-140s with no incoming request/RPC/event. The 5-min `scheduled` cron alone is too infrequent to prevent that gap. `ensureConnected()` schedules the first alarm (and re-schedules one if it's ever found missing, e.g. after an unrelated eviction/restart); each `alarm()` firing calls `ensureConnected()` then reschedules itself, regardless of whether that call succeeded.
  - Responds to guild messages that `@mention` the bot, and to any message in a DM (`isAddressedToBot()` in `src/discord/mentions.ts`, keyed off whether `guild_id` is present on the dispatch). Requests the privileged `MESSAGE_CONTENT` intent (must also be enabled under the bot's Privileged Gateway Intents in the Discord Developer Portal, or Discord rejects the connection with a non-resumable invalid session) — needed because without it, `content`/`embeds`/`attachments` come back empty for any message that doesn't mention the bot, isn't a DM, or wasn't sent by the bot, which is most of what `fetch_message_history`'s `around` fetch (see `src/gemini.ts` below) pulls in.
  - Bot identity (`botUserId`/`botUsername`) is resolved via REST (`getCurrentUser`, `GET /users/@me`) in `connectToGateway()` before the socket even opens, not solely from the Gateway's `READY` dispatch — a `RESUME` never re-sends `READY`, so a session that only ever resumes would otherwise never learn its own identity.
  - Verbose tracing (raw Gateway payloads, and — in `src/gemini.ts` — raw Gemini request/response bodies) is gated behind `LOG_LEVEL="debug"` through the shared `debugLog()` helper in `src/log-level.ts` — set `LOG_LEVEL="debug"` in `.dev.vars` locally; never in production.
- `src/discord/rest.ts` — Discord REST v10 calls (bot-token `Authorization` header): fetching the Gateway WSS URL, the bot's own identity (`getCurrentUser`), posting a channel message (optionally as a reply via `message_reference`), and fetching channel messages around a given id (`getChannelMessages`, using Discord's `around` param — both earlier and later messages in one call).
- `src/discord/mentions.ts` — pure helpers: whether a message mentions a given user id, whether a message should be treated as addressed to the bot (DM or mention). Message content is passed to Gemini unstripped, mention tokens included — the system instruction (see below) teaches the model to recognize its own `<@id>`/`<@!id>` token.
- `src/discord/gateway-types.ts` — Gateway payload envelope and opcode types.
- `src/gemini.ts` — drives `gemini-3.5-flash-lite` as a small function-calling agent, not a single-turn prompt.
  - Every call has the same shape: both tools (`fetch_message_history`, `send_reply`) always offered, `toolConfig.mode: "ANY"` forces a function call every turn. `send_reply` is itself the terminal tool call (not a separate structured-output step) — keeps the request shape uniform for the whole loop.
  - `fetch_message_history` fetches around a message id (Discord's `around`, not `before`-only paging) — doubles as "give me more context" and "show me what a `replyToId` reply-chain link points to."
  - No accumulated transcript: fetched messages merge into a `Map<id, HistoryMessage>` (dedupes automatically), and each call gets a *freshly rebuilt* `{trigger, messages}` turn from that map — the model's own past tool calls are never echoed back to it.
  - `generateReply(env, botUserId, botUsername, trigger, fetchAround)` builds the system instruction per call so the model can recognize its own past messages (`messages[].userId === botUserId`) and resolve mention tokens.
- `wrangler.jsonc` — uses the current `exports` field (not the legacy `migrations` array) to declare the `DiscordGateway` DO with the SQLite storage backend, and `secrets.required` to declare `DISCORD_TOKEN`/`GEMINI_API_KEY` (drives both `Env` typing and `wrangler deploy` validation).

Test coverage is unit-level only (mocked `fetch`, pure logic) for the REST/Gemini/mention helpers and the health-check response; the actual Gateway handshake (IDENTIFY/heartbeat/RESUME) is verified live via `wrangler dev` rather than automated tests.
