// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GlobalConfig } from "../api/types";
import { ApiError } from "../api/errors";
import { preferences, serveMeta } from "../__tests__/standalone";

const apiConfig = vi.fn<() => Promise<GlobalConfig>>();
const deleteSession = vi.fn<() => Promise<void>>();

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      config: () => apiConfig(),
      workspace: () => Promise.reject(new ApiError(404, "not found")),
      getSession: () => Promise.resolve(null),
      putSession: () => Promise.resolve(),
      deleteSession: () => deleteSession(),
    },
    openWatchSocket: () => () => {},
  };
});

beforeEach(() => {
  vi.resetModules();
  deleteSession.mockReset().mockResolvedValue(undefined);
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
