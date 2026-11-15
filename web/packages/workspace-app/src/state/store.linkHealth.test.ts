// @vitest-environment jsdom

// The store is where the watcher and the window's link state meet: it opens
// the watcher on the window's link probe and passes each status on. The
// watcher itself is replaced here by one that records what it was opened with.

import { afterEach, expect, test, vi } from "vitest";

const watcher = vi.hoisted(() => ({
  status: null as ((status: "connecting" | "open" | "reconnecting", attempt: number) => void) | null,
  link: undefined as unknown,
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
    ) => {
      watcher.status = onStatus;
      watcher.link = link;
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
});

test("the store opens its watcher on the window's link probe and reports each status", () => {
  resumeWatcher();
  expect(watcher.link).toBe(watchLinkProbe);

  watcher.status?.("connecting", 0);
  watcher.status?.("open", 0);
  expect(ui.ws).toBe("open");
  expect(linkHealth.state).toBe("unknown");

  watcher.status?.("reconnecting", 1);
  expect(ui.ws).toBe("reconnecting");
  expect(ui.wsAttempt).toBe(1);
  expect(linkHealth.state).toBe("down");

  watcher.status?.("open", 0);
  expect(linkHealth.state).toBe("unknown");
});
