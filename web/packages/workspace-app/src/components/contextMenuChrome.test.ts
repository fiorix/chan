// @vitest-environment jsdom
//
// The chrome the custom menus share. The portal action moves a menu under
// the page body, so a transformed ancestor cannot pull its fixed position
// away from the cursor; each menu's mounted test checks that it lands there
// (TerminalTab.menus, FileEditorTab, GraphPanel.depth, FileBrowserSurface).
// The pane stylesheet is read as text for the one rule the terminal needs:
// no rule on the pane element scales it.

import { describe, expect, test } from "vitest";

// Build-time contract: no rule on the pane element scales it, since a scaled ancestor corrupts xterm's WebGL glyph atlas; vitest drops component CSS.
import pane from "./Pane.svelte?raw";
import { portal } from "./portal";

function css(source: string): string {
  const start = source.indexOf("<style");
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start);
}

describe("the portal action", () => {
  test("moves a menu node under the page body, and takes it away on destroy", () => {
    const node = document.createElement("div");
    const action = portal(node);

    expect(node.parentElement).toBe(document.body);

    action.destroy();
    expect(document.body.contains(node)).toBe(false);
  });
});

describe("the pane stylesheet", () => {
  test("no rule on the pane element, in any state, scales it", () => {
    const styles = css(pane);
    expect(styles).toMatch(/\n\s*\.pane \{/);
    expect(styles).not.toMatch(/(?:^|[\n,])\s*\.pane(?:\.[\w-]+|:[\w-]+(?:\([^)]*\))?)*\s*\{[^}]*transform:\s*scale/);
  });
});
