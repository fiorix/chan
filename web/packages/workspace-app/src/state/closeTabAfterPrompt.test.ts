// @vitest-environment jsdom
//
// A close acts on the tab it was asked to close. `closeTabAsync` and its two
// bulk siblings capture the pane, the side and the index BEFORE they await the
// close confirm and the terminal close sink, so anything that reshapes the
// pane while the dialog is up redirects the removal onto a bystander.

import { afterEach, describe, expect, test } from "vitest";

import { confirmState, resolveConfirm } from "./confirm.svelte";
import {
  clearRecentlyClosedTabsForTest,
  closePane,
  closeTab,
  closeTabsInPane,
  layout,
  moveTab,
  registerTerminalInputSink,
  reorderTab,
  type FileTab,
  type LeafNode,
  type TerminalTab,
} from "./tabs.svelte";

const PANE_ID = "close-after-prompt-pane";
const unregisterSinks: Array<() => void> = [];

afterEach(() => {
  for (const off of unregisterSinks.splice(0)) off();
  resolveConfirm(false);
  clearRecentlyClosedTabsForTest();
});

function fileTab(id: string): FileTab {
  return {
    kind: "file",
    fileKind: "document",
    id,
    path: `notes/${id}.md`,
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
  };
}

/// A terminal with a live input sink reads as a running shell, which is what
/// makes the close path raise its confirm and hold there.
function liveTerminalTab(id: string): TerminalTab {
  unregisterSinks.push(registerTerminalInputSink(id, () => true));
  return {
    kind: "terminal",
    id,
    title: id,
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
  };
}

function resetLayout(tabs: Array<FileTab | TerminalTab>): LeafNode {
  const node: LeafNode = {
    kind: "leaf",
    id: PANE_ID,
    tabs: [...tabs],
    activeTabId: tabs[0]?.id ?? null,
  };
  layout.nodes = { [PANE_ID]: node };
  layout.rootId = PANE_ID;
  layout.activePaneId = PANE_ID;
  return layout.nodes[PANE_ID] as LeafNode;
}

function pane(): LeafNode {
  return layout.nodes[PANE_ID] as LeafNode;
}

function sideA(): string[] {
  return pane().tabs.map((t) => t.id);
}

function sideB(): string[] {
  return (pane().bTabs ?? []).map((t) => t.id);
}

/// Wait for the close pipeline's awaits (the confirm helper and the terminal
/// close sink) to settle after the dialog resolves.
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("a close that waits on a prompt", () => {
  test("follows its own tab through a reorder", async () => {
    resetLayout([fileTab("a"), liveTerminalTab("b"), fileTab("c")]);

    const closing = closeTab(PANE_ID, "b");
    await settle();
    expect(confirmState.open).toBe(true);

    reorderTab(PANE_ID, "c", 0);
    expect(sideA()).toEqual(["c", "a", "b"]);

    resolveConfirm(true);
    await closing;
    await settle();

    expect(sideA()).toEqual(["c", "a"]);
  });

  test("follows its own tab across a split", async () => {
    resetLayout([fileTab("a"), liveTerminalTab("b"), fileTab("c")]);

    const closing = closeTab(PANE_ID, "b");
    await settle();
    expect(confirmState.open).toBe(true);

    moveTab(PANE_ID, "b", PANE_ID, undefined, { toSide: "b" });
    expect(sideA()).toEqual(["a", "c"]);
    expect(sideB()).toEqual(["b"]);

    resolveConfirm(true);
    await closing;
    await settle();

    expect(sideA()).toEqual(["a", "c"]);
    expect(sideB()).toEqual([]);
  });

  test("two concurrent closes of one tab remove one tab", async () => {
    resetLayout([liveTerminalTab("b"), fileTab("a")]);

    // `force` is the Ctrl+D-on-an-exited-terminal shape: no dialog, but the
    // same captured index survives the sink await in both runs.
    await Promise.all([
      closeTab(PANE_ID, "b", { force: true }),
      closeTab(PANE_ID, "b", { force: true }),
    ]);
    await settle();

    expect(sideA()).toEqual(["a"]);
  });

  test("closeTabsInPane leaves a tab that arrived during the prompt", async () => {
    resetLayout([liveTerminalTab("b"), fileTab("a")]);

    const closing = closeTabsInPane(PANE_ID);
    await settle();
    expect(confirmState.open).toBe(true);

    // A peer's tab landing in this pane, which nobody confirmed closing.
    pane().tabs.push(fileTab("late"));

    resolveConfirm(true);
    await closing;
    await settle();

    expect(sideA()).toEqual(["late"]);
  });

  test("closePane leaves a tab that arrived during the prompt", async () => {
    resetLayout([liveTerminalTab("b"), fileTab("a")]);

    const closing = closePane(PANE_ID);
    await settle();
    expect(confirmState.open).toBe(true);

    pane().tabs.push(fileTab("late"));

    resolveConfirm(true);
    await closing;
    await settle();

    expect(sideA()).toEqual(["late"]);
  });
});
