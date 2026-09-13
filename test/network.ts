import { setupNetwork } from "@msw/cloudflare";

/** Shared MSW mock for outbound HTTP and WebSocket traffic; enabled for every test file by `setup.ts`. */
export const network = setupNetwork();
