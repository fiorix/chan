// The FileTab layout harness: tab literals typed against the real tab shapes,
// and one-pane layouts written into the live store. A field added to FileTab
// or TerminalTab is one edit here, not one per test file.
//
// A test that re-imports the state modules after `vi.resetModules()` imports
// this module the same way, after the reset, so `layout` below is the store
// instance the test is driving.

import {
  layout,
  type FileTab,
  type LeafNode,
  type Tab,
  type TerminalTab,
} from "../state/tabs.svelte";

/// A clean document tab: its content equals what was saved, so closing it
/// never raises the unsaved-changes prompt.
export function fileTab(partial: Partial<FileTab> = {}): FileTab {
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

export function terminalTab(partial: Partial<TerminalTab> = {}): TerminalTab {
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

/// Replace the layout with one leaf pane holding `tabs`, the first one
/// active, as the root and the active pane, with the default focus colour.
/// Returns the pane as the store holds it, so a write through it is a write
/// to the layout.
export function resetLayout(tabs: Tab[] = [], pane: Partial<LeafNode> = {}): LeafNode {
  const node: LeafNode = {
    kind: "leaf",
    id: "pane-test",
    tabs: [...tabs],
    activeTabId: tabs[0]?.id ?? null,
    ...pane,
  };
  layout.rootId = node.id;
  layout.activePaneId = node.id;
  layout.nodes = { [node.id]: node };
  layout.focusColor = "blue";
  return layout.nodes[node.id] as LeafNode;
}

/// The file tab with `id`, read back through the store wherever it sits in
/// the layout. A Svelte 5 state proxy does not write through to the object a
/// test put into the layout, so read after async work, never the literal.
export function readTab(id: string): FileTab | undefined {
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    const tab = node.tabs.find((t) => t.id === id);
    if (tab && tab.kind === "file") return tab;
  }
  return undefined;
}
