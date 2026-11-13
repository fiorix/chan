import { defineConfig } from "vitest/config";

// The one run of record-oracle.ts, from the package directory: the package's
// own vitest.config.ts leaves it out, as it is no test.
export default defineConfig({
  test: {
    include: ["vt/__tests__/record-oracle.ts"],
    environment: "node",
    testTimeout: 60_000,
  },
});
