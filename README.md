# sadr

A Discord bot that replies to `@mention`s in guild channels and to any message in a DM, using the Gemini API. Runs as a single Cloudflare Worker with a Durable Object holding a persistent Gateway connection (not slash commands / Interactions).

## How it works

- The bot connects directly to Discord's Gateway over a WebSocket (HELLO → IDENTIFY/RESUME → heartbeat → dispatch), rather than registering slash commands, so it can hold free-text conversations instead of being limited to structured commands.
- On a `MESSAGE_CREATE` it's addressed to, it drives `gemini-3.5-flash-lite` as a small function-calling agent: the model can call `fetch_message_history` (Discord's `around`, both directions from an anchor) to pull in more context or follow a reply chain, then `send_reply` once it has enough to answer.
- A typing indicator shows for as long as a reply is being generated.
- A self-rescheduling Durable Object alarm keeps the Gateway connection alive indefinitely (an outbound WebSocket alone only keeps a DO alive for 15 minutes).

See `CLAUDE.md` for the full architecture writeup.

## Setup

Requires [bun](https://bun.sh).

```sh
bun install
```

Create a `.dev.vars` file in the repo root with:

```
DISCORD_TOKEN=...
GEMINI_API_KEY=...
```

Your Discord bot needs the privileged **MESSAGE_CONTENT** intent enabled in the Discord Developer Portal, or the Gateway connection will be rejected.

## Local development

```sh
bun run dev
```

Starts `wrangler dev` on `http://localhost:8787`. Nothing auto-triggers the Gateway connection locally — hit the server once to fire it:

```sh
curl localhost:8787
```

The 5-minute self-heal cron doesn't run locally either; trigger it manually if needed:

```sh
curl "http://localhost:8787/cdn-cgi/local/scheduled"
```

## Testing

```sh
bun run test        # full suite
bunx tsc --noEmit    # typecheck
```

## Deploying

```sh
wrangler secret put DISCORD_TOKEN
wrangler secret put GEMINI_API_KEY
bun run deploy
```
