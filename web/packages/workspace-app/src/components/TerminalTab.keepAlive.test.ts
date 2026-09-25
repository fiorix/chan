import { describe, expect, test } from "vitest";
import pane from "./Pane.svelte?raw";

// Hybrid Nav (Cmd+.) must not unmount TerminalTab instances.
// Unmounting disposes the xterm.js EditorView and drops the scrollback
// buffer. Instead the `active` prop flips to false and the existing CSS
// visibility rule hides the terminal. These pins catch any regression
// that re-introduces an outer `{#if !paneMode.active}` guard.

describe("TerminalTabs survive Hybrid NAV toggles", () => {
  test("terminal each-block does not sit under a {#if !paneMode.active}", () => {
    // The pre-fix pattern was: `{#if !paneMode.active}` immediately
    // followed by the terminal each-block, with only whitespace and
    // {/if} between them. Asserting the absence of that exact
    // adjacency catches the regression without false-matching the
    // separate `{#if paneMode.active}` block above (which renders
    // the pane-mode-preview).
    const banned = /\{#if\s+!paneMode\.active\}\s+\{#each everyTab\.filter\(\(t\) => t\.kind === "terminal"\) as t \(t\.id\)\}/;
    expect(pane).not.toMatch(banned);
  });

  test("active prop is gated by pane mode + visible-side active tab", () => {
    // The prop short-circuits on pane mode so the visibility-hidden
    // CSS fires during Hybrid NAV. isLiveActive() keeps only the active
    // tab on the visible A/B side live.
    expect(pane).toMatch(
      /active=\{isLiveActive\(t\)\}/,
    );
  });

  test("focused prop is gated by visible-side active tab and active pane", () => {
    // Same gates on focused so focus is never pulled into a hidden
    // xterm during pane mode, from a hidden side, or from another pane.
    expect(pane).toMatch(
      /focused=\{isLiveActive\(t\) && viewLayout\.activePaneId === pane\.id\}/,
    );
  });
});
