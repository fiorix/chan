import { defineConfig } from "vitest/config";

// The binding, input handler, link and viewport tests use the vendored core.
export default defineConfig({
  test: {
    include: [
      "vt/**/*.test.ts",
      "lib/input-handler.test.ts",
      "lib/terminal.links.test.ts",
      "lib/terminal.viewport.test.ts",
    ],
    environment: "jsdom",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
