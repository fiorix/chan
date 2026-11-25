// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";

const watch = vi.hoisted(() => ({ probes: 0 }));
vi.mock("./state/store.svelte", async (importOriginal) => {
  const store = await importOriginal<typeof import("./state/store.svelte")>();
  return {
    ...store,
    resumeWatcher: () => {
      watch.probes += 1;
    },
  };
});

import { api } from "./api/client";
import { mountApp, stubAppEnvironment, unmountApp } from "./__tests__/app";

stubAppEnvironment();

afterEach(async () => {
  vi.useRealTimers();
  await unmountApp();
  watch.probes = 0;
  vi.restoreAllMocks();
});

describe("workspace resume", () => {
  test("visibility refreshes a healthy page without replacing its event socket", async () => {
    await mountApp();
    const list = vi.spyOn(api, "list");
    vi.useFakeTimers();

    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(300);

    expect(watch.probes).toBe(1);
    expect(list).toHaveBeenCalled();
  });
});
