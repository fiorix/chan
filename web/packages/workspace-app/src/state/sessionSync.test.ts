// @vitest-environment jsdom

// Live co-view session sync: the `session_changed` /ws frame filter and
// the refetch -> reconcile -> echo-suppression pipeline in store.svelte.
// The wire contract (frame shape, nonce echo, omitted `client`, deleted
// variant) is pinned server-side in chan-server's sessions tests; these
// tests pin the receiver's behavior against that contract.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./caretIndex");

import { api, clientNonce, sessionWindowId } from "../api/client";
import {
  __testResetSessionDiscarded,
  __testSetBootstrapHydrated,
  discardWindowSessionLocal,
  onWatchEvent,
  scheduleSessionSave,
} from "./store.svelte";
import {
  cancelPaneMode,
  enterPaneMode,
  layout,
  paneMode,
  type FileTab,
  type LeafNode,
} from "./tabs.svelte";

function fileTab(partial: Partial<FileTab> = {}): FileTab {
  return {
    kind: "file",
    fileKind: "document",
    id: "file-1",
    path: "notes/a.md",
    content: "saved",
    saved: "saved",
    savedMtime: 1,
    mode: "wysiwyg",
    loading: false,
    error: null,
    fileMissing: null,
    inspectorOpen: false,
    outlineOpen: false,
    repoRoot: null,
    readMode: false,
    fsWritable: true,
    styleToolbarOpen: false,
    syntaxHighlight: true,
    highlightTrailingWhitespace: false,
    codeBlocksCollapsed: false,
    ...partial,
  };
}

function resetLayout(): LeafNode {
  const tab = fileTab();
  const pane: LeafNode = {
    kind: "leaf",
    id: "pane-sync",
    tabs: [tab],
    activeTabId: tab.id,
  };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  layout.focusColor = "blue";
  return layout.nodes[pane.id] as LeafNode;
}

/// A remote payload congruent with `resetLayout()`'s tree, carrying one
/// observable in-place change (focus color green).
function remotePayload(): unknown {
  return {
    layout: { k: "l", t: [{ p: "notes/a.md", m: "wysiwyg" }], wc: "g" },
  };
}

function fireFrame(frame: Record<string, unknown>): void {
  onWatchEvent({ kind: "session_changed", ...frame });
}

beforeEach(() => {
  vi.useFakeTimers();
  cancelPaneMode();
  resetLayout();
  // Normalize module state: clear any pending save timer + the dedupe
  // snapshot, then re-arm saves.
  discardWindowSessionLocal();
  __testResetSessionDiscarded();
  __testSetBootstrapHydrated(true);
});

afterEach(async () => {
  cancelPaneMode();
  // Drain armed sync/save timers while the api mocks are still in place,
  // so no callback leaks into the next test's clock.
  await vi.runOnlyPendingTimersAsync();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("session_changed frame filter", () => {
  test("a foreign-nonce frame for this window refetches and reconciles", async () => {
    const getSession = vi
      .spyOn(api, "getSession")
      .mockResolvedValue(remotePayload());

    fireFrame({ w: sessionWindowId(), client: "peer-nonce" });
    expect(getSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);

    expect(getSession).toHaveBeenCalledTimes(1);
    expect(layout.focusColor).toBe("green");
  });

  test("a frame without a client nonce is treated as foreign", async () => {
    const getSession = vi
      .spyOn(api, "getSession")
      .mockResolvedValue(remotePayload());

    fireFrame({ w: sessionWindowId() });
    await vi.advanceTimersByTimeAsync(250);

    expect(getSession).toHaveBeenCalledTimes(1);
  });

  test("drops own-nonce echoes", async () => {
    const getSession = vi
      .spyOn(api, "getSession")
      .mockResolvedValue(remotePayload());

    fireFrame({ w: sessionWindowId(), client: clientNonce() });
    await vi.advanceTimersByTimeAsync(1000);

    expect(getSession).not.toHaveBeenCalled();
  });

  test("drops frames for another window", async () => {
    const getSession = vi
      .spyOn(api, "getSession")
      .mockResolvedValue(remotePayload());

    fireFrame({ w: "someone-elses-window", client: "peer-nonce" });
    await vi.advanceTimersByTimeAsync(1000);

    expect(getSession).not.toHaveBeenCalled();
  });

  test("a deleted frame never refetches or tears down live tabs", async () => {
    const getSession = vi
      .spyOn(api, "getSession")
      .mockResolvedValue(remotePayload());

    fireFrame({ w: sessionWindowId(), client: "peer-nonce", deleted: true });
    await vi.advanceTimersByTimeAsync(1000);

    expect(getSession).not.toHaveBeenCalled();
    expect((layout.nodes[layout.rootId] as LeafNode).tabs).toHaveLength(1);
  });

  test("drops frames before bootstrap hydration", async () => {
    __testSetBootstrapHydrated(false);
    const getSession = vi
      .spyOn(api, "getSession")
      .mockResolvedValue(remotePayload());

    fireFrame({ w: sessionWindowId(), client: "peer-nonce" });
    await vi.advanceTimersByTimeAsync(1000);

    expect(getSession).not.toHaveBeenCalled();
    __testSetBootstrapHydrated(true);
  });

  test("a frame burst coalesces into one refetch", async () => {
    const getSession = vi
      .spyOn(api, "getSession")
      .mockResolvedValue(remotePayload());

    fireFrame({ w: sessionWindowId(), client: "peer-nonce" });
    fireFrame({ w: sessionWindowId(), client: "peer-nonce" });
    fireFrame({ w: sessionWindowId(), client: "peer-nonce" });
    await vi.advanceTimersByTimeAsync(1000);

    expect(getSession).toHaveBeenCalledTimes(1);
  });
});

describe("session sync apply pipeline", () => {
  test("queues only the newest Pane Mode conflict without save-back", async () => {
    enterPaneMode();
    const first = {
      layout: { k: "l", t: [{ p: "notes/a.md" }], wc: "o" },
    };
    const newest = {
      layout: { k: "l", t: [{ p: "notes/a.md" }], wc: "g" },
    };
    vi.spyOn(api, "getSession")
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(newest);
    const putSession = vi.spyOn(api, "putSession").mockResolvedValue(undefined);

    fireFrame({ w: sessionWindowId(), client: "peer-nonce" });
    await vi.advanceTimersByTimeAsync(250);
    expect(paneMode.stale).toBe(true);
    expect(paneMode.pendingRemoteLayout).toEqual(first.layout);
    expect(layout.focusColor).toBe("blue");

    fireFrame({ w: sessionWindowId(), client: "peer-nonce" });
    await vi.advanceTimersByTimeAsync(250);
    expect(paneMode.pendingRemoteLayout).toEqual(newest.layout);
    await vi.advanceTimersByTimeAsync(750);
    expect(putSession).not.toHaveBeenCalled();

    cancelPaneMode();
    expect(layout.focusColor).toBe("green");
    expect(paneMode.pendingRemoteLayout).toBeNull();
    expect(putSession).not.toHaveBeenCalled();
  });

  test("ordinarily reconciles an excluded-only update during Pane Mode", async () => {
    enterPaneMode();
    vi.spyOn(api, "getSession").mockResolvedValue({
      layout: { k: "l", t: [{ p: "notes/a.md", a: 1 }], f: 1, wc: "g" },
    });

    fireFrame({ w: sessionWindowId(), client: "peer-nonce" });
    await vi.advanceTimersByTimeAsync(250);

    expect(paneMode.stale).toBe(false);
    expect(layout.focusColor).toBe("green");
  });

  test("a clean apply pre-seeds the save dedupe so the reactive echo save no-ops", async () => {
    vi.spyOn(api, "getSession").mockResolvedValue(remotePayload());
    const putSession = vi.spyOn(api, "putSession").mockResolvedValue(undefined);

    fireFrame({ w: sessionWindowId(), client: "peer-nonce" });
    await vi.advanceTimersByTimeAsync(250);
    expect(layout.focusColor).toBe("green");

    // The layout mutation retriggers App.svelte's save walk; simulate it.
    scheduleSessionSave();
    await vi.advanceTimersByTimeAsync(750);

    expect(putSession).not.toHaveBeenCalled();
  });

  test("a diverged apply leaves the snapshot unseeded so the local save pushes back", async () => {
    // The live pane holds a dirty tab the remote no longer carries:
    // reconcile keeps it (diverged) and must NOT seed the dedupe, so the
    // trailing local save pushes the kept tab back to the peer.
    const pane = layout.nodes[layout.rootId];
    if (pane?.kind === "leaf") {
      pane.tabs.push(
        fileTab({
          id: "file-dirty",
          path: "notes/dirty.md",
          content: "unsaved edits",
          saved: "old",
        }),
      );
    }
    vi.spyOn(api, "getSession").mockResolvedValue(remotePayload());
    const putSession = vi.spyOn(api, "putSession").mockResolvedValue(undefined);

    fireFrame({ w: sessionWindowId(), client: "peer-nonce" });
    await vi.advanceTimersByTimeAsync(250);

    // The dirty tab survived the apply.
    const tabs = (layout.nodes[layout.rootId] as LeafNode).tabs;
    expect(tabs.some((t) => t.id === "file-dirty")).toBe(true);

    // The push-back is self-arming: the diverged apply invalidates the
    // dedupe snapshot AND schedules the save itself (a keep whose net
    // apply changes nothing locally would otherwise dedupe to silence).
    await vi.advanceTimersByTimeAsync(750);

    expect(putSession).toHaveBeenCalledTimes(1);
  });

  test("an inbound frame racing a pending local save flushes the save and refetches after", async () => {
    const getSession = vi
      .spyOn(api, "getSession")
      .mockResolvedValue(remotePayload());
    const putSession = vi.spyOn(api, "putSession").mockResolvedValue(undefined);

    // Local edit sits in the 750ms debounce...
    scheduleSessionSave();
    // ...when a peer's write lands.
    fireFrame({ w: sessionWindowId(), client: "peer-nonce" });
    await vi.advanceTimersByTimeAsync(250);

    // The pending save was flushed instead of applying the remote blob.
    expect(putSession).toHaveBeenCalledTimes(1);
    expect(getSession).not.toHaveBeenCalled();
    expect(layout.focusColor).toBe("blue");

    // The re-armed refetch then observes post-flush state and applies a
    // genuinely newer peer write.
    await vi.advanceTimersByTimeAsync(250);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(layout.focusColor).toBe("green");
  });

  test("a peer delete stops the echo save from re-persisting the discarded blob", async () => {
    const putSession = vi.spyOn(api, "putSession").mockResolvedValue(undefined);

    // A save sits in the debounce when the peer's DELETE lands: the
    // frame seeds the dedupe with the current serialization, so the
    // pending write (same state) dedupes to nothing, and so does any
    // later save of the unchanged state.
    scheduleSessionSave();
    fireFrame({ w: sessionWindowId(), client: "peer-nonce", deleted: true });
    await vi.advanceTimersByTimeAsync(750);
    expect(putSession).not.toHaveBeenCalled();

    scheduleSessionSave();
    await vi.advanceTimersByTimeAsync(750);
    expect(putSession).not.toHaveBeenCalled();
  });

  test("a peer delete never latches: syncs and new local saves continue", async () => {
    // Both co-viewers of an empty window fire the routine empty-layout
    // DELETE at boot; a hard suppression here would deadlock the pair
    // (neither side could ever PUT again). The deleted frame must only
    // dedupe the echo, not stop the pipeline.
    const getSession = vi
      .spyOn(api, "getSession")
      .mockResolvedValue(remotePayload());
    const putSession = vi.spyOn(api, "putSession").mockResolvedValue(undefined);

    fireFrame({ w: sessionWindowId(), client: "peer-nonce", deleted: true });
    await vi.advanceTimersByTimeAsync(750);

    // A later peer write still syncs...
    fireFrame({ w: sessionWindowId(), client: "peer-nonce" });
    await vi.advanceTimersByTimeAsync(250);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(layout.focusColor).toBe("green");

    // ...and a genuinely new local mutation still saves.
    layout.focusColor = "pink";
    scheduleSessionSave();
    await vi.advanceTimersByTimeAsync(750);
    expect(putSession).toHaveBeenCalledTimes(1);
  });

  test("a local discard is never lifted by a peer write", async () => {
    const getSession = vi
      .spyOn(api, "getSession")
      .mockResolvedValue(remotePayload());

    discardWindowSessionLocal();
    fireFrame({ w: sessionWindowId(), client: "peer-nonce" });
    await vi.advanceTimersByTimeAsync(1000);

    expect(getSession).not.toHaveBeenCalled();
  });

  test("an echo of the blob this window already carries applies nothing", async () => {
    const putSession = vi.spyOn(api, "putSession").mockResolvedValue(undefined);

    // Save once so lastSessionSnapshot holds our serialization.
    scheduleSessionSave();
    await vi.advanceTimersByTimeAsync(750);
    expect(putSession).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(JSON.stringify(putSession.mock.calls[0]![0]));

    // The server hands back exactly that blob.
    const getSession = vi.spyOn(api, "getSession").mockResolvedValue(saved);
    fireFrame({ w: sessionWindowId(), client: "peer-nonce" });
    await vi.advanceTimersByTimeAsync(250);

    expect(getSession).toHaveBeenCalledTimes(1);
    // No state change and no re-save from the no-op apply.
    scheduleSessionSave();
    await vi.advanceTimersByTimeAsync(750);
    expect(putSession).toHaveBeenCalledTimes(1);
  });
});
