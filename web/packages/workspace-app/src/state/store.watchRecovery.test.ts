// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";

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
let errors: typeof import("../api/errors");
let fixtures: typeof import("../__tests__/tabs");

beforeEach(async () => {
  vi.resetModules();
  window.history.replaceState(null, "", "/?w=window-root-recovery");
  client = await import("../api/client");
  errors = await import("../api/errors");
  store = await import("./store.svelte");
  fixtures = await import("../__tests__/tabs");
  vi.spyOn(client.api, "terminalRoster").mockResolvedValue({ sessions: [] } as never);
  vi.spyOn(client.api, "health").mockResolvedValue({ instance: "same" } as never);
  vi.spyOn(client.api, "extensions").mockResolvedValue([]);
  vi.spyOn(client.api, "getSession").mockResolvedValue(null);
  store.resumeWatcher();
});

afterEach(() => {
  store.teardown();
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
    new errors.ApiError(404, "root gone", { error: "root gone", code: "workspace_root_missing" }),
  );

  socket.ready?.();
  await vi.waitFor(() => expect(store.tree.rootUnavailable).toBe(true));

  expect(list).toHaveBeenCalledTimes(1);
  expect(store.tree.entries).toEqual([]);
  const live = fixtures.readTab("dirty");
  expect(live?.fileMissing?.path).toBe("notes/a.md");
  expect(live?.content).toBe("unsaved edit");
  expect(live?.saved).toBe("old disk");
});

test("overlapping ready and lag cues share one bounded root-list chain", async () => {
  let release!: (entries: Awaited<ReturnType<typeof client.api.list>>) => void;
  const pending = new Promise<Awaited<ReturnType<typeof client.api.list>>>((resolve) => {
    release = resolve;
  });
  const list = vi.spyOn(client.api, "list").mockReturnValueOnce(pending).mockResolvedValue([]);

  socket.ready?.();
  socket.ready?.();
  store.onWatchEvent({ type: "watch_resync" });
  expect(list).toHaveBeenCalledTimes(1);

  release([]);
  await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  expect(store.tree.loadedDirs[""]).toBe(true);
});

test("a transient root list failure retries, then stops at a successful listing", async () => {
  const list = vi.spyOn(client.api, "list")
    .mockRejectedValueOnce(new errors.ApiError(503, "temporarily unavailable"))
    .mockResolvedValue([]);

  socket.ready?.();
  await vi.waitFor(() => expect(store.tree.loadedDirs[""]).toBe(true), { timeout: 1500 });
  expect(list).toHaveBeenCalledTimes(2);
});

test("a nontransient root list failure stops after one attempt", async () => {
  const list = vi.spyOn(client.api, "list").mockRejectedValue(new errors.ApiError(401, "unauthorized"));

  socket.ready?.();
  await vi.waitFor(() => expect(store.tree.error).toBe("unauthorized"));
  expect(list).toHaveBeenCalledTimes(1);
});

test("transient retries stop after five attempts", async () => {
  const list = vi.spyOn(client.api, "list").mockRejectedValue(new errors.ApiError(503, "temporarily unavailable"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    socket.ready?.();
    expect(list).toHaveBeenCalledTimes(1);
    // Let both async catch layers arm the first retry before advancing time.
    await vi.advanceTimersByTimeAsync(0);
    for (const [wait, expected] of [[250, 2], [500, 3], [750, 4], [1000, 5]] as const) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(list).toHaveBeenCalledTimes(expected - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(list).toHaveBeenCalledTimes(expected);
    }
    await vi.advanceTimersByTimeAsync(3_000);
    expect(list).toHaveBeenCalledTimes(5);
  } finally {
    vi.useRealTimers();
  }
});

test("teardown cancels a root-list retry", async () => {
  const list = vi.spyOn(client.api, "list").mockRejectedValue(new errors.ApiError(503, "temporarily unavailable"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    socket.ready?.();
    await Promise.resolve();
    expect(list).toHaveBeenCalledTimes(1);
    store.teardown();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(list).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test("a terminal-only ready does not request a workspace root", async () => {
  vi.resetModules();
  window.history.replaceState(null, "", "/?kind=terminal&w=window-terminal");
  const terminalClient = await import("../api/client");
  const terminalStore = await import("./store.svelte");
  vi.spyOn(terminalClient.api, "terminalRoster").mockResolvedValue({ sessions: [] } as never);
  vi.spyOn(terminalClient.api, "health").mockResolvedValue({ instance: "same" } as never);
  const list = vi.spyOn(terminalClient.api, "list");

  terminalStore.resumeWatcher();
  socket.ready?.();
  terminalStore.onWatchEvent({ type: "watch_resync" });
  await Promise.resolve();

  expect(list).not.toHaveBeenCalled();
  terminalStore.teardown();
});
