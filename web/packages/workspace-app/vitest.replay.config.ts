import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vite.config";

export default mergeConfig(base, defineConfig({
  test: {
    include: ["src/components/TerminalTab.replay.e2e.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 30_000,
    environmentOptions: { jsdom: { url: process.env.CHAN_REPLAY_URL } },
  },
}));
