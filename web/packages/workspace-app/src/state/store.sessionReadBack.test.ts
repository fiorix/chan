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
  fixtures.resetLayout([fixtures.fileTab()], { id: "pane-sync" });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  store.reconnectWatcher();
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
