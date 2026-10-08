// @vitest-environment jsdom
//
// A draft whose buffer is not its file closes with its file left in the
// drafts. That is a draft whose load is still running, or whose last read
// failed: the buffer holds at most the bytes that had arrived, so an empty
// buffer does not mean an empty draft, and a discard or a promote decided
// from it would act on text the user has not seen. The reopen then opens that
// same draft by its path and loads it, rather than minting a new one.
//
// The other half is what the keep must never do: drop typing. A draft that
// holds text the user typed is saved and asked about as before, whatever its
// tab's error says, and a draft whose read later succeeded closes as the file
// it now is.
//
// Every case opens the draft through the real load with `api.readStream`
// stubbed, so the state the close reads is the one a load leaves behind. The
// draft routes answer as a server would, which is what lets a close that
// wrongly inspects or discards go through with it and be seen.
//
// A close that runs no draft flow leaves the file too: a scripted close of the
// tab, of its pane or of every pane. Its reopen opens that draft by its path,
// with the buffer the tab held when that buffer was the file and with a new
// load when it was not. A draft that moved to another window was not closed,
// so this window has nothing of it to reopen. Only a draft whose path was
// deleted has no file left, and its reopen mints a new draft, seeded with the
// closed buffer when that buffer was the file.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, sessionWindowId } from "../api/client";
import { ApiError } from "../api/errors";
import { confirmState, resolveConfirm } from "./confirm.svelte";
import * as notifications from "./notify.svelte";
import { fileOps, onWatchEvent } from "./store.svelte";
import {
  activePane,
  canReopenClosedTab,
  clearRecentlyClosedTabsForTest,
  closeFileTabAfterMove,
  closeTab,
  draftCloseState,
  layout,
  openInPane,
  reloadTabFromDisk,
  reopenClosedTab,
  resolveDraftClose,
  saveTab,
  setTabContent,
  type FileTab,
  type Tab,
} from "./tabs.svelte";
import { fileTab, resetLayout } from "../__tests__/tabs";
import { draftPath } from "../__tests__/drafts";
import { draftDirOf } from "../api/fileIdentity";

const PANE_ID = "pane-draft-close";
const DRAFT_PATH = draftPath("untitled-9");
const WHOLE = "# Draft\n\nwords on disk\n";
/// Mirror of the server's markdown draft seed: a clean buffer holding exactly
/// this is discarded on close with no dialog.
const DRAFT_SEED = "# Draft\n";

beforeEach(() => {
  clearRecentlyClosedTabsForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/// The tab the layout holds now, or undefined once it is gone. Read out of
/// `layout` because the object a test opened with is not the one the app
/// renders after the load writes into it.
function liveTab(tabId: string): FileTab | undefined {
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    const found = ([...node.tabs, ...(node.bTabs ?? [])] as Tab[]).find((t) => t.id === tabId);
    if (found?.kind === "file") return found;
  }
  return undefined;
}

function meta() {
  return {
    path: DRAFT_PATH,
    mtime: 10,
    mtime_ns: "10",
    authority_version: 1,
    disk_conflicted: false,
    writable: true,
    size: WHOLE.length,
  };
}

/// A read that sends its meta and then parks before any content, finishing
/// with `content` only when released. With `first` it parks after that much
/// of the content has arrived.
function parkedRead(content = WHOLE, first?: string): {
  release: () => void;
  signal: () => AbortSignal | undefined;
} {
  let release: () => void = () => {};
  let signal: AbortSignal | undefined;
  vi.spyOn(api, "readStream").mockImplementation(async (_path, opts) => {
    signal = opts?.signal ?? undefined;
    opts?.onMeta?.(meta());
    if (first !== undefined) {
      opts?.onChunk?.(first, { loadedBytes: first.length, totalBytes: content.length });
    }
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    opts?.onChunk?.(content, { loadedBytes: content.length, totalBytes: content.length });
    return { ...meta(), content };
  });
  return { release: () => release(), signal: () => signal };
}

/// A read that fails for a reason other than a missing file, after sending
/// `partial` when it is given.
function failingRead(partial?: string): void {
  vi.spyOn(api, "readStream").mockImplementation(async (_path, opts) => {
    opts?.onMeta?.(meta());
    if (partial !== undefined) {
      opts?.onChunk?.(partial, { loadedBytes: partial.length, totalBytes: WHOLE.length });
    }
    throw new ApiError(500, "connection reset");
  });
}

function draftRoutes() {
  return {
    inspect: vi.spyOn(api, "inspectDraft").mockResolvedValue({
      path: DRAFT_PATH,
      name: "untitled-9",
      file_count: 1,
      dir_count: 0,
      total_size: WHOLE.length,
      has_attachments: false,
    }),
    discard: vi.spyOn(api, "discardDraft").mockResolvedValue(undefined),
    promote: vi.spyOn(api, "promoteDraft").mockResolvedValue({
      path: "untitled-9.md",
      name: "untitled-9",
      mode: "file",
    }),
    // Never answers. A reopen that mints is seen by the call alone, and the
    // recovery it starts then waits here instead of opening a tab into the
    // next case's layout.
    createDraft: vi
      .spyOn(api, "createDraft")
      .mockReturnValue(new Promise<{ path: string; name: string }>(() => {})),
    write: vi.spyOn(api, "write").mockResolvedValue({ mtime: 11, mtime_ns: "11" }),
  };
}

/// Open the draft and wait until its read has sent the meta and nothing else.
async function openParked(): Promise<{
  tabId: string;
  read: ReturnType<typeof parkedRead>;
  opened: Promise<unknown>;
}> {
  const read = parkedRead();
  resetLayout([], { id: PANE_ID });
  const opened = openInPane(PANE_ID, DRAFT_PATH);
  const tabId = activePane().tabs[0]!.id;
  await vi.waitFor(() => expect(liveTab(tabId)?.loadProgress?.totalBytes).toBe(WHOLE.length));
  expect(liveTab(tabId)?.content, "no content has arrived").toBe("");
  expect(liveTab(tabId)?.loading).toBe(true);
  return { tabId, read, opened };
}

/// Open the draft through a read that fails, and wait for the load to end.
async function openFailed(partial?: string): Promise<string> {
  failingRead(partial);
  resetLayout([], { id: PANE_ID });
  await openInPane(PANE_ID, DRAFT_PATH);
  const tabId = activePane().tabs[0]!.id;
  await vi.waitFor(() => expect(liveTab(tabId)?.loading).toBe(false));
  expect(liveTab(tabId)?.error).toBe("connection reset");
  return tabId;
}

describe("a draft whose buffer is not its file keeps its file on close", () => {
  test("closed before its first chunk arrives", async () => {
    const routes = draftRoutes();
    const { tabId, read, opened } = await openParked();

    await closeTab(PANE_ID, tabId);

    try {
      expect(routes.discard, "a close before the first chunk sends no discard").not.toHaveBeenCalled();
      expect(routes.inspect, "nor inspects a draft it has not read").not.toHaveBeenCalled();
      expect(liveTab(tabId), "the tab closes").toBeUndefined();
      expect(read.signal()?.aborted, "and its read ends with it").toBe(true);
    } finally {
      read.release();
      await opened;
    }
  });

  test("its read failed before any chunk", async () => {
    const routes = draftRoutes();
    const tabId = await openFailed();

    await closeTab(PANE_ID, tabId);

    expect(routes.discard, "a close after a failed read sends no discard").not.toHaveBeenCalled();
    expect(routes.inspect).not.toHaveBeenCalled();
    expect(liveTab(tabId)).toBeUndefined();
  });

  test("its read failed after some bytes, with no dialog", async () => {
    const routes = draftRoutes();
    const tabId = await openFailed("# Draft\n\nwor");

    // A close that asks waits on the dialog, so bound the wait rather than
    // hang on a prompt the user would see.
    const close = closeTab(PANE_ID, tabId);
    await Promise.race([close, new Promise((resolve) => setTimeout(resolve, 50))]);

    try {
      expect(draftCloseState.open, "no dialog about bytes the tab cannot show").toBe(false);
      expect(routes.discard).not.toHaveBeenCalled();
      expect(routes.promote).not.toHaveBeenCalled();
      expect(liveTab(tabId)).toBeUndefined();
    } finally {
      if (draftCloseState.open) resolveDraftClose("cancel");
      await close;
    }
  });
});

describe("the reopen of a kept draft opens that draft", () => {
  test("after a close during its load, it loads the draft by its path", async () => {
    const routes = draftRoutes();
    const { tabId, read, opened } = await openParked();
    await closeTab(PANE_ID, tabId);
    read.release();
    await opened;

    const again = parkedRead();
    expect(reopenClosedTab()).toBe(true);

    try {
      expect(routes.createDraft, "the reopen mints no new draft").not.toHaveBeenCalled();
      const reopened = liveTab(tabId);
      expect(reopened?.path).toBe(DRAFT_PATH);
      expect(reopened?.loading, "its own load is running").toBe(true);
    } finally {
      again.release();
    }
    await vi.waitFor(() => expect(liveTab(tabId)?.loading).toBe(false));
    expect(liveTab(tabId)?.content).toBe(WHOLE);
    expect(routes.write, "and nothing is written").not.toHaveBeenCalled();
  });

  test("after a failed read, it loads the draft again", async () => {
    const routes = draftRoutes();
    const tabId = await openFailed();
    await closeTab(PANE_ID, tabId);

    const again = parkedRead();
    expect(reopenClosedTab()).toBe(true);

    try {
      expect(routes.createDraft, "the reopen mints no new draft").not.toHaveBeenCalled();
      expect(liveTab(tabId)?.loading, "it loads again rather than show the failed read").toBe(true);
      expect(liveTab(tabId)?.error).toBeNull();
    } finally {
      again.release();
    }
    await vi.waitFor(() => expect(liveTab(tabId)?.loading).toBe(false));
    expect(liveTab(tabId)?.content).toBe(WHOLE);
    expect(routes.write).not.toHaveBeenCalled();
  });
});

describe("a draft whose buffer is its file, or holds typing, closes as before", () => {
  test("text typed into a draft whose close failed is saved by the next close", async () => {
    vi.spyOn(api, "readStream").mockResolvedValue({ ...meta(), content: WHOLE });
    const routes = draftRoutes();
    resetLayout([], { id: PANE_ID });
    await openInPane(PANE_ID, DRAFT_PATH);
    const tabId = activePane().tabs[0]!.id;
    await vi.waitFor(() => expect(liveTab(tabId)?.loading).toBe(false));
    setTabContent(liveTab(tabId)!, WHOLE + "typed\n");
    routes.write.mockRejectedValueOnce(new Error("server gone"));
    const notice = vi.spyOn(notifications, "notify");
    await closeTab(PANE_ID, tabId);
    expect(liveTab(tabId)?.error).toBeNull();
    expect(liveTab(tabId)?.saveError).toBe("the save request failed (server gone)");
    expect(notice).toHaveBeenCalledExactlyOnceWith("draft.md was not saved because the save request failed (server gone).");
    expect(draftCloseState.open).toBe(false);

    const close = closeTab(PANE_ID, tabId);
    await vi.waitFor(() => expect(draftCloseState.open).toBe(true));

    expect(routes.write.mock.calls.at(-1)?.slice(0, 2)).toEqual([DRAFT_PATH, WHOLE + "typed\n"]);
    resolveDraftClose("cancel");
    await close;
    expect(liveTab(tabId)?.saveError).toBeNull();
  });

  test("an inspect failure keeps a clean draft and reports its own reason", async () => {
    vi.spyOn(api, "readStream").mockResolvedValue({ ...meta(), content: WHOLE });
    const routes = draftRoutes();
    resetLayout([], { id: PANE_ID });
    await openInPane(PANE_ID, DRAFT_PATH);
    const tabId = activePane().tabs[0]!.id;
    routes.inspect.mockRejectedValueOnce(new Error("inspect unavailable"));
    const notice = vi.spyOn(notifications, "notify");

    await closeTab(PANE_ID, tabId);

    expect(liveTab(tabId)?.content).toBe(WHOLE);
    expect(liveTab(tabId)?.error).toBeNull();
    expect(liveTab(tabId)?.saveError).toBeFalsy();
    expect(notice).toHaveBeenCalledExactlyOnceWith("Draft close failed: inspect unavailable");
    expect(draftCloseState.open).toBe(false);
  });

  test("text typed after a failed read, over a buffer a sibling's save replaced, is saved", async () => {
    // The one way a failed read's tab takes typing: another tab of the same
    // draft saves, the save mirrors into this clean buffer and clears its
    // error, and the editor comes back.
    const routes = draftRoutes();
    const tabId = await openFailed();
    (layout.nodes[PANE_ID] as { tabs: Tab[] }).tabs.push(
      fileTab({ id: "draft-sibling", path: DRAFT_PATH, content: WHOLE, saved: WHOLE, savedMtime: 10 }),
    );
    const sibling = liveTab("draft-sibling")!;
    setTabContent(sibling, WHOLE + "from the sibling\n");
    await saveTab(sibling);
    expect(liveTab(tabId)?.error, "the save mirrored into the failed tab").toBeNull();
    setTabContent(liveTab(tabId)!, WHOLE + "from the sibling\ntyped\n");

    const close = closeTab(PANE_ID, tabId);
    await vi.waitFor(() => expect(draftCloseState.open).toBe(true));

    expect(routes.write.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      DRAFT_PATH,
      WHOLE + "from the sibling\ntyped\n",
    ]);
    resolveDraftClose("cancel");
    await close;
  });

  test("a draft whose reload succeeded after a failed read closes as its file", async () => {
    const routes = draftRoutes();
    const tabId = await openFailed();
    vi.spyOn(api, "readStream").mockResolvedValue({ ...meta(), content: DRAFT_SEED });
    await reloadTabFromDisk(tabId);
    expect(liveTab(tabId)?.content).toBe(DRAFT_SEED);

    await closeTab(PANE_ID, tabId);

    expect(routes.discard, "a pristine seed that loaded is discarded").toHaveBeenCalledWith(DRAFT_PATH);
    expect(liveTab(tabId)).toBeUndefined();
  });
});

/// The draft open with `content` over `saved`, as a load that finished and
/// the typing after it leave a tab.
function openWhole(content = WHOLE, saved = WHOLE): string {
  resetLayout([fileTab({ id: "draft-whole", path: DRAFT_PATH, content, saved, savedMtime: 10 })], {
    id: PANE_ID,
  });
  return "draft-whole";
}

/// Run a `cs pane` operation as the window does: the command the server
/// relays, answered through the window's reply.
async function paneExec(op: Record<string, unknown>): Promise<{ ok: boolean; summary: string }> {
  const reply = vi.spyOn(api, "windowReply").mockResolvedValue(undefined);
  onWatchEvent({
    type: "window_command",
    window_id: sessionWindowId(),
    command: "pane_exec",
    request_id: "pane-exec",
    op,
  });
  await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
  const { ok, summary } = reply.mock.calls[0]![0].payload as { ok: boolean; summary: string };
  return { ok, summary };
}

/// Delete the draft's directory as a delete behind its confirm does. The
/// remove itself is stubbed: what the window does once the directory is gone
/// is under test. The tree refresh after it fails, which closes the tabs all
/// the same.
async function deleteDraftDirectory(): Promise<void> {
  vi.spyOn(api, "remove").mockResolvedValue(undefined);
  vi.spyOn(api, "list").mockRejectedValue(new Error("listing down"));
  vi.spyOn(api, "workspace").mockRejectedValue(new Error("workspace down"));
  const removed = fileOps.remove(draftDirOf(DRAFT_PATH)!, true);
  await vi.waitFor(() => expect(confirmState.open).toBe(true));
  resolveConfirm(true);
  expect(await removed).toBe(true);
  expect(openDraftPaths(), "the delete closes the draft's tab").toEqual([]);
}

function openDraftPaths(): string[] {
  const paths: string[] = [];
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    for (const t of [...node.tabs, ...(node.bTabs ?? [])] as Tab[]) {
      if (t.kind === "file") paths.push(t.path);
    }
  }
  return paths;
}

const NEW_DRAFT_PATH = draftPath("untitled-10");

/// The routes a reopen that mints goes through, answered: the new draft is
/// created, takes a write, and loads as `content`.
function mintRoutes(content: string) {
  const createDraft = vi
    .spyOn(api, "createDraft")
    .mockResolvedValue({ path: NEW_DRAFT_PATH, name: "untitled-10" });
  const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 12, mtime_ns: "12" });
  vi.spyOn(api, "readStream").mockResolvedValue({ ...meta(), path: NEW_DRAFT_PATH, content });
  return { createDraft, write };
}

describe("the reopen of a draft whose close ran no draft flow opens that draft", () => {
  test.each([
    { route: "its tab", op: (tabId: string) => ({ kind: "close_tab", pane_id: PANE_ID, tab_id: tabId }) },
    { route: "its pane", op: () => ({ kind: "close_pane", pane_id: PANE_ID }) },
    { route: "every pane", op: () => ({ kind: "close_all" }) },
  ])("after a scripted close of $route, with the buffer it held and no read", async ({ op }) => {
    const routes = draftRoutes();
    const read = vi.spyOn(api, "readStream").mockResolvedValue({ ...meta(), content: "read again\n" });
    const tabId = openWhole();
    expect((await paneExec(op(tabId))).ok, "the scripted close closes it").toBe(true);
    expect(openDraftPaths()).toEqual([]);

    expect(reopenClosedTab()).toBe(true);

    expect({
      minted: routes.createDraft.mock.calls.length,
      open: openDraftPaths(),
      content: liveTab(tabId)?.content,
      reads: read.mock.calls.length,
      written: routes.write.mock.calls.length,
      discarded: routes.discard.mock.calls.length,
    }).toEqual({ minted: 0, open: [DRAFT_PATH], content: WHOLE, reads: 0, written: 0, discarded: 0 });
  });

  test("after a forced scripted close, with its unsaved text", async () => {
    const routes = draftRoutes();
    vi.spyOn(api, "readStream").mockResolvedValue({ ...meta(), content: "read again\n" });
    const tabId = openWhole(WHOLE + "typed\n");
    const closed = await paneExec({ kind: "close_tab", pane_id: PANE_ID, tab_id: tabId, force: true });
    expect(closed.ok, "the forced close closes an unsaved draft").toBe(true);

    expect(reopenClosedTab()).toBe(true);

    const reopened = liveTab(tabId);
    expect({
      minted: routes.createDraft.mock.calls.length,
      open: openDraftPaths(),
      content: reopened?.content,
      saved: reopened?.saved,
      written: routes.write.mock.calls.length,
    }).toEqual({ minted: 0, open: [DRAFT_PATH], content: WHOLE + "typed\n", saved: WHOLE, written: 0 });
  });

  test("after a read that failed with some bytes, it loads the draft again and seeds no new one", async () => {
    const routes = draftRoutes();
    const tabId = await openFailed("# Draft\n\nwor");
    expect((await paneExec({ kind: "close_tab", pane_id: PANE_ID, tab_id: tabId })).ok).toBe(true);

    const again = parkedRead();
    expect(reopenClosedTab()).toBe(true);

    try {
      expect({
        minted: routes.createDraft.mock.calls.length,
        open: openDraftPaths(),
        loading: liveTab(tabId)?.loading,
        error: liveTab(tabId)?.error,
      }).toEqual({ minted: 0, open: [DRAFT_PATH], loading: true, error: null });
    } finally {
      again.release();
    }
    await vi.waitFor(() => expect(liveTab(tabId)?.loading).toBe(false));
    expect(liveTab(tabId)?.content).toBe(WHOLE);
    expect(routes.write, "and nothing is written").not.toHaveBeenCalled();
  });
});

describe("a draft moved to another window", () => {
  test("is not this window's to reopen", async () => {
    const routes = draftRoutes();
    const tabId = openWhole();

    await closeFileTabAfterMove(PANE_ID, tabId);
    expect(openDraftPaths(), "the move takes the tab out of this window").toEqual([]);

    expect({
      canReopen: canReopenClosedTab(),
      reopened: reopenClosedTab(),
      minted: routes.createDraft.mock.calls.length,
      open: openDraftPaths(),
    }).toEqual({ canReopen: false, reopened: false, minted: 0, open: [] });
  });
});

describe("the reopen of a draft whose path was deleted mints a new draft", () => {
  test("seeded with the closed buffer when that buffer was the file", async () => {
    openWhole();
    await deleteDraftDirectory();
    const { createDraft, write } = mintRoutes(WHOLE);

    expect(reopenClosedTab()).toBe(true);
    await vi.waitFor(() => expect(openDraftPaths()).toEqual([NEW_DRAFT_PATH]));

    expect({ minted: createDraft.mock.calls.length, written: write.mock.calls }).toEqual({
      minted: 1,
      written: [[NEW_DRAFT_PATH, WHOLE]],
    });
  });

  test("and writes none of the bytes of a read that had failed", async () => {
    await openFailed("# Draft\n\nwor");
    await deleteDraftDirectory();
    const { createDraft, write } = mintRoutes(DRAFT_SEED);

    expect(reopenClosedTab()).toBe(true);
    await vi.waitFor(() => expect(openDraftPaths()).toEqual([NEW_DRAFT_PATH]));

    expect({ minted: createDraft.mock.calls.length, written: write.mock.calls }).toEqual({
      minted: 1,
      written: [],
    });
  });

  test.each([
    { route: "its tab", op: { kind: "close_tab", pane_id: PANE_ID, tab_id: "draft-missing" } },
    { route: "its pane", op: { kind: "close_pane", pane_id: PANE_ID } },
  ])("as does a draft whose file was already found missing, after a scripted close of $route", async ({ op }) => {
    resetLayout(
      [
        fileTab({
          id: "draft-missing",
          path: DRAFT_PATH,
          content: WHOLE,
          saved: WHOLE,
          fileMissing: { path: DRAFT_PATH, fragment: "words on disk" },
        }),
      ],
      { id: PANE_ID },
    );
    expect((await paneExec(op)).ok).toBe(true);
    const { createDraft, write } = mintRoutes(WHOLE);

    expect(reopenClosedTab()).toBe(true);
    await vi.waitFor(() => expect(openDraftPaths()).toEqual([NEW_DRAFT_PATH]));

    expect({ minted: createDraft.mock.calls.length, written: write.mock.calls }).toEqual({
      minted: 1,
      written: [[NEW_DRAFT_PATH, WHOLE]],
    });
  });

  test("nor the bytes of a load that was running", async () => {
    const read = parkedRead(WHOLE, "# Draft\n\nwor");
    resetLayout([], { id: PANE_ID });
    const opened = openInPane(PANE_ID, DRAFT_PATH);
    const tabId = activePane().tabs[0]!.id;
    await vi.waitFor(() => expect(liveTab(tabId)?.content).toBe("# Draft\n\nwor"));
    expect(liveTab(tabId)?.loading, "the load is still running").toBe(true);
    await deleteDraftDirectory();
    read.release();
    await opened;
    const { createDraft, write } = mintRoutes(DRAFT_SEED);

    expect(reopenClosedTab()).toBe(true);
    await vi.waitFor(() => expect(openDraftPaths()).toEqual([NEW_DRAFT_PATH]));

    expect({ minted: createDraft.mock.calls.length, written: write.mock.calls }).toEqual({
      minted: 1,
      written: [],
    });
  });
});
