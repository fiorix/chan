// @vitest-environment jsdom

// `reconcileLayout` applies a co-viewer's persisted layout snapshot onto
// the live tree in place (never remounting tabs), and refuses -- as one
// atomic no-op -- anything structurally diverged. These tests pin both
// halves plus the contracts the session-sync handler builds on:
// idempotence and echo round-trips.

import { afterEach, describe, expect, test, vi } from "vitest";

// The per-file caret index is a localStorage store; mock it the same way
// tabs.test.ts does so importing the module never touches real storage.
vi.mock("./caretIndex");

import {
  layout,
  paneActiveTabId,
  paneSide,
  reconcileLayout,
  serializeLayout,
  type FileTab,
  type LeafNode,
  type SerNode,
  type SplitNode,
  type Tab,
  type TerminalTab,
} from "./tabs.svelte";

function fileTab(partial: Partial<FileTab> = {}): FileTab {
  return {
    kind: "file",
    fileKind: "document",
    id: "file-1",
    path: "notes/a.md",
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
    ...partial,
  };
}

function terminalTab(partial: Partial<TerminalTab> = {}): TerminalTab {
  return {
    kind: "terminal",
    id: "term-1",
    title: "Terminal",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
    ...partial,
  };
}

// Both reset helpers return the LIVE nodes read back from `layout.nodes`:
// a tab or pane object pushed into `$state` is only observable through its
// Svelte proxy -- in-place mutations never land on the raw pre-push object
// (see the applyGlobalTerminalName note in tabs.svelte.ts).
function resetLayout(tabs: Tab[], partial: Partial<LeafNode> = {}): LeafNode {
  const pane: LeafNode = {
    kind: "leaf",
    id: "pane-test",
    tabs,
    activeTabId: tabs[0]?.id ?? null,
    ...partial,
  };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  layout.focusColor = "blue";
  return layout.nodes[pane.id] as LeafNode;
}

function resetSplitLayout(
  aTabs: Tab[],
  bTabs: Tab[],
  opts: { direction?: SplitNode["direction"]; ratio?: number } = {},
): { split: SplitNode; a: LeafNode; b: LeafNode } {
  const a: LeafNode = {
    kind: "leaf",
    id: "pane-a",
    tabs: aTabs,
    activeTabId: aTabs[0]?.id ?? null,
  };
  const b: LeafNode = {
    kind: "leaf",
    id: "pane-b",
    tabs: bTabs,
    activeTabId: bTabs[0]?.id ?? null,
  };
  const split: SplitNode = {
    kind: "split",
    id: "split-test",
    direction: opts.direction ?? "row",
    a: a.id,
    b: b.id,
    ratio: opts.ratio ?? 0.5,
  };
  layout.rootId = split.id;
  layout.activePaneId = a.id;
  layout.nodes = { [a.id]: a, [b.id]: b, [split.id]: split };
  layout.focusColor = "blue";
  return {
    split: layout.nodes[split.id] as SplitNode,
    a: layout.nodes[a.id] as LeafNode,
    b: layout.nodes[b.id] as LeafNode,
  };
}

/// Stable full-state fingerprint (structure + view markers) for
/// asserting that an apply or a refused apply changed nothing.
function fingerprint(): string {
  return JSON.stringify({
    layout: serializeLayout({ terminalSessions: true }),
    activePaneId: layout.activePaneId,
    perPaneActive: Object.values(layout.nodes)
      .filter((n) => n.kind === "leaf")
      .map((n) => [n.id, n.activeTabId, n.bActiveTabId ?? null]),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  resetLayout([]);
});

describe("reconcileLayout in-place subset", () => {
  test("applies a changed split ratio", () => {
    const { split } = resetSplitLayout(
      [fileTab()],
      [fileTab({ id: "file-2", path: "notes/b.md" })],
    );
    const remote: SerNode = {
      k: "s",
      d: "r",
      r: 0.7,
      a: { k: "l", t: [{ p: "notes/a.md", m: "wysiwyg" }] },
      b: { k: "l", t: [{ p: "notes/b.md", m: "wysiwyg" }] },
    };

    expect(reconcileLayout(remote)).toBe("applied");
    expect(split.ratio).toBe(0.7);
  });

  test("an absent ratio means the peer sits at the 50/50 default", () => {
    const { split } = resetSplitLayout(
      [fileTab()],
      [fileTab({ id: "file-2", path: "notes/b.md" })],
      { ratio: 0.8 },
    );
    const remote: SerNode = {
      k: "s",
      d: "r",
      a: { k: "l", t: [{ p: "notes/a.md" }] },
      b: { k: "l", t: [{ p: "notes/b.md" }] },
    };

    expect(reconcileLayout(remote)).toBe("applied");
    expect(split.ratio).toBe(0.5);
  });

  test("applies an A/B side flip and seeds the incoming side's active tab", () => {
    const bTab = terminalTab({ id: "term-b" });
    const pane = resetLayout([fileTab()], {
      bTabs: [bTab],
      bActiveTabId: null,
    });
    const remote: SerNode = {
      k: "l",
      t: [{ p: "notes/a.md" }],
      bt: [{ k: "t", n: "Terminal" }],
      sb: 1,
    };

    expect(reconcileLayout(remote)).toBe("applied");
    expect(paneSide(pane)).toBe("b");
    expect(paneActiveTabId(pane, "b")).toBe(bTab.id);
  });

  test("flips back to side A when the remote drops sb", () => {
    const pane = resetLayout([fileTab()], {
      bTabs: [terminalTab({ id: "term-b" })],
      bActiveTabId: "term-b",
      side: "b",
    });
    const remote: SerNode = {
      k: "l",
      t: [{ p: "notes/a.md" }],
      bt: [{ k: "t", n: "Terminal" }],
    };

    expect(reconcileLayout(remote)).toBe("applied");
    expect(paneSide(pane)).toBe("a");
  });

  test("applies and clears the per-pane hybrid theme override", () => {
    const pane = resetLayout([fileTab()]);

    expect(reconcileLayout({ k: "l", t: [{ p: "notes/a.md" }], ht: "d" })).toBe(
      "applied",
    );
    expect(pane.theme).toBe("dark");

    // Absence means "follow global": the override clears, it does not stick.
    expect(reconcileLayout({ k: "l", t: [{ p: "notes/a.md" }] })).toBe(
      "applied",
    );
    expect(pane.theme).toBeUndefined();
  });

  test("applies the window focus color, absence meaning the default", () => {
    resetLayout([fileTab()]);

    expect(reconcileLayout({ k: "l", t: [{ p: "notes/a.md" }], wc: "g" })).toBe(
      "applied",
    );
    expect(layout.focusColor).toBe("green");

    expect(reconcileLayout({ k: "l", t: [{ p: "notes/a.md" }] })).toBe(
      "applied",
    );
    expect(layout.focusColor).toBe("blue");
  });

  test("applies a renamed terminal title positionally", () => {
    const pane = resetLayout([terminalTab({ terminalSessionId: "ts-1" })]);
    const remote: SerNode = {
      k: "l",
      t: [{ k: "t", n: "build watch", tsid: "ts-1" }],
    };

    expect(reconcileLayout(remote)).toBe("applied");
    expect((pane.tabs[0] as TerminalTab).title).toBe("build watch");
  });

  test("an empty remote terminal title keeps the local one", () => {
    const pane = resetLayout([terminalTab({ title: "local name" })]);

    expect(reconcileLayout({ k: "l", t: [{ k: "t", n: "" }] })).toBe("applied");
    expect((pane.tabs[0] as TerminalTab).title).toBe("local name");
  });

  test("never applies remote active/focus markers", () => {
    const tabA = fileTab({ id: "file-a" });
    const tabB = fileTab({ id: "file-b", path: "notes/b.md" });
    const { a, b } = resetSplitLayout([tabA, tabB], [terminalTab()]);
    a.activeTabId = tabA.id;
    layout.activePaneId = a.id;
    // Remote marks the OTHER tab active and the OTHER pane focused.
    const remote: SerNode = {
      k: "s",
      d: "r",
      a: {
        k: "l",
        t: [{ p: "notes/a.md" }, { p: "notes/b.md", a: 1 }],
      },
      b: { k: "l", t: [{ k: "t", n: "Terminal" }], f: 1 },
    };

    expect(reconcileLayout(remote)).toBe("applied");
    expect(a.activeTabId).toBe(tabA.id);
    expect(layout.activePaneId).toBe(a.id);
    expect(b.activeTabId).not.toBeNull();
  });
});

describe("reconcileLayout tab-set sync", () => {
  test("a tab the peer opened is created loading, in remote order", () => {
    const pane = resetLayout([fileTab()]);
    const remote: SerNode = {
      k: "l",
      t: [{ p: "notes/new.md" }, { p: "notes/a.md" }],
    };

    expect(reconcileLayout(remote)).toBe("applied");
    expect(pane.tabs).toHaveLength(2);
    const created = pane.tabs[0] as FileTab;
    expect(created.path).toBe("notes/new.md");
    expect(created.loading).toBe(true);
    // The pre-existing tab is the SAME object, not a recreate.
    expect(pane.tabs[1]!.id).toBe("file-1");
  });

  test("a clean tab the peer closed is removed; the local active falls back", () => {
    const keep = fileTab({ id: "file-keep", path: "notes/b.md" });
    const pane = resetLayout([fileTab(), keep]);
    pane.activeTabId = "file-1";

    expect(reconcileLayout({ k: "l", t: [{ p: "notes/b.md", a: 1 }] })).toBe(
      "applied",
    );
    expect(pane.tabs).toHaveLength(1);
    expect(pane.tabs[0]!.id).toBe("file-keep");
    expect(pane.activeTabId).toBe("file-keep");
  });

  test("a peer terminal with a tsid reattaches, never spawns", () => {
    const pane = resetLayout([fileTab()]);
    const remote: SerNode = {
      k: "l",
      t: [
        { p: "notes/a.md" },
        { k: "t", n: "peer term", tsid: "ts-peer", tc: 1 },
      ],
    };

    expect(reconcileLayout(remote)).toBe("applied");
    const term = pane.tabs[1] as TerminalTab;
    expect(term.kind).toBe("terminal");
    expect(term.terminalSessionId).toBe("ts-peer");
    expect(term.controlledTerminal).toBe(true);
    expect(term.title).toBe("peer term");
  });

  test("a peer terminal without a tsid is skipped and flags divergence", () => {
    const pane = resetLayout([fileTab()]);
    const remote: SerNode = {
      k: "l",
      t: [{ p: "notes/a.md" }, { k: "t", n: "not yet connected" }],
    };

    expect(reconcileLayout(remote)).toBe("diverged");
    expect(pane.tabs).toHaveLength(1);
  });

  test("a live terminal the peer closed is removed", () => {
    const pane = resetLayout([
      fileTab(),
      terminalTab({ terminalSessionId: "ts-1" }),
    ]);

    expect(reconcileLayout({ k: "l", t: [{ p: "notes/a.md" }] })).toBe(
      "applied",
    );
    expect(pane.tabs).toHaveLength(1);
    expect(pane.tabs[0]!.kind).toBe("file");
  });

  test("a terminal tsid swap closes the old view and reattaches the new id", () => {
    const pane = resetLayout([terminalTab({ terminalSessionId: "ts-old" })]);

    expect(
      reconcileLayout({ k: "l", t: [{ k: "t", n: "T", tsid: "ts-new" }] }),
    ).toBe("applied");
    expect(pane.tabs).toHaveLength(1);
    expect((pane.tabs[0] as TerminalTab).terminalSessionId).toBe("ts-new");
  });

  test("a structure-only blob (no tsids) keeps live terminals by ordinal", () => {
    const pane = resetLayout([terminalTab({ terminalSessionId: "ts-live" })]);

    expect(reconcileLayout({ k: "l", t: [{ k: "t", n: "renamed" }] })).toBe(
      "applied",
    );
    expect(pane.tabs[0]!.id).toBe("term-1");
    expect((pane.tabs[0] as TerminalTab).title).toBe("renamed");
    expect((pane.tabs[0] as TerminalTab).terminalSessionId).toBe("ts-live");
  });

  test("legacy overlay kinds in a remote blob drop silently", () => {
    const pane = resetLayout([fileTab()]);

    expect(
      reconcileLayout({ k: "l", t: [{ k: "s" }, { p: "notes/a.md" }] }),
    ).toBe("applied");
    expect(pane.tabs).toHaveLength(1);
    expect(pane.tabs[0]!.id).toBe("file-1");
  });

  test("a reorder moves the same live objects, no recreates", () => {
    const a = fileTab();
    const b = fileTab({ id: "file-2", path: "notes/b.md" });
    const pane = resetLayout([a, b]);

    expect(
      reconcileLayout({
        k: "l",
        t: [{ p: "notes/b.md" }, { p: "notes/a.md" }],
      }),
    ).toBe("applied");
    expect(pane.tabs.map((t) => t.id)).toEqual(["file-2", "file-1"]);
  });

  test("a cross-pane move salvages the live object into the target pane", () => {
    const moved = fileTab({ id: "file-moved", path: "notes/b.md" });
    const { a: paneA, b: paneB } = resetSplitLayout(
      [fileTab(), moved],
      [terminalTab({ terminalSessionId: "ts-1" })],
    );
    const remote: SerNode = {
      k: "s",
      d: "r",
      a: { k: "l", t: [{ p: "notes/a.md" }] },
      b: { k: "l", t: [{ k: "t", tsid: "ts-1" }, { p: "notes/b.md" }] },
    };

    expect(reconcileLayout(remote)).toBe("applied");
    expect(paneA.tabs.map((t) => t.id)).toEqual(["file-1"]);
    expect(paneB.tabs.map((t) => t.id)).toEqual(["term-1", "file-moved"]);
  });

  test("side B syncs too: the peer emptying side B clears clean b tabs", () => {
    const pane = resetLayout([fileTab()], {
      bTabs: [terminalTab({ terminalSessionId: "ts-1" })],
      bActiveTabId: "term-1",
    });

    expect(reconcileLayout({ k: "l", t: [{ p: "notes/a.md" }] })).toBe(
      "applied",
    );
    expect(pane.bTabs ?? []).toHaveLength(0);
    expect(pane.bActiveTabId).toBeNull();
  });
});

describe("reconcileLayout rebuild + salvage", () => {
  test("a leaf-to-split rebuild salvages live tabs into the new panes", () => {
    const file = fileTab();
    const term = terminalTab({ terminalSessionId: "ts-1" });
    resetLayout([file, term]);
    const remote: SerNode = {
      k: "s",
      d: "r",
      r: 0.4,
      a: { k: "l", t: [{ p: "notes/a.md" }] },
      b: { k: "l", t: [{ k: "t", tsid: "ts-1" }], f: 1 },
    };

    expect(reconcileLayout(remote)).toBe("applied");
    const root = layout.nodes[layout.rootId]!;
    expect(root.kind).toBe("split");
    if (root.kind !== "split") return;
    expect(root.ratio).toBe(0.4);
    const paneA = layout.nodes[root.a] as LeafNode;
    const paneB = layout.nodes[root.b] as LeafNode;
    // Salvage: the SAME live objects landed in the new panes.
    expect(paneA.tabs.map((t) => t.id)).toEqual(["file-1"]);
    expect(paneB.tabs.map((t) => t.id)).toEqual(["term-1"]);
    // The replaced pane is gone from the node table.
    expect(layout.nodes["pane-test"]).toBeUndefined();
    // Local focused pane vanished -> the remote focus marker wins.
    expect(layout.activePaneId).toBe(paneB.id);
  });

  test("a split direction flip rebuilds and salvages", () => {
    resetSplitLayout([fileTab()], [terminalTab({ terminalSessionId: "ts-1" })]);
    const remote: SerNode = {
      k: "s",
      d: "c",
      a: { k: "l", t: [{ p: "notes/a.md" }] },
      b: { k: "l", t: [{ k: "t", tsid: "ts-1" }] },
    };

    expect(reconcileLayout(remote)).toBe("applied");
    const root = layout.nodes[layout.rootId]!;
    expect(root.kind).toBe("split");
    if (root.kind !== "split") return;
    expect(root.direction).toBe("column");
    expect((layout.nodes[root.a] as LeafNode).tabs[0]!.id).toBe("file-1");
    expect((layout.nodes[root.b] as LeafNode).tabs[0]!.id).toBe("term-1");
  });

  test("a split-to-leaf collapse salvages the surviving tab set", () => {
    resetSplitLayout(
      [fileTab()],
      [fileTab({ id: "file-2", path: "notes/b.md" })],
    );

    expect(
      reconcileLayout({
        k: "l",
        t: [{ p: "notes/a.md" }, { p: "notes/b.md" }],
      }),
    ).toBe("applied");
    const root = layout.nodes[layout.rootId]!;
    expect(root.kind).toBe("leaf");
    if (root.kind !== "leaf") return;
    expect(root.tabs.map((t) => t.id)).toEqual(["file-1", "file-2"]);
  });
});

describe("reconcileLayout protection rules", () => {
  test("a dirty file tab the peer closed survives in its pane and flags divergence", () => {
    const dirty = fileTab({
      id: "file-dirty",
      path: "notes/dirty.md",
      content: "unsaved edits",
      saved: "old",
    });
    const pane = resetLayout([fileTab(), dirty]);

    expect(reconcileLayout({ k: "l", t: [{ p: "notes/a.md" }] })).toBe(
      "diverged",
    );
    expect(pane.tabs.map((t) => t.id)).toEqual(["file-1", "file-dirty"]);
  });

  test("a dirty tab whose pane was rebuilt away parks in the focused pane", () => {
    const dirty = fileTab({
      id: "file-dirty",
      path: "notes/dirty.md",
      content: "unsaved edits",
      saved: "old",
    });
    resetSplitLayout([dirty], [fileTab({ id: "file-b", path: "notes/b.md" })]);

    // The peer collapsed the split to a single pane without the dirty tab.
    expect(reconcileLayout({ k: "l", t: [{ p: "notes/b.md" }] })).toBe(
      "diverged",
    );
    const root = layout.nodes[layout.rootId]!;
    expect(root.kind).toBe("leaf");
    if (root.kind !== "leaf") return;
    expect(root.tabs.map((t) => t.id)).toEqual(["file-b", "file-dirty"]);
    // The dirty keep never steals the active slot.
    expect(root.activeTabId).toBe("file-b");
  });

  test("an active pane-mode transaction applies an excluded-only update", async () => {
    const pane = resetLayout([fileTab()]);
    const { enterPaneMode, cancelPaneMode, paneMode } =
      await import("./tabs.svelte");
    enterPaneMode();
    try {
      expect(
        reconcileLayout({
          k: "l",
          t: [{ p: "notes/a.md", a: 1 }],
          f: 1,
          wc: "g",
        }),
      ).toBe("applied");
      expect(layout.focusColor).toBe("green");
      expect(paneMode.stale).toBe(false);
      expect(pane.tabs).toHaveLength(1);
    } finally {
      cancelPaneMode();
    }
  });

  test("an active pane-mode transaction defers a conflicting update", async () => {
    const pane = resetLayout([fileTab()]);
    const { enterPaneMode, cancelPaneMode, paneMode } =
      await import("./tabs.svelte");
    const remote: SerNode = {
      k: "l",
      t: [{ p: "notes/a.md" }, { p: "notes/b.md" }],
    };
    enterPaneMode();
    try {
      expect(reconcileLayout(remote)).toBe("deferred");
      expect(paneMode.stale).toBe(true);
      expect(paneMode.pendingRemoteLayout).toEqual(remote);
      expect(pane.tabs).toHaveLength(1);
    } finally {
      cancelPaneMode();
    }
  });
});

describe("reconcileLayout idempotence and echo", () => {
  test("applying the same remote twice is a no-op", () => {
    resetSplitLayout([fileTab()], [terminalTab({ terminalSessionId: "ts-1" })]);
    const remote: SerNode = {
      k: "s",
      d: "r",
      r: 0.62,
      wc: "p",
      a: { k: "l", t: [{ p: "notes/a.md" }], ht: "l" },
      b: { k: "l", t: [{ k: "t", n: "peer name", tsid: "ts-1" }] },
    };

    expect(reconcileLayout(remote)).toBe("applied");
    const after = fingerprint();
    expect(reconcileLayout(remote)).toBe("applied");
    expect(fingerprint()).toBe(after);
  });

  test("a serialize->reconcile round-trip of the live tree changes nothing", () => {
    resetSplitLayout(
      [fileTab(), fileTab({ id: "file-2", path: "notes/b.md" })],
      [terminalTab({ terminalSessionId: "ts-1", title: "worker" })],
      { direction: "column", ratio: 0.33 },
    );
    layout.focusColor = "orange";
    const before = fingerprint();
    const snapshot = serializeLayout({ terminalSessions: true });
    expect(snapshot).not.toBeNull();

    expect(reconcileLayout(snapshot!)).toBe("applied");
    expect(fingerprint()).toBe(before);
  });
});
