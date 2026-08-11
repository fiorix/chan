// The deck actions in the command catalog: registered next to
// app.slides.new, grouped under Editor, available on a file surface.
// Both the Settings keymap grid and the command launcher iterate
// allCommands(), so catalog membership is what puts the rows (and their
// per-slot assignment cells, shortcutEditable defaults to true) on those
// surfaces; chordFor(id) supplies the displayed chord.

import { describe, it, expect } from "vitest";
import { allCommands, availableCommands, type CommandContext } from "../commands";

import "./slides";

function entryOf(id: string) {
  return allCommands().find((c) => c.id === id);
}

function ctx(partial: Partial<CommandContext> = {}): CommandContext {
  return {
    terminalOnly: false,
    terminalControl: false,
    activeSurface: "file",
    activeSide: "a",
    activeTabId: "tab-1",
    activeExtensionId: null,
    ...partial,
  };
}

function visibleIds(c: CommandContext): Set<string> {
  return new Set(availableCommands(c).map((cmd) => cmd.id));
}

describe("slide deck commands in the catalog", () => {
  it("registers both deck actions under Editor, editable and chorded", () => {
    for (const id of ["app.slides.preview", "app.slides.present"]) {
      const cmd = entryOf(id);
      expect(cmd, id).toBeDefined();
      expect(cmd?.category).toBe("Editor");
      // The assignment affordance (the per-slot cells in the keymap
      // grid) stays on.
      expect(cmd?.shortcutEditable).not.toBe(false);
    }
    // The spawn command stays under Apps.
    expect(entryOf("app.slides.new")?.category).toBe("Apps");
  });

  it("is available on a file surface and hidden off it", () => {
    const onFile = visibleIds(ctx({ activeSurface: "file" }));
    expect(onFile.has("app.slides.preview")).toBe(true);
    expect(onFile.has("app.slides.present")).toBe(true);
    const onTerminal = visibleIds(ctx({ activeSurface: "terminal" }));
    expect(onTerminal.has("app.slides.preview")).toBe(false);
    expect(onTerminal.has("app.slides.present")).toBe(false);
  });
});
