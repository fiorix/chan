import { defineConfig } from "vitest/config";

// The binding tests and input handler use the vendored core.
export default defineConfig({
  test: {
    include: ["vt/**/*.test.ts", "lib/input-handler.test.ts"],
    environment: "jsdom",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
