// @vitest-environment jsdom
//
// The file tree shows the workspace's drafts in a group of their own above
// its rows: a draft is kept outside the workspace, so it is no row of the
// tree, and a folder of the workspace is no draft.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// jsdom has no layout, so it implements no scrollIntoView.
Element.prototype.scrollIntoView = vi.fn();

import { draftSeed } from "../__tests__/drafts";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { resetDraftsForTests } from "../state/drafts.svelte";
import { disposeFbTreeInstance, refreshTree, refreshWorkspace, tree } from "../state/store.svelte";
import FileTree from "./FileTree.svelte";

const INSTANCE = "fb-drafts-test";
const mounted: Array<Record<string, unknown>> = [];
let timers: TimerTrack;

async function settle(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(async () => {
  timers = trackTimers();
  resetDraftsForTests();
  installDemoWorkspace({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1, fileCount: 2, textCount: 2 },
    files: [
      { path: "notes/a.md", kind: "document", size: 5, mtime: 100, content: "hello" },
      { path: ".Drafts/kept.md", kind: "document", size: 4, mtime: 100, content: "kept" },
    ],
    drafts: [draftSeed("untitled", { "draft.md": "# Draft\n" })],
  });
  await refreshWorkspace();
  await refreshTree();
});

afterEach(async () => {
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  disposeFbTreeInstance(INSTANCE);
  await settle(2);
  uninstallDemoWorkspace();
  tree.entries = [];
  tree.loadedDirs = {};
  timers.release();
  vi.restoreAllMocks();
});

describe("the file tree of a workspace window", () => {
  test("lists the workspace's drafts in a group above its rows, and no draft among the rows", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(FileTree, { target, props: { instanceId: INSTANCE } }) as Record<string, unknown>);
    await settle();

    const group = target.querySelector(".drafts-group");
    const rows = target.querySelector(".tree")!;
    expect.soft(group, "the Drafts group").not.toBeNull();
    expect.soft([...(group?.querySelectorAll(".draft-name") ?? [])].map((el) => el.textContent)).toEqual(["untitled"]);
    expect.soft(
      group ? Boolean(group.compareDocumentPosition(rows) & Node.DOCUMENT_POSITION_FOLLOWING) : false,
      "the group comes before the tree's rows",
    ).toBe(true);
    // The tree's own rows are the workspace's: its folder named .Drafts is
    // one of them, and the draft is not.
    const rowNames = [...rows.querySelectorAll(".name")].map((el) => el.textContent?.replace(/\/$/, ""));
    expect.soft(rowNames).toEqual(expect.arrayContaining([".Drafts", "notes"]));
    expect.soft(rowNames).not.toContain("untitled");
  });
});
