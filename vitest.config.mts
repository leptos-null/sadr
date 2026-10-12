import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			// Not the root config: see `test/wrangler.jsonc` for details.
			wrangler: { configPath: "./test/wrangler.jsonc" },
		}),
	],
	test: {
		setupFiles: ["./test/setup.ts"],
	},
});
