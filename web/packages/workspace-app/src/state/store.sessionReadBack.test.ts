// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("./caretIndex");

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
      });
    },
  };
});

let client: typeof import("../api/client");
let store: typeof import("./store.svelte");
let tabs: typeof import("./tabs.svelte");
let fixtures: typeof import("../__tests__/tabs");

function remotePayload(): unknown {
  return { layout: { k: "l", t: [{ p: "notes/a.md", m: "wysiwyg" }], wc: "g" } };
}

beforeEach(async () => {
  vi.resetModules();
  window.history.replaceState({}, "", "/?w=window-read-back");
  client = await import("../api/client");
  store = await import("./store.svelte");
  tabs = await import("./tabs.svelte");
  fixtures = await import("../__tests__/tabs");
  vi.spyOn(client.api, "terminalRoster").mockResolvedValue({ sessions: [] } as never);
  vi.spyOn(client.api, "health").mockResolvedValue({ instance: "a" } as never);
  vi.spyOn(client.api, "extensions").mockResolvedValue([]);
  vi.spyOn(client.api, "list").mockResolvedValue([]);
  fixtures.resetLayout([fixtures.fileTab()], { id: "pane-sync" });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  store.resumeWatcher();
});

afterEach(async () => {
  await vi.runOnlyPendingTimersAsync();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("the first ready reads the session back and a later ready reads nothing", async () => {
  const getSession = vi.spyOn(client.api, "getSession").mockResolvedValue(remotePayload());
  const putSession = vi.spyOn(client.api, "putSession").mockResolvedValue(undefined);
  const deleteSession = vi.spyOn(client.api, "deleteSession").mockResolvedValue(undefined);

  socket.ready?.();
  expect(getSession).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(250);
  expect(getSession, "the first ready").toHaveBeenCalledTimes(1);
  expect(tabs.layout.focusColor).toBe("green");

  getSession.mockResolvedValue({ layout: { k: "l", t: [{ p: "notes/a.md", m: "wysiwyg" }], wc: "p" } });
  socket.ready?.();
  await vi.advanceTimersByTimeAsync(1000);
  expect(getSession, "a later ready").toHaveBeenCalledTimes(1);
  expect(tabs.layout.focusColor).toBe("green");
  expect(putSession).not.toHaveBeenCalled();
  expect(deleteSession).not.toHaveBeenCalled();
});

test("an unchanged blob costs one read, applies nothing and sends nothing", async () => {
  const putSession = vi.spyOn(client.api, "putSession").mockResolvedValue(undefined);
  const deleteSession = vi.spyOn(client.api, "deleteSession").mockResolvedValue(undefined);
  store.scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(750);
  expect(putSession).toHaveBeenCalledTimes(1);
  const saved = JSON.parse(JSON.stringify(putSession.mock.calls[0]![0]));
  const getSession = vi.spyOn(client.api, "getSession").mockResolvedValue(saved);

  socket.ready?.();
  await vi.advanceTimersByTimeAsync(250);
  expect(getSession).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(getSession).toHaveBeenCalledTimes(1);
  expect(putSession).toHaveBeenCalledTimes(1);
  expect(deleteSession).not.toHaveBeenCalled();
  expect(tabs.layout.focusColor).toBe("blue");
});

test("a discarded window reads nothing", async () => {
  store.discardWindowSessionLocal();
  const getSession = vi.spyOn(client.api, "getSession").mockResolvedValue(remotePayload());
  socket.ready?.();
  await vi.advanceTimersByTimeAsync(1000);
  expect(getSession).not.toHaveBeenCalled();
  expect(tabs.layout.focusColor).toBe("blue");
});

test("a pending local save is sent before the blob is read", async () => {
  const getSession = vi.spyOn(client.api, "getSession").mockResolvedValue(remotePayload());
  const putSession = vi.spyOn(client.api, "putSession").mockResolvedValue(undefined);
  store.scheduleSessionSave();
  socket.ready?.();
  await vi.advanceTimersByTimeAsync(250);
  expect(putSession).toHaveBeenCalledTimes(1);
  expect(getSession).not.toHaveBeenCalled();
  expect(tabs.layout.focusColor).toBe("blue");
  await vi.advanceTimersByTimeAsync(250);
  expect(getSession).toHaveBeenCalledTimes(1);
  expect(tabs.layout.focusColor).toBe("green");
});

test.each(["move-out", "close"] as const)("a co-viewer blob cannot recreate a terminal after a local %s with a save in flight", async (intent) => {
  const terminal = fixtures.terminalTab({ id: "term-move", terminalSessionId: "session-move" });
  const pane = fixtures.resetLayout([terminal, fixtures.fileTab()], { id: "pane-sync" });
  const putSession = vi.spyOn(client.api, "putSession").mockResolvedValue(undefined);
  store.scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(750);
  const peerBlob = structuredClone(putSession.mock.calls[0]![0]);

  let releasePut!: () => void;
  const putHeld = new Promise<void>((resolve) => { releasePut = resolve; });
  let diskBlob = peerBlob;
  putSession.mockImplementation(async (payload) => {
    await putHeld;
    diskBlob = structuredClone(payload);
  });
  const getSession = vi.spyOn(client.api, "getSession").mockImplementation(async () => structuredClone(diskBlob));

  store.onWatchEvent({ kind: "session_changed", w: "window-read-back", client: "peer" });
  await vi.advanceTimersByTimeAsync(160);
  if (intent === "move-out") tabs.markTerminalMovingOut(terminal.id);
  await tabs.closeTab(pane.id, terminal.id, { force: true });
  store.scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(90);
  expect(putSession).toHaveBeenCalledTimes(2);

  try {
    await vi.advanceTimersByTimeAsync(250);
    expect(
      tabs.activePane().tabs.some((tab) => tab.kind === "terminal" && tab.terminalSessionId === "session-move"),
      "the older co-viewer blob must not recreate the removed terminal",
    ).toBe(false);
    expect(getSession, "refetch waits for the local PUT").not.toHaveBeenCalled();
  } finally {
    releasePut();
  }

  await vi.advanceTimersByTimeAsync(250);
  expect(getSession).toHaveBeenCalledTimes(1);
  expect(tabs.activePane().tabs.every((tab) => tab.kind !== "terminal")).toBe(true);
});

test("an emptied window waits for its DELETE before reading the session back", async () => {
  const terminal = fixtures.terminalTab({ id: "term-move", terminalSessionId: "session-move" });
  const pane = fixtures.resetLayout([terminal], { id: "pane-sync" });
  const putSession = vi.spyOn(client.api, "putSession").mockResolvedValue(undefined);
  store.scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(750);
  expect(putSession).toHaveBeenCalledTimes(1);
  let diskBlob: unknown = structuredClone(putSession.mock.calls[0]![0]);

  let releaseDelete!: () => void;
  const deleteHeld = new Promise<void>((resolve) => { releaseDelete = resolve; });
  const deleteSession = vi.spyOn(client.api, "deleteSession").mockImplementation(async () => {
    await deleteHeld;
    diskBlob = null;
  });
  const getSession = vi.spyOn(client.api, "getSession").mockImplementation(async () => structuredClone(diskBlob));

  store.onWatchEvent({ kind: "session_changed", w: "window-read-back", client: "peer" });
  await vi.advanceTimersByTimeAsync(160);
  tabs.markTerminalMovingOut(terminal.id);
  await tabs.closeTab(pane.id, terminal.id, { force: true });
  store.scheduleSessionSave();
  try {
    await vi.advanceTimersByTimeAsync(90);
    expect(deleteSession).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(getSession, "refetch waits for the local DELETE").not.toHaveBeenCalled();
  } finally {
    releaseDelete();
  }

  await vi.advanceTimersByTimeAsync(250);
  expect(getSession).toHaveBeenCalledTimes(1);
  expect(tabs.activePane().tabs.every((tab) => tab.kind !== "terminal")).toBe(true);
  expect(putSession).toHaveBeenCalledTimes(1);
  expect(deleteSession).toHaveBeenCalledTimes(1);
});

test("a rejected debounce save leaves no unhandled rejection", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("write failed"));
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  // Rejected promises reach Node's process in jsdom, not its window.
  const runner = globalThis as unknown as {
    process: {
      on: (event: "unhandledRejection", fn: (reason: unknown) => void) => void;
      off: (event: "unhandledRejection", fn: (reason: unknown) => void) => void;
    };
  };
  runner.process.on("unhandledRejection", onUnhandled);
  try {
    store.scheduleSessionSave();
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(750);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/session?w=window-read-back&client="),
      expect.objectContaining({ method: "PUT" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(unhandled, "the debounce caller handles a rejected save").toEqual([]);
  } finally {
    runner.process.off("unhandledRejection", onUnhandled);
  }
});

test("a failed local flush does not refetch the older co-viewer blob", async () => {
  const terminal = fixtures.terminalTab({ id: "term-move", terminalSessionId: "session-move" });
  const pane = fixtures.resetLayout([terminal, fixtures.fileTab()], { id: "pane-sync" });
  const putSession = vi.spyOn(client.api, "putSession").mockResolvedValue(undefined);
  store.scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(750);
  const peerBlob = structuredClone(putSession.mock.calls[0]![0]);
  putSession.mockRejectedValueOnce(new Error("write failed"));
  const getSession = vi.spyOn(client.api, "getSession").mockResolvedValue(peerBlob);

  store.onWatchEvent({ kind: "session_changed", w: "window-read-back", client: "peer" });
  await vi.advanceTimersByTimeAsync(160);
  tabs.markTerminalMovingOut(terminal.id);
  await tabs.closeTab(pane.id, terminal.id, { force: true });
  store.scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(90);
  await vi.advanceTimersByTimeAsync(250);

  expect(putSession).toHaveBeenCalledTimes(2);
  expect(getSession, "a failed flush must not fetch the old blob").not.toHaveBeenCalled();
  expect(tabs.activePane().tabs.every((tab) => tab.kind !== "terminal")).toBe(true);
});

test("a window that found no blob sends no DELETE and no PUT", async () => {
  store.__testSetSessionLoad(false);
  fixtures.resetLayout([], { id: "pane-sync" });
  vi.spyOn(client.api, "getSession").mockResolvedValue(null);
  const putSession = vi.spyOn(client.api, "putSession").mockResolvedValue(undefined);
  const deleteSession = vi.spyOn(client.api, "deleteSession").mockResolvedValue(undefined);
  store.scheduleSessionSave();
  socket.ready?.();
  await vi.advanceTimersByTimeAsync(250);
  await vi.advanceTimersByTimeAsync(250);
  await vi.advanceTimersByTimeAsync(750);
  expect(deleteSession).not.toHaveBeenCalled();
  expect(putSession).not.toHaveBeenCalled();
});

test("a ready before hydration reads nothing", async () => {
  store.__testSetBootstrapHydrated(false);
  const getSession = vi.spyOn(client.api, "getSession").mockResolvedValue(remotePayload());
  socket.ready?.();
  await vi.advanceTimersByTimeAsync(1000);
  expect(getSession).not.toHaveBeenCalled();
});
