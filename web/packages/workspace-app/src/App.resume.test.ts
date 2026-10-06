// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());

const watch = vi.hoisted(() => ({ replacements: 0, probes: 0 }));
vi.mock("./state/store.svelte", async (importOriginal) => {
  const store = await importOriginal<typeof import("./state/store.svelte")>();
  return {
    ...store,
    reconnectWatcher: () => {
      watch.replacements += 1;
      store.reconnectWatcher();
    },
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
  watch.replacements = 0;
  watch.probes = 0;
  vi.restoreAllMocks();
});

describe("workspace resume", () => {
  test("visibility refreshes a healthy page without replacing its event socket", async () => {
    await mountApp();
    const list = vi.spyOn(api, "list");
    const before = watch.replacements;
    vi.useFakeTimers();

    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(300);

    expect(watch.replacements).toBe(before);
    expect(watch.probes).toBe(1);
    expect(list).toHaveBeenCalled();
  });
});
