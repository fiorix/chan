import { defineConfig } from "vitest/config";

// chan's tests of the binding and the vendored core under vt/. Upstream's
// tests in lib/ import bun:test and preload Happy DOM (bunfig.toml), so they
// are left out. Vitest reads this file before upstream's vite.config.js,
// which imports a build plugin the workspace does not install.
export default defineConfig({
  test: {
    include: ["vt/**/*.test.ts"],
    environment: "jsdom",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
