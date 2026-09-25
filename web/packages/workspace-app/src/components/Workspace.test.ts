// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import workspaceSource from "../components/Workspace.svelte?raw";
import {
  type LeafNode,
  layout,
  restoreLayout,
  serializeLayout,
  splitPane,
} from "./tabs.svelte";

// Pane sizes must survive reload, including when a pane is EMPTY. The split
// tree already serializes the ratio and empty leaves; the gap was that a
// divider drag never scheduled a save (the layout-persistence effect only
// tracks leaf nodes, never split.ratio), so an empty-pane resize was lost.

function emptyPane(): LeafNode {
  const pane: LeafNode = {
    kind: "leaf",
    id: "pane-test",
    tabs: [],
    activeTabId: null,
  };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  layout.focusColor = "blue";
  return pane;
}

describe("empty-pane size persistence (save/restore seam)", () => {
  test("a resized empty-pane split keeps its ratio across a serialize -> restore reload", async () => {
    const pane = emptyPane();
    splitPane(pane.id, "row", "after"); // two empty panes
    const split = layout.nodes[layout.rootId];
    expect(split?.kind).toBe("split");
    if (split?.kind !== "split") return;

    split.ratio = 0.72; // user dragged the divider

    // What the save persists (URL hash + /api/session blob).
    const serialized = serializeLayout();
    expect(serialized).not.toBeNull();

    // Re-instantiate from the persisted blob == a reload.
    await restoreLayout(serialized!);

    const restored = layout.nodes[layout.rootId];
    expect(restored?.kind).toBe("split");
    if (restored?.kind !== "split") return;
    expect(restored.ratio).toBeCloseTo(0.72, 3);
    // Both panes come back, still empty.
    expect(layout.nodes[restored.a]?.kind).toBe("leaf");
    expect(layout.nodes[restored.b]?.kind).toBe("leaf");
    expect((layout.nodes[restored.a] as LeafNode).tabs).toHaveLength(0);
    expect((layout.nodes[restored.b] as LeafNode).tabs).toHaveLength(0);
  });
});

describe("divider drag schedules a save (trigger fix)", () => {
  test("Workspace onUp persists the ratio to the URL hash and session", () => {
    expect(workspaceSource).toMatch(
      /const onUp = \(\) => \{[\s\S]*?schedulePersistStateToHash\(\);[\s\S]*?scheduleSessionSave\(\);[\s\S]*?\};/,
    );
    expect(workspaceSource).toMatch(
      /import \{[\s\S]*?schedulePersistStateToHash,[\s\S]*?scheduleSessionSave,[\s\S]*?\} from "\.\.\/state\/store\.svelte";/,
    );
  });
});
