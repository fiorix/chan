// @vitest-environment jsdom
//
// Where the editor's commands sit in the launcher's list. The list follows
// the editor's menus: the find family reads as one run, in the order a
// search goes, on an editor tab and on a terminal tab alike, and the Details
// inspector's actions keep the inspector's order. The whole catalog is
// loaded, so a row of another module that sorted in among them would show.

import { afterEach, describe, expect, test } from "vitest";
import { fileTab, resetLayout, terminalTab } from "../../__tests__/tabs";
import { allCommands, type CommandContext, type CommandSurface } from "../commands";
import { openFind } from "../tabs.svelte";
import { browseRows, type DeckSource } from "./deck";

import "./install";

function source(activeSurface: CommandSurface, label: string): DeckSource {
  const ctx: CommandContext = {
    terminalOnly: false,
    terminalControl: false,
    caps: { workspace: true, files: true, drafts: true, terminal: true },
    activeSurface,
    activeSide: "a",
    activeTabId: null,
    activeExtensionId: null,
  };
  return {
    ctx,
    commands: allCommands(),
    app: { label },
    settings: [],
    sections: [],
    recent: [],
    chord: () => null,
  };
}

/// The ids of the focused tab's commands, in the order the launcher lists
/// them.
function listed(activeSurface: CommandSurface, label: string): string[] {
  return browseRows(source(activeSurface, label), "app", () => {}).map((row) => row.command!.id);
}

/// The slice of `ids` from its first member of `family` to its last.
function run(ids: readonly string[], family: readonly string[]): string[] {
  const at = ids.map((id, index) => (family.includes(id) ? index : -1)).filter((index) => index >= 0);
  return at.length === 0 ? [] : ids.slice(at[0]!, at[at.length - 1]! + 1);
}

const FIND = ["app.find.open", "app.find.next", "app.find.prev", "app.find.close"];

afterEach(() => {
  resetLayout([]);
});

describe("the find family", () => {
  test("lists together on an editor tab, in the order a search runs", () => {
    resetLayout([fileTab({ id: "note", path: "notes/a.md" })]);
    openFind("note");

    expect(run(listed("file", "Editor"), FIND)).toEqual(FIND);
  });

  test("lists together on a terminal tab, which has no command to close its bar", () => {
    resetLayout([terminalTab({ id: "shell" })]);

    expect(run(listed("terminal", "Terminal"), FIND)).toEqual(FIND.slice(0, 3));
  });

  test("carries the search icon", () => {
    const icons = FIND.map((id) => allCommands().find((command) => command.id === id)?.icon);

    expect(icons).toEqual(["search", "search", "search", "search"]);
  });
});

describe("the editor's list", () => {
  test("follows the tab menu, the body menu and then the Details inspector", () => {
    resetLayout([fileTab({ id: "note", path: "notes/a.md" })]);
    openFind("note");

    const ids = listed("file", "Editor");
    expect(ids.slice(0, ids.indexOf("app.editor.graphFromHere") + 1)).toEqual([
      "app.file.rename",
      "app.editor.outline",
      "app.editor.details",
      "app.editor.styleToolbar",
      "app.editor.copyPath",
      "app.file.delete",
      "app.file.duplicate",
      "app.editor.reloadFromDisk",
      ...FIND,
      "app.editor.searchSelection",
      "app.editor.showInBrowser",
      "app.editor.download",
      "app.editor.terminalFromHere",
      "app.editor.exportPdf",
      "app.editor.graphFromHere",
    ]);
  });
});
