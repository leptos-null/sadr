# sadr

A Discord bot that replies to `@mention`s in servers and to any message in a DM, using the Gemini API. Runs as a single Cloudflare Worker with a Durable Object holding a persistent Gateway connection.

## Goals

- Respond to messages with similar context that a human in the conversation would have
    - Nearby messages in the channel
    - Linked messages
    - Channel name and topic
    - Guild (server) name and description
- Keep private messages private: the bot may have a wider level of access than other participants in a conversation - the bot should not include content from channels that other participants don't have access to

At the time of writing, this project is designed to fit within the free tier for both [Cloudflare](<https://www.cloudflare.com/plans/>) and [Gemini API](<https://ai.google.dev/gemini-api/docs/pricing>).

## How it works

- The bot connects directly to Discord's Gateway over a WebSocket (HELLO → IDENTIFY/RESUME → heartbeat → dispatch), rather than registering slash commands, so it can hold free-text conversations instead of being limited to structured commands.
- On a `MESSAGE_CREATE` it's addressed to, it drives `gemini-3.5-flash-lite` as a small function-calling agent: the model can call `fetch_message_history` (Discord's `around`, both directions from an anchor) to pull in more context or follow a reply chain, then `send_reply` once it has enough to answer.
- A typing indicator shows for as long as a reply is being generated.
- A self-rescheduling Durable Object alarm keeps the Gateway connection alive indefinitely (an outbound WebSocket alone only keeps a DO alive for 15 minutes).

See `CLAUDE.md` for the full architecture writeup.

## Authorship

Nearly all of the code in this repo was written by Claude. I make an effort to set the author accurately for each git commit, to reflect who wrote the code.

I still review and oversee the development, including making architectural decisions.

## Running and deploying

Whether you're running locally or deploying to Cloudflare, you'll need the following:

1. Discord bot
    1. I recommend separate bots for local development and a production deployment, to avoid both instances attempting to respond to the same message
    2. If you don't yet have one, create a Discord bot: [Discord guide](<https://docs.discord.com/developers/quick-start/getting-started#step-1-creating-an-app>)
        - Use this guide also to install the bot to a server
    3. The bot must have "Message Content Intent" enabled in the Discord Developer Portal: [Discord guide](<https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review#1-the-developer-portal>)
2. Gemini API
    1. It's technically fine to re-use the same API key between a local instance and a deployment. You may choose to use separate keys for organization or security.
    2. If you don't yet have one, create a Gemini API key: [Google guide](<https://ai.google.dev/gemini-api/docs>)

### Local

1. Place the 2 secrets from the steps above in `.dev.vars`:
    ```txt
    DISCORD_TOKEN=""
    GEMINI_API_KEY=""
    ```
    - You may also choose to add the line
        ```txt
        LOG_LEVEL="debug"
        ```
        to this file to enable debug logging (only applies when running locally)
2. Install package dependencies:
    ```bash
    bun install
    ```
    - You only need to do this when first cloning the repo or if `bun.lock` changed when pulling
3. Run:
    ```bash
    bun run dev
    ```
    - The first time you run, you will likely need to manually start the Gateway connection, which you can do with:
        ```bash
        curl -sS "http://localhost:8787/" && echo
        ```
        You can also do this at any time, if the Gateway connection doesn't automatically connect.

### Deploying

1. Provide the 2 secrets from the shared steps above to Cloudflare:
    ```bash
    wrangler secret put DISCORD_TOKEN
    wrangler secret put GEMINI_API_KEY
    ```
    - Each of these commands will interactively prompt you to input the value for the secret
2. Deploy:
    ```bash
    bun run deploy
    ```
