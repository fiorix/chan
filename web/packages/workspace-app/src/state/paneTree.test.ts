// The pane tree's model: panes in reading order with their sides and tabs,
// the title filter that keeps a match's pane and side headers, the hidden
// program status the window tab bar's tree button badges, the gate that
// keeps the tree shut under Hybrid Nav, and a pick that shows the tab the
// way a strip press does.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fileTab, terminalTab } from "../__tests__/tabs";
import { assignOverride, hydrateOverrides } from "./keymapOverrides.svelte";
import {
  activatePaneTreeTab,
  closePaneTree,
  hiddenTabStatus,
  isBuiltInPaneTreeChord,
  mostUrgentMark,
  openPaneTree,
  paneOrder,
  paneTree,
  paneTreeModel,
  paneTreeRows,
  tabKindLabel,
  tabProgramMark,
  togglePaneTree,
} from "./paneTree.svelte";
import type { ProgramStatusRecord } from "./programStatus";
import { ui } from "./store.svelte";
import {
  layout,
  paneMode,
  tabFocusPulse,
  type LayoutState,
  type LeafNode,
  type Node,
  type Tab,
  type TerminalTab,
} from "./tabs.svelte";

function record(partial: Partial<ProgramStatusRecord> = {}): ProgramStatusRecord {
  return {
    source: "program",
    id: null,
    state: "idle",
    kind: null,
    progress: null,
    app: null,
    title: null,
    msg: null,
    seen: false,
    update_order: 1,
    ...partial,
  };
}

function statusTerminal(id: string, title: string, ...records: Partial<ProgramStatusRecord>[]): TerminalTab {
  return terminalTab({ id, title, programStatus: { revision: 1, records: records.map(record) } });
}

function leaf(id: string, tabs: Tab[], over: Partial<LeafNode> = {}): LeafNode {
  return { kind: "leaf", id, tabs, activeTabId: tabs[0]?.id ?? null, ...over };
}

/// left | (top-right over bottom-right): a row split whose right child is a
/// column split. The top-right pane is active and shows side B.
function windowLayout(): LayoutState {
  const nodes: Record<string, Node> = {
    root: { id: "root", kind: "split", direction: "row", a: "left", b: "right", ratio: 0.5 },
    right: { id: "right", kind: "split", direction: "column", a: "top-right", b: "bottom-right", ratio: 0.25 },
    left: leaf("left", [terminalTab({ id: "shell", title: "Shell" }), fileTab({ id: "plan", path: "notes/plan.md" })], {
      activeTabId: "plan",
      bTabs: [terminalTab({ id: "logs", title: "Logs" })],
      bActiveTabId: "logs",
    }),
    "top-right": leaf("top-right", [], {
      side: "b",
      bTabs: [terminalTab({ id: "build", title: "Build" }), fileTab({ id: "readme", path: "README.md" })],
      bActiveTabId: "build",
    }),
    "bottom-right": leaf("bottom-right", [fileTab({ id: "code", path: "src/code.md" })]),
  };
  return { rootId: "root", nodes, activePaneId: "top-right", focusColor: "blue" };
}

function titles(state: LayoutState, query?: string): string[] {
  return paneTreeRows(paneTreeModel(state, { query })).map((row) => row.title);
}

describe("the model", () => {
  test("lists the panes in reading order, depth first, a before b", () => {
    expect(paneOrder(windowLayout())).toEqual(["left", "top-right", "bottom-right"]);
    const panes = paneTreeModel(windowLayout());
    expect(panes.map((pane) => [pane.id, pane.number])).toEqual([
      ["left", 1],
      ["top-right", 2],
      ["bottom-right", 3],
    ]);
    expect(panes[1]!.rect).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.25 });
    expect(panes[2]!.rect).toEqual({ x: 0.5, y: 0.25, w: 0.5, h: 0.75 });
  });

  test("lists both sides of every pane, in strip order, with the visible side, the active tabs and the current tab", () => {
    const [left, topRight, bottomRight] = paneTreeModel(windowLayout());
    expect(left!.sides.map((side) => [side.side, side.visible, side.tabs.map((row) => row.title)])).toEqual([
      ["a", true, ["Shell", "plan.md"]],
      ["b", false, ["Logs"]],
    ]);
    expect(left!.sides[0]!.tabs.map((row) => row.active)).toEqual([false, true]);
    expect(left!.sides[1]!.tabs[0]!.active, "a hidden side's active tab is still active").toBe(true);
    expect(topRight!.active).toBe(true);
    expect(topRight!.sides.map((side) => [side.side, side.visible, side.total])).toEqual([
      ["a", false, 0],
      ["b", true, 2],
    ]);
    const current = paneTreeRows([left!, topRight!, bottomRight!]).filter((row) => row.current);
    expect(current.map((row) => [row.paneId, row.side, row.tab.id])).toEqual([["top-right", "b", "build"]]);
    expect(bottomRight!.sides[1], "an empty side is listed as empty").toMatchObject({ side: "b", tabs: [], total: 0 });
  });

  test("labels each pane with the tab it shows, or as empty", () => {
    const state = windowLayout();
    (state.nodes["bottom-right"] as LeafNode).activeTabId = null;
    expect(paneTreeModel(state).map((pane) => pane.label)).toEqual(["plan.md", "Build", "Empty pane"]);
  });

  test("names the tab kinds in the design's words", () => {
    expect(tabKindLabel(terminalTab())).toBe("Terminal");
    expect(tabKindLabel(fileTab())).toBe("Editor");
  });

  test("a window without sides lists only the side each pane shows", () => {
    const panes = paneTreeModel(windowLayout(), { sides: false });
    expect(panes.map((pane) => pane.sides.map((side) => side.side))).toEqual([["a"], ["b"], ["a"]]);
  });

  test("the filter narrows tabs by title, keeping each match's pane and side, and drops the rest", () => {
    const panes = paneTreeModel(windowLayout(), { query: "  MD " });
    expect(panes.map((pane) => [pane.id, pane.sides.map((side) => [side.side, side.tabs.map((row) => row.title)])])).toEqual([
      ["left", [["a", ["plan.md"]]]],
      ["top-right", [["b", ["README.md"]]]],
      ["bottom-right", [["a", ["code.md"]]]],
    ]);
    expect(titles(windowLayout(), "l")).toEqual(["Shell", "plan.md", "Logs", "Build"]);
    expect(titles(windowLayout(), "sh l"), "every term must match").toEqual(["Shell"]);
    expect(paneTreeModel(windowLayout(), { query: "nothing" })).toEqual([]);
  });

  test("lists a tab id the pane repeats once, as the strip draws it", () => {
    const shell = terminalTab({ id: "twice", title: "Shell" });
    const state: LayoutState = {
      rootId: "solo",
      nodes: { solo: leaf("solo", [shell], { bTabs: [{ ...shell }], bActiveTabId: "twice" }) },
      activePaneId: "solo",
      focusColor: "blue",
    };
    expect(paneTreeRows(paneTreeModel(state)).map((row) => [row.side, row.tab.id])).toEqual([["a", "twice"]]);
  });
});

describe("program status marks", () => {
  test("a tab's mark is the strip's: an attention record's state, else working, else none", () => {
    expect(tabProgramMark(fileTab())).toBeNull();
    expect(tabProgramMark(terminalTab())).toBeNull();
    expect(tabProgramMark(statusTerminal("t", "T", { state: "working" }))).toBe("working");
    expect(tabProgramMark(statusTerminal("t", "T", { state: "done" }))).toBe("done");
    expect(tabProgramMark(statusTerminal("t", "T", { state: "done", seen: true })), "a seen done is no mark").toBeNull();
    expect(tabProgramMark(statusTerminal("t", "T", { state: "blocked", kind: "question" }))).toBe("blocked");
    expect(tabProgramMark(statusTerminal("t", "T", { state: "error" }, { state: "working", update_order: 2 }))).toBe("error");
  });

  test("the most urgent mark is error, then blocked, then done, then working", () => {
    expect(mostUrgentMark([])).toBeNull();
    expect(mostUrgentMark([null, "working", "done"])).toBe("done");
    expect(mostUrgentMark(["working", "blocked", "done"])).toBe("blocked");
    expect(mostUrgentMark(["blocked", "error", "working"])).toBe("error");
  });

  test("the hidden status counts every tab outside the active pane's visible side", () => {
    const state = windowLayout();
    const topRight = state.nodes["top-right"] as LeafNode;
    const left = state.nodes.left as LeafNode;
    expect(hiddenTabStatus(state)).toBeNull();

    topRight.bTabs = [statusTerminal("build", "Build", { state: "error" })];
    expect(hiddenTabStatus(state), "a mark on the shown side is the bar's to show").toBeNull();

    topRight.tabs = [statusTerminal("hidden-a", "Hidden", { state: "working" })];
    expect(hiddenTabStatus(state), "the active pane's other side is hidden").toBe("working");

    left.bTabs = [statusTerminal("logs", "Logs", { state: "done" })];
    expect(hiddenTabStatus(state)).toBe("done");

    left.tabs = [statusTerminal("shell", "Shell", { state: "blocked", kind: "permission" })];
    expect(hiddenTabStatus(state), "another pane's shown side is hidden from the bar").toBe("blocked");

    (state.nodes["bottom-right"] as LeafNode).tabs = [statusTerminal("code", "Code", { state: "error" })];
    expect(hiddenTabStatus(state)).toBe("error");

    state.activePaneId = "bottom-right";
    expect(hiddenTabStatus(state), "the error pane is now the shown one; top-right's error is hidden").toBe("error");
    topRight.bTabs = [];
    expect(hiddenTabStatus(state)).toBe("blocked");
  });

  test("the hidden status counts only panes the split tree reaches", () => {
    const state = windowLayout();
    state.nodes.stray = leaf("stray", [statusTerminal("stray-term", "Stray", { state: "error" })]);
    expect(hiddenTabStatus(state)).toBeNull();
  });

  test("reads the live layout by default", () => {
    const live = windowLayout();
    (live.nodes.left as LeafNode).tabs = [statusTerminal("shell", "Shell", { state: "blocked" })];
    layout.rootId = live.rootId;
    layout.nodes = live.nodes;
    layout.activePaneId = live.activePaneId;
    expect(hiddenTabStatus()).toBe("blocked");
  });
});

describe("opening and picking", () => {
  beforeEach(() => {
    const live = windowLayout();
    layout.rootId = live.rootId;
    layout.nodes = live.nodes;
    layout.activePaneId = live.activePaneId;
    closePaneTree();
  });

  afterEach(() => {
    paneMode.active = false;
    ui.terminalControl = false;
    closePaneTree();
  });

  test("opens, toggles and closes", () => {
    openPaneTree();
    expect(paneTree.open).toBe(true);
    togglePaneTree();
    expect(paneTree.open).toBe(false);
    togglePaneTree();
    expect(paneTree.open).toBe(true);
  });

  test("does not open while Hybrid Nav is up or in the control terminal", () => {
    paneMode.active = true;
    openPaneTree();
    togglePaneTree();
    expect(paneTree.open).toBe(false);
    paneMode.active = false;
    ui.terminalControl = true;
    openPaneTree();
    expect(paneTree.open).toBe(false);
  });

  test("a pick makes the tab's pane active, turns it to the tab's side, selects the tab, pulses focus and closes", () => {
    (layout.nodes.left as LeafNode).bTabs![0] = terminalTab({ id: "logs", title: "Logs", terminalActivity: true });
    openPaneTree();
    const pulse = tabFocusPulse.value;

    expect(activatePaneTreeTab("left", "logs")).toBe(true);

    const left = layout.nodes.left as LeafNode;
    expect(layout.activePaneId).toBe("left");
    expect(left.side).toBe("b");
    expect(left.bActiveTabId).toBe("logs");
    expect(left.activeTabId, "side A keeps its own active tab").toBe("plan");
    expect(tabFocusPulse.value).toBe(pulse + 1);
    expect(paneTree.open).toBe(false);
    expect((left.bTabs![0] as TerminalTab).terminalActivity, "the unread-output dot clears as on a strip press").toBeFalsy();
  });

  test("a pick on the visible side of another pane leaves that pane's side alone", () => {
    expect(activatePaneTreeTab("left", "shell")).toBe(true);
    const left = layout.nodes.left as LeafNode;
    expect([layout.activePaneId, left.side ?? "a", left.activeTabId]).toEqual(["left", "a", "shell"]);
  });

  test("a pick of a tab that is gone changes nothing and keeps the tree open", () => {
    openPaneTree();
    expect(activatePaneTreeTab("left", "missing")).toBe(false);
    expect(activatePaneTreeTab("missing", "shell")).toBe(false);
    expect(paneTree.open).toBe(true);
    expect(layout.activePaneId).toBe("top-right");
  });
});

describe("the chord", () => {
  function key(init: KeyboardEventInit): KeyboardEvent {
    return new KeyboardEvent("keydown", { key: "A", code: "KeyA", shiftKey: true, ...init });
  }

  afterEach(() => {
    hydrateOverrides(null);
    vi.restoreAllMocks();
  });

  test("is Cmd+Shift+A on macOS and Ctrl+Shift+A elsewhere", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(isBuiltInPaneTreeChord(key({ metaKey: true }))).toBe(true);
    expect(isBuiltInPaneTreeChord(key({ ctrlKey: true }))).toBe(false);
    expect(isBuiltInPaneTreeChord(key({ metaKey: true, shiftKey: false, key: "a" }))).toBe(false);
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64)");
    expect(isBuiltInPaneTreeChord(key({ ctrlKey: true }))).toBe(true);
    expect(isBuiltInPaneTreeChord(key({ ctrlKey: true, altKey: true }))).toBe(false);
  });

  test("an assignment that moves the command or takes the chord leaves the built-in to the app's override path", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    assignOverride("app.pane.tree", "Mod+J");
    expect(isBuiltInPaneTreeChord(key({ metaKey: true }))).toBe(false);
    hydrateOverrides(null);
    assignOverride("app.window.reload", "Mod+Shift+A");
    expect(isBuiltInPaneTreeChord(key({ metaKey: true }))).toBe(false);
  });
});
