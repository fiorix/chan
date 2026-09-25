// @vitest-environment jsdom
//
// The chrome the custom menus share. The portal action moves a menu under
// the page body, so a transformed ancestor cannot pull its fixed position
// away from the cursor; each menu's mounted test checks that it lands there
// (TerminalTab.menus, FileEditorTab, GraphPanel.depth, FileBrowserSurface).
// The rest is stylesheet, read as text: tab menus stack above the panes,
// menu rows pop on the tab pill's curve, the focused pane wobbles on the same
// curve without scaling itself, and Hybrid Nav's focus chrome leaves the
// pane bodies uncomposited.

import { describe, expect, test } from "vitest";

// Build-time contract: Hybrid Nav's pane rules put no filter or opacity on a pane; vitest drops component CSS.
import app from "../App.svelte?raw";
// Build-time contract: the editor tab menu stacks at z-index 25500 and its rows pop on the tab pill's curve; vitest drops component CSS.
import editor from "./FileEditorTab.svelte?raw";
// Build-time contract: the tree's menu rows pop on the tab pill's curve; vitest drops component CSS.
import fileTree from "./FileTree.svelte?raw";
// Build-time contract: the graph tab menu stacks at z-index 25500 and its rows pop on the tab pill's curve; vitest drops component CSS.
import graph from "./GraphPanel.svelte?raw";
// Build-time contract: the hamburger menu's rows pop on the tab pill's curve; vitest drops component CSS.
import hamburger from "./HamburgerMenu.svelte?raw";
// Build-time contract: the focused pane wobbles on the menus' curve and no pane rule scales the pane; vitest drops component CSS.
import pane from "./Pane.svelte?raw";
// Build-time contract: the terminal tab menu stacks at z-index 25500 and its rows pop on the tab pill's curve; vitest drops component CSS.
import terminal from "./TerminalTab.svelte?raw";
import { portal } from "./portal";

const POP = "transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1)";

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

describe("the menu stylesheets", () => {
  test("tab menus stack above the panes", () => {
    for (const source of [terminal, editor, graph]) {
      expect(css(source)).toContain("z-index: 25500;");
    }
  });

  test("menu rows pop on the tab pill's curve", () => {
    for (const source of [terminal, editor, graph, fileTree, hamburger]) {
      expect(css(source)).toContain(POP);
      expect(css(source)).toContain("transform: scale(1.02)");
    }
  });
});

describe("the pane stylesheet", () => {
  test("the focused pane wobbles on the menus' curve and never scales itself", () => {
    const styles = css(pane);
    expect(styles).toMatch(
      /\.pane\.focused\.wobble \{[\s\S]*?animation: pane-wobble-once 360ms cubic-bezier\(0\.34, 1\.56, 0\.64, 1\)/,
    );
    // A scaled ancestor corrupts xterm's WebGL glyph atlas, so no rule on
    // the pane element itself, in any state, scales it.
    expect(styles).toMatch(/\n\s*\.pane \{/);
    expect(styles).not.toMatch(/(?:^|[\n,])\s*\.pane(?:\.[\w-]+|:[\w-]+(?:\([^)]*\))?)*\s*\{[^}]*transform:\s*scale/);
  });

  test("Hybrid Nav's focus chrome composites no pane body", () => {
    const styles = css(app);
    expect(styles).toMatch(/\.app\.pane-mode :global\(\.pane\) \{/);
    expect(styles).not.toMatch(/\.app\.pane-mode\s+:global\(\.pane[^{]*\)\s*\{[^}]*\b(?:filter|opacity):/);
  });
});
