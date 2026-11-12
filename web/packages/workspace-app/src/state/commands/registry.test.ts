// Invariants over the whole catalog. Importing install registers every
// command module; these tests then hold the rules that keep one action under
// one name in one place: every command says where it acts, a title follows
// the naming rules, no two commands of a scope answer to the same title, and
// a renamed command is still found by the title it had.

import { describe, expect, test } from "vitest";
import {
  PANE_GROUPS,
  allCommands,
  commandPlacement,
  commandUnavailableReason,
  type Command,
  type CommandContext,
  type CommandScope,
} from "../commands";
import { SHORTCUTS } from "../shortcuts";

import "./install";

const SCOPES: readonly CommandScope[] = ["app", "pane", "window", "workspace", "settings"];

function byId(id: string): Command {
  const command = allCommands().find((candidate) => candidate.id === id);
  if (!command) throw new Error(`no command ${id}`);
  return command;
}

function context(partial: Partial<CommandContext> = {}): CommandContext {
  return {
    terminalOnly: false,
    terminalControl: false,
    caps: { workspace: true, files: true, drafts: true, terminal: true },
    activeSurface: null,
    activeSide: null,
    activeTabId: null,
    activeExtensionId: null,
    ...partial,
  };
}

describe("where a command acts", () => {
  test("every command declares its scope", () => {
    const catalog = allCommands();
    expect(catalog.length).toBeGreaterThan(80);
    for (const command of catalog) {
      expect(SCOPES, command.id).toContain(command.scope);
    }
  });

  test("an app command names its surface, and only an app command does", () => {
    for (const command of allCommands()) {
      const { surfaces } = commandPlacement(command);
      if (command.scope === "app") expect(surfaces.length, command.id).toBeGreaterThan(0);
      else expect(command.surface, command.id).toBeUndefined();
    }
  });

  test("a pane command sits in one of the pane's three groups", () => {
    const pane = allCommands().filter((command) => command.scope === "pane");
    expect(pane.length).toBeGreaterThan(15);
    for (const command of pane) {
      expect(PANE_GROUPS as readonly string[], command.id).toContain(command.group);
    }
  });

  test("a toggle reports its state and a choice lists its options", () => {
    const toggles = allCommands().filter((command) => command.kind === "toggle");
    const choices = allCommands().filter((command) => command.kind === "choice");
    expect(toggles.length).toBeGreaterThan(8);
    expect(choices.length).toBeGreaterThan(3);
    for (const command of toggles) expect(typeof command.state, command.id).toBe("function");
    for (const command of choices) expect(typeof command.options, command.id).toBe("function");
  });

  test("a row registered without a scope is placed by its id", () => {
    const row = (id: string): Command => ({
      id,
      title: id,
      category: "Apps",
      requirement: "workspace",
      available: () => true,
      run: () => {},
    });
    // The extension catalog's two shapes: the app's own entry spawns its tab,
    // and a command of the app belongs to that app.
    expect(commandPlacement(row("extension.echo"))).toEqual({
      scope: "pane",
      surfaces: [],
      group: "New tab",
    });
    expect(commandPlacement(row("extension.echo.say"))).toEqual({
      scope: "app",
      surfaces: ["extension"],
      group: null,
    });
    expect(commandPlacement(row("app.custom.demo")).scope).toBe("window");
  });
});

describe("how a command is named", () => {
  test("no title names a toggle by its verb or carries a value", () => {
    for (const { id, title } of allCommands()) {
      expect(title, id).not.toMatch(/^Toggle\b/);
      expect(title, id).not.toMatch(/Show\/Hide/);
      expect(title, id).not.toMatch(/^(Enable|Disable)\b/);
      // `X: value` is a setting's row; a command is one action.
      expect(title, id).not.toMatch(/: /);
    }
  });

  test("a title is sentence case: one capital to open it, proper names aside", () => {
    const PROPER = /\b(Hybrid Nav|Rich Prompt|Inspector|PIN)\b/g;
    for (const { id, title } of allCommands()) {
      expect(title[0], id).toBe(title[0]!.toUpperCase());
      const rest = title.replace(PROPER, "").replace(/\bside [AB]\b/, "").slice(1);
      expect(rest, `${id}: ${title}`).toBe(rest.toLowerCase());
    }
  });

  test("no two commands of a scope share a title where both can be listed", () => {
    // Two app commands may share a title only on different tabs: New terminal
    // here is the editor's and the file browser's.
    const seen = new Map<string, Command[]>();
    for (const command of allCommands()) {
      const key = `${command.scope}|${command.title}`;
      seen.set(key, [...(seen.get(key) ?? []), command]);
    }
    for (const [key, commands] of seen) {
      if (commands.length === 1) continue;
      expect(key.startsWith("app|"), `${key}: ${commands.map((c) => c.id).join(", ")}`).toBe(true);
      const surfaces = commands.flatMap((command) => commandPlacement(command).surfaces);
      expect(new Set(surfaces).size, key).toBe(surfaces.length);
    }
  });

  test("one id is registered once", () => {
    const ids = allCommands().map((command) => command.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  // Every title a command carried before its current one, by id. A search by
  // the old words must still reach the command.
  const FORMER_TITLES: Record<string, string[]> = {
    "app.search.toggle": ["Search"],
    "app.pane.mode": ["Enter hybrid navigation"],
    "app.tab.reopenClosed": ["Reopen last closed tab"],
    "app.pane.splitDown": ["Split bottom"],
    "app.pane.flip": ["Flip", "Flip pane side"],
    "app.open.path": ["Open"],
    "app.screensaver.test": ["Screen lock: test"],
    "app.screensaver.setPin": ["Screen lock: set PIN"],
    "app.window.reload": ["Reload"],
    "app.metadata.export": ["Metadata archive: export"],
    "app.metadata.import": ["Metadata archive: import"],
    "app.index.rebuild": ["Rebuild search index"],
    "app.slides.present": ["Present slide deck fullscreen"],
    "app.editor.toggleMode": ["Show source code"],
    "app.editor.styleToolbar": ["Toggle style toolbar"],
    "app.editor.toggleCollapse": ["Toggle collapse code blocks"],
    "app.editor.copyPath": ["Copy path to file"],
    "app.editor.copyParentPath": ["Copy path to parent directory"],
    "app.editor.terminalFromHere": ["Terminal from here"],
    "app.editor.graphFromHere": ["Graph from here"],
    "app.editor.toggleTrailingWs": ["Toggle highlight trailing whitespace"],
    "app.editor.outline": ["Toggle outline"],
    "app.editor.details": ["Toggle details"],
    "app.editor.syntaxHighlight": ["Toggle syntax highlighting"],
    "app.browser.clearClipboard": ["Clear file browser clipboard"],
    "app.browser.copySelection": ["Copy selection"],
    "app.browser.cutSelection": ["Cut selection"],
    "app.browser.newGraph": ["New graph"],
    "app.browser.newTerminal": ["New terminal"],
    "app.browser.openInBrowser": ["Open in new File Browser"],
    "app.browser.pasteSelection": ["Paste file browser clipboard"],
    "app.browser.renameSelection": ["Rename / move"],
    "app.browser.showWorkspaceInfo": ["Show workspace details"],
    "app.browser.toggleLeftDock": ["Toggle left file browser dock"],
    "app.browser.toggleRightDock": ["Toggle right file browser dock"],
    "app.terminal.details": ["Toggle details"],
    "app.terminal.secretMasking.toggle": ["Toggle secret masking for this terminal"],
    "app.terminal.broadcastToggle": ["Toggle group broadcast"],
    "app.terminal.setName": ["Set terminal name"],
    "terminal.richPrompt": ["Show/Hide Rich Prompt"],
    "terminal.richPromptToolbar": ["Toggle Rich Prompt style toolbar"],
    "app.terminal.copyCwd": ["Copy path to $CWD"],
    "app.terminal.newFsEntry": ["New file or directory ($CWD)"],
    "app.dashboard.slide": [
      "Go to Metrics",
      "Go to Workspace status",
      "Go to Indexing status",
      "Go to About chan",
    ],
    "app.graph.copyLink": ["Copy link to graph"],
    "app.graph.depth.increase": ["Graph depth: increase"],
    "app.graph.depth.decrease": ["Graph depth: decrease"],
    "app.graph.filters": [
      "Graph filter: tags",
      "Graph filter: contacts",
      "Graph filter: languages",
      "Graph filter: media",
      "Graph filter: markdown",
      "Graph filter: source",
    ],
    "app.pane.focusColor": ["Focus border"],
  };

  test("a renamed command keeps every former title as a keyword", () => {
    for (const [id, former] of Object.entries(FORMER_TITLES)) {
      const command = byId(id);
      for (const title of former) {
        expect(command.title, id).not.toBe(title);
        expect(command.keywords ?? [], `${id} lost "${title}"`).toContain(title);
      }
    }
  });
});

describe("why a command cannot run", () => {
  test("a window that lacks the capability says which", () => {
    const terminalWindow = context({
      terminalOnly: true,
      caps: { workspace: false, files: false, drafts: false, terminal: true },
    });
    expect(commandUnavailableReason(byId("app.search.toggle"), terminalWindow)).toBe(
      "Needs a workspace window",
    );
    expect(commandUnavailableReason(byId("app.files.toggle"), terminalWindow)).toBe(
      "Needs a file surface",
    );
    expect(commandUnavailableReason(byId("app.draft.new"), terminalWindow)).toBe(
      "Needs a draft store",
    );
  });

  test("an app command off its tab names the tab it needs", () => {
    const onEditor = context({ activeSurface: "file" });
    expect(commandUnavailableReason(byId("app.terminal.restart"), onEditor)).toBe(
      "Needs a terminal tab",
    );
    expect(commandUnavailableReason(byId("app.graph.reload"), onEditor)).toBe("Needs a graph tab");
    expect(commandUnavailableReason(byId("app.editor.outline"), context())).toBe(
      "Needs an editor tab",
    );
    expect(commandUnavailableReason(byId("app.find.next"), context({ activeSurface: "graph" }))).toBe(
      "Needs an editor or a terminal tab",
    );
  });

  test("a command on its tab gives its own reason", () => {
    const onBrowser = context({ activeSurface: "browser" });
    expect(commandUnavailableReason(byId("app.browser.deleteSelection"), onBrowser)).toBe(
      "Needs a selection",
    );
    expect(commandUnavailableReason(byId("app.browser.pasteSelection"), onBrowser)).toBe(
      "Needs a copied or cut selection",
    );
    expect(commandUnavailableReason(byId("app.tab.reopenClosed"), context())).toBe(
      "No closed tab to reopen",
    );
    expect(commandUnavailableReason(byId("app.window.hide"), context())).toBe(
      "Needs the desktop app",
    );
  });
});

describe("the shortcut table", () => {
  test("names a chorded command by its catalog title", () => {
    const titles = new Map(allCommands().map((command) => [command.id, command.title]));
    const shared = SHORTCUTS.filter((shortcut) => titles.has(shortcut.id));
    expect(shared.length).toBeGreaterThan(20);
    for (const shortcut of shared) {
      expect(shortcut.label, shortcut.id).toBe(titles.get(shortcut.id));
    }
  });
});
