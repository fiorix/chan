// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GlobalConfig } from "../api/types";
import { ApiError } from "../api/errors";
import { preferences, serveMeta } from "../__tests__/standalone";

const apiConfig = vi.fn<() => Promise<GlobalConfig>>();
const getSession = vi.fn<() => Promise<unknown>>();
const deleteSession = vi.fn<() => Promise<void>>();
const failBeforeSessionRead = vi.fn<() => Promise<never>>();
const socket = vi.hoisted(() => ({ ready: null as (() => void) | null }));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      config: () => apiConfig(),
      workspace: () => failBeforeSessionRead(),
      fsContext: () => failBeforeSessionRead(),
      health: () => Promise.resolve({ instance: "a" }),
      terminalRoster: () => Promise.resolve({ sessions: [] }),
      getSession: () => getSession(),
      putSession: () => Promise.resolve(),
      deleteSession: () => deleteSession(),
    },
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

beforeEach(() => {
  vi.resetModules();
  getSession.mockReset().mockResolvedValue(null);
  deleteSession.mockReset().mockResolvedValue(undefined);
  failBeforeSessionRead.mockReset().mockRejectedValue(new ApiError(401, "unauthorized"));
  apiConfig.mockResolvedValue({ revision: 1, preferences: preferences(), workspaces: [] });
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("a standalone window that loaded no blob sends no DELETE at its first save", async () => {
  window.history.replaceState({}, "", "/?kind=terminal&w=w-empty&seed=0");
  serveMeta("chan-files", false);
  serveMeta("chan-drafts", false);
  const store = await import("./store.svelte");
  await store.bootstrap();

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  store.scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(750);
  expect(deleteSession).not.toHaveBeenCalled();
});

test("a failed session read sends no DELETE at the first empty save", async () => {
  window.history.replaceState({}, "", "/?kind=terminal&w=w-read-failed&seed=0");
  serveMeta("chan-files", false);
  serveMeta("chan-drafts", false);
  getSession.mockRejectedValueOnce(new Error("session unavailable"));
  const store = await import("./store.svelte");
  await store.bootstrap();
  expect(getSession).toHaveBeenCalledTimes(1);
  expect(store.ui.status).toBe("restore failed: session unavailable");

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  store.scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(750);
  expect(deleteSession).not.toHaveBeenCalled();
});

test.each([
  ["standalone filesystem", "/?kind=terminal&w=w-before-read", true],
  ["workspace", "/?w=w-before-read", false],
] as const)("a %s boot stopped before its session read sends no DELETE at its first empty save", async (_kind, url, files) => {
  window.history.replaceState({}, "", url);
  serveMeta("chan-files", files);
  serveMeta("chan-drafts", false);
  const store = await import("./store.svelte");
  await store.bootstrap();
  expect(failBeforeSessionRead).toHaveBeenCalled();
  expect(getSession).not.toHaveBeenCalled();

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  store.scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(750);
  expect(deleteSession).not.toHaveBeenCalled();
});

test("a standalone window that read a blob deletes it at its first empty save", async () => {
  window.history.replaceState({}, "", "/?kind=terminal&w=w-blob&seed=0");
  serveMeta("chan-files", false);
  serveMeta("chan-drafts", false);
  getSession.mockResolvedValueOnce({});
  const store = await import("./store.svelte");
  await store.bootstrap();
  expect(getSession).toHaveBeenCalledTimes(1);

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  store.scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(750);
  expect(deleteSession).toHaveBeenCalledTimes(1);
});

test("a standalone window applies a layout a peer saved before its socket was ready", async () => {
  window.history.replaceState({}, "", "/?kind=terminal&w=w-read-back&seed=0");
  serveMeta("chan-files", false);
  serveMeta("chan-drafts", false);
  const store = await import("./store.svelte");
  await store.bootstrap();
  expect(getSession).toHaveBeenCalledTimes(1);

  getSession.mockResolvedValue({
    layout: { k: "s", d: "r", a: { k: "l", t: [] }, b: { k: "l", t: [] } },
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  socket.ready?.();
  await vi.advanceTimersByTimeAsync(250);
  expect(getSession).toHaveBeenCalledTimes(2);
  const { layout } = await import("./tabs.svelte");
  expect(Object.values(layout.nodes).filter((node) => node.kind === "leaf")).toHaveLength(2);

  store.scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(750);
  expect(deleteSession).not.toHaveBeenCalled();
});
