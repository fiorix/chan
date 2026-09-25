// @vitest-environment jsdom
//
// Ctrl+D close-tab smoke tests. Two cheaper checks replace a full App mount:
// 1. Per-tab-type behavior via direct closeTab invocations (the dispatcher
//    is a thin wrapper around closeTab(p.id, p.activeTabId)).
// 2. The routing guards (terminal skipped; modal-up skipped; pane-mode
//    skipped) verified against App.svelte source, same pattern as
//    paneModeKeymap.test.ts.

import { afterEach, describe, expect, test } from "vitest";
import {
  activePane,
  cancelPaneMode,
  closeTab,
  openBrowserInActivePane,
  openGraphInActivePane,
} from "../state/tabs.svelte";
import { clearRecentlyClosedTabsForTest } from "../state/tabs.svelte";
import app from "../App.svelte?raw";
import { fileTab, resetLayout } from "../__tests__/tabs";

afterEach(() => {
  cancelPaneMode();
  clearRecentlyClosedTabsForTest();
});

describe("Ctrl+D close-tab behaviour", () => {
  test("closes a Files tab from the active pane", async () => {
    const pane = resetLayout([]);
    const browser = openBrowserInActivePane();
    pane.activeTabId = browser.id;

    await closeTab(pane.id, browser.id);

    expect(activePane().tabs).toHaveLength(0);
  });

  test("closes a Graph tab from the active pane", async () => {
    const pane = resetLayout([]);
    const graph = openGraphInActivePane({ mode: "semantic", scopeId: "workspace" });
    pane.activeTabId = graph.id;

    await closeTab(pane.id, graph.id);

    expect(activePane().tabs.find((t) => t.id === graph.id)).toBeUndefined();
  });

  test("closes a clean doc tab from the active pane", async () => {
    const tab = fileTab();
    const pane = resetLayout([tab]);

    await closeTab(pane.id, tab.id);

    expect(activePane().tabs).toHaveLength(0);
  });
});

describe("Ctrl+D dispatcher (App.svelte raw-source guards)", () => {
  test("scoped to the literal Ctrl modifier on the layout-resolved D key", () => {
    expect(app).toContain('if (!e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;');
    expect(app).toContain('if (builtInChordSuperseded("app.tab.close")) return;');
    expect(app).toContain('if (shortcutLetter(e) !== "D") return;');
  });

  test("skips when in-house modals are open or pane mode is active", () => {
    expect(app).toMatch(/draftCloseState\.open/);
    expect(app).toContain("if (paneMode.active) return;");
  });

  test("does not intercept Ctrl+D inside a terminal tab", () => {
    expect(app).toContain('if (active.kind === "terminal") return;');
  });

  test("does not intercept Ctrl+D inside an Excalidraw canvas tab", () => {
    // The board keeps Ctrl+D for its own duplicate chord; Cmd+W is the
    // close path for canvas tabs. This early-return must survive future
    // cleanups (it is not dead code), so pin it against the source.
    expect(app).toContain(
      'if (active.kind === "file" && active.mode === "canvas") return;',
    );
  });

  test("listener is registered on document capture to beat CodeMirror", () => {
    // Capture phase fires before CodeMirror's bubble-phase keymap,
    // so the close-tab path wins over the multi-cursor default.
    expect(app).toContain(
      'document.addEventListener("keydown", onCtrlDCapture, true)',
    );
    expect(app).toContain(
      'document.removeEventListener("keydown", onCtrlDCapture, true)',
    );
  });
});
