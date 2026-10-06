// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../api/errors";

const socket = vi.hoisted(() => ({ ready: null as (() => void) | null }));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    openWatchSocket: (_onEvent: unknown, _onStatus: unknown, onReady?: () => void) => {
      socket.ready = onReady ?? null;
      return Object.assign(() => {}, {
        subscribeDir() {},
        unsubscribeDir() {},
        reportTransfers() {},
        probe() {},
      });
    },
  };
});

let store: typeof import("./store.svelte");
let client: typeof import("../api/client");
let tabs: typeof import("./tabs.svelte");
let fixtures: typeof import("../__tests__/tabs");

beforeEach(async () => {
  vi.resetModules();
  window.history.replaceState(null, "", "/?w=window-root-recovery");
  client = await import("../api/client");
  store = await import("./store.svelte");
  tabs = await import("./tabs.svelte");
  fixtures = await import("../__tests__/tabs");
  vi.spyOn(client.api, "terminalRoster").mockResolvedValue({ sessions: [] } as never);
  vi.spyOn(client.api, "health").mockResolvedValue({ instance: "same" } as never);
  vi.spyOn(client.api, "extensions").mockResolvedValue([]);
  vi.spyOn(client.api, "getSession").mockResolvedValue(null);
  store.reconnectWatcher();
});

afterEach(() => {
  vi.restoreAllMocks();
  fixtures.resetLayout();
  window.history.replaceState(null, "", "/");
});

test("ready detects a coded missing root and preserves dirty file text", async () => {
  const file = fixtures.fileTab({
    id: "dirty",
    path: "notes/a.md",
    content: "unsaved edit",
    saved: "old disk",
    savedMtimeNs: "1",
    mode: "source" as const,
  });
  fixtures.resetLayout([file], { id: "pane" });
  store.tree.entries = [{ path: "notes/a.md", is_dir: false, size: 8, mtime: 1 }];
  const list = vi.spyOn(client.api, "list").mockRejectedValue(
    new ApiError(404, "root gone", { error: "root gone", code: "workspace_root_missing" }),
  );

  socket.ready?.();
  await vi.waitFor(() => expect(store.tree.rootUnavailable).toBe(true));

  expect(list).toHaveBeenCalledTimes(1);
  expect(store.tree.entries).toEqual([]);
  expect(file.fileMissing?.path).toBe("notes/a.md");
  expect(file.content).toBe("unsaved edit");
  expect(file.saved).toBe("old disk");
});

test("overlapping ready and lag cues share one pending root listing", async () => {
  let release!: (entries: Awaited<ReturnType<typeof client.api.list>>) => void;
  const pending = new Promise<Awaited<ReturnType<typeof client.api.list>>>((resolve) => {
    release = resolve;
  });
  const list = vi.spyOn(client.api, "list").mockReturnValue(pending);

  socket.ready?.();
  socket.ready?.();
  store.onWatchEvent({ type: "watch_resync" });
  expect(list).toHaveBeenCalledTimes(1);

  release([]);
  await vi.waitFor(() => expect(store.tree.loadedDirs[""]).toBe(true));
  expect(list).toHaveBeenCalledTimes(1);
});

test("a transient root list failure retries, then stops at a successful listing", async () => {
  const list = vi.spyOn(client.api, "list")
    .mockRejectedValueOnce(new ApiError(503, "temporarily unavailable"))
    .mockResolvedValue([]);

  socket.ready?.();
  await vi.waitFor(() => expect(store.tree.loadedDirs[""]).toBe(true), { timeout: 1500 });
  expect(list).toHaveBeenCalledTimes(2);
});

test("a terminal-only ready does not request a workspace root", async () => {
  vi.resetModules();
  window.history.replaceState(null, "", "/?kind=terminal&w=window-terminal");
  const terminalClient = await import("../api/client");
  const terminalStore = await import("./store.svelte");
  vi.spyOn(terminalClient.api, "terminalRoster").mockResolvedValue({ sessions: [] } as never);
  vi.spyOn(terminalClient.api, "health").mockResolvedValue({ instance: "same" } as never);
  const list = vi.spyOn(terminalClient.api, "list");

  terminalStore.reconnectWatcher();
  socket.ready?.();
  await Promise.resolve();

  expect(list).not.toHaveBeenCalled();
});
