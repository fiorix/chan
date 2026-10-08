// @vitest-environment jsdom
//
// A workspace's draft is kept outside the workspace, so its client path has
// no place in it: no row to reveal, no directory to expand, to scope a graph
// to or to spawn from. The mark its path carries must reach neither the
// tree's expansion, which is stored, nor a tab the layout saves.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { draftPath } from "../__tests__/drafts";
import { fileTab, resetLayout } from "../__tests__/tabs";
import { api } from "../api/client";
import { demoWorkspaceInfo, type MockWorkspaceData } from "../demo/data";
import {
  browserSelection,
  noteDraftCreated,
  openFsGraphForFile,
  resolveSpawnContext,
  revealAndSelect,
  revealPathInBrowser,
  tree,
  treeExpanded,
} from "./store.svelte";
import { activePane } from "./tabs.svelte";
import { workspace } from "./workspace.svelte";

const DRAFT = draftPath("untitled");
const MARK = String.fromCharCode(0);
// The mark as JSON text spells it, which is how a stored snapshot holds it.
const ESCAPED_MARK = String.fromCharCode(92) + "u0000";
const DEMO: MockWorkspaceData = {
  metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1, fileCount: 0, textCount: 0 },
  files: [],
};

/// Every key and value the page has stored, as one text.
function stored(): string {
  const text: string[] = [];
  for (const storage of [localStorage, sessionStorage]) {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i)!;
      text.push(key, storage.getItem(key) ?? "");
    }
  }
  return text.join(" ");
}

function markedDirs(): string[] {
  return Object.keys(treeExpanded.map).filter((dir) => dir.includes(MARK));
}

function storedMark(): boolean {
  const text = stored();
  return text.includes(MARK) || text.includes(ESCAPED_MARK);
}

beforeEach(() => {
  // The session save a reveal schedules never fires under these timers.
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  workspace.info = demoWorkspaceInfo(DEMO);
  treeExpanded.map = { "": true };
  browserSelection.path = null;
  resetLayout([fileTab({ id: "draft-tab", path: DRAFT })]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  workspace.info = null;
  tree.loadedDirs = {};
});

describe("a workspace draft's path", () => {
  test("is not revealed in the tree: nothing is expanded, selected or stored for it", () => {
    revealAndSelect(DRAFT);

    expect.soft(markedDirs()).toEqual([]);
    expect.soft(browserSelection.path).toBeNull();
    expect.soft(storedMark(), "the mark is stored").toBe(false);
  });

  test("a workspace file is revealed and its expansion stored, which the draft's is measured against", () => {
    revealAndSelect("notes/deep/a.md");

    expect(treeExpanded.map["notes/deep"]).toBe(true);
    expect(browserSelection.path).toBe("notes/deep/a.md");
    expect(stored()).toContain("notes/deep");
  });

  test("opens the file browser on the workspace, with no row selected or expanded for it", () => {
    const browser = revealPathInBrowser(DRAFT, { inspectorOpen: true });

    expect.soft(browser.expanded).toBeUndefined();
    expect.soft(browserSelection.path).toBeNull();
    expect.soft(markedDirs()).toEqual([]);
    expect.soft(storedMark(), "the mark is stored").toBe(false);
  });

  test("scopes no graph", () => {
    openFsGraphForFile(DRAFT);

    expect(activePane().tabs.map((tab) => tab.kind)).toEqual(["file"]);
  });

  test("gives its tab no directory to spawn from", () => {
    expect(resolveSpawnContext()).toEqual({ dir: "" });
  });

  test("lists no directory when the draft is created", async () => {
    // The root is listed, as in a window whose tree is showing.
    tree.loadedDirs = { "": true };
    const list = vi.spyOn(api, "list").mockResolvedValue([]);

    await noteDraftCreated(DRAFT);

    expect(list).not.toHaveBeenCalled();
  });
});
