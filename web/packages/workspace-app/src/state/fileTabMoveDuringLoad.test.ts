// @vitest-environment jsdom
//
// A file tab that moves while its content is still downloading has to end up
// showing that content, wherever it now is, and no tab may be left claiming to
// be loading when no load is running.
//
// The load resolves its tab on every chunk, because Svelte 5 mutations through
// the original object literal do not reach the array element. A move replaces
// that element with a clone in another pane, another side, or a rebuilt
// layout, so a lookup that starts from the pane the load began in stops
// finding it: the load aborts, which is correct, and then the same lookup
// misses again in the cleanup, which leaves `loading` true for good.
//
// Each case holds the stream open, moves the tab, and then lets the stream
// finish, so the move lands strictly between the first chunk and the last.

import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "../api/client";
import {
  activePane,
  canReopenClosedTab,
  closeTab,
  commitPaneMode,
  enterPaneMode,
  layout,
  moveTab,
  openInPane,
  paneModeSetGrab,
  reopenClosedTab,
  splitPane,
  type FileTab,
  type LeafNode,
  type Tab,
} from "./tabs.svelte";

const PANE_ID = "pane-load-move";
const PATH = "notes/slow.md";

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

/// A read that emits one chunk, parks, and finishes only when released. The
/// returned `release` is what lets a test put a move strictly in the middle of
/// the download.
function pausedRead(): {
  release: () => void;
  signal: () => AbortSignal | undefined;
} {
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
    opts?.onChunk?.("# part", { loadedBytes: 6, totalBytes: 9 });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    opts?.onChunk?.("ial", { loadedBytes: 9, totalBytes: 9 });
    return {
      path: PATH,
      content: "# partial",
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

/// Open the file and stop with one chunk in, the state every case moves from.
async function startLoad(): Promise<{
  tabId: string;
  opened: Promise<unknown>;
}> {
  const pane = resetLayout();
  const opened = openInPane(pane.id, PATH);
  const tabId = activePane().tabs[0]!.id;
  await vi.waitFor(() => expect(liveTab(tabId).content).toBe("# part"));
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
