// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import fbSource from "./FileBrowserSurface.svelte?raw";
import {
  type BrowserTab,
  type LeafNode,
  layout,
  restoreLayout,
  serializeLayout,
} from "../state/tabs.svelte";

// The File-Browser inspector width is a per-tab value (BrowserTab.inspectorWidth,
// serialized as `iw`) that the Editor inspector already round-trips. The gap was
// that a File-Browser inspector resize only saved the GLOBAL pane_widths slot, so
// the per-tab width never reached the URL hash / session blob and reload fell back
// to a non-matching default.

function paneWith(tab: BrowserTab): LeafNode {
  const pane: LeafNode = {
    kind: "leaf",
    id: "pane-test",
    tabs: [tab],
    activeTabId: tab.id,
  };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  layout.focusColor = "blue";
  return pane;
}

describe("File-Browser inspector width persistence (save/restore seam)", () => {
  test("a BrowserTab inspector width round-trips through serialize -> restore", async () => {
    const browser: BrowserTab = {
      kind: "browser",
      id: "browser-1",
      title: "Files",
      inspectorOpen: true,
      inspectorWidth: 333,
    };
    paneWith(browser);

    const serialized = serializeLayout();
    expect(serialized).not.toBeNull();
    expect(JSON.stringify(serialized)).toContain('"iw":333');

    // Re-instantiate from the persisted blob == a reload.
    await restoreLayout(serialized!);

    const pane = layout.nodes[layout.rootId] as LeafNode;
    expect(pane?.kind).toBe("leaf");
    const restored = pane.tabs.find((t) => t.kind === "browser") as
      | BrowserTab
      | undefined;
    expect(restored?.inspectorWidth).toBe(333);
  });
});

describe("File-Browser inspector resize schedules a save (trigger fix)", () => {
  test("onResize routes the per-tab width through the hash + session save", () => {
    expect(fbSource).toMatch(/onResize=\{onInspectorResize\}/);
    expect(fbSource).toMatch(
      /function onInspectorResize\(\): void \{[\s\S]*?persistPaneWidths\(\);[\s\S]*?schedulePersistStateToHash\(\);[\s\S]*?scheduleSessionSave\(\);[\s\S]*?\}/,
    );
    expect(fbSource).toMatch(/scheduleSessionSave,/);
  });
});
