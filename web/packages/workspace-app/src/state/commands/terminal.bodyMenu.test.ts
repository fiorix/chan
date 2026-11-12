// @vitest-environment jsdom
//
// The terminal body menu's actions as catalog commands: Find, Copy, Paste
// and Copy scrollback. Find, Copy and Paste sit under the ids their chords
// carry in the shortcut table, so the Keyboard Shortcuts grid lists them and
// a chord the user assigns runs them. Each needs the live renderer, so it
// asks the focused terminal by a chan:command of its own id.

import { describe, expect, test } from "vitest";

import { allCommands, availableCommands, type Command, type CommandContext } from "../commands";
import { SHORTCUTS } from "../shortcuts";
import "./install";

function command(id: string): Command {
  const found = allCommands().find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no command ${id}`);
  return found;
}

function context(partial: Partial<CommandContext> = {}): CommandContext {
  return {
    terminalOnly: false,
    terminalControl: false,
    caps: { workspace: true, files: true, drafts: true, terminal: true },
    activeSurface: "terminal",
    activeSide: "a",
    activeTabId: "term-1",
    activeExtensionId: null,
    ...partial,
  };
}

/// The chan:command ids a run fires.
function dispatched(run: () => void): string[] {
  const seen: string[] = [];
  const listener = (e: Event) => seen.push((e as CustomEvent<{ name: string }>).detail.name);
  window.addEventListener("chan:command", listener);
  try {
    run();
  } finally {
    window.removeEventListener("chan:command", listener);
  }
  return seen;
}

const ROWS = [
  ["terminal.find", "Find"],
  ["terminal.copy", "Copy"],
  ["terminal.paste", "Paste"],
  ["app.terminal.copyScrollback", "Copy scrollback"],
] as const;

describe("the terminal body menu's commands", () => {
  test.each(ROWS)("%s is the terminal's %s and asks the focused terminal for it", (id, title) => {
    expect(command(id)).toMatchObject({
      title,
      category: "Terminal",
      scope: "app",
      surface: "terminal",
      requirement: "terminal",
    });
    expect(dispatched(() => command(id).run())).toEqual([id]);
  });

  test("Find, Copy and Paste carry the ids of their chords", () => {
    const chorded = new Set(SHORTCUTS.map((shortcut) => shortcut.id));
    expect(ROWS.map(([id]) => [id, chorded.has(id)])).toEqual([
      ["terminal.find", true],
      ["terminal.copy", true],
      ["terminal.paste", true],
      ["app.terminal.copyScrollback", false],
    ]);
  });

  test("are offered on a terminal tab, and not on another tab or the control terminal", () => {
    const ids = (ctx: CommandContext) => new Set(availableCommands(ctx).map((entry) => entry.id));
    const onTerminal = ids(context());
    const inStandalone = ids(
      context({ terminalOnly: true, caps: { workspace: false, files: false, drafts: false, terminal: true } }),
    );
    const onEditor = ids(context({ activeSurface: "file" }));
    const onControl = ids(context({ terminalOnly: true, terminalControl: true }));
    for (const [id] of ROWS) {
      expect([id, onTerminal.has(id), inStandalone.has(id), onEditor.has(id), onControl.has(id)]).toEqual([
        id,
        true,
        true,
        false,
        false,
      ]);
    }
  });

  test("a search by the words the menus and the shortcut table used before still finds each", () => {
    expect(command("terminal.find").keywords).toContain("Find in terminal");
    expect(command("terminal.copy").keywords).toContain("Copy selection");
    expect(command("app.terminal.broadcastToggle").keywords).toEqual(
      expect.arrayContaining(["Select All", "Deselect All"]),
    );
    expect(command("terminal.richPrompt").keywords).toEqual(
      expect.arrayContaining(["Show Rich Prompt", "Hide Rich Prompt"]),
    );
    expect(command("terminal.richPromptToolbar").keywords).toEqual(
      expect.arrayContaining(["Show Style Toolbar", "Hide Style Toolbar"]),
    );
  });
});

describe("the terminal's Find", () => {
  // The editor's module lists Find next and Find previous on a terminal tab
  // too, at orders just past its own Find's. The terminal's Find holds that
  // same order, with a whole step before Copy, so the steps follow it.
  test("sits where the editor's Find does, a whole step ahead of Copy", () => {
    const find = command("terminal.find").order!;
    expect(find).toBe(command("app.find.open").order);
    expect(command("terminal.copy").order! - find).toBeGreaterThanOrEqual(1);
  });
});

describe("the terminal's commands", () => {
  test("are listed in the order its menus offer them: the tab menu's rows, then the body menu's", () => {
    const ordered = allCommands()
      .filter((entry) => entry.category === "Terminal" && entry.scope === "app" && entry.order !== undefined)
      .sort((a, b) => a.order! - b.order!)
      .map((entry) => entry.id);
    expect(ordered).toEqual([
      "app.terminal.setName",
      "app.terminal.setGroup",
      "app.terminal.restart",
      "app.terminal.broadcastToggle",
      "app.terminal.broadcastTargets",
      "app.terminal.details",
      "app.terminal.secretMasking.toggle",
      "terminal.find",
      "terminal.copy",
      "terminal.paste",
      "app.terminal.copyScrollback",
      "terminal.richPrompt",
      "terminal.richPromptToolbar",
    ]);
  });
});
