import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vite.config";

// The find frame measurement (`src/terminal/ghosttyFind.frames.measure.ts`),
// which the ordinary web tests do not select: one worker, so its frames do
// not share the machine with other files, and hours of timeout for a full
// run.
export default mergeConfig(base, defineConfig({
  test: {
    include: ["src/terminal/ghosttyFind.frames.measure.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 6 * 3_600_000,
  },
}));
