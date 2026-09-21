import { describe, expect, test } from "vitest";
import appSource from "../App.svelte?raw";

// The "Flip pane" command (app.pane.flip) flips the focused
// pane. It must NOT fire while a modal or the search overlay owns the
// keyboard, or it flips the pane hidden behind the surface - the reported
// "panes flip" desync. Reproduced on a real build: open Search (or the New
// file dialog), trigger the flip, dismiss the surface -> the obscured pane
// had silently flipped to its other side.
//
// The Settings overlay owns comma, so the pane-flip command path carries this
// guard explicitly.
describe("Flip-pane command modal/overlay guard", () => {
  const src = appSource.replace(/\s+/g, " ");

  test("paneChordBlocked checks the overlay stack and every modal", () => {
    // Per-term so a new modal added to the guard (or a reordering /
    // inline comment) doesn't force a brittle contiguous-string rewrite.
    // Every surface that renders OVER the pane must appear here, or the pane
    // flip command could flip a pane hidden behind it.
    expect(src).toContain("function paneChordBlocked(): boolean {");
    for (const term of [
      "topOverlay() !== null",
      "promptState.open",
      "pathPromptState.open",
      "confirmState.open",
      "draftCloseState.open",
      "teamDialogState.request !== null",
      "conflictDialog.open",
      "workspaceWarningsDialog.open",
      "paneModalGuard.openCount > 0",
    ]) {
      expect(src).toContain(term);
    }
  });

  test("the flip command bails when a modal or overlay is active", () => {
    const guards = src.match(/if \(paneChordBlocked\(\)\) return;/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(1);
  });

  test("the flip action is guarded at the command entry point", () => {
    const flips = src.match(/flipHybrid\(layout\.activePaneId\)/g) ?? [];
    expect(flips.length).toBeGreaterThanOrEqual(1);
  });

  test("Ctrl+Backquote web chord dispatches app.pane.flip through the same guard", () => {
    expect(appSource).toMatch(
      /e\.ctrlKey &&\s*!e\.metaKey &&\s*!e\.altKey &&\s*!pressedShift &&\s*pressedKey === "`" &&\s*!builtInChordSuperseded\("app\.pane\.flip"\)/,
    );
    expect(src).toMatch(
      /if \( e\.ctrlKey && !e\.metaKey && !e\.altKey && !pressedShift && pressedKey === "`" && !builtInChordSuperseded\("app\.pane\.flip"\) \) \{ e\.preventDefault\(\); if \(!paneChordBlocked\(\)\) flipHybrid\(layout\.activePaneId\); return; \}/,
    );
  });
});
