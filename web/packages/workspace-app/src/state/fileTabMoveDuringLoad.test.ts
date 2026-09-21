// @vitest-environment jsdom
//
// A file tab that moves while its content is still downloading has to end up
// showing that content, wherever it now is, and no tab may be left claiming to
// be loading when no load is running.
//
// The load resolves its tab on every chunk, because a Svelte 5 mutation
// through the object it started with does not reach the array element. Moving
// a tab to another pane, to the other side, or through a Hybrid Nav commit
// each replaces that element, so what the load resolves through decides
// whether it can still find it. Only the cross-pane move defeats a lookup
// scoped to one pane; the side switch is found because such a lookup searches
// both sides of its pane node, and a commit is found because the pane id
// outlives the tab object. The two that were never broken are here as guards,
// each with an assertion that it really happened, so they cannot pass by not
// happening.
//
// The close cases are the other half of the contract. A removal is the only
// thing that can end a load: the reader learns its tab is gone on its next
// callback, which may never come, and a reopen puts the same tab id back
// within reach of a read still parked from before.
//
// Each case parks the stream, acts, and then releases it, so the action lands
// strictly inside the download. `pausedRead` chooses where it parks.

import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "../api/client";
import { confirmState, resolveConfirm } from "./confirm.svelte";
import {
  activePane,
  canReopenClosedTab,
  closeTab,
  closeTabsInPane,
  commitPaneMode,
  enterPaneMode,
  layout,
  moveTab,
  openInPane,
  paneModeSetGrab,
  registerTerminalInputSink,
  reloadTabFromDisk,
  reopenClosedTab,
  splitPane,
  type FileTab,
  type LeafNode,
  type Tab,
} from "./tabs.svelte";

const PANE_ID = "pane-load-move";
const PATH = "notes/slow.md";
/// A draft path, so the single close routes through the draft flow, which is
/// the one refusal a file tab mid-load can reach.
const DRAFT_PATH = ".Drafts/untitled-probe/draft.md";

afterEach(() => {
  vi.restoreAllMocks();
});

function resetLayout(): LeafNode {
  const pane: LeafNode = {
    kind: "leaf",
    id: PANE_ID,
    tabs: [],
    activeTabId: null,
  };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  layout.focusColor = "blue";
  return layout.nodes[pane.id] as LeafNode;
}

/// A read that parks partway and finishes only when released, so a test can
/// put a move or a close strictly inside the download.
///
/// `park` chooses where it stops. `after-first-chunk` has content on the tab
/// already, which is what the move cases want to see survive. `after-meta`
/// stops before any chunk has been written, which is the timing acceptance 1
/// names and the only point at which the reader has not yet had a chance to
/// notice anything about its tab.
function pausedRead(
  park: "after-meta" | "after-first-chunk" = "after-first-chunk",
  /// The two halves this read delivers. A second read in the same test needs
  /// its own, or two completions landing on one tab look identical and a
  /// collision between them cannot be seen.
  halves: [string, string] = ["# part", "ial"],
): {
  release: () => void;
  signal: () => AbortSignal | undefined;
} {
  const whole = halves[0] + halves[1];
  let release: () => void = () => {};
  let signal: AbortSignal | undefined;
  vi.spyOn(api, "readStream").mockImplementation(async (_path, opts) => {
    signal = opts?.signal ?? undefined;
    opts?.onMeta?.({
      path: PATH,
      mtime: 10,
      mtime_ns: "10",
      authority_version: 7,
      disk_conflicted: false,
      writable: true,
      size: 9,
    });
    if (park === "after-first-chunk") {
      opts?.onChunk?.(halves[0], { loadedBytes: 6, totalBytes: 9 });
    }
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    if (park === "after-meta") {
      opts?.onChunk?.(halves[0], { loadedBytes: 6, totalBytes: 9 });
    }
    opts?.onChunk?.(halves[1], { loadedBytes: 9, totalBytes: 9 });
    return {
      path: PATH,
      content: whole,
      mtime: 10,
      mtime_ns: "10",
      authority_version: 7,
      disk_conflicted: false,
      writable: true,
    };
  });
  return { release: () => release(), signal: () => signal };
}

/// The tab the layout holds now, found by id wherever it ended up. Reading it
/// out of `layout` is the point: a move replaces the object, so the handle the
/// test opened with is not what the app is rendering.
function liveTab(tabId: string): FileTab {
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    const found = ([...node.tabs, ...(node.bTabs ?? [])] as Tab[]).find(
      (t) => t.id === tabId,
    );
    if (found?.kind === "file") return found;
  }
  throw new Error(`tab ${tabId} is not in the layout`);
}

/// Open the file and stop where the paused read parks, the state each case
/// acts from.
async function startLoad(
  park: "after-meta" | "after-first-chunk" = "after-first-chunk",
): Promise<{ tabId: string; opened: Promise<unknown> }> {
  const pane = resetLayout();
  const opened = openInPane(pane.id, PATH);
  const tabId = activePane().tabs[0]!.id;
  if (park === "after-first-chunk") {
    await vi.waitFor(() => expect(liveTab(tabId).content).toBe("# part"));
  } else {
    // The meta has landed and no chunk has: the size is on the tab, the
    // content is not.
    await vi.waitFor(() =>
      expect(liveTab(tabId).loadProgress).toEqual({ loadedBytes: 0, totalBytes: 9 }),
    );
    expect(liveTab(tabId).content, "no chunk has been written yet").toBe("");
  }
  expect(liveTab(tabId).loading, "the load is in flight").toBe(true);
  return { tabId, opened };
}

describe("a file tab that moves mid-load still finishes loading", () => {
  test("moved to another pane", async () => {
    const { release } = pausedRead();
    const { tabId, opened } = await startLoad();
    const otherPaneId = splitPane(PANE_ID, "row");
    expect(otherPaneId, "the split gave us a second pane").not.toBeNull();

    moveTab(PANE_ID, tabId, otherPaneId!);
    release();
    await opened;

    const moved = liveTab(tabId);
    expect(moved.content).toBe("# partial");
    expect(moved.loading).toBe(false);
    expect(moved.loadProgress).toBeUndefined();
  });

  test("moved to another pane before the first chunk", async () => {
    // The timing acceptance 1 names. Nothing has been written to the tab yet,
    // so the reader has had no occasion to notice anything about it, and the
    // whole download still has to land in the pane the tab moved to.
    const { release } = pausedRead("after-meta");
    const { tabId, opened } = await startLoad("after-meta");
    const otherPaneId = splitPane(PANE_ID, "row");
    expect(otherPaneId, "the split gave us a second pane").not.toBeNull();

    moveTab(PANE_ID, tabId, otherPaneId!);
    release();
    await opened;

    const moved = liveTab(tabId);
    expect(moved.content).toBe("# partial");
    expect(moved.loading).toBe(false);
    expect(moved.loadProgress).toBeUndefined();
  });

  test("moved to the other side of a split", async () => {
    const { release } = pausedRead();
    const { tabId, opened } = await startLoad();

    moveTab(PANE_ID, tabId, PANE_ID, undefined, {
      fromSide: "a",
      toSide: "b",
    });
    // Non-vacuity: the tab really crossed to the other side, and the object
    // the load started against was replaced by the clone the move makes.
    const node = layout.nodes[PANE_ID] as LeafNode;
    expect(node.tabs.map((t) => t.id)).not.toContain(tabId);
    expect((node.bTabs ?? []).map((t) => t.id)).toContain(tabId);
    release();
    await opened;

    const moved = liveTab(tabId);
    expect(moved.content).toBe("# partial");
    expect(moved.loading).toBe(false);
    expect(moved.loadProgress).toBeUndefined();
  });

  test("carried through a Hybrid Nav commit", async () => {
    const { release } = pausedRead();
    const { tabId, opened } = await startLoad();

    // The commit rebuilds the layout from its draft, so the tab the load
    // started against is replaced even though it never left its pane.
    const before = liveTab(tabId);
    enterPaneMode();
    paneModeSetGrab(PANE_ID);
    commitPaneMode();
    // Non-vacuity: a commit that handed back the same object would make this
    // case a second copy of the plain-load test.
    expect(liveTab(tabId)).not.toBe(before);
    release();
    await opened;

    const moved = liveTab(tabId);
    expect(moved.content).toBe("# partial");
    expect(moved.loading).toBe(false);
    expect(moved.loadProgress).toBeUndefined();
  });
});

describe("a load whose tab is closed leaves nothing behind", () => {
  test("the close itself ends the read, with no later chunk needed", async () => {
    // The close has to cancel the download. Observing the signal while the
    // stream is still parked is what separates that from the reader noticing
    // its tab is gone on the next callback, which is a different thing and
    // leaves the read running until one arrives.
    const { release, signal } = pausedRead();
    const { tabId, opened } = await startLoad();

    await closeTab(PANE_ID, tabId, { force: true });

    try {
      expect(activePane().tabs).toHaveLength(0);
      expect(
        signal()?.aborted,
        "close cancels the parked read before any later chunk",
      ).toBe(true);
    } finally {
      release();
      await opened;
    }
  });

  test("a closed read cannot write into whatever holds its id next", async () => {
    // A reopen replays the closed buffer under the same tab id, so a load
    // still parked from before the close would find that id and write a stale
    // download over whatever the user has done since.
    const { release, signal } = pausedRead();
    const { tabId, opened } = await startLoad();

    await closeTab(PANE_ID, tabId, { force: true });
    expect(reopenClosedTab()).toBe(true);
    const reopened = activePane().tabs[0] as FileTab;
    expect(reopened.id, "the reopen reuses the closed tab's id").toBe(tabId);
    expect(reopened.loading).toBe(false);
    reopened.content = "# edited after reopen";

    release();
    await opened;

    expect(
      reopened.content,
      "a late completion must not replace edits made after the reopen",
    ).toBe("# edited after reopen");
    expect(reopened.loading, "and must not put the tab back into loading").toBe(
      false,
    );
    expect(signal()?.aborted).toBe(true);
  });

  test("a cancelled bulk close leaves the load running", async () => {
    // The other side of the contract, and what pins where the cancellation
    // sits. This is also the bulk route: a live terminal beside the loading
    // file makes the pane close prompt, and answering no has to leave both
    // tabs and the download exactly as they were.
    const { release, signal } = pausedRead();
    const { tabId, opened } = await startLoad();
    const pane = layout.nodes[PANE_ID] as LeafNode;
    pane.tabs.push({
      kind: "terminal",
      id: "term-beside",
      title: "Terminal",
      createdAt: 1,
      broadcastEnabled: false,
      broadcastTargetIds: [],
    });
    const unregister = registerTerminalInputSink("term-beside", () => {});

    const closing = closeTabsInPane(PANE_ID);
    await vi.waitFor(() => expect(confirmState.open).toBe(true));
    resolveConfirm(false);
    expect(await closing).toBe(false);

    expect(
      (layout.nodes[PANE_ID] as LeafNode).tabs.map((t) => t.id),
      "the cancelled close removed nothing",
    ).toEqual([tabId, "term-beside"]);
    expect(signal()?.aborted, "and cancelled nothing").toBe(false);
    release();
    await opened;

    const still = liveTab(tabId);
    expect(still.content).toBe("# partial");
    expect(still.loading).toBe(false);
    expect(still.loadProgress).toBeUndefined();
    unregister();
  });

  test("a refused single close leaves the load running", async () => {
    // The single-close route's refusal, which is the draft flow: an inspect
    // that fails takes the close back before anything is removed. Nothing was
    // closed, so nothing may be cancelled. This is what pins the cancellation
    // to the removal rather than to the request.
    const { release, signal } = pausedRead();
    const pane = resetLayout();
    const opened = openInPane(pane.id, DRAFT_PATH);
    const tabId = activePane().tabs[0]!.id;
    await vi.waitFor(() => expect(liveTab(tabId).content).toBe("# part"));
    vi.spyOn(api, "inspectDraft").mockRejectedValue(new Error("probe refusal"));

    await closeTab(PANE_ID, tabId);

    expect(activePane().tabs, "the refused close removed nothing").toHaveLength(1);
    expect(signal()?.aborted, "and cancelled nothing").toBe(false);
    release();
    await opened;

    const still = liveTab(tabId);
    expect(still.content).toBe("# partial");
    expect(still.loading).toBe(false);
  });

  test("a load started after the reopen is not overwritten by the closed one", async () => {
    // Why the generation is retired rather than deleted. The reopen brings the
    // id back and the user reloads, so two reads exist for one id: the one the
    // close ended, still parked, and the live one. Counting a fresh load up
    // from a deleted entry would hand it the number the parked read carries,
    // and the stale completion would land on the new tab.
    const first = pausedRead();
    const { tabId, opened } = await startLoad();
    await closeTab(PANE_ID, tabId, { force: true });
    expect(reopenClosedTab()).toBe(true);
    expect(activePane().tabs[0]!.id, "the reopen reuses the id").toBe(tabId);

    // Its own content, so a completion from the closed read is visible rather
    // than indistinguishable from the live one's.
    const second = pausedRead("after-first-chunk", ["# re", "loaded"]);
    const reloaded = reloadTabFromDisk(tabId);
    await vi.waitFor(() => expect(liveTab(tabId).loading).toBe(true));

    // The closed read finishes last, so it has every chance to win.
    second.release();
    await reloaded;
    expect(liveTab(tabId).content, "the live read landed").toBe("# reloaded");
    first.release();
    await opened;

    expect(
      liveTab(tabId).content,
      "the closed read must not land on the live one's tab",
    ).toBe("# reloaded");
    expect(liveTab(tabId).loading).toBe(false);
  });

  test("the bulk route ends the load of every file it removes", async () => {
    // The same route carried through, so the removal half is covered where
    // `dropTabsById` does the splicing rather than the single close.
    const { release, signal } = pausedRead();
    const { opened } = await startLoad();

    const closed = await closeTabsInPane(PANE_ID, { force: true });

    expect(closed).toBe(true);
    expect((layout.nodes[PANE_ID] as LeafNode).tabs).toHaveLength(0);
    expect(signal()?.aborted, "the bulk close cancelled the read too").toBe(true);
    release();
    await opened;
  });

  test("the download is abandoned, not left running", async () => {
    const { release, signal } = pausedRead();
    const { tabId, opened } = await startLoad();

    await closeTab(PANE_ID, tabId, { force: true });
    release();
    await opened;

    expect(signal()?.aborted, "the read was aborted").toBe(true);
    expect(activePane().tabs).toHaveLength(0);
  });

  test("reopening it does not restore a tab that claims to be loading", async () => {
    // The close keeps a reopen record, and a reopen replays that buffer
    // instead of reading the file again. A record that carries `loading` puts
    // a tab on screen waiting for a download nobody is running.
    const { release } = pausedRead();
    const { tabId, opened } = await startLoad();

    await closeTab(PANE_ID, tabId, { force: true });
    release();
    await opened;

    expect(canReopenClosedTab()).toBe(true);
    expect(reopenClosedTab()).toBe(true);
    const reopened = activePane().tabs[0] as FileTab;
    expect(reopened.kind).toBe("file");
    expect(reopened.loading).toBe(false);
    expect(reopened.loadProgress).toBeUndefined();
  });
});
