// @vitest-environment jsdom
//
// A remote `chan devserver run` bouncing (^C + re-run) would leave its window
// stale: the watch socket reconnects fine, but the new process has none of the
// old PTYs, so terminals sit stuck until a manual Cmd+R. On every watch-socket
// (re)connect the store reads /api/health's `instance` (a random id per
// process) and reloads the window when it changed. The read retries transient
// failures (a devserver behind a tunnel accepts the socket before its HTTP
// routes settle), and each (re)connect also re-resolves the extension catalog
// so mounted extension frames converge on fresh per-process capabilities even
// when the instance check cannot decide.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { ApiError } from "../api/errors";
import { __testHealthInstanceWithRetry } from "./store.svelte";

const socket = vi.hoisted(() => ({ ready: null as (() => void) | null }));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    // The watch socket is the seam: every (re)connect calls its ready hook.
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

describe("a watch-socket (re)connect", () => {
  let reload: ReturnType<typeof vi.fn>;
  let originalLocation: Location;
  let client: typeof import("../api/client");
  let lifecycle: typeof import("./windowLifecycle.svelte");

  /// A fresh store (so no instance is remembered yet) and its first connect.
  async function connect(): Promise<void> {
    const store = await import("./store.svelte");
    store.reconnectWatcher();
    await reconnect();
  }

  async function reconnect(): Promise<void> {
    socket.ready?.();
    await vi.waitFor(() => expect(client.api.health).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(async () => {
    vi.resetModules();
    client = await import("../api/client");
    lifecycle = await import("./windowLifecycle.svelte");
    vi.spyOn(client.api, "terminalRoster").mockResolvedValue({ sessions: [] } as never);
    vi.spyOn(client.api, "extensions").mockResolvedValue([]);
    reload = vi.fn();
    originalLocation = window.location;
    // jsdom's `location.reload` is non-configurable, so swap the object.
    Object.defineProperty(window, "location", {
      value: { ...originalLocation, reload },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      value: originalLocation,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  test("to the same server process reloads nothing; the first only remembers it", async () => {
    const health = vi.spyOn(client.api, "health").mockResolvedValue({ instance: "a" } as never);
    await connect();
    health.mockClear();
    await reconnect();

    expect(reload).not.toHaveBeenCalled();
  });

  test("to a restarted server process reloads the window", async () => {
    const health = vi.spyOn(client.api, "health").mockResolvedValue({ instance: "a" } as never);
    await connect();
    health.mockClear();
    health.mockResolvedValue({ instance: " b " } as never);
    await reconnect();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("does not reload a window the leader ended", async () => {
    const health = vi.spyOn(client.api, "health").mockResolvedValue({ instance: "a" } as never);
    await connect();
    lifecycle.markWindowDiscarded();
    health.mockClear();
    health.mockResolvedValue({ instance: "b" } as never);
    await reconnect();

    expect(reload).not.toHaveBeenCalled();
  });

  test("drops a superseded check's late answer", async () => {
    const health = vi.spyOn(client.api, "health").mockResolvedValue({ instance: "a" } as never);
    await connect();
    // A reconnect whose health read is slow, then another that answers first.
    let late: (value: { instance: string }) => void = () => {};
    health.mockReset();
    health.mockReturnValueOnce(new Promise((resolve) => (late = resolve)) as never);
    health.mockResolvedValueOnce({ instance: "a" } as never);
    socket.ready?.();
    await reconnect();
    late({ instance: "b" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reload).not.toHaveBeenCalled();
  });

  test("re-resolves the extension catalog every time", async () => {
    vi.spyOn(client.api, "health").mockResolvedValue({ instance: "a" } as never);
    await connect();
    await vi.waitFor(() => expect(client.api.extensions).toHaveBeenCalledTimes(1));
    await reconnect();

    await vi.waitFor(() => expect(client.api.extensions).toHaveBeenCalledTimes(2));
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
