// @vitest-environment jsdom
//
// What a multi-row move does, driven through the real tree with a real drop.
//
// A drop of two or more rows leaves `fileOps.moveTo` and calls the transfer
// route directly. That route never refuses an occupied name: it resolves one
// server-side and reports what it rewrote. The handler reads `resp.moved` and
// nothing else, so every step a single move runs is skipped, and the four
// cases below are what that costs the user.
//
// A move onto an occupied name has one behaviour whatever the gesture, and it
// is to refuse and name the occupied path. These cases assert that contract,
// so they describe what a multi-row move must do and measure what it does.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// jsdom has no layout, so it implements no scrollIntoView. Selecting a row
// schedules one in an animation frame, and an uncaught TypeError from a frame
// callback fails the whole run.
Element.prototype.scrollIntoView = vi.fn();

const served = vi.hoisted(() => ({
  listings: {} as Record<string, unknown[]>,
  transfer: {
    moved: [] as Array<{ from: string; to: string }>,
    skipped: [] as string[],
    conflicts: [] as string[],
  },
  calls: [] as Array<{ op: string; sources: string[]; destDir: string }>,
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      list: vi.fn(async (dir: string) => served.listings[dir] ?? []),
      fsTransfer: vi.fn(async (op: string, sources: string[], destDir: string) => {
        served.calls.push({ op, sources, destDir });
        return served.transfer;
      }),
    },
  };
});

vi.mock("../api/desktop", () => ({
  isTauriDesktop: () => false,
  saveBytesToDownloads: vi.fn(async () => {}),
}));
vi.mock("../api/download", () => ({ downloadBytes: vi.fn() }));
// The transport module is stubbed empty: any wire access that reaches it fails
// loudly instead of hitting fetch.
vi.mock("../api/transport", () => ({}));

import FileTree from "./FileTree.svelte";
import {
  disposeFbTreeInstance,
  tree,
  ui,
} from "../state/store.svelte";
import { layout, tabsForPath } from "../state/tabs.svelte";
import { setNotifyHandler } from "../state/notify.svelte";
import type { FileTab, LeafNode } from "../state/tabs.svelte";
import { fileTab as harnessFileTab } from "../__tests__/tabs";

const INSTANCE = "fb-multimove-test";
const TREE_MOVE_MIME = "application/x-chan-tree-move";

const mounted: Array<Record<string, unknown>> = [];
const notices: string[] = [];

function fileTab(path: string): FileTab {
  return harnessFileTab({ id: `tab-${path}`, path });
}

function seedLayoutWithTab(path: string): void {
  const pane: LeafNode = {
    kind: "leaf",
    id: "pane-1",
    tabs: [fileTab(path)],
    activeTabId: `tab-${path}`,
  } as unknown as LeafNode;
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
}

beforeEach(() => {
  notices.length = 0;
  setNotifyHandler((msg) => notices.push(msg));
  served.listings = {};
  served.calls = [];
  served.transfer = { moved: [], skipped: [], conflicts: [] };
  ui.status = null;
  tree.entries = [
    { path: "a.md", is_dir: false, kind: "document", size: 1, mtime: null },
    { path: "b.md", is_dir: false, kind: "document", size: 1, mtime: null },
    { path: "dest", is_dir: true, size: 0, mtime: null },
    { path: "busy", is_dir: true, size: 0, mtime: null },
    { path: "busy/a.md", is_dir: false, kind: "document", size: 1, mtime: null },
    { path: "hidden", is_dir: true, size: 0, mtime: null },
    { path: ".Drafts", is_dir: true, size: 0, mtime: null },
  ];
  tree.loadedDirs = { "": true, dest: true, busy: true };
  tree.loadingDirs = {};
  tree.dirErrors = {};
});

afterEach(() => {
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  disposeFbTreeInstance(INSTANCE);
  tree.entries = [];
  tree.loadedDirs = {};
  tree.loadingDirs = {};
  tree.dirErrors = {};
  ui.status = null;
  layout.nodes = {};
  vi.clearAllMocks();
});

async function settle(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

function mountTree(): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(
    mount(FileTree, { target, props: { instanceId: INSTANCE } }) as Record<
      string,
      unknown
    >,
  );
  return target;
}

/// jsdom builds no DataTransfer, so the drag payload is supplied directly in
/// the shape `readTreeDrag` reads it out of.
function dropOnDir(target: HTMLElement, destDir: string, paths: string[]): void {
  const row = [...target.querySelectorAll<HTMLElement>(".row")].find(
    (el) => (el.getAttribute("title") ?? "").endsWith(destDir),
  );
  expect(row, `tree row for ${destDir}`).toBeDefined();
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: [TREE_MOVE_MIME],
      getData: (mime: string) =>
        mime === TREE_MOVE_MIME
          ? JSON.stringify({ path: paths[0], isDir: false, paths })
          : "",
    },
  });
  row!.dispatchEvent(event);
}

function said(): string {
  return [...notices, ui.status ?? ""].join(" | ");
}

describe("a multi-row move", () => {
  test("carries an open tab to the file's new path", async () => {
    seedLayoutWithTab("b.md");
    served.transfer.moved = [{ from: "b.md", to: "dest/b.md" }];
    const target = mountTree();
    await settle();

    dropOnDir(target, "dest", ["a.md", "b.md"]);
    await settle();

    expect(tabsForPath("dest/b.md"), "the tab follows the file").toHaveLength(1);
    expect(tabsForPath("b.md"), "and does not stay on the old path").toHaveLength(0);
  });

  test("refuses a Drafts destination before it asks the server", async () => {
    const target = mountTree();
    await settle();

    dropOnDir(target, ".Drafts", ["a.md", "b.md"]);
    await settle();

    expect(served.calls, "nothing is sent").toHaveLength(0);
    expect(said()).toContain("Drafts are saved or discarded from editor tabs");
  });

  test("reports the rewrite conflicts the response carries", async () => {
    served.transfer.moved = [{ from: "b.md", to: "dest/b.md" }];
    served.transfer.conflicts = ["notes/links.md"];
    const target = mountTree();
    await settle();

    dropOnDir(target, "dest", ["a.md", "b.md"]);
    await settle();

    expect(said()).toContain("1 link conflict: notes/links.md");
  });

  test("counts the conflicts it does not name", async () => {
    // The list comes from the server and has no bound; the status line does.
    served.transfer.moved = [{ from: "b.md", to: "dest/b.md" }];
    served.transfer.conflicts = ["c1.md", "c2.md", "c3.md", "c4.md", "c5.md"];
    const target = mountTree();
    await settle();

    dropOnDir(target, "dest", ["a.md", "b.md"]);
    await settle();

    expect(said()).toContain("5 link conflicts: c1.md, c2.md, c3.md, and 2 more");
    expect(said(), "the rest are counted, not printed").not.toContain("c4.md");
  });

  test("says so when the server resolved a name the check could not see", async () => {
    // The check reads a cached listing, so it cannot promise there was no
    // collision. `loadTreeDir` returns at once while a listing is in flight,
    // which is one of the ways `tree.entries` can be missing the destination's
    // contents when the check runs. The response is the authority: a `to` that
    // is not the landing path asked for is a name the server resolved.
    tree.loadingDirs = { dest: true };
    served.transfer.moved = [
      { from: "a.md", to: "dest/a copy.md" },
      { from: "b.md", to: "dest/b.md" },
    ];
    const target = mountTree();
    await settle();

    dropOnDir(target, "dest", ["a.md", "b.md"]);
    await settle();

    expect(served.calls, "the transfer went out").toHaveLength(1);
    expect(said(), "the name it asked for is named").toContain("dest/a.md");
    expect(said(), "and where the file actually landed").toContain("dest/a copy.md");
  });

  test("says so when the server skipped a source", async () => {
    served.transfer.moved = [{ from: "b.md", to: "dest/b.md" }];
    served.transfer.skipped = ["a.md"];
    const target = mountTree();
    await settle();

    dropOnDir(target, "dest", ["a.md", "b.md"]);
    await settle();

    expect(said(), "the source that did not move is named").toContain("a.md");
  });

  test("refuses an occupied name in a listed destination", async () => {
    const target = mountTree();
    await settle();

    dropOnDir(target, "busy", ["a.md", "b.md"]);
    await settle();

    expect(served.calls, "nothing is sent").toHaveLength(0);
    expect(said(), "the occupied path is named").toContain("busy/a.md");
  });

  test("refuses an occupied name in a destination whose listing was never loaded", async () => {
    // `hidden` is collapsed and unlisted, so tree.entries knows nothing under
    // it. The name is occupied all the same, and the transfer route would
    // resolve the collision to a " copy" suffix without a word.
    served.listings["hidden"] = [
      { path: "hidden/a.md", is_dir: false, kind: "document", size: 1, mtime: null },
    ];
    served.transfer.moved = [
      { from: "a.md", to: "hidden/a copy.md" },
      { from: "b.md", to: "hidden/b.md" },
    ];
    const target = mountTree();
    await settle();

    dropOnDir(target, "hidden", ["a.md", "b.md"]);
    await settle();

    expect(served.calls, "nothing is sent").toHaveLength(0);
    expect(said(), "the occupied path is named").toContain("hidden/a.md");
  });
});
