import { defineConfig } from "vitest/config";

// The binding tests and input handler use the vendored core. The remaining
// upstream tests use bun:test. Vitest reads this file before vite.config.js,
// whose build plugin is not installed.
export default defineConfig({
  test: {
    include: ["vt/**/*.test.ts", "lib/input-handler.test.ts"],
    environment: "jsdom",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
