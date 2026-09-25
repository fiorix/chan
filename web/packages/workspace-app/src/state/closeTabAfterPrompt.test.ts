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
  cancelPaneMode,
  closeAllTabs,
  closeOtherTabsInPane,
  closePane,
  closeTab,
  closeTabsInPane,
  commitPaneMode,
  enterPaneMode,
  layout,
  moveTab,
  paneActiveTabId,
  registerTerminalInputSink,
  reopenClosedTab,
  reorderTab,
  type FileTab,
  type LeafNode,
  type TerminalTab,
} from "./tabs.svelte";
import {
  fileTab as harnessFileTab,
  resetLayout as harnessResetLayout,
  terminalTab as harnessTerminalTab,
} from "../__tests__/tabs";

const PANE_ID = "close-after-prompt-pane";
const unregisterSinks: Array<() => void> = [];

afterEach(() => {
  for (const off of unregisterSinks.splice(0)) off();
  resolveConfirm(false);
  cancelPaneMode();
  clearRecentlyClosedTabsForTest();
});

function fileTab(id: string): FileTab {
  return harnessFileTab({ id, path: `notes/${id}.md` });
}

/// A terminal with a live input sink reads as a running shell, which is what
/// makes the close path raise its confirm and hold there.
function liveTerminalTab(id: string): TerminalTab {
  unregisterSinks.push(registerTerminalInputSink(id, () => true));
  return harnessTerminalTab({ id, title: id });
}

function resetLayout(tabs: Array<FileTab | TerminalTab>): LeafNode {
  return harnessResetLayout(tabs, { id: PANE_ID });
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

describe("closePane on a non-root pane", () => {
  test("keeps the pane when a tab arrived during the prompt", async () => {
    // The conditional collapse is invisible on the root pane, which never
    // collapses, so this one splits first.
    const leaf: LeafNode = {
      kind: "leaf",
      id: PANE_ID,
      tabs: [liveTerminalTab("b"), fileTab("a")],
      activeTabId: "b",
    };
    const sibling: LeafNode = {
      kind: "leaf",
      id: "sibling-pane",
      tabs: [fileTab("s")],
      activeTabId: "s",
    };
    layout.nodes = {
      root: {
        kind: "split",
        id: "root",
        direction: "row",
        a: PANE_ID,
        b: "sibling-pane",
        ratio: 0.5,
      },
      [PANE_ID]: leaf,
      "sibling-pane": sibling,
    };
    layout.rootId = "root";
    layout.activePaneId = PANE_ID;

    const closing = closePane(PANE_ID);
    await settle();
    expect(confirmState.open).toBe(true);
    (layout.nodes[PANE_ID] as LeafNode).tabs.push(fileTab("late"));

    resolveConfirm(true);
    await closing;
    await settle();

    const survivor = layout.nodes[PANE_ID] as LeafNode | undefined;
    expect(survivor?.kind).toBe("leaf");
    expect(survivor?.tabs.map((t) => t.id)).toEqual(["late"]);
  });
});

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

// ---- the bookkeeping a close leaves behind ----------------------------------
//
// Asserting the surviving id lists is not enough: the reopen record and the
// active tab are the half the item's Boundaries paragraph warns about, and a
// close that writes them against the side the tab started on leaves the id
// lists correct and the bookkeeping wrong.

describe("a close records where the tab ended up", () => {
  test("a tab closed from the other side leaves no active id behind", async () => {
    const pane0 = resetLayout([fileTab("a"), liveTerminalTab("b"), fileTab("c")]);
    // B is the side's active tab when it crosses, which is what makes a
    // stale-side fixup observable.
    pane0.activeTabId = "b";

    const closing = closeTab(PANE_ID, "b");
    await settle();
    moveTab(PANE_ID, "b", PANE_ID, undefined, { toSide: "b" });
    expect(paneActiveTabId(pane(), "b")).toBe("b");

    resolveConfirm(true);
    await closing;
    await settle();

    expect(sideB()).toEqual([]);
    expect(paneActiveTabId(pane(), "b")).toBeNull();
  });

  test("the reopen record names the side the tab ended on", async () => {
    resetLayout([fileTab("a"), liveTerminalTab("b"), fileTab("c")]);

    const closing = closeTab(PANE_ID, "b");
    await settle();
    moveTab(PANE_ID, "b", PANE_ID, undefined, { toSide: "b" });

    resolveConfirm(true);
    await closing;
    await settle();

    expect(reopenClosedTab()).toBe(true);
    await settle();
    expect(sideB().filter((id) => id.startsWith("b") || id.startsWith("term"))).
      toHaveLength(1);
    expect(sideA()).toEqual(["a", "c"]);
  });
});

describe("the bulk closes follow their tabs", () => {
  test("closeTabsInPane closes a tab that crossed the split", async () => {
    resetLayout([liveTerminalTab("b"), fileTab("a")]);

    const closing = closeTabsInPane(PANE_ID);
    await settle();
    expect(confirmState.open).toBe(true);
    moveTab(PANE_ID, "a", PANE_ID, undefined, { toSide: "b" });
    expect(sideB()).toEqual(["a"]);

    resolveConfirm(true);
    await closing;
    await settle();

    expect(sideA()).toEqual([]);
    expect(sideB()).toEqual([]);
  });

  test("closeTabsInPane acts on the live pane after a Hybrid Nav commit", async () => {
    // A commit replaces every node with a clone, so the pane object a close
    // captured before its prompt is no longer the one the layout holds.
    resetLayout([liveTerminalTab("b"), fileTab("a")]);

    const closing = closeTabsInPane(PANE_ID);
    await settle();
    expect(confirmState.open).toBe(true);
    enterPaneMode();
    commitPaneMode();

    resolveConfirm(true);
    await closing;
    await settle();

    expect(sideA()).toEqual([]);
  });

  test("closeOtherTabsInPane leaves a tab that arrived during the prompt", async () => {
    resetLayout([fileTab("keep"), liveTerminalTab("b"), fileTab("a")]);

    const closing = closeOtherTabsInPane(PANE_ID, "keep");
    await settle();
    expect(confirmState.open).toBe(true);
    pane().tabs.push(fileTab("late"));

    resolveConfirm(true);
    await closing;
    await settle();

    expect(sideA()).toEqual(["keep", "late"]);
  });

  test("closeAllTabs leaves a tab that arrived during the prompt", async () => {
    resetLayout([liveTerminalTab("b"), fileTab("a")]);

    const closing = closeAllTabs();
    await settle();
    expect(confirmState.open).toBe(true);
    pane().tabs.push(fileTab("late"));

    resolveConfirm(true);
    await closing;
    await settle();

    expect(sideA()).toEqual(["late"]);
  });
});

