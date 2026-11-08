// The pane tree's launcher row and chord: the catalog offers "Show panes and
// tabs" in every window that has panes to list, never in the control
// terminal or under Hybrid Nav; running it opens the tree; and the chord the
// launcher shows is Cmd+Shift+A on macOS and Ctrl+Shift+A elsewhere, which
// escapes a focused terminal.

import { afterEach, describe, expect, test, vi } from "vitest";
import { availableCommands, allCommands, commandContext, type CommandContext } from "../commands";
import { closePaneTree, paneTree } from "../paneTree.svelte";
import { chordFor, SHORTCUTS, shouldEscapeTerminal } from "../shortcuts";
import { ui } from "../store.svelte";
import { paneMode } from "../tabs.svelte";
import { capsForMode } from "../windowCaps";

import "./install";

const ID = "app.pane.tree";

function tauri(on: boolean): void {
  const w = window as typeof window & { __TAURI__?: unknown };
  if (on) w.__TAURI__ = {};
  else delete w.__TAURI__;
}

function terminalWindow(): CommandContext {
  return {
    ...commandContext(),
    terminalOnly: true,
    caps: capsForMode("terminal", false, false),
  };
}

afterEach(() => {
  ui.terminalControl = false;
  paneMode.active = false;
  closePaneTree();
  tauri(false);
  vi.restoreAllMocks();
});

describe("the launcher row", () => {
  test("is a Panes command any window may run", () => {
    const command = allCommands().find((c) => c.id === ID);
    expect(command).toMatchObject({ title: "Show panes and tabs", category: "Panes", requirement: "any" });
    expect(availableCommands(commandContext()).some((c) => c.id === ID)).toBe(true);
    expect(availableCommands(terminalWindow()).some((c) => c.id === ID), "a terminal window has panes too").toBe(true);
  });

  test("is hidden in the control terminal and under Hybrid Nav", () => {
    ui.terminalControl = true;
    expect(availableCommands(commandContext()).some((c) => c.id === ID)).toBe(false);
    ui.terminalControl = false;
    paneMode.active = true;
    expect(availableCommands(commandContext()).some((c) => c.id === ID)).toBe(false);
  });

  test("opens the tree", () => {
    allCommands().find((c) => c.id === ID)!.run();
    expect(paneTree.open).toBe(true);
  });
});

describe("the chord", () => {
  test("is registered in the Panes group and escapes a focused terminal", () => {
    expect(SHORTCUTS.find((s) => s.id === ID)).toMatchObject({
      label: "Show panes and tabs",
      web: "Mod+Shift+A",
      native: "Mod+Shift+A",
      group: "Panes",
      escapeTerminal: true,
    });
  });

  test("reads Cmd+Shift+A on macOS and Ctrl+Shift+A on Linux and Windows, in the browser and on the desktop", () => {
    for (const [ua, label] of [
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "Cmd+Shift+A"],
      ["Mozilla/5.0 (X11; Linux x86_64)", "Ctrl+Shift+A"],
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Ctrl+Shift+A"],
    ] as const) {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
      tauri(false);
      expect(chordFor(ID), `${ua} web`).toBe(label);
      tauri(true);
      expect(chordFor(ID), `${ua} native`).toBe(label);
    }
  });

  test("a focused terminal lets the chord out on every OS", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64)");
    const ctrl = new KeyboardEvent("keydown", { key: "A", code: "KeyA", ctrlKey: true, shiftKey: true });
    expect(shouldEscapeTerminal(ctrl)).toBe(true);
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    const cmd = new KeyboardEvent("keydown", { key: "A", code: "KeyA", metaKey: true, shiftKey: true });
    expect(shouldEscapeTerminal(cmd)).toBe(true);
  });
});
