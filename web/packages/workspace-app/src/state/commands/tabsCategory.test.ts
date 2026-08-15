// The launcher category split: "Apps" holds the spawn commands, "Tabs"
// holds the tab operations (close / next / prev / reopen). Importing the
// modules is the registration side effect; allCommands() then exposes the
// catalog so these assert category membership without the launcher UI.

import { describe, it, expect } from "vitest";
import { allCommands, availableCommands, type CommandContext } from "../commands";

import "./core";
import "./diagram";
import "./slides";
import "./tabs";

function categoryOf(id: string): string | undefined {
  return allCommands().find((c) => c.id === id)?.category;
}

function ctx(partial: Partial<CommandContext> = {}): CommandContext {
  return {
    terminalOnly: false,
    terminalControl: false,
    // Full caps keep the requirement gate open; these tests pin the
    // per-command availability predicates on their own.
    caps: { workspace: true, files: true, terminal: true },
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

describe("launcher Apps / Tabs split", () => {
  it("keeps the spawn commands under Apps", () => {
    for (const id of [
      "app.terminal.toggle",
      "app.terminal.teamWork",
      "app.draft.new",
      "app.graph.toggle",
      "app.files.toggle",
      "app.dashboard.open",
      "app.diagram.new",
      "app.slides.new",
    ]) {
      expect(categoryOf(id)).toBe("Apps");
    }
  });

  it("groups the tab operations under Tabs", () => {
    for (const id of [
      "app.tab.close",
      "app.tab.next",
      "app.tab.prev",
      "app.tab.reopenClosed",
      "app.tab.sendToA",
      "app.tab.sendToB",
    ]) {
      expect(categoryOf(id)).toBe("Tabs");
    }
  });

  it("shows only the opposite-side send action when an active tab exists", () => {
    expect(visibleIds(ctx({ activeSide: "a" })).has("app.tab.sendToA")).toBe(false);
    expect(visibleIds(ctx({ activeSide: "a" })).has("app.tab.sendToB")).toBe(true);
    expect(visibleIds(ctx({ activeSide: "b" })).has("app.tab.sendToA")).toBe(true);
    expect(visibleIds(ctx({ activeSide: "b" })).has("app.tab.sendToB")).toBe(false);
  });

  it("hides side send actions without an active tab", () => {
    const ids = visibleIds(ctx({ activeTabId: null }));
    expect(ids.has("app.tab.sendToA")).toBe(false);
    expect(ids.has("app.tab.sendToB")).toBe(false);
  });

  it("does not surface Jump to tab in the launcher", () => {
    expect(categoryOf("app.tab.jump")).toBeUndefined();
  });
});
