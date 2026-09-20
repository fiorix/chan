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
  reorderTab,
  type FileTab,
  type LeafNode,
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

function resetLayout(tabs: Array<FileTab | TerminalTab>): void {
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

function paneTabs(): Array<FileTab | TerminalTab> {
  return (layout.nodes[PANE_ID] as LeafNode).tabs as Array<FileTab | TerminalTab>;
}

/// Everything the clone is allowed to drop, by the item's own contract.
const DELIBERATE_DROPS = ["find", "caretCommand", "loadProgress"];

function withoutDeliberateDrops<T extends Record<string, unknown>>(tab: T): T {
  const out = { ...tab };
  for (const key of DELIBERATE_DROPS) delete out[key];
  return out;
}

describe("a reorder keeps every field it was not told to drop", () => {
  test("terminal", () => {
    const source = loadedTerminalTab();
    resetLayout([source, { ...loadedFileTab(), id: "file-neighbour" }]);

    reorderTab(PANE_ID, source.id, 1);

    const moved = paneTabs().find((t) => t.id === source.id);
    expect(moved).toBeDefined();
    expect(withoutDeliberateDrops(moved as unknown as Record<string, unknown>)).toEqual(
      withoutDeliberateDrops(source as unknown as Record<string, unknown>),
    );
  });

  test("file", () => {
    const source = loadedFileTab();
    resetLayout([source, { ...loadedTerminalTab(), id: "term-neighbour" }]);

    reorderTab(PANE_ID, source.id, 1);

    const moved = paneTabs().find((t) => t.id === source.id);
    expect(moved).toBeDefined();
    expect(withoutDeliberateDrops(moved as unknown as Record<string, unknown>)).toEqual(
      withoutDeliberateDrops(source as unknown as Record<string, unknown>),
    );
  });

  test("the keyboard protocol travels by reference", () => {
    // A by-value copy is the Shift+Enter regression the terminal's own
    // comment records as already fixed once: the xterm handlers hold the
    // object the negotiation writes into.
    const source = loadedTerminalTab();
    const protocol = source.keyboardProtocol;
    resetLayout([source, { ...loadedFileTab(), id: "file-neighbour" }]);

    reorderTab(PANE_ID, source.id, 1);

    const moved = paneTabs().find((t) => t.id === source.id) as TerminalTab;
    expect(moved.keyboardProtocol).toBe(protocol);
  });
});

describe("a Hybrid Nav commit keeps every field it was not told to drop", () => {
  test("terminal", () => {
    const source = loadedTerminalTab();
    resetLayout([source]);

    enterPaneMode();
    commitPaneMode();

    const moved = paneTabs().find((t) => t.id === source.id);
    expect(moved).toBeDefined();
    expect(withoutDeliberateDrops(moved as unknown as Record<string, unknown>)).toEqual(
      withoutDeliberateDrops(source as unknown as Record<string, unknown>),
    );
  });
});
