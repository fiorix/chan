// @vitest-environment jsdom
//
// A mutation the server stores and announces that gets no answer within the
// page's answer deadline is reported as possibly made, never as failed: the
// affected view is listed again at once, and the watch frame that announces
// the stored result lists it again when it lands. A refusal the server answers
// keeps the caller's failure line. The store-level cases run a slide deck's
// create over the in-memory demo server with the create held past the
// deadline, the server storing it when it is let go; the caller cases answer
// each mutation with the uncertain outcome and read the line and the refresh.

import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { draftPath, draftSeed } from "../__tests__/drafts";
import { fileTab, readTab, resetLayout } from "../__tests__/tabs";
import { api, sessionWindowId } from "../api/client";
import { UncertainOutcomeError } from "../api/errors";
import type { DraftInspectResponse } from "../api/types";
import { setFetchImpl, setSocketFactory } from "../api/transport";
import type { MockWorkspaceData } from "../demo/data";
import { DemoDrafts } from "../demo/drafts";
import { DemoGraph } from "../demo/graph";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { MockReports } from "../demo/report";
import { createDemoFetch } from "../demo/router";
import { MockWorkspaceStore } from "../demo/store";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { createDiagramAndOpen } from "./commands/diagram";
import { createSlidesAndOpen } from "./commands/slides";
import { confirmState, resolveConfirm } from "./confirm.svelte";
import { drafts, resetDraftsForTests } from "./drafts.svelte";
import {
  discardWorkspaceWarning,
  fileOps,
  onWatchEvent,
  pathPromptState,
  refreshTree,
  refreshWorkspace,
  resolvePathPrompt,
  ui,
  workspaceWarningsDialog,
} from "./store.svelte";
import {
  closeTab,
  conflictDialog,
  layout,
  overwriteConflictedTab,
  overwriteDiskConflict,
  reopenClosedTab,
  saveDraftTabToWorkspace,
} from "./tabs.svelte";

const DATA: MockWorkspaceData = {
  metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1, fileCount: 2, textCount: 2 },
  files: [
    { path: "notes/a.md", kind: "document", size: 5, mtime: 100, content: "hello" },
    { path: "notes/b.md", kind: "document", size: 5, mtime: 100, content: "world" },
  ],
  drafts: [draftSeed("untitled", { "draft.md": "" })],
};

async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function uncertain(method: string, path: string): UncertainOutcomeError {
  return new UncertainOutcomeError(method, path, 10_000);
}

function inspected(path: string): DraftInspectResponse {
  return { path, name: "untitled", file_count: 1, dir_count: 0, total_size: 0, has_attachments: false };
}

function fileTabsOpen(): string[] {
  return Object.values(layout.nodes).flatMap((node) =>
    node.kind === "leaf" ? node.tabs.filter((t) => t.kind === "file").map((t) => t.id) : [],
  );
}

describe("a new slide deck whose create gets no answer", () => {
  /// What the page asked of the server, by method and path.
  let asked: string[];
  /// The held create: let go, the server stores the draft and answers a page
  /// that stopped waiting at its deadline.
  let held: { release(): Promise<void> } | null;
  let refuse: boolean;
  let timers: TimerTrack;

  function lists(): number {
    return asked.filter((a) => a === "GET /api/drafts").length;
  }

  beforeEach(() => {
    timers = trackTimers();
    resetDraftsForTests();
    resetLayout([]);
    ui.status = null;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const disk = new MockWorkspaceStore(DATA);
    const store = new DemoDrafts(DATA);
    const serve = createDemoFetch(disk, new DemoGraph(disk), new MockReports([]), {}, store);
    asked = [];
    held = null;
    refuse = false;
    setFetchImpl(async (input, init) => {
      const path = new URL(input, "http://demo").pathname;
      asked.push(`${init?.method ?? "GET"} ${path}`);
      if (path !== "/api/drafts/new") return serve(input, init);
      if (refuse) {
        return new Response(JSON.stringify({ error: "the draft store is full", code: "drafts_full" }), {
          status: 409,
        });
      }
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
        held = {
          release: async () => resolve(await serve(input, { ...init, signal: undefined })),
        };
      });
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await settle(2);
    uninstallDemoWorkspace();
    setSocketFactory(null);
    resetLayout([]);
    ui.status = null;
    timers.release();
    vi.restoreAllMocks();
  });

  async function createPastTheDeadline(): Promise<void> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const done = createSlidesAndOpen();
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    vi.useRealTimers();
    await settle();
  }

  test("says it may have completed, lists the drafts at once and again when the frame lands", async () => {
    await createPastTheDeadline();

    expect.soft(ui.status).toBe("New slide deck may have completed: no answer within 10 s");
    expect.soft(ui.status).not.toMatch(/failed/);
    expect.soft(lists(), "the drafts are listed at the report").toBe(1);
    expect.soft(drafts.rows.map((r) => r.name)).toEqual(["untitled"]);

    await held!.release();
    const created = drafts.rows.length;
    onWatchEvent({
      type: "draft",
      event: "created",
      source: { root: "draft", path: "untitled-1/draft.md", draft_id: "demo-life-1" },
      source_w: sessionWindowId(),
    });
    await settle();

    expect.soft(created, "nothing shows the draft before its frame").toBe(1);
    expect.soft(lists(), "the frame lists the drafts again").toBe(2);
    expect.soft(drafts.rows.map((r) => r.name).sort()).toEqual(["untitled", "untitled-1"]);
    expect.soft(fileTabsOpen(), "a frame is not taken as the create's answer").toEqual([]);
  });

  test("takes no other frame of this window as the create's answer", async () => {
    await createPastTheDeadline();
    const report = ui.status;

    onWatchEvent({
      type: "draft",
      event: "created",
      source: { root: "draft", path: "untitled/draft.md", draft_id: "life-untitled" },
      source_w: sessionWindowId(),
    });
    await settle();

    expect.soft(fileTabsOpen(), "no tab opens").toEqual([]);
    expect.soft(ui.status, "nothing more is reported").toBe(report);
    expect.soft(held, "the create is still held").not.toBeNull();
  });

  test("keeps the failure line for a refusal the server answers", async () => {
    refuse = true;
    await createSlidesAndOpen();
    await settle();

    expect.soft(ui.status).toBe("New slide deck failed: the draft store is full");
    expect.soft(lists(), "a refusal lists nothing").toBe(0);
  });
});

describe("each caller of a mutation with no answer", () => {
  let timers: TimerTrack;

  beforeEach(async () => {
    timers = trackTimers();
    resetDraftsForTests();
    resetLayout([]);
    installDemoWorkspace(DATA);
    await refreshWorkspace();
    await refreshTree();
    ui.status = null;
  });

  afterEach(async () => {
    if (pathPromptState.open) resolvePathPrompt(null);
    if (confirmState.open) resolveConfirm(false);
    vi.restoreAllMocks();
    await settle(2);
    uninstallDemoWorkspace();
    resetLayout([]);
    ui.status = null;
    timers.release();
  });

  test("a new folder", async () => {
    vi.spyOn(api, "create").mockRejectedValue(uncertain("POST", "/api/fs"));
    const list = vi.spyOn(api, "list");
    const done = fileOps.createDir("notes");
    await vi.waitFor(() => expect(pathPromptState.open).toBe(true));
    resolvePathPrompt("notes/new");
    await done;

    expect.soft(ui.status).toBe("create may have completed: no answer within 10 s");
    expect.soft(list.mock.calls.filter(([dir]) => !dir), "the tree is listed").toHaveLength(1);
  });

  test.each([
    ["a new file", () => fileOps.createFile("notes"), "notes/new.md"],
    ["a new file or folder, as a file", () => fileOps.createFileOrDir("notes"), "notes/new.md"],
    ["a new file or folder, as a folder", () => fileOps.createFileOrDir("notes"), "notes/new/"],
  ])("%s", async (_name, start, typed) => {
    vi.spyOn(api, "create").mockRejectedValue(uncertain("POST", "/api/fs"));
    const list = vi.spyOn(api, "list");
    const done = start();
    await vi.waitFor(() => expect(pathPromptState.open).toBe(true));
    resolvePathPrompt(typed);
    await done;

    expect.soft(ui.status).toBe("create may have completed: no answer within 10 s");
    expect.soft(list.mock.calls.filter(([dir]) => !dir), "the tree is listed").toHaveLength(1);
  });

  test("a duplicate", async () => {
    vi.spyOn(api, "create").mockRejectedValue(uncertain("POST", "/api/fs"));
    const list = vi.spyOn(api, "list");
    await fileOps.duplicateFile("notes/a.md");
    await settle();

    expect.soft(ui.status).toBe("duplicate may have completed: no answer within 10 s");
    expect.soft(list.mock.calls.filter(([dir]) => !dir), "the tree is listed").toHaveLength(1);
  });

  test("a new diagram", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(api, "createDiagram").mockRejectedValue(uncertain("POST", "/api/diagrams/new"));
    const listed = vi.spyOn(api, "listDrafts");
    await createDiagramAndOpen();
    await settle();

    expect.soft(ui.status).toBe("New diagram may have completed: no answer within 10 s");
    expect.soft(listed, "the drafts are listed").toHaveBeenCalledTimes(1);
  });

  test("a closed draft's reopen", async () => {
    const path = draftPath("untitled");
    resetLayout([fileTab({ id: "draft", path, content: "", saved: "", loading: false })]);
    vi.spyOn(api, "inspectDraft").mockResolvedValue(inspected(path));
    vi.spyOn(api, "discardDraft").mockResolvedValue(undefined);
    await closeTab("pane-test", "draft");
    await settle();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(api, "createDraft").mockRejectedValue(uncertain("POST", "/api/drafts/new"));
    const listed = vi.spyOn(api, "listDrafts");

    expect.soft(reopenClosedTab()).toBe(true);
    await settle();
    expect.soft(ui.status).toBe("Reopen draft may have completed: no answer within 10 s");
    expect.soft(listed, "the drafts are listed").toHaveBeenCalledTimes(1);
  });

  test("a delete", async () => {
    vi.spyOn(api, "remove").mockRejectedValue(uncertain("DELETE", "/api/fs/notes/a.md"));
    const list = vi.spyOn(api, "list");
    const done = fileOps.remove("notes/a.md", false);
    await vi.waitFor(() => expect(confirmState.open).toBe(true));
    resolveConfirm(true);

    expect.soft(await done).toBe(false);
    await settle();
    expect.soft(ui.status).toBe("delete may have completed: no answer within 10 s");
    expect.soft(list.mock.calls.filter(([dir]) => !dir), "the tree is listed").toHaveLength(1);
  });

  test("a delete of several entries names the first with no answer and lists the tree", async () => {
    vi.spyOn(api, "remove").mockImplementation(async (path) => {
      throw uncertain("DELETE", `/api/fs/${path}`);
    });
    const list = vi.spyOn(api, "list");
    const done = fileOps.removeSelection(["notes/a.md", "notes/b.md"]);
    await vi.waitFor(() => expect(confirmState.open).toBe(true));
    resolveConfirm(true);
    await done;
    await settle();

    expect.soft(ui.status).toBe("deleted 0 of 2; notes/a.md: delete may have completed: no answer within 10 s");
    expect.soft(list.mock.calls.filter(([dir]) => !dir), "the tree is listed").toHaveLength(1);
  });

  test("a broken draft's discard", async () => {
    vi.spyOn(api, "discardDraft").mockRejectedValue(uncertain("POST", "/api/drafts/discard"));
    const listed = vi.spyOn(api, "listDrafts");
    const info = vi.spyOn(api, "workspace");
    const done = discardWorkspaceWarning({
      kind: "broken_draft",
      path: "/home/user/.chan/workspaces/demo/Drafts/broken",
      message: "missing draft.md",
      source: { root: "draft", path: "broken" },
    });
    await vi.waitFor(() => expect(confirmState.open).toBe(true));
    resolveConfirm(true);

    expect.soft(await done).toBe("Discarding broken may have completed: no answer within 10 s");
    await settle();
    expect.soft(workspaceWarningsDialog.error).toBe("Discarding broken may have completed: no answer within 10 s");
    expect.soft(listed, "the drafts are listed").toHaveBeenCalledTimes(1);
    expect.soft(info, "the workspace's warnings are read again").toHaveBeenCalledTimes(1);
  });

  test("a move", async () => {
    vi.spyOn(api, "move").mockRejectedValue(uncertain("POST", "/api/move"));
    const list = vi.spyOn(api, "list");
    await fileOps.moveTo("notes/a.md", "notes/c.md");
    await settle();

    expect.soft(ui.status).toBe("move may have completed: no answer within 10 s");
    expect.soft(list.mock.calls.filter(([dir]) => !dir), "the tree is listed").toHaveLength(1);
  });

  test("a move of several entries", async () => {
    vi.spyOn(api, "fsTransfer").mockRejectedValue(uncertain("POST", "/api/fs/transfer"));
    const list = vi.spyOn(api, "list");
    expect.soft(await fileOps.moveManyTo(["notes/a.md", "notes/b.md"], "")).toEqual([]);
    await settle();

    expect.soft(ui.status).toBe("move may have completed: no answer within 10 s");
    expect.soft(list.mock.calls.filter(([dir]) => !dir), "the tree is listed").toHaveLength(1);
  });

  test("a draft's close that discards it", async () => {
    const path = draftPath("untitled");
    resetLayout([fileTab({ id: "draft", path, content: "", saved: "", loading: false })]);
    vi.spyOn(api, "inspectDraft").mockResolvedValue(inspected(path));
    vi.spyOn(api, "discardDraft").mockRejectedValue(uncertain("POST", "/api/drafts/discard"));
    const listed = vi.spyOn(api, "listDrafts");
    await closeTab("pane-test", "draft");
    await settle();

    expect.soft(ui.status).toBe("Draft close may have completed: no answer within 10 s");
    expect.soft(listed, "the drafts are listed").toHaveBeenCalledTimes(1);
    expect.soft(readTab("draft"), "the tab stays for the frame to settle").toBeDefined();
  });

  test("a draft's save to the workspace", async () => {
    const path = draftPath("untitled");
    resetLayout([fileTab({ id: "draft", path, content: "# Kept\n", saved: "# Kept\n", loading: false })]);
    vi.spyOn(api, "inspectDraft").mockResolvedValue(inspected(path));
    vi.spyOn(api, "promoteDraft").mockRejectedValue(uncertain("POST", "/api/drafts/promote"));
    const listed = vi.spyOn(api, "listDrafts");
    const list = vi.spyOn(api, "list");
    const done = saveDraftTabToWorkspace(readTab("draft")!);
    await vi.waitFor(() => expect(pathPromptState.open).toBe(true));
    resolvePathPrompt("notes/kept.md");

    expect.soft(await done).toBe(false);
    await settle();
    expect.soft(ui.status).toBe("Draft save may have completed: no answer within 10 s");
    expect.soft(listed, "the drafts are listed").toHaveBeenCalledTimes(1);
    expect.soft(list.mock.calls.filter(([dir]) => !dir), "the tree is listed").toHaveLength(1);
  });

  test("an overwrite from the conflict dialog reads nothing", async () => {
    resetLayout([fileTab({ id: "conflicted", path: "notes/a.md", diskConflicted: true, loading: false })]);
    vi.spyOn(api, "resolveSessionConflict").mockRejectedValue(uncertain("POST", "/api/session-conflicts/resolve"));
    const read = vi.spyOn(api, "read");
    Object.assign(conflictDialog, { open: true, kind: "classic", tabId: "conflicted", diskConflicted: true });
    await overwriteConflictedTab();
    await settle();

    expect.soft(ui.status).toBe("Overwrite may have completed: no answer within 10 s");
    expect.soft(read, "the session's conflict frame settles the bar").not.toHaveBeenCalled();
  });

  test("keeping this tab's version over a disk conflict reads nothing", async () => {
    resetLayout([fileTab({ id: "conflicted", path: "notes/a.md", diskConflicted: true, loading: false })]);
    vi.spyOn(api, "resolveSessionConflict").mockRejectedValue(uncertain("POST", "/api/session-conflicts/resolve"));
    const read = vi.spyOn(api, "read");
    const done = overwriteDiskConflict("conflicted");
    await vi.waitFor(() => expect(confirmState.open).toBe(true));
    resolveConfirm(true);
    await done;
    await settle();

    expect.soft(ui.status).toBe("Keeping your version may have completed: no answer within 10 s");
    expect.soft(read, "the session's conflict frame settles the bar").not.toHaveBeenCalled();
    expect.soft(readTab("conflicted")?.diskConflicted).toBe(true);
  });
});
