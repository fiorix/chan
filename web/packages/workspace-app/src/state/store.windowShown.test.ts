// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  window.history.replaceState({}, "", "/?w=window-a");
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function freshStore() {
  const client = await import("../api/client");
  const health = vi.spyOn(client.api, "health").mockResolvedValue({ instance: "a" } as never);
  const lifecycle = await import("./windowLifecycle.svelte");
  const store = await import("./store.svelte");
  return {
    lifecycle,
    store,
    health,
    hear: (command: "window_hidden" | "window_shown") =>
      store.onWatchEvent({ type: "window_command", window_id: client.sessionWindowId(), command }),
  };
}

function expectNoHealthFetch(): void {
  expect(vi.mocked(globalThis.fetch).mock.calls.some(([input]) => String(input).includes("/api/health"))).toBe(false);
}

function turn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("the shown frame for this window clears the hidden cover", async () => {
  const { lifecycle, hear, health } = await freshStore();
  hear("window_hidden");
  await turn();
  expect(lifecycle.windowLifecycle.ended).toBe("hidden");
  expect(lifecycle.isWindowEnded()).toBe(true);

  hear("window_shown");
  await turn();
  expect(lifecycle.windowLifecycle.ended).toBeNull();
  expect(lifecycle.isWindowEnded()).toBe(false);
  expect(health).toHaveBeenCalledTimes(1);
  expectNoHealthFetch();
});

test("a shown frame for another window clears nothing", async () => {
  const { lifecycle, store, hear, health } = await freshStore();
  hear("window_hidden");
  await turn();
  expect(lifecycle.windowLifecycle.ended).toBe("hidden");

  store.onWatchEvent({ type: "window_command", window_id: "another-window", command: "window_shown" });
  await turn();
  expect(lifecycle.windowLifecycle.ended).toBe("hidden");
  expect(health).not.toHaveBeenCalled();
  expectNoHealthFetch();
});

test("a shown frame to a page that is not hidden clears nothing and checks the server instance", async () => {
  const { lifecycle, hear, health } = await freshStore();
  hear("window_shown");
  await turn();
  expect(lifecycle.windowLifecycle.ended).toBeNull();
  expect(health).toHaveBeenCalledTimes(1);

  lifecycle.markWindowDiscarded();
  hear("window_shown");
  await turn();
  expect(lifecycle.windowLifecycle.ended).toBe("discarded");
  expect(health).toHaveBeenCalledTimes(2);
  expectNoHealthFetch();
});
