import { describe, expect, test } from "vitest";
import terminal from "./TerminalTab.svelte?raw";

// TerminalTab.svelte's `handleTerminalKeyEvent` (the xterm
// `customKeyEventHandler` translation layer) carries no Alt+Space
// chord branch. Pin its absence so it can't be reintroduced.

describe("handleTerminalKeyEvent has no Alt+Space branch", () => {
  test("no Alt+Space branch inside handleTerminalKeyEvent", () => {
    expect(terminal).not.toMatch(
      /function handleTerminalKeyEvent\(e: KeyboardEvent\): boolean \{[\s\S]*?e\.altKey &&[\s\S]*?e\.code === "Space"/,
    );
  });

  test("handleTerminalKeyEvent still defers to handleTerminalMetaKey", () => {
    // Sanity check: removal shouldn't strip the meta-key
    // delegation that handles the legitimate terminal-side
    // keymap surfaces (Hybrid Nav leader chord, etc.).
    expect(terminal).toMatch(
      /function handleTerminalKeyEvent\(e: KeyboardEvent\): boolean \{[\s\S]*?return handleTerminalMetaKey\(e, sendUserInput, tab\.keyboardProtocol\);/,
    );
  });

  test("attachCustomKeyEventHandler registration present", () => {
    // Sanity: the registration line stays; only the chord branch
    // inside the registered handler is absent.
    expect(terminal).toMatch(
      /term\.attachCustomKeyEventHandler\(handleTerminalKeyEvent\)/,
    );
  });
});
