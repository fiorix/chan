// @vitest-environment jsdom
//
// The chrome the custom menus share. The portal action moves a menu under
// the page body, so a transformed ancestor cannot pull its fixed position
// away from the cursor; each menu's mounted test checks that it lands there
// (TerminalTab.menus, FileEditorTab, GraphPanel.depth, FileBrowserSurface).

import { describe, expect, test } from "vitest";
import { portal } from "./portal";

describe("the portal action", () => {
  test("moves a menu node under the page body, and takes it away on destroy", () => {
    const node = document.createElement("div");
    const action = portal(node);

    expect(node.parentElement).toBe(document.body);

    action.destroy();
    expect(document.body.contains(node)).toBe(false);
  });
});
