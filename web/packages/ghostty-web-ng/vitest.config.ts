import { defineConfig } from "vitest/config";

// The binding and widget tests use the vendored core.
export default defineConfig({
  test: {
    include: [
      "vt/**/*.test.ts",
      "lib/input-handler.test.ts",
      "lib/terminal.focus.test.ts",
      "lib/terminal.core.test.ts",
      "lib/terminal.scrollback.test.ts",
      "lib/terminal.theme.test.ts",
      "lib/terminal.selection.test.ts",
      "lib/highlights.test.ts",
      "lib/paint-layers.test.ts",
      "lib/render-options.test.ts",
      "lib/drawn-wraps.test.ts",
      "lib/terminal.links.test.ts",
      "lib/terminal.pointer.test.ts",
      "lib/terminal.viewport.test.ts",
    ],
    environment: "jsdom",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
