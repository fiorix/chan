// @vitest-environment jsdom

// The exit flush at `pagehide`: the page sends its layout once more with
// `keepalive` unless the server has answered a save of that same layout,
// because the browser cancels an ordinary request with its page.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./caretIndex");

import { api, sessionWindowId } from "../api/client";
import {
  __testResetSessionDiscarded,
  __testResetSessionWrites,
  __testSetBootstrapHydrated,
  __testSetSessionLoad,
  discardWindowSessionLocal,
  installSessionFlushHook,
  onWatchEvent,
  scheduleSessionSave,
} from "./store.svelte";
import { applySessionRoster } from "./session.svelte";
import { cancelPaneMode, layout } from "./tabs.svelte";
import { fileTab, resetLayout } from "../__tests__/tabs";

/// A write the test answers when it chooses.
function heldWrite(): { promise: Promise<void>; answer: () => void; fail: () => void } {
  let answer!: () => void;
  let fail!: () => void;
  const promise = new Promise<void>((resolve, reject) => {
    answer = () => resolve();
    fail = () => reject(new Error("save failed"));
  });
  return { promise, answer, fail };
}

function spyFetch() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
}

let fetchSpy: ReturnType<typeof spyFetch>;

function exitWrites(method: "PUT" | "DELETE"): RequestInit[] {
  return fetchSpy.mock.calls
    .map(([, init]) => init ?? {})
    .filter((init) => init.method === method);
}

async function save(): Promise<void> {
  scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(750);
}

function pagehide(): void {
  window.dispatchEvent(new Event("pagehide"));
}

function peerFrame(): void {
  onWatchEvent({ kind: "session_changed", w: sessionWindowId(), client: "peer-nonce" });
}

beforeEach(() => {
  vi.useFakeTimers();
  cancelPaneMode();
  resetLayout([fileTab()], { id: "pane-exit" });
  discardWindowSessionLocal();
  __testResetSessionDiscarded();
  __testResetSessionWrites();
  __testSetBootstrapHydrated(true);
  fetchSpy = spyFetch();
  installSessionFlushHook();
});

afterEach(async () => {
  cancelPaneMode();
  applySessionRoster({ participants: [], leader: null });
  await vi.runOnlyPendingTimersAsync();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the exit flush", () => {
  test("a save still unanswered when the page goes is sent again with keepalive", async () => {
    const put = vi.spyOn(api, "putSession").mockReturnValue(heldWrite().promise);
    await save();
    expect(put).toHaveBeenCalledTimes(1);

    pagehide();

    const puts = exitWrites("PUT");
    expect(puts, "the unanswered save is sent again").toHaveLength(1);
    expect(puts[0].keepalive).toBe(true);
    expect(JSON.parse(String(puts[0].body))).toEqual(put.mock.calls[0][0]);
  });

  test("a save answered before the page goes is not sent again", async () => {
    vi.spyOn(api, "putSession").mockResolvedValue(undefined);
    await save();

    pagehide();

    expect(exitWrites("PUT")).toHaveLength(0);
  });

  test("a save that failed is sent again by the exit flush", async () => {
    const write = heldWrite();
    vi.spyOn(api, "putSession").mockReturnValue(write.promise);
    await save();
    write.fail();
    await vi.advanceTimersByTimeAsync(0);

    pagehide();

    expect(exitWrites("PUT"), "the failed save is sent again").toHaveLength(1);
  });

  test("an emptied window's DELETE still unanswered when the page goes is sent again", async () => {
    vi.spyOn(api, "putSession").mockResolvedValue(undefined);
    await save();
    vi.spyOn(api, "deleteSession").mockReturnValue(heldWrite().promise);
    resetLayout([], { id: "pane-exit" });
    await save();

    pagehide();

    const deletes = exitWrites("DELETE");
    expect(deletes, "the unanswered DELETE is sent again").toHaveLength(1);
    expect(deletes[0].keepalive).toBe(true);
  });

  test("a save asked for while another is out is sent at exit when the page goes before it", async () => {
    // Layout A is out when the page changes to B: B waits for A's answer, so
    // the page goes with B unsent while the server may hold A.
    const put = vi.spyOn(api, "putSession").mockReturnValue(heldWrite().promise);
    await save();
    layout.focusColor = "green";
    await save();
    expect(put, "B waits for A").toHaveBeenCalledTimes(1);

    pagehide();

    const puts = exitWrites("PUT");
    expect(puts, "the waiting layout is sent at exit").toHaveLength(1);
    expect(JSON.parse(String(puts[0].body)).layout.wc).toBe("g");
  });

  test("a failed save is sent once with keepalive when the page goes before its retry", async () => {
    const write = heldWrite();
    const put = vi.spyOn(api, "putSession").mockReturnValue(write.promise);
    await save();
    write.fail();
    await vi.advanceTimersByTimeAsync(0);
    layout.focusColor = "green";
    scheduleSessionSave();

    pagehide();

    const puts = exitWrites("PUT");
    expect(puts, "one keepalive PUT").toHaveLength(1);
    expect(puts[0].keepalive).toBe(true);
    expect(JSON.parse(String(puts[0].body)).layout.wc, "of the layout as it is").toBe("g");
    expect(put, "the retry is not sent beside it").toHaveBeenCalledTimes(1);
  });

  test("a layout back at an answered save is sent while a newer save is still out", async () => {
    // A is answered, B is still out, and the page goes with A again in the
    // debounce: B can still land, so the server may not hold A.
    const put = vi.spyOn(api, "putSession").mockResolvedValueOnce(undefined).mockReturnValueOnce(heldWrite().promise);
    await save();
    layout.focusColor = "green";
    await save();
    expect(put).toHaveBeenCalledTimes(2);
    layout.focusColor = "blue";
    scheduleSessionSave();

    pagehide();

    const puts = exitWrites("PUT");
    expect(puts, "the layout is sent while the newer save is out").toHaveLength(1);
    expect(JSON.parse(String(puts[0].body))).toEqual(put.mock.calls[0][0]);
  });

  test("a peer's DELETE taken while a save is out keeps the exit flush from writing the blob back", async () => {
    const write = heldWrite();
    vi.spyOn(api, "putSession").mockReturnValue(write.promise);
    await save();
    // A local change waits in the debounce when the peer's DELETE lands; the
    // frame records the current layout as the server's, so neither the
    // pending save nor the older save's late answer makes the flush re-send.
    layout.focusColor = "green";
    scheduleSessionSave();
    onWatchEvent({ kind: "session_changed", w: sessionWindowId(), client: "peer-nonce", deleted: true });
    await vi.advanceTimersByTimeAsync(750);
    write.answer();
    await vi.advanceTimersByTimeAsync(0);

    pagehide();

    expect(exitWrites("PUT")).toHaveLength(0);
  });

  test("a peer's layout applied cleanly is not written back", async () => {
    vi.spyOn(api, "getSession").mockResolvedValue({
      layout: { k: "l", t: [{ p: "notes/a.md", m: "wysiwyg" }], wc: "g" },
    });
    vi.spyOn(api, "putSession").mockResolvedValue(undefined);
    peerFrame();
    await vi.advanceTimersByTimeAsync(250);
    expect(layout.focusColor).toBe("green");

    pagehide();

    expect(exitWrites("PUT")).toHaveLength(0);
  });

  test("a peer's layout the page cannot attach, leaving it empty, is not deleted", async () => {
    vi.spyOn(api, "putSession").mockResolvedValue(undefined);
    await save();
    vi.spyOn(api, "getSession").mockResolvedValue({ layout: { k: "l", t: [{ k: "t", n: "not yet connected" }] } });
    resetLayout([], { id: "pane-exit" });
    peerFrame();
    await vi.advanceTimersByTimeAsync(250);

    pagehide();

    expect(exitWrites("DELETE")).toHaveLength(0);
  });

  test("a page whose load found no blob and that holds no layout sends no DELETE", async () => {
    const previous = __testSetSessionLoad(false);
    try {
      const del = vi.spyOn(api, "deleteSession").mockResolvedValue(undefined);
      resetLayout([], { id: "pane-exit" });
      await save();
      expect(del).not.toHaveBeenCalled();

      pagehide();

      expect(exitWrites("DELETE")).toHaveLength(0);
    } finally {
      __testSetSessionLoad(previous);
    }
  });

  test("a follower's empty view sends no DELETE at exit after its role changes", async () => {
    vi.spyOn(api, "putSession").mockResolvedValue(undefined);
    await save();
    const del = vi.spyOn(api, "deleteSession").mockResolvedValue(undefined);
    applySessionRoster({
      participants: [{ window_id: sessionWindowId(), name: null, role: "follower", status: "live" }],
      leader: "leader-window",
    });
    resetLayout([], { id: "pane-exit" });
    await save();
    expect(del, "the follower leaves the DELETE to the leader").not.toHaveBeenCalled();
    applySessionRoster({ participants: [], leader: null });

    pagehide();

    expect(exitWrites("DELETE"), "the empty view is the follower's, not a DELETE to send").toHaveLength(0);
  });
});
