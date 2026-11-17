import { defineConfig } from "vitest/config";

// The binding, input handler and viewport tests use the vendored core.
export default defineConfig({
  test: {
    include: ["vt/**/*.test.ts", "lib/input-handler.test.ts", "lib/terminal.viewport.test.ts", "lib/terminal.focus.test.ts"],
    environment: "jsdom",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
