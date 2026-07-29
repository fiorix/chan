import { describe, expect, test } from "vitest";
import statusBar from "./AppStatusBar.svelte?raw";

describe("AppStatusBar right-dock positioning", () => {
  test("tracks the live right file-browser width", () => {
    expect(statusBar).toMatch(
      /!ui\.terminalOnly && browserSidePanes\.right \? paneWidths\.browser \+ 12 : 12/,
    );
    expect(statusBar).toContain('style:right={`${rightInset}px`}');
  });

  test("does not offset terminal-only windows for persisted dock state", () => {
    expect(statusBar).toContain("!ui.terminalOnly && browserSidePanes.right");
  });
});
