import { svelte } from "@sveltejs/vite-plugin-svelte";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);
const svelteClient = join(dirname(require.resolve("svelte/package.json")), "src/index-client.js");

export default defineConfig({
  plugins: [svelte()],
  test: {
    environment: "jsdom",
    alias: [{ find: /^svelte$/, replacement: svelteClient }],
    testTimeout: 30_000,
  },
});
