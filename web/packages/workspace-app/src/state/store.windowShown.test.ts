// @vitest-environment jsdom

import { beforeEach, expect, test, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  window.history.replaceState({}, "", "/?w=window-a");
});

async function freshStore() {
  const client = await import("../api/client");
  const lifecycle = await import("./windowLifecycle.svelte");
  const store = await import("./store.svelte");
  return {
    lifecycle,
    store,
    hear: (command: "window_hidden" | "window_shown") =>
      store.onWatchEvent({ type: "window_command", window_id: client.sessionWindowId(), command }),
  };
}

function turn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("the shown frame for this window clears the hidden cover", async () => {
  const { lifecycle, hear } = await freshStore();
  hear("window_hidden");
  await turn();
  expect(lifecycle.windowLifecycle.ended).toBe("hidden");
  expect(lifecycle.isWindowEnded()).toBe(true);

  hear("window_shown");
  await turn();
  expect(lifecycle.windowLifecycle.ended).toBeNull();
  expect(lifecycle.isWindowEnded()).toBe(false);
});

test("a shown frame for another window clears nothing", async () => {
  const { lifecycle, store, hear } = await freshStore();
  hear("window_hidden");
  await turn();
  expect(lifecycle.windowLifecycle.ended).toBe("hidden");

  store.onWatchEvent({ type: "window_command", window_id: "another-window", command: "window_shown" });
  await turn();
  expect(lifecycle.windowLifecycle.ended).toBe("hidden");
});

test("a shown frame to a page that is not hidden changes nothing", async () => {
  const { lifecycle, hear } = await freshStore();
  hear("window_shown");
  await turn();
  expect(lifecycle.windowLifecycle.ended).toBeNull();

  lifecycle.markWindowDiscarded();
  hear("window_shown");
  await turn();
  expect(lifecycle.windowLifecycle.ended).toBe("discarded");
});
