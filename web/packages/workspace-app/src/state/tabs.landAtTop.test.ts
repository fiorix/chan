// @vitest-environment jsdom
//
// An explicit open lands the caret at the top of the document, including for
// a tab that is already open and has latched its caret: openInPane issues a
// caret command to that tab (FileEditorTab.test.ts covers the editor obeying
// it). Every explicit-open caller is driven here over the demo workspace, and
// the tab that should move is already open with its caret mid-document.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import FileBrowserSurface from "../components/FileBrowserSurface.svelte";
import { sessionWindowId } from "../api/client";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { trackTimers, type TimerTrack } from "../demo/timers";
import {
  __testSetBootstrapHydrated,
  browserSelection,
  fileOps,
  onWatchEvent,
  pathPromptState,
  refreshTree,
  refreshWorkspace,
  resolvePathPrompt,
} from "./store.svelte";
import { layout, type BrowserTab, type FileTab, type LeafNode } from "./tabs.svelte";

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView = () => {};

const PANE = "land-at-top-pane";
const README = "# Readme\n\nSome text.\n";
const mounted: Array<Record<string, unknown>> = [];
let timers: TimerTrack;

function fileTab(path: string): FileTab {
  return {
    kind: "file",
    fileKind: "document",
    id: `file-${path}`,
    path,
    content: README,
    saved: README,
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
    caret: { from: 12, to: 12 },
  };
}

/// One pane holding README.md with its caret mid-document, plus an optional
/// Files tab (active when given).
function seat(browser?: BrowserTab): { file: FileTab; browser?: BrowserTab } {
  const tabs = browser ? [fileTab("README.md"), browser] : [fileTab("README.md")];
  layout.nodes = {
    [PANE]: { kind: "leaf", id: PANE, tabs, activeTabId: (browser ?? tabs[0]!).id },
  };
  layout.rootId = PANE;
  layout.activePaneId = PANE;
  const live = (layout.nodes[PANE] as LeafNode).tabs;
  return { file: live[0] as FileTab, browser: live[1] as BrowserTab | undefined };
}

function tabFor(path: string): FileTab | undefined {
  return (layout.nodes[PANE] as LeafNode).tabs.find(
    (t): t is FileTab => t.kind === "file" && t.path === path,
  );
}

async function settle(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function renderBrowser(props: Record<string, unknown>): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(FileBrowserSurface, { target, props }));
  await settle();
  return target;
}

beforeEach(async () => {
  timers = trackTimers();
  installDemoWorkspace({
    metadata: {
      workspaceRoot: "demo",
      label: "demo",
      generatedAt: 1_700_000_000_000,
      fileCount: 1,
      textCount: 1,
    },
    files: [{ path: "README.md", kind: "document", size: README.length, mtime: 100, content: README }],
  });
  await refreshWorkspace();
  await refreshTree();
  browserSelection.path = null;
  browserSelection.showWorkspace = false;
});

afterEach(async () => {
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  if (pathPromptState.open) resolvePathPrompt(null);
  await settle(2);
  uninstallDemoWorkspace();
  timers.release();
});

describe("an explicit open lands at the top", () => {
  test("cs open of an open file", async () => {
    const { file } = seat();
    // Window commands wait for the boot hydration a mounted app performs.
    __testSetBootstrapHydrated(true);

    onWatchEvent({
      type: "window_command",
      window_id: sessionWindowId(),
      command: "open_file",
      path: "README.md",
    });
    await settle();

    expect(file.caretCommand).toEqual({ from: 0, to: 0 });
  });

  test("a double-click on the file's tree row", async () => {
    const { file } = seat();
    const target = await renderBrowser({ variant: "dock", side: "left" });
    const row = [...target.querySelectorAll<HTMLElement>("[role='treeitem']")].find((el) =>
      el.textContent?.includes("README.md"),
    );
    expect(row, "the tree listed the file").toBeDefined();

    row!.querySelector("button.name")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await settle();

    expect(file.caretCommand).toEqual({ from: 0, to: 0 });
  });

  test("the File Browser inspector's Open", async () => {
    const { file, browser } = seat({
      kind: "browser",
      id: "files",
      title: "Files",
      inspectorOpen: true,
      selected: "README.md",
    });
    const target = await renderBrowser({ variant: "tab", tab: browser });
    const open = target.querySelector<HTMLButtonElement>(".inspector .pill-main");
    expect(open?.textContent?.trim()).toBe("Open");

    open!.click();
    await settle();

    expect(file.caretCommand).toEqual({ from: 0, to: 0 });
  });

  test("a new file from the create prompt", async () => {
    seat();
    const created = fileOps.createFile("");
    await settle(2);
    expect(pathPromptState.open).toBe(true);
    resolvePathPrompt("fresh.md");
    await created;
    await settle();

    expect(tabFor("fresh.md")?.caret).toEqual({ from: 0, to: 0 });
  });

  test("a new file from the create-file-or-directory prompt", async () => {
    seat();
    const created = fileOps.createFileOrDir("");
    await settle(2);
    expect(pathPromptState.open).toBe(true);
    resolvePathPrompt("fresh-too.md");
    await created;
    await settle();

    expect(tabFor("fresh-too.md")?.caret).toEqual({ from: 0, to: 0 });
  });

  test("the copy a duplicate opens", async () => {
    seat();
    await fileOps.duplicateFile("README.md");
    await settle();

    const copy = (layout.nodes[PANE] as LeafNode).tabs.find(
      (t): t is FileTab => t.kind === "file" && t.path !== "README.md",
    );
    expect(copy, "the duplicate opened").toBeDefined();
    expect(copy!.caret).toEqual({ from: 0, to: 0 });
  });
});
