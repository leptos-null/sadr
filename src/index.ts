export { DiscordGateway } from "./discord-gateway";

function gateway(env: Env) {
	return env.DISCORD_GATEWAY.getByName("default");
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		// Health check: nudge the gateway without making the response wait on it.
		ctx.waitUntil(gateway(env).ensureConnected().catch((error) => console.error("ensureConnected failed", error)));
		return new Response("ok");
	},

	async scheduled(controller, env): Promise<void> {
		await gateway(env).ensureConnected();
	},
} satisfies ExportedHandler<Env>;
