// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import {
  __testSetBootstrapHydrated,
  browserSelection,
  onWatchEvent,
  ui,
} from "./store.svelte";
import {
  cancelPaneMode,
  layout,
  paneActiveTabId,
  paneSide,
  paneTabs,
  resolveTabDestination,
  setTerminalSession,
  type DashboardTab,
  type LeafNode,
  type TerminalTab,
} from "./tabs.svelte";

function setTwoPaneLayout(): void {
  const left: LeafNode = {
    kind: "leaf",
    id: "pane-left",
    tabs: [],
    activeTabId: null,
    side: "a",
    theme: "light",
  };
  const right: LeafNode = {
    kind: "leaf",
    id: "pane-right",
    tabs: [],
    activeTabId: null,
    side: "a",
    theme: "dark",
  };
  layout.rootId = "split-root";
  layout.activePaneId = left.id;
  layout.nodes = {
    "split-root": {
      kind: "split",
      id: "split-root",
      direction: "row",
      a: left.id,
      b: right.id,
      ratio: 0.35,
    },
    [left.id]: left,
    [right.id]: right,
  };
}

function leaf(id: string): LeafNode {
  const node = layout.nodes[id];
  if (!node || node.kind !== "leaf") throw new Error(`expected leaf ${id}`);
  return node;
}

function dispatch(frame: Record<string, unknown>): void {
  onWatchEvent({
    type: "window_command",
    window_id: "window-a",
    ...frame,
  });
}

afterEach(() => {
  cancelPaneMode();
  vi.restoreAllMocks();
  __testSetBootstrapHydrated(true);
  ui.terminalOnly = false;
  ui.status = null;
  ui.statusKind = null;
  browserSelection.path = null;
  window.history.replaceState(null, "", "/");
  const pane: LeafNode = {
    kind: "leaf",
    id: "pane-reset",
    tabs: [],
    activeTabId: null,
  };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
});

describe("queued window command placement", () => {
  test("places every tab-opening command in the same explicit pane and side", async () => {
    window.history.replaceState(null, "", "/?w=window-a");
    setTwoPaneLayout();
    vi.spyOn(api, "readStream").mockResolvedValue({
      path: "README.md",
      content: "# readme\n",
      mtime: 1,
      mtime_ns: "1",
      writable: true,
    });

    const destination = { pane_id: "pane-right", side: "b" };
    dispatch({ command: "open_file", path: "README.md", destination });
    dispatch({ command: "open_browser", path: "", destination });
    dispatch({ command: "open_graph", path: "notes", is_dir: true, destination });
    dispatch({
      command: "open_graph_link",
      link: "chan://graph?s=workspace&m=s&f=2ltmaifds",
      destination,
    });
    dispatch({
      command: "open_term_new",
      tab_name: "build",
      tab_group: "agents",
      spawn_command: "./run-my-agent.sh",
      env: { CHAN_AGENT: "codex" },
      destination,
    });
    dispatch({
      command: "open_dashboard",
      carousel_index: 1,
      carousel_off: true,
      destination,
    });
    dispatch({
      command: "team_spawned",
      group: "team-1",
      members: [
        { tab_name: "lead", session_id: "session-lead" },
        { tab_name: "worker", session_id: "session-worker" },
      ],
      destination,
    });

    await vi.waitFor(() => {
      expect(paneTabs(leaf("pane-right"), "b").map((tab) => tab.kind)).toEqual([
        "file",
        "browser",
        "graph",
        "graph",
        "terminal",
        "dashboard",
        "terminal",
        "terminal",
      ]);
    });
    const target = leaf("pane-right");
    expect(target.tabs).toHaveLength(0);
    expect(paneSide(target)).toBe("b");
    expect(layout.activePaneId).toBe(target.id);
    expect(paneActiveTabId(target, "b")).toBe(paneTabs(target, "b").at(-1)?.id);
    expect(browserSelection.path).toBeNull();
    const terminals = paneTabs(target, "b").filter((tab) => tab.kind === "terminal");
    expect(terminals.map((tab) => tab.title)).toEqual(["build", "lead", "worker"]);
    expect(terminals[0]).toMatchObject({
      spawnCommand: "./run-my-agent.sh",
      spawnEnv: { CHAN_AGENT: "codex" },
    });
    setTerminalSession(terminals[0]!, "session-build");
    expect(terminals[0]?.spawnCommand).toBeUndefined();
    expect(terminals[0]?.spawnEnv).toBeUndefined();
  });

  test("refuses an invalid explicit pane for every opener without fallback or mutation", () => {
    window.history.replaceState(null, "", "/?w=window-a");
    setTwoPaneLayout();
    const before = JSON.stringify(layout.nodes);
    const destination = { pane_id: "pane-missing", side: "b" };
    const read = vi.spyOn(api, "readStream").mockResolvedValue({
      path: "README.md",
      content: "",
      mtime: 1,
      writable: true,
    });
    const frames = [
      { command: "open_file", path: "README.md", destination },
      { command: "open_browser", path: "", destination },
      { command: "open_graph", destination },
      {
        command: "open_graph_link",
        link: "chan://graph?s=workspace&m=s&f=2ltmaifds",
        destination,
      },
      { command: "open_term_new", destination },
      { command: "open_dashboard", destination },
      {
        command: "team_spawned",
        group: "team-1",
        members: [
          // The position must not carve anything when the destination
          // refuses: the grid build only runs on a resolved pane.
          { tab_name: "lead", session_id: "session-lead", position: { row: 0, col: 0 } },
        ],
        destination,
      },
    ];

    for (const frame of frames) {
      dispatch(frame);
      expect(JSON.stringify(layout.nodes)).toBe(before);
      expect(layout.activePaneId).toBe("pane-left");
      expect(ui.status).toBe("placement failed: no such pane pane-missing");
    }
    expect(read).not.toHaveBeenCalled();
  });

  test("resolves omitted coordinates from the active pane and visible side", () => {
    setTwoPaneLayout();
    const left = leaf("pane-left");
    left.side = "b";
    expect(resolveTabDestination()).toEqual({ paneId: "pane-left", side: "b" });
    expect(resolveTabDestination({ side: "a" })).toEqual({
      paneId: "pane-left",
      side: "a",
    });
    expect(resolveTabDestination({ paneId: "pane-right" })).toEqual({
      paneId: "pane-right",
      side: "a",
    });
    expect(resolveTabDestination({ paneId: "pane-missing" })).toBeNull();
  });
});

describe("team spawn grid placement", () => {
  function leaves(): LeafNode[] {
    return Object.values(layout.nodes).filter((n): n is LeafNode => n.kind === "leaf");
  }
  function paneHolding(title: string): LeafNode | null {
    for (const pane of leaves()) {
      for (const side of ["a", "b"] as const) {
        if (paneTabs(pane, side).some((tab) => tab.title === title)) return pane;
      }
    }
    return null;
  }
  /// The host terminal that ran `cs terminal team`: pre-existing content in
  /// the seed pane before the team surfaces.
  function seedHostTerminal(paneId: string): void {
    const pane = leaf(paneId);
    const host: TerminalTab = {
      kind: "terminal",
      id: "term-host",
      title: "host",
      createdAt: 1,
      broadcastEnabled: false,
      broadcastTargetIds: [],
      terminalSessionId: "session-host",
    };
    pane.tabs = [host];
    pane.activeTabId = host.id;
  }

  test("positions carve the destination pane into the config grid", () => {
    window.history.replaceState(null, "", "/?w=window-a");
    seedHostTerminal("pane-reset");
    dispatch({
      command: "team_spawned",
      group: "team-1",
      members: [
        { tab_name: "lead", session_id: "s-lead", position: { row: 0, col: 0 } },
        { tab_name: "w1", session_id: "s-w1", position: { row: 0, col: 1 } },
        { tab_name: "w2", session_id: "s-w2", position: { row: 1, col: 0 } },
        { tab_name: "w3", session_id: "s-w3", position: { row: 1, col: 1 } },
        { tab_name: "w4", session_id: "s-w4", position: { row: 2, col: 0 } },
      ],
    });
    // 5 members positioned over a 3x2 grid: six leaves.
    expect(leaves()).toHaveLength(6);
    // Each member sits in its own pane.
    const memberPanes = ["lead", "w1", "w2", "w3", "w4"].map((t) => paneHolding(t)?.id);
    expect(new Set(memberPanes).size).toBe(5);
    // The host terminal moved to the member-free cell instead of hiding
    // behind the lead in cell 0.
    const hostPane = paneHolding("host");
    expect(hostPane).not.toBeNull();
    expect(memberPanes).not.toContain(hostPane!.id);
    // Focus lands back on the lead's pane after the grid build walks it
    // to the bottom-right cell.
    expect(layout.activePaneId).toBe(paneHolding("lead")!.id);
  });

  test("a full grid keeps the host stacked with the cell-0 member", () => {
    window.history.replaceState(null, "", "/?w=window-a");
    seedHostTerminal("pane-reset");
    dispatch({
      command: "team_spawned",
      group: "team-1",
      members: [
        { tab_name: "lead", session_id: "s-lead", position: { row: 0, col: 0 } },
        { tab_name: "w1", session_id: "s-w1", position: { row: 0, col: 1 } },
      ],
    });
    // No member-free cell: the host has nowhere of its own and stays
    // stacked in cell 0.
    expect(leaves()).toHaveLength(2);
    expect(paneHolding("host")!.id).toBe(paneHolding("lead")!.id);
    expect(paneHolding("w1")!.id).not.toBe(paneHolding("lead")!.id);
  });

  test("an implausible grid falls back to stacking", () => {
    window.history.replaceState(null, "", "/?w=window-a");
    dispatch({
      command: "team_spawned",
      group: "team-1",
      members: [
        // A 10x10 coordinate is past the server's 9-pane validation cap;
        // only a drifted server can push it. Stack instead of carving.
        { tab_name: "lead", session_id: "s-lead", position: { row: 9, col: 9 } },
        { tab_name: "w1", session_id: "s-w1" },
      ],
    });
    expect(leaves()).toHaveLength(1);
    const pane = leaf("pane-reset");
    expect(paneTabs(pane, paneSide(pane)).map((tab) => tab.title)).toEqual(["lead", "w1"]);
  });
});

describe("pane command semantics", () => {
  test("reports both sides, including an explicit empty side", async () => {
    window.history.replaceState(null, "", "/?w=window-a");
    setTwoPaneLayout();
    const dashboard: DashboardTab = {
      kind: "dashboard",
      id: "dashboard-a",
      title: "Dashboard",
    };
    const terminal: TerminalTab = {
      kind: "terminal",
      id: "terminal-b",
      title: "build",
      createdAt: 1,
      broadcastEnabled: false,
      broadcastTargetIds: [],
      terminalSessionId: "session-build",
    };
    const left = leaf("pane-left");
    left.tabs = [dashboard];
    left.activeTabId = dashboard.id;
    left.bTabs = [terminal];
    left.bActiveTabId = terminal.id;
    const reply = vi.spyOn(api, "windowReply").mockResolvedValue(undefined);

    dispatch({ command: "pane_query", request_id: "request-list" });

    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    const request = reply.mock.calls[0]![0];
    expect(request.requestId).toBe("request-list");
    expect(request.payload).toMatchObject({
      windowId: "window-a",
      activePaneId: "pane-left",
      panes: [
        {
          id: "pane-left",
          active: true,
          activeSide: "a",
          sides: {
            a: {
              activeTabId: "dashboard-a",
              tabs: [{ id: "dashboard-a", kind: "dashboard", active: true }],
            },
            b: {
              activeTabId: "terminal-b",
              tabs: [{ id: "terminal-b", kind: "terminal", active: true, live: true }],
            },
          },
        },
        {
          id: "pane-right",
          sides: {
            a: { activeTabId: null, tabs: [] },
            b: { activeTabId: null, tabs: [] },
          },
        },
      ],
    });
  });

  test("focus-side, resize, equalize, swap, and new use the live Hybrid operations", async () => {
    window.history.replaceState(null, "", "/?w=window-a");
    __testSetBootstrapHydrated(false);
    setTwoPaneLayout();
    const leftTab: DashboardTab = {
      kind: "dashboard",
      id: "left-tab",
      title: "Left",
    };
    const rightTab: DashboardTab = {
      kind: "dashboard",
      id: "right-tab",
      title: "Right",
    };
    const left = leaf("pane-left");
    left.tabs = [leftTab];
    left.activeTabId = leftTab.id;
    const right = leaf("pane-right");
    right.bTabs = [rightTab];
    right.bActiveTabId = rightTab.id;
    right.side = "b";
    const reply = vi.spyOn(api, "windowReply").mockResolvedValue(undefined);

    dispatch({
      command: "pane_exec",
      request_id: "request-focus",
      op: { kind: "focus", pane_id: "pane-right", side: "b" },
    });
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    expect(layout.activePaneId).toBe("pane-right");
    expect(paneSide(right)).toBe("b");

    dispatch({
      command: "pane_exec",
      request_id: "request-resize",
      op: { kind: "resize", pane_id: "pane-left", delta: 0.1 },
    });
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(2));
    const resized = layout.nodes["split-root"];
    expect(resized?.kind).toBe("split");
    if (resized?.kind !== "split") throw new Error("expected split root");
    expect(resized.ratio).toBeCloseTo(0.45);

    dispatch({
      command: "pane_exec",
      request_id: "request-equalize",
      op: { kind: "equalize", pane_id: "pane-left" },
    });
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(3));
    expect(layout.nodes["split-root"]).toMatchObject({ ratio: 0.5 });

    dispatch({
      command: "pane_exec",
      request_id: "request-swap",
      op: {
        kind: "swap",
        pane_id: "pane-left",
        other_pane_id: "pane-right",
      },
    });
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(4));
    expect(paneTabs(leaf("pane-left"), "b").map((tab) => tab.id)).toEqual(["right-tab"]);
    expect(paneTabs(leaf("pane-right"), "a").map((tab) => tab.id)).toEqual(["left-tab"]);
    expect(leaf("pane-left").theme).toBe("dark");
    expect(leaf("pane-right").theme).toBe("light");
    expect(layout.activePaneId).toBe("pane-right");

    dispatch({
      command: "pane_exec",
      request_id: "request-split",
      op: { kind: "split", pane_id: "pane-left", dir: "right" },
    });
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(5));
    const splitReply = reply.mock.calls[4]![0].payload as {
      ok: boolean;
      paneId?: string;
      activeSide?: string;
    };
    expect(splitReply.ok).toBe(true);
    expect(splitReply.paneId).toBeTruthy();
    expect(splitReply.activeSide).toBe("a");
    expect(layout.activePaneId).toBe(splitReply.paneId);
    expect(leaf(splitReply.paneId!)).toMatchObject({ tabs: [], activeTabId: null });
  });

  test("new preserves the standalone-terminal no-empty-pane invariant", async () => {
    window.history.replaceState(null, "", "/?w=window-a&kind=terminal");
    __testSetBootstrapHydrated(false);
    ui.terminalOnly = true;
    setTwoPaneLayout();
    const reply = vi.spyOn(api, "windowReply").mockResolvedValue(undefined);

    dispatch({
      command: "pane_exec",
      request_id: "request-terminal-split",
      op: { kind: "split", pane_id: "pane-left", dir: "bottom" },
    });

    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    const result = reply.mock.calls[0]![0].payload as { paneId?: string };
    const pane = leaf(result.paneId!);
    expect(pane.tabs).toHaveLength(1);
    expect(pane.tabs[0]?.kind).toBe("terminal");
    expect(layout.activePaneId).toBe(pane.id);
  });

  test("close preflights both sides and leaves the pane unchanged when blocked", async () => {
    window.history.replaceState(null, "", "/?w=window-a");
    __testSetBootstrapHydrated(false);
    setTwoPaneLayout();
    const live: TerminalTab = {
      kind: "terminal",
      id: "terminal-live",
      title: "build",
      createdAt: 1,
      broadcastEnabled: false,
      broadcastTargetIds: [],
      terminalSessionId: "session-live",
    };
    const left = leaf("pane-left");
    left.bTabs = [live];
    left.bActiveTabId = live.id;
    const before = JSON.stringify(layout.nodes);
    const reply = vi.spyOn(api, "windowReply").mockResolvedValue(undefined);

    dispatch({
      command: "pane_exec",
      request_id: "request-close",
      op: { kind: "close_pane", pane_id: "pane-left", force: false },
    });

    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(layout.nodes)).toBe(before);
    expect(reply.mock.calls[0]![0].payload).toMatchObject({
      ok: false,
      summary: "blocked 1 tab(s)",
      blocked: [{ tab: "build", reason: "live terminal" }],
    });
  });
});
