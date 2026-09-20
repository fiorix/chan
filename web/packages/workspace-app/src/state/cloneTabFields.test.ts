// @vitest-environment jsdom
//
// Cloning a tab keeps every field unless the code names it as a deliberate
// drop. `cloneTab` is a hand-maintained object literal per kind and it fails
// open, so a field it does not name disappears on the next reorder, cross-pane
// move or Hybrid Nav commit. The deliberate drops today are `find`,
// `caretCommand` and `loadProgress`.

import { afterEach, describe, expect, test } from "vitest";

import { createTerminalKeyboardProtocolState } from "../terminal/keymap";
import { defaultTeamConfig } from "./teamDialog.svelte";
import {
  cancelPaneMode,
  commitPaneMode,
  enterPaneMode,
  layout,
  makeFindState,
  reorderTab,
  serializeLayout,
  type BrowserTab,
  type DashboardTab,
  type ExtensionTab,
  type FileTab,
  type GraphTab,
  type Tab,
  type LeafNode,
  type SerLeaf,
  type SerTab,
  type TerminalTab,
} from "./tabs.svelte";

const PANE_ID = "clone-tab-fields-pane";

afterEach(() => {
  cancelPaneMode();
});

/// A terminal carrying every optional field the type allows, each with a
/// distinguishable value.
function loadedTerminalTab(): TerminalTab {
  return {
    kind: "terminal",
    id: "term-loaded",
    title: "worker",
    createdAt: 7,
    broadcastEnabled: true,
    broadcastTargetIds: ["term-other"],
    terminalEnvTabName: "spawn-name",
    terminalEnvTabGroup: "spawn-group",
    terminalEnvNamePromptDismissed: true,
    terminalEnvPromptDismissedFor: "spawn-name",
    terminalMetadataDraft: { name: "draft", group: "draft-group" },
    terminalMetadataPending: { name: "pending", group: "pending-group" },
    terminalMetadataError: "rename rejected",
    terminalSessionId: "sess-1",
    submitAgent: "claude",
    controlledTerminal: true,
    terminalActivity: true,
    terminalActivityPulsing: true,
    queueDepth: 3,
    pendingPrompt: { id: "prompt-1", phase: "queued", depth: 1 },
    cwd: "/work",
    seedInput: "echo hi",
    spawnCommand: "bash -l",
    spawnEnv: { CHAN_AGENT: "claude" },
    profile: "fish",
    pendingGlobalName: true,
    richPromptDraftPath: ".chan/drafts/worker/draft.md",
    richPromptCaret: { from: 2, to: 5 },
    richPromptHeight: 240,
    group: "ops",
    keyboardProtocol: createTerminalKeyboardProtocolState(),
    teamWorkPending: defaultTeamConfig(),
  };
}

/// A file tab carrying the optional fields the file branch does not name.
function loadedFileTab(): FileTab {
  return {
    kind: "file",
    fileKind: "document",
    id: "file-loaded",
    path: "notes/loaded.md",
    content: "body",
    saved: "body",
    savedMtime: 1,
    savedMtimeNs: "1000000000",
    authorityVersion: 4,
    diskConflicted: false,
    mode: "wysiwyg",
    loading: false,
    error: null,
    fileMissing: null,
    inspectorOpen: true,
    outlineOpen: true,
    repoRoot: "/repo",
    readMode: false,
    fsWritable: true,
    styleToolbarOpen: true,
    syntaxHighlight: true,
    highlightTrailingWhitespace: true,
    codeBlocksCollapsed: true,
    caret: { from: 1, to: 1 },
    externalChange: true,
    doc: { state: "attached", peers: 2 },
    openedEmpty: true,
    inspectorWidth: 321,
    outlineWidth: 123,
  };
}

/// A graph tab carrying every optional field its kind allows.
function loadedGraphTab(): GraphTab {
  return {
    kind: "graph",
    id: "graph-loaded",
    title: "workspace",
    mode: "filesystem",
    scopeId: "scope-1",
    depth: 2,
    expanded: { "": true, src: true },
    filters: {
      link: true,
      tag: false,
      mention: true,
      language: false,
      img: true,
      folder: false,
      markdown: true,
      source: false,
    },
    inspectorOpen: true,
    pendingSelectId: "node-9",
    selectedNodeId: "node-3",
    selectedNodeLabel: "src/main.rs",
    inspectorWidth: 287,
  };
}

/// A File Browser tab carrying every optional field its kind allows.
function loadedBrowserTab(): BrowserTab {
  return {
    kind: "browser",
    id: "browser-loaded",
    title: "files",
    inspectorOpen: true,
    selected: "src/main.rs",
    selectedPaths: ["src/main.rs", "src/lib.rs"],
    showWorkspace: true,
    expanded: ["src", "src/state"],
    scroll: 412,
    inspectorWidth: 265,
  };
}

/// A dashboard tab carrying every optional field its kind allows. All three
/// are optional and a clone that emits them conditionally loses them, so the
/// fixture sets each to a value that is not the field's default.
function loadedDashboardTab(): DashboardTab {
  return {
    kind: "dashboard",
    id: "dashboard-loaded",
    title: "dashboard",
    carouselSlide: 2,
    disabledSlots: [1],
    autoRotate: false,
  };
}

function loadedExtensionTab(): ExtensionTab {
  return {
    kind: "extension",
    id: "extension-loaded",
    title: "notes",
    extensionId: "ext-1",
  };
}

/// One fixture per tab kind, so a move is exercised on every branch of the
/// per-kind copy block and not only on the two kinds a pane usually holds.
const EVERY_KIND: Array<{ kind: string; make: () => Tab }> = [
  { kind: "terminal", make: loadedTerminalTab },
  { kind: "file", make: loadedFileTab },
  { kind: "graph", make: loadedGraphTab },
  { kind: "browser", make: loadedBrowserTab },
  { kind: "dashboard", make: loadedDashboardTab },
  { kind: "extension", make: loadedExtensionTab },
];

/// A second tab so a reorder has somewhere to go. Its kind does not matter to
/// what these tests assert, and a dashboard is the cheapest to build.
function neighbour(id: string): Tab {
  return { kind: "dashboard", id, title: "neighbour" };
}

function resetLayout(tabs: Tab[]): void {
  const node: LeafNode = {
    kind: "leaf",
    id: PANE_ID,
    tabs: [...tabs],
    activeTabId: tabs[0]?.id ?? null,
  };
  layout.nodes = { [PANE_ID]: node };
  layout.rootId = PANE_ID;
  layout.activePaneId = PANE_ID;
}

function paneTabs(): Tab[] {
  return (layout.nodes[PANE_ID] as LeafNode).tabs as Tab[];
}

/// Everything the clone is allowed to drop, by the item's own contract.
const DELIBERATE_DROPS = ["find", "caretCommand", "loadProgress"];

function withoutDeliberateDrops<T extends Record<string, unknown>>(tab: T): T {
  const out = { ...tab };
  for (const key of DELIBERATE_DROPS) delete out[key];
  return out;
}

describe("a reorder keeps every field it was not told to drop", () => {
  for (const { kind, make } of EVERY_KIND) {
    test(kind, () => {
      const source = make();
      resetLayout([source, neighbour("neighbour-tab")]);

      reorderTab(PANE_ID, source.id, 1);

      const moved = paneTabs().find((t) => t.id === source.id);
      expect(moved).toBeDefined();
      expect(withoutDeliberateDrops(moved as unknown as Record<string, unknown>)).toEqual(
        withoutDeliberateDrops(source as unknown as Record<string, unknown>),
      );
    });
  }

  test("the drops the table names are the drops that happen", () => {
    // withoutDeliberateDrops strips these from both sides everywhere else, so
    // this is the only place the drop decision itself is under test: flipping
    // one of the three to "carry" has to fail here and nowhere else.
    const source: FileTab = {
      ...loadedFileTab(),
      find: makeFindState(),
      caretCommand: { from: 3, to: 9 },
      loadProgress: { loadedBytes: 10, totalBytes: 100 },
    };
    resetLayout([source, neighbour("neighbour-tab")]);

    reorderTab(PANE_ID, source.id, 1);

    const moved = paneTabs().find((t) => t.id === source.id) as FileTab;
    expect(moved.find).toBeUndefined();
    expect(moved.caretCommand).toBeUndefined();
    expect(moved.loadProgress).toBeUndefined();
    // Dropping three fields is not licence to drop a fourth.
    expect(withoutDeliberateDrops(moved as unknown as Record<string, unknown>)).toEqual(
      withoutDeliberateDrops(source as unknown as Record<string, unknown>),
    );
  });

  test("the keyboard protocol travels by reference", () => {
    // A by-value copy is the Shift+Enter regression the terminal's own
    // comment records as already fixed once: the xterm handlers hold the
    // object the running program writes its negotiation into, and they take
    // it from the tab in the layout, so that is where both references are
    // read from here.
    const source = loadedTerminalTab();
    resetLayout([source, { ...loadedFileTab(), id: "file-neighbour" }]);
    const before = (paneTabs().find((t) => t.id === source.id) as TerminalTab)
      .keyboardProtocol!;

    reorderTab(PANE_ID, source.id, 1);

    const moved = paneTabs().find((t) => t.id === source.id) as TerminalTab;
    expect(moved.keyboardProtocol).toBe(before);
    // What the identity is for: a negotiation written through the reference
    // the handlers hold has to be visible on the tab after the move.
    before.xtermModifyOtherKeys = 2;
    expect(moved.keyboardProtocol?.xtermModifyOtherKeys).toBe(2);
  });
});

describe("a Hybrid Nav commit keeps every field it was not told to drop", () => {
  for (const { kind, make } of EVERY_KIND) {
    test(kind, () => {
      const source = make();
      resetLayout([source]);

      enterPaneMode();
      commitPaneMode();

      const moved = paneTabs().find((t) => t.id === source.id);
      expect(moved).toBeDefined();
      expect(withoutDeliberateDrops(moved as unknown as Record<string, unknown>)).toEqual(
        withoutDeliberateDrops(source as unknown as Record<string, unknown>),
      );
    });
  }
});

// ---- the persisted session --------------------------------------------------
//
// Live state is only half of a dropped field. `serializeTab` reads the same
// tab objects, so a field the clone drops is also gone from the per-window
// session blob and does not come back on reload.
//
// Only the fields the serializer is meant to keep are asserted here. The clone
// also drops `submitAgent`, `queueDepth`, `terminalActivity`,
// `terminalActivityPulsing`, `externalChange`, `doc` and `openedEmpty`, and
// none of those appear in `SerTab`: the type's own comments call them
// transient, re-synced from the attach prelude or ephemeral. Their loss is a
// live-state loss only, so asserting they persist would pin the wrong contract.

/// The per-window session payload for the pane. `terminalSessions` is what the
/// session blob passes and the shareable URL hash does not.
function serializedPaneTabs(): SerTab[] {
  const tree = serializeLayout({ terminalSessions: true });
  expect(tree).not.toBeNull();
  return (tree as SerLeaf).t;
}

/// The active flag rides the pane's active tab, which a reorder moves by
/// design, so it is not part of what a clone must carry.
function withoutActiveFlag(tab: SerTab): SerTab {
  const out = { ...tab };
  delete out.a;
  return out;
}

function serializedTerminal(): SerTab {
  const found = serializedPaneTabs().find((t) => t.k === "t");
  expect(found).toBeDefined();
  return withoutActiveFlag(found!);
}

function serializedFile(): SerTab {
  // A file tab is the default kind, so the serializer omits `k` for it.
  const found = serializedPaneTabs().find((t) => t.k === undefined);
  expect(found).toBeDefined();
  return withoutActiveFlag(found!);
}

describe("the persisted session survives a reorder", () => {
  test("terminal", () => {
    const source = loadedTerminalTab();
    // A negotiated protocol: the serializer emits `kp` only for non-default
    // state, so an untouched state would make the field's loss invisible.
    source.keyboardProtocol!.xtermModifyOtherKeys = 2;
    resetLayout([source, { ...loadedFileTab(), id: "file-neighbour" }]);

    const before = serializedTerminal();
    // Everything this test is about has to be in the payload to begin with.
    expect(Object.keys(before)).toEqual(
      expect.arrayContaining([
        "tp",
        "kp",
        "rpd",
        "rpc",
        "rph",
        "pp",
        "twk",
      ]),
    );

    reorderTab(PANE_ID, source.id, 1);

    expect(serializedTerminal()).toEqual(before);
  });

  test("file", () => {
    const source = loadedFileTab();
    resetLayout([source, { ...loadedTerminalTab(), id: "term-neighbour" }]);

    const before = serializedFile();
    expect(Object.keys(before)).toEqual(expect.arrayContaining(["iw", "ow"]));

    reorderTab(PANE_ID, source.id, 1);

    expect(serializedFile()).toEqual(before);
  });
});

