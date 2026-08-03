import { afterEach, describe, expect, test, vi } from "vitest";

import {
  applyTerminalRoster,
  cancelPaneMode,
  enterPaneMode,
  flipHybrid,
  layout,
  paneMode,
  paneModeConflictFieldSets,
  paneModeDeferRemoteLayout,
  paneModeLayoutsSemanticallyEqual,
  paneModeMarkStaleForAuthoritativeMetadata,
  paneModeOpenTerminal,
  paneModeRemoveStagedDraftEditor,
  paneModeStageDiagramEditor,
  paneModeStageDraftEditor,
  paneModeStagedDraftEditorsFor,
  paneModeStagedTabIds,
  reconcileLayout,
  registerPaneModeSettledSink,
  registerTerminalCloseSink,
  serializeLayout,
  terminalTabGroup,
  type LeafNode,
  type SerNode,
  type SerTab,
  type SplitNode,
  type TerminalTab,
} from "./tabs.svelte";

type LayoutPair = () => [SerNode | null, SerNode | null];

function clone<T>(value: T): T {
  return structuredClone(value);
}

function leaf(tabs: SerTab[] = []): SerNode {
  return { k: "l", t: tabs };
}

function splitFixture(): SerNode {
  return {
    k: "s",
    d: "r",
    r: 0.6,
    a: {
      k: "l",
      f: 1,
      t: [
        { k: "f", p: "notes/a.md", a: 1 },
        { k: "x", xi: "calendar", n: "Calendar" },
      ],
    },
    b: {
      k: "l",
      t: [{ k: "t", n: "worker", tg: "agents", tsid: "session-1", a: 1 }],
    },
  };
}

function changed(
  mutate: (candidate: SerNode) => void,
  baseline: SerNode = splitFixture(),
): [SerNode, SerNode] {
  const candidate = clone(baseline);
  mutate(candidate);
  return [baseline, candidate];
}

const includedCases: [string, LayoutPair][] = [
  [
    "pane inventory",
    () =>
      changed((node) => {
        if (node.k !== "s") throw new Error("expected split");
        node.b = { k: "s", d: "c", a: node.b, b: leaf() };
      }),
  ],
  [
    "pane nesting",
    () =>
      changed((node) => {
        if (node.k !== "s") throw new Error("expected split");
        node.a = { k: "s", d: "r", a: node.a, b: leaf() };
      }),
  ],
  [
    "split direction",
    () =>
      changed((node) => {
        if (node.k !== "s") throw new Error("expected split");
        node.d = "c";
      }),
  ],
  [
    "split ratio",
    () =>
      changed((node) => {
        if (node.k !== "s") throw new Error("expected split");
        node.r = 0.7;
      }),
  ],
  [
    "split child order",
    () =>
      changed((node) => {
        if (node.k !== "s") throw new Error("expected split");
        [node.a, node.b] = [node.b, node.a];
      }),
  ],
  [
    "tab inventory",
    () =>
      changed((node) => {
        if (node.k !== "s" || node.a.k !== "l")
          throw new Error("expected leaf");
        node.a.t.push({ k: "b" });
      }),
  ],
  [
    "tab order",
    () =>
      changed((node) => {
        if (node.k !== "s" || node.a.k !== "l")
          throw new Error("expected leaf");
        [node.a.t[0], node.a.t[1]] = [node.a.t[1]!, node.a.t[0]!];
      }),
  ],
  [
    "tab pane placement",
    () =>
      changed((node) => {
        if (node.k !== "s" || node.a.k !== "l" || node.b.k !== "l") {
          throw new Error("expected leaves");
        }
        node.b.t.push(node.a.t.pop()!);
      }),
  ],
  [
    "tab Hybrid-side placement",
    () =>
      changed((node) => {
        if (node.k !== "s" || node.a.k !== "l")
          throw new Error("expected leaf");
        node.a.bt = [node.a.t.pop()!];
      }),
  ],
  [
    "active pane",
    () =>
      changed((node) => {
        if (node.k !== "s" || node.a.k !== "l" || node.b.k !== "l") {
          throw new Error("expected leaves");
        }
        delete node.a.f;
        node.b.f = 1;
      }),
  ],
  [
    "active side",
    () =>
      changed((node) => {
        if (node.k !== "s" || node.a.k !== "l")
          throw new Error("expected leaf");
        node.a.sb = 1;
      }),
  ],
  [
    "active tab",
    () =>
      changed((node) => {
        if (node.k !== "s" || node.a.k !== "l")
          throw new Error("expected leaf");
        delete node.a.t[0]!.a;
        node.a.t[1]!.a = 1;
      }),
  ],
  [
    "file identity",
    () =>
      changed((node) => {
        if (node.k !== "s" || node.a.k !== "l")
          throw new Error("expected leaf");
        node.a.t[0]!.p = "notes/other.md";
      }),
  ],
  [
    "extension identity",
    () =>
      changed((node) => {
        if (node.k !== "s" || node.a.k !== "l")
          throw new Error("expected leaf");
        node.a.t[1]!.xi = "tasks";
      }),
  ],
  [
    "terminal live name",
    () =>
      changed((node) => {
        if (node.k !== "s" || node.b.k !== "l")
          throw new Error("expected leaf");
        node.b.t[0]!.n = "renamed";
      }),
  ],
  [
    "terminal live group",
    () =>
      changed((node) => {
        if (node.k !== "s" || node.b.k !== "l")
          throw new Error("expected leaf");
        node.b.t[0]!.tg = "reviewers";
      }),
  ],
  [
    "settled terminal identity",
    () =>
      changed((node) => {
        if (node.k !== "s" || node.b.k !== "l")
          throw new Error("expected leaf");
        node.b.t[0]!.tsid = "session-2";
      }),
  ],
];

describe("paneModeLayoutsSemanticallyEqual conflict fields", () => {
  test.each(includedCases)("detects %s", (_name, makePair) => {
    const [baseline, incoming] = makePair();
    expect(paneModeLayoutsSemanticallyEqual(baseline, incoming)).toBe(false);
  });

  test("normalizes compact omitted defaults", () => {
    const baseline: SerNode = {
      k: "s",
      d: "r",
      a: { k: "l", t: [{ p: "notes/a.md" }] },
      b: { k: "l", t: [{ k: "t", n: "Terminal" }] },
    };
    const expanded: SerNode = {
      k: "s",
      d: "r",
      r: 0.5,
      a: { k: "l", t: [{ k: "f", p: "notes/a.md" }], bt: [] },
      b: { k: "l", t: [{ k: "t", n: "Terminal", tg: "default" }], bt: [] },
    };
    expect(paneModeLayoutsSemanticallyEqual(baseline, expanded)).toBe(true);
  });

  test("treats a one-sided terminal session id as attach settlement", () => {
    const baseline = leaf([{ k: "t", n: "worker", tg: "agents" }]);
    const settled = leaf([
      { k: "t", n: "worker", tg: "agents", tsid: "session-1" },
    ]);
    expect(paneModeLayoutsSemanticallyEqual(baseline, settled)).toBe(true);
  });
});

type TabKind = NonNullable<SerTab["k"]>;
type SerNodeField =
  keyof Extract<SerNode, { k: "s" }> | keyof Extract<SerNode, { k: "l" }>;
type FieldPartition = {
  readonly included: readonly string[];
  readonly excluded: readonly string[];
};

const allCurrentNodeFields = {
  k: true,
  d: true,
  r: true,
  a: true,
  b: true,
  t: true,
  bt: true,
  sb: true,
  f: true,
  wc: true,
  pc: true,
  ht: true,
  bm: true,
  hb: true,
} satisfies Record<SerNodeField, true>;

const allCurrentTabFields = {
  k: true,
  a: true,
  p: true,
  m: true,
  o: true,
  ol: true,
  spo: true,
  sp: true,
  spm: true,
  s: true,
  r: true,
  c: true,
  h: true,
  iw: true,
  ow: true,
  n: true,
  tg: true,
  tsid: true,
  tc: true,
  tae: true,
  kp: true,
  rpd: true,
  rpc: true,
  rph: true,
  pp: true,
  rpv: true,
  twk: true,
  gm: true,
  gs: true,
  gd: true,
  gi: true,
  gf: true,
  ge: true,
  gp: true,
  gn: true,
  gnl: true,
  bi: true,
  bs: true,
  bd: true,
  be: true,
  bsc: true,
  cs: true,
  ds: true,
  ar: true,
  xi: true,
} satisfies Record<keyof SerTab, true>;

const representativeTabs = {
  f: {
    k: "f",
    a: 1,
    p: "notes/a.md",
    m: "source",
    o: 1,
    ol: 1,
    spo: 1,
    sp: 1,
    spm: "p",
    s: 1,
    r: 1,
    c: [1, 1],
    h: 0,
    iw: 240,
    ow: 220,
  } as unknown as SerTab,
  t: {
    k: "t",
    a: 1,
    n: "worker",
    tg: "agents",
    tsid: "session-1",
    tc: 1,
    tae: 1,
    kp: { modifyOtherKeys: 1 },
    rpd: "notes/prompt.md",
    rpc: [1, 1],
    rph: 120,
    pp: { id: "prompt-1", ph: "queued" },
    rpv: 1,
    twk: { name: "round" },
  } as unknown as SerTab,
  s: { k: "s", a: 1 } as SerTab,
  h: { k: "h", a: 1 } as SerTab,
  g: {
    k: "g",
    a: 1,
    gm: "s",
    gs: "workspace",
    gd: 1,
    gi: 1,
    gf: "2lt",
    ge: ["src"],
    gp: "pending",
    gn: "selected",
    gnl: "Selected",
    iw: 240,
  } as SerTab,
  b: {
    k: "b",
    a: 1,
    bi: 1,
    bs: "src",
    bd: 1,
    be: ["src"],
    bsc: 10,
    iw: 240,
  } as SerTab,
  d: { k: "d", a: 1, cs: 1, ds: [1], ar: true } as SerTab,
  x: { k: "x", a: 1, xi: "calendar", n: "Calendar" } as SerTab,
} satisfies Record<TabKind, SerTab>;

const representativeLayout = {
  k: "s",
  d: "r",
  r: 0.5,
  a: {
    k: "l",
    t: Object.values(representativeTabs),
    bt: [],
    sb: 1,
    f: 1,
    wc: "o",
    pc: "p",
    ht: "d",
    bm: 1,
    hb: "d",
  },
  b: { k: "l", t: [] },
} as unknown as SerNode;

function collectFieldKeys(
  node: SerNode,
  nodeKeys: Set<string>,
  tabKeys: Map<TabKind, Set<string>>,
): void {
  for (const key of Object.keys(node)) nodeKeys.add(key);
  if (node.k === "s") {
    collectFieldKeys(node.a, nodeKeys, tabKeys);
    collectFieldKeys(node.b, nodeKeys, tabKeys);
    return;
  }
  for (const tab of [...node.t, ...(node.bt ?? [])]) {
    const kind = tab.k ?? "f";
    const keys = tabKeys.get(kind) ?? new Set<string>();
    for (const key of Object.keys(tab)) keys.add(key);
    tabKeys.set(kind, keys);
  }
}

function expectClosedPartition(
  actualKeys: ReadonlySet<string>,
  partition: FieldPartition,
): void {
  const declarations = [...partition.included, ...partition.excluded];
  const duplicateDeclarations = declarations.filter(
    (field, index) => declarations.indexOf(field) !== index,
  );
  const unclassified = [...actualKeys].filter(
    (field) => !declarations.includes(field),
  );
  const declaredButAbsent = declarations.filter(
    (field) => !actualKeys.has(field),
  );
  expect({ duplicateDeclarations, unclassified, declaredButAbsent }).toEqual({
    duplicateDeclarations: [],
    unclassified: [],
    declaredButAbsent: [],
  });
}

describe("paneModeLayoutsSemanticallyEqual field partition", () => {
  test("classifies every current serialized field exactly once", () => {
    const nodeKeys = new Set<string>();
    const tabKeys = new Map<TabKind, Set<string>>();
    collectFieldKeys(representativeLayout, nodeKeys, tabKeys);

    expect([...nodeKeys].sort()).toEqual(
      Object.keys(allCurrentNodeFields).sort(),
    );
    expectClosedPartition(nodeKeys, paneModeConflictFieldSets.node);

    const everyTabKey = new Set(
      [...tabKeys.values()].flatMap((keys) => [...keys]),
    );
    expect([...everyTabKey].sort()).toEqual(
      Object.keys(allCurrentTabFields).sort(),
    );
    for (const kind of Object.keys(representativeTabs) as TabKind[]) {
      expectClosedPartition(
        tabKeys.get(kind)!,
        paneModeConflictFieldSets.tabs[kind],
      );
    }
  });
});

type ExcludedTabField = [
  label: string,
  kind: TabKind,
  field: keyof SerTab,
  baseline: unknown,
  incoming: unknown,
];

function tabForKind(kind: TabKind): SerTab {
  if (kind === "f") return { k: "f", p: "notes/a.md" };
  if (kind === "t") {
    return { k: "t", n: "worker", tg: "agents", tsid: "session-1" };
  }
  if (kind === "x") return { k: "x", xi: "calendar", n: "Calendar" };
  return { k: kind };
}

function withField(tab: SerTab, field: keyof SerTab, value: unknown): SerTab {
  const copy = clone(tab) as SerTab & Record<string, unknown>;
  const fields = copy as Record<string, unknown>;
  const key = field as string;
  if (value === undefined) delete fields[key];
  else fields[key] = value;
  return copy;
}

const excludedTabFields: ExcludedTabField[] = [
  ["editor mode m", "f", "m", "source", "wysiwyg"],
  ["file inspector o", "f", "o", undefined, 1],
  ["outline visibility ol", "f", "ol", undefined, 1],
  ["slide preview visibility spo", "f", "spo", undefined, 1],
  ["slide preview index sp", "f", "sp", 1, 2],
  ["slide preview mode spm", "f", "spm", undefined, "p"],
  ["style toolbar s", "f", "s", undefined, 1],
  ["read mode r", "f", "r", undefined, 1],
  ["editor caret c", "f", "c", [1, 1], [2, 3]],
  ["syntax highlight h", "f", "h", undefined, 0],
  ["inspector width iw", "f", "iw", 240, 320],
  ["outline width ow", "f", "ow", 220, 300],
  ["controlled terminal tc", "t", "tc", undefined, 1],
  ["terminal echo cursor tae", "t", "tae", 1, 2],
  ["keyboard protocol kp", "t", "kp", { modifyOtherKeys: 1 }, { kitty: true }],
  ["Rich Prompt draft rpd", "t", "rpd", "a/draft.md", "b/draft.md"],
  ["Rich Prompt caret rpc", "t", "rpc", [1, 1], [2, 3]],
  ["Rich Prompt height rph", "t", "rph", 120, 180],
  [
    "queued prompt pp",
    "t",
    "pp",
    { id: "a", ph: "queued" },
    { id: "b", ph: "queued" },
  ],
  ["Rich Prompt visibility rpv", "t", "rpv", undefined, 1],
  ["Team Work draft twk", "t", "twk", { name: "a" }, { name: "b" }],
  ["graph mode gm", "g", "gm", "s", "f"],
  ["graph scope gs", "g", "gs", "workspace", "dir:src"],
  ["graph depth gd", "g", "gd", 1, 2],
  ["graph inspector gi", "g", "gi", undefined, 1],
  ["graph filters gf", "g", "gf", "2lt", "2ai"],
  ["graph expansion ge", "g", "ge", ["src"], ["src", "web"]],
  ["graph pending selection gp", "g", "gp", "a", "b"],
  ["graph selection gn", "g", "gn", "a", "b"],
  ["graph selection label gnl", "g", "gnl", "A", "B"],
  ["graph inspector width iw", "g", "iw", 240, 320],
  ["browser inspector bi", "b", "bi", undefined, 1],
  ["browser selection bs", "b", "bs", "src", "web"],
  ["browser workspace view bd", "b", "bd", undefined, 1],
  ["browser expansion be", "b", "be", ["src"], ["src", "web"]],
  ["browser scroll bsc", "b", "bsc", 10, 20],
  ["browser inspector width iw", "b", "iw", 240, 320],
  ["dashboard rotation cursor cs", "d", "cs", 1, 2],
  ["dashboard disabled slots ds", "d", "ds", [1], [1, 2]],
  ["dashboard auto-rotation ar", "d", "ar", true, false],
  ["extension display title n", "x", "n", "Calendar", "Schedule"],
];

describe("paneModeLayoutsSemanticallyEqual excluded tab fields", () => {
  test.each(excludedTabFields)(
    "ignores %s",
    (_label, kind, field, before, after) => {
      const tab = tabForKind(kind);
      const baseline = leaf([withField(tab, field, before)]);
      const incoming = leaf([withField(tab, field, after)]);
      expect(paneModeLayoutsSemanticallyEqual(baseline, incoming)).toBe(true);
    },
  );
});

describe("paneModeLayoutsSemanticallyEqual excluded node fields", () => {
  test.each([
    ["window focus color wc", "wc", "o", "g"],
    ["pane focus color pc", "pc", "o", "p"],
    ["Hybrid theme ht", "ht", "d", "l"],
    ["legacy back marker bm", "bm", undefined, 1],
    ["legacy back theme hb", "hb", "d", "l"],
  ] as const)("ignores %s", (_label, field, before, after) => {
    const baseline = leaf() as Extract<SerNode, { k: "l" }> &
      Record<string, unknown>;
    const incoming = clone(baseline);
    const baselineFields = baseline as Record<string, unknown>;
    const incomingFields = incoming as Record<string, unknown>;
    const key = field as string;
    if (before !== undefined) baselineFields[key] = before;
    if (after !== undefined) incomingFields[key] = after;
    expect(paneModeLayoutsSemanticallyEqual(baseline, incoming)).toBe(true);
  });
});

function resetLiveTerminal(): void {
  cancelPaneMode();
  const tab: TerminalTab = {
    kind: "terminal",
    id: "terminal-1",
    title: "worker",
    group: "agents",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
    terminalSessionId: "session-1",
  };
  const pane: LeafNode = {
    kind: "leaf",
    id: "pane-1",
    tabs: [tab],
    activeTabId: tab.id,
  };
  layout.rootId = pane.id;
  layout.nodes = { [pane.id]: pane };
  layout.activePaneId = pane.id;
  layout.focusColor = "blue";
}

function resetLiveSplit(): {
  split: SplitNode;
  left: LeafNode;
  right: LeafNode;
} {
  cancelPaneMode();
  const leftTab: TerminalTab = {
    kind: "terminal",
    id: "terminal-left",
    title: "left",
    group: "agents",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
    terminalSessionId: "session-left",
  };
  const rightTab: TerminalTab = {
    ...leftTab,
    id: "terminal-right",
    title: "right",
    terminalSessionId: "session-right",
  };
  const left: LeafNode = {
    kind: "leaf",
    id: "pane-left",
    tabs: [leftTab],
    activeTabId: leftTab.id,
  };
  const right: LeafNode = {
    kind: "leaf",
    id: "pane-right",
    tabs: [rightTab],
    activeTabId: rightTab.id,
  };
  const split: SplitNode = {
    kind: "split",
    id: "split-root",
    direction: "row",
    a: left.id,
    b: right.id,
    ratio: 0.5,
  };
  layout.rootId = split.id;
  layout.nodes = { [split.id]: split, [left.id]: left, [right.id]: right };
  layout.activePaneId = left.id;
  layout.focusColor = "blue";
  return {
    split: layout.nodes[split.id] as SplitNode,
    left: layout.nodes[left.id] as LeafNode,
    right: layout.nodes[right.id] as LeafNode,
  };
}

afterEach(() => cancelPaneMode());

describe("Pane Mode remote-layout deferral", () => {
  test("first conflict is permanent and the newest pending layout wins", () => {
    resetLiveTerminal();
    enterPaneMode();
    const baseline = serializeLayout({ terminalSessions: true });
    if (!baseline || baseline.k !== "l")
      throw new Error("expected serialized leaf");

    expect(paneModeDeferRemoteLayout(clone(baseline))).toBe(false);

    const first = clone(baseline);
    first.t[0]!.n = "first";
    expect(paneModeDeferRemoteLayout(first)).toBe(true);
    expect(paneMode.stale).toBe(true);
    expect(paneMode.pendingRemoteLayout).toEqual(first);

    const newest = clone(baseline);
    newest.t[0]!.n = "newest";
    expect(paneModeDeferRemoteLayout(newest)).toBe(true);
    expect(paneMode.pendingRemoteLayout).toEqual(newest);

    expect(paneModeDeferRemoteLayout(clone(baseline))).toBe(true);
    expect(paneMode.stale).toBe(true);
    expect(paneMode.pendingRemoteLayout).toEqual(baseline);
  });

  test("cancellation resets state and hands the newest layout to the settled sink", () => {
    resetLiveTerminal();
    const settled: Array<SerNode | null> = [];
    const unregister = registerPaneModeSettledSink((pending) => {
      settled.push(pending);
    });
    try {
      enterPaneMode();
      settled.length = 0;
      const baseline = serializeLayout({ terminalSessions: true });
      if (!baseline || baseline.k !== "l")
        throw new Error("expected serialized leaf");
      const first = clone(baseline);
      first.t[0]!.n = "first";
      const newest = clone(baseline);
      newest.t[0]!.n = "newest";
      paneModeDeferRemoteLayout(first);
      paneModeDeferRemoteLayout(newest);

      cancelPaneMode();

      expect(settled).toEqual([newest]);
      expect(paneMode.stale).toBe(false);
      expect(paneMode.pendingRemoteLayout).toBeNull();
    } finally {
      unregister();
    }
  });

  test("cancels staged work before applying the newest layout with local focus", () => {
    const { left } = resetLiveSplit();
    enterPaneMode();
    paneModeOpenTerminal();
    paneModeStageDraftEditor();
    const [stagedTerminalId] = paneModeStagedTabIds();
    if (!stagedTerminalId) throw new Error("expected a staged terminal");

    const events: string[] = [];
    const closeSink = vi.fn(() => {
      events.push("terminal-cleanup");
      return Promise.resolve(false);
    });
    const unregisterClose = registerTerminalCloseSink(
      stagedTerminalId,
      closeSink,
    );
    let applyResult: ReturnType<typeof reconcileLayout> | undefined;
    const unregisterSettled = registerPaneModeSettledSink((pending) => {
      events.push("pending-apply");
      expect(closeSink).toHaveBeenCalledOnce();
      expect(paneMode.active).toBe(false);
      expect(paneMode.stagedDraftEditors).toEqual([]);
      if (!pending) throw new Error("expected a pending remote layout");
      applyResult = reconcileLayout(pending);
    });

    try {
      const first = serializeLayout({ terminalSessions: true });
      if (!first || first.k !== "s")
        throw new Error("expected serialized split");
      first.r = 0.6;
      expect(paneModeDeferRemoteLayout(first)).toBe(true);

      const newest = clone(first);
      newest.r = 0.7;
      if (newest.a.k !== "l" || newest.b.k !== "l") {
        throw new Error("expected serialized leaves");
      }
      delete newest.a.f;
      newest.b.f = 1;
      expect(paneModeDeferRemoteLayout(newest)).toBe(true);

      cancelPaneMode();

      expect(events).toEqual(["terminal-cleanup", "pending-apply"]);
      expect(applyResult).toBe("applied");
      expect(layout.activePaneId).toBe(left.id);
      expect((layout.nodes[layout.rootId] as SplitNode).ratio).toBe(0.7);
      expect(
        Object.values(layout.nodes)
          .filter((node): node is LeafNode => node.kind === "leaf")
          .flatMap((node) => node.tabs)
          .some((tab) => tab.id === stagedTerminalId),
      ).toBe(false);
    } finally {
      unregisterSettled();
      unregisterClose();
    }
  });

  test("authoritative metadata can stale without synthesizing a pending layout", () => {
    resetLiveTerminal();
    enterPaneMode();

    paneModeMarkStaleForAuthoritativeMetadata();

    expect(paneMode.stale).toBe(true);
    expect(paneMode.pendingRemoteLayout).toBeNull();
  });

  test("roster metadata settles live before marking the transaction stale", () => {
    resetLiveTerminal();
    enterPaneMode();

    applyTerminalRoster([
      {
        id: "session-1",
        tab_name: "renamed",
        tab_group: "reviewers",
        window_id: "peer-window",
        broadcast: false,
      },
    ]);

    const pane = layout.nodes["pane-1"] as LeafNode;
    const terminal = pane.tabs[0] as TerminalTab;
    expect(terminal.title).toBe("renamed");
    expect(terminalTabGroup(terminal)).toBe("reviewers");
    expect(paneMode.stale).toBe(true);
    expect(paneMode.pendingRemoteLayout).toBeNull();
    applyTerminalRoster([]);
  });
});

describe("Pane Mode staged editor intent state", () => {
  test("assigns stable ids and projects queue order by pane and side", () => {
    resetLiveTerminal();
    enterPaneMode();

    paneModeStageDraftEditor();
    paneModeStageDraftEditor();
    flipHybrid("pane-1");
    paneModeStageDiagramEditor();

    const sideA = paneModeStagedDraftEditorsFor("pane-1", "a");
    const sideB = paneModeStagedDraftEditorsFor("pane-1", "b");
    expect(sideA.map((intent) => intent.kind)).toEqual(["draft", "draft"]);
    expect(sideB.map((intent) => intent.kind)).toEqual(["diagram"]);
    expect(new Set([...sideA, ...sideB].map((intent) => intent.id)).size).toBe(
      3,
    );

    const keep = sideA[1]!;
    paneModeRemoveStagedDraftEditor(sideA[0]!.id);
    expect(paneModeStagedDraftEditorsFor("pane-1", "a")).toEqual([keep]);
  });

  test("remove-by-id is inert after the transaction becomes stale", () => {
    resetLiveTerminal();
    enterPaneMode();
    paneModeStageDraftEditor();
    const intent = paneMode.stagedDraftEditors[0]!;
    paneModeMarkStaleForAuthoritativeMetadata();

    paneModeRemoveStagedDraftEditor(intent.id);

    expect(paneMode.stagedDraftEditors).toEqual([intent]);
  });
});
