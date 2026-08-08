// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { ApiError } from "../api/errors";
import { __testHealthInstanceWithRetry } from "./store.svelte";
import storeSource from "./store.svelte.ts?raw";

// A remote `chan devserver` bouncing (^C + re-run) used to leave its
// desktop window stale: the watch socket reconnected fine, but the new
// process had none of the old PTYs, so terminals sat stuck until a
// manual Cmd+R. The store now reads /api/health's `instance` (random
// per-process id) on every watch-socket (re)connect and reloads the
// window when it changed. The read retries transient failures (a
// devserver behind a tunnel accepts the socket before its HTTP routes
// settle) instead of silently skipping the reload decision, and each
// (re)connect also re-resolves the extension catalog so mounted
// extension frames converge on fresh per-process capabilities even when
// the instance check cannot decide. These pins lock that wiring.
describe("server-restart auto-reload", () => {
  const src = storeSource.replace(/\s+/g, " ");

  test("every watch (re)connect checks the server instance and refreshes the extension catalog", () => {
    expect(src).toMatch(
      /function onWatchReady\(\): void \{.*?void checkServerInstance\(\);.*?if \(!ui\.terminalOnly\) void refreshExtensions\(\);/,
    );
  });

  test("the health read goes through the bounded transient retry", () => {
    expect(src).toContain("const instance = await healthInstanceWithRetry()");
    expect(src).toMatch(
      /async function healthInstanceWithRetry\(\): Promise<string \| undefined> \{.*?api\.health\(\)\)\.instance\?\.trim\(\);.*?!isTransientApiError\(e\)\) throw e;.*?250 \* attempt/,
    );
  });

  test("a superseding reconnect drops the older retry loop's late result", () => {
    expect(src).toContain("const generation = ++instanceCheckGeneration;");
    expect(src).toMatch(
      /const instance = await healthInstanceWithRetry\(\); if \(generation !== instanceCheckGeneration\) return;/,
    );
  });

  test("a changed instance reloads the window (unless a leader teardown overlay shows); the first read only seeds", () => {
    expect(src).toMatch(
      /if \(serverInstance === null\) \{ serverInstance = instance; return; \}/,
    );
    expect(src).toMatch(
      /if \(serverInstance !== instance\) \{.*?if \(isWindowEnded\(\)\) return; window\.location\.reload\(\);/,
    );
  });
});

describe("healthInstanceWithRetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("retries transient failures, then returns the trimmed instance", async () => {
    vi.useFakeTimers();
    const health = vi
      .spyOn(api, "health")
      .mockRejectedValueOnce(new ApiError(503, "unavailable"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ instance: " x1 " });
    const promise = __testHealthInstanceWithRetry();
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("x1");
    expect(health).toHaveBeenCalledTimes(3);
  });

  test("a non-transient failure throws immediately, no retry", async () => {
    const health = vi
      .spyOn(api, "health")
      .mockRejectedValue(new ApiError(404, "not found"));
    await expect(__testHealthInstanceWithRetry()).rejects.toMatchObject({
      status: 404,
    });
    expect(health).toHaveBeenCalledTimes(1);
  });

  test("persistent transient failure gives up after 5 attempts", async () => {
    vi.useFakeTimers();
    const health = vi
      .spyOn(api, "health")
      .mockRejectedValue(new ApiError(502, "bad gateway"));
    const promise = __testHealthInstanceWithRetry();
    const rejection = expect(promise).rejects.toMatchObject({ status: 502 });
    await vi.runAllTimersAsync();
    await rejection;
    expect(health).toHaveBeenCalledTimes(5);
  });
});
