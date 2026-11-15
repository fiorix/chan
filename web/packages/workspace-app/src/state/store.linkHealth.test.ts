// @vitest-environment jsdom

// The store is where the watcher and the window's link state meet: it opens
// the watcher on the window's link probe and passes each status on. The
// watcher itself is replaced here by one that records what it was opened with.

import { afterEach, expect, test, vi } from "vitest";
import type { WatchDrop } from "../api/transport";

const watcher = vi.hoisted(() => ({
  status: null as ((status: "connecting" | "open" | "reconnecting", attempt: number, drop?: WatchDrop) => void) | null,
  link: undefined as unknown,
  options: undefined as { remote?: boolean } | undefined,
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    openWatchSocket: (
      _onEvent: unknown,
      onStatus: typeof watcher.status,
      _onReady: unknown,
      link: unknown,
      options?: { remote?: boolean },
    ) => {
      watcher.status = onStatus;
      watcher.link = link;
      watcher.options = options;
      return Object.assign(() => {}, {
        subscribeDir() {},
        unsubscribeDir() {},
        reportTransfers() {},
        probe() {},
        close() {},
      });
    },
  };
});

import { linkHealth, resetLinkHealthForTests, watchLinkProbe } from "./linkHealth.svelte";
import { resumeWatcher, teardown, ui } from "./store.svelte";

afterEach(() => {
  teardown();
  resetLinkHealthForTests();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  history.replaceState(null, "", "/");
});

test("the store opens its watcher on the window's link probe and reports each status", () => {
  resumeWatcher();
  expect(watcher.link).toBe(watchLinkProbe);
  expect(watcher.options).toEqual({ remote: false });

  watcher.status?.("connecting", 0);
  watcher.status?.("open", 0);
  expect(ui.ws).toBe("open");
  expect(linkHealth.state).toBe("unknown");

  const contact = Date.now() - 15_000;
  watcher.status?.("reconnecting", 1, { reason: "deadline", lastFrameAt: contact });
  expect(ui.ws).toBe("reconnecting");
  expect(ui.wsAttempt).toBe(1);
  expect(linkHealth.state).toBe("down");
  expect(linkHealth.outage?.coverAt).toBe(contact + 45_000);

  watcher.status?.("open", 0);
  expect(linkHealth.state).toBe("down");
});

test("a remote desktop window passes its remote flag to the watcher", () => {
  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  history.replaceState(null, "", "/?lib=dev-1");
  resumeWatcher();
  expect(watcher.options).toEqual({ remote: true });
});
