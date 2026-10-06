// @vitest-environment jsdom

// File Browser scoped-subscription manager. Tests pin the cross-instance
// refcount behaviour:
//   * sub1(dir) emits a wire `sub`,
//   * sub2(dir) from a second instance REUSES it (no second `sub`),
//   * unsub by the first instance keeps the scope (refcount 2 -> 1, no
//     `unsub`),
//   * unsub by the last instance tears it down (refcount 1 -> 0, one
//     `unsub`),
//   * disposing an instance unsubscribes every dir it held (so a closed
//     pane cannot leak server-side watchers),
//   * a reconnect replays the union of all instances' scopes.
// The manager talks to the live watcher socket via `watchSubscription()`;
// the test uses a controllable fake WebSocket (jsdom has no WebSocket).

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { trackTimers, type TimerTrack } from "../demo/timers";
import {
  fbWatchRegister,
  fbWatchSubscribe,
  fbWatchUnsubscribe,
  fbWatchReconcile,
  fbWatchDispose,
  fbWatchResyncAll,
} from "./fbWatch.svelte";
import { fbTreeInstances, resumeWatcher, teardown } from "./store.svelte";
import type { WsClientFrame } from "../api/types";

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3; // CLOSED
  }
}

function latest(): FakeWebSocket {
  const ws = FakeWebSocket.instances.at(-1);
  if (!ws) throw new Error("no socket opened");
  return ws;
}

function frames(ws: FakeWebSocket): WsClientFrame[] {
  return ws.sent.map((s) => JSON.parse(s) as WsClientFrame);
}

/// Frames excluding the implicit root (`""`) sub, which several entry
/// points emit idempotently; the refcount assertions care about real
/// directory scopes.
function dirFrames(ws: FakeWebSocket): WsClientFrame[] {
  return frames(ws).filter((f) => f.type !== "transfers" && f.dir !== "");
}

let socket: FakeWebSocket;
let timers: TimerTrack | null = null;

beforeEach(() => {
  timers = trackTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  vi.spyOn(api, "getSession").mockResolvedValue(null);
  vi.spyOn(api, "list").mockResolvedValue([]);
  window.history.replaceState(null, "", "/");
  fbTreeInstances.byId = {};
  resumeWatcher();
  socket = latest();
  socket.open();
});

afterEach(() => {
  teardown();
  vi.unstubAllGlobals();
  fbTreeInstances.byId = {};
  vi.restoreAllMocks();
  timers?.release();
  timers = null;
});

describe("fbWatch scoped subscription manager", () => {
  test("register subscribes the instance to the workspace root", () => {
    fbWatchRegister("fb-a");
    expect(frames(socket)).toContainEqual({ type: "sub", dir: "" });
  });

  test("sub1/sub2/unsub1/unsub2 refcount: one sub, one unsub", () => {
    fbWatchRegister("fb-a");
    fbWatchRegister("fb-b");
    socket.sent = [];

    // sub1: first instance to watch the dir -> exactly one wire `sub`.
    fbWatchSubscribe("fb-a", "notes");
    expect(dirFrames(socket)).toEqual([{ type: "sub", dir: "notes" }]);

    // sub2: second instance reuses the scope -> no new wire frame.
    fbWatchSubscribe("fb-b", "notes");
    expect(dirFrames(socket)).toEqual([{ type: "sub", dir: "notes" }]);

    // unsub1: the original subscriber drops it; refcount 2 -> 1, scope
    // stays alive -> no wire `unsub`.
    fbWatchUnsubscribe("fb-a", "notes");
    expect(dirFrames(socket)).toEqual([{ type: "sub", dir: "notes" }]);

    // unsub2: the last subscriber drops it; refcount 1 -> 0 -> one
    // wire `unsub`.
    fbWatchUnsubscribe("fb-b", "notes");
    expect(dirFrames(socket)).toEqual([
      { type: "sub", dir: "notes" },
      { type: "unsub", dir: "notes" },
    ]);
  });

  test("a single instance re-subscribing the same dir is idempotent", () => {
    fbWatchRegister("fb-a");
    socket.sent = [];
    fbWatchSubscribe("fb-a", "notes");
    fbWatchSubscribe("fb-a", "notes");
    expect(dirFrames(socket)).toEqual([{ type: "sub", dir: "notes" }]);
  });

  test("dispose unsubscribes every dir the instance held (no leak)", () => {
    fbWatchRegister("fb-a");
    fbWatchSubscribe("fb-a", "notes");
    fbWatchSubscribe("fb-a", "tasks");
    socket.sent = [];

    fbWatchDispose("fb-a");
    const sent = dirFrames(socket);
    expect(sent).toContainEqual({ type: "unsub", dir: "notes" });
    expect(sent).toContainEqual({ type: "unsub", dir: "tasks" });
    expect(fbTreeInstances.byId["fb-a"]).toBeUndefined();
  });

  test("dispose with a peer still subscribed keeps the shared scope", () => {
    fbWatchRegister("fb-a");
    fbWatchRegister("fb-b");
    fbWatchSubscribe("fb-a", "notes");
    fbWatchSubscribe("fb-b", "notes");
    socket.sent = [];

    fbWatchDispose("fb-a");
    // fb-b still watches `notes`, so no `unsub` goes out.
    expect(dirFrames(socket)).toEqual([]);
  });

  test("reconcile diffs the expanded set: subscribe added, unsubscribe removed", () => {
    fbWatchRegister("fb-a");
    socket.sent = [];

    fbWatchReconcile("fb-a", ["notes", "tasks"]);
    expect(dirFrames(socket)).toEqual([
      { type: "sub", dir: "notes" },
      { type: "sub", dir: "tasks" },
    ]);
    socket.sent = [];

    // Collapse `tasks`, keep `notes`: one `unsub`, no churn on `notes`.
    fbWatchReconcile("fb-a", ["notes"]);
    expect(dirFrames(socket)).toEqual([{ type: "unsub", dir: "tasks" }]);
  });

  test("resync replays the union of all instances' scopes after reconnect", () => {
    fbWatchRegister("fb-a");
    fbWatchRegister("fb-b");
    fbWatchSubscribe("fb-a", "notes");
    fbWatchSubscribe("fb-b", "tasks");
    fbWatchSubscribe("fb-b", "notes"); // shared dir, sent once on resync

    // Simulate a reconnect: a fresh socket starts with an empty server
    // registry, so resync must replay every desired scope.
    socket.close();
    socket.onclose?.();
    resumeWatcher();
    const fresh = latest();
    fresh.open();
    fresh.sent = [];

    fbWatchResyncAll();
    const sent = frames(fresh);
    expect(sent).toContainEqual({ type: "sub", dir: "" });
    expect(sent).toContainEqual({ type: "sub", dir: "notes" });
    expect(sent).toContainEqual({ type: "sub", dir: "tasks" });
    // `notes` is shared by two instances but replayed exactly once.
    expect(sent.filter((f) => f.type !== "transfers" && f.dir === "notes")).toHaveLength(1);
  });
});
