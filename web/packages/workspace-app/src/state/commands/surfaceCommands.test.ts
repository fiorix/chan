// Registration and availability gating for the Editor, File Browser,
// Graph, and Dashboard surface command modules. Importing the modules is the
// registration side effect; availableCommands then filters by a
// hand-built context, so these assert the surface gates without a live
// layout or the launcher UI.

import { describe, it, expect } from "vitest";
import { availableCommands, type CommandContext } from "../commands";
import { workspace } from "../workspace.svelte";

import "./editor";
import "./browser";
import "./graph";
import "./dashboard";
import "./diagram";
import "./slides";
import "./terminal";

function ctx(partial: Partial<CommandContext>): CommandContext {
  return {
    terminalOnly: false,
    terminalControl: false,
    // Full caps keep the requirement gate open; these tests pin the
    // per-command availability predicates on their own.
    caps: { workspace: true, files: true, terminal: true },
    activeSurface: null,
    activeSide: null,
    activeTabId: null,
    activeExtensionId: null,
    ...partial,
  };
}

function idsIn(c: CommandContext): Set<string> {
  return new Set(availableCommands(c).map((cmd) => cmd.id));
}

describe("editor surface commands", () => {
  it("appear only when a file tab is the active surface", () => {
    const onFile = idsIn(ctx({ activeSurface: "file" }));
    for (const id of [
      "app.editor.surfaceTheme.dark",
      "app.editor.toggleMode",
      "app.editor.outline",
      "app.editor.copyPath",
      "app.editor.copyParentPath",
      "app.file.duplicate",
      "app.file.rename",
      "app.editor.stripTrailingWs",
      "app.editor.toggleCollapse",
      "app.editor.searchSelection",
      "app.editor.syntaxHighlight",
      "app.editor.reloadFromDisk",
    ]) {
      expect(onFile.has(id)).toBe(true);
    }
    expect(idsIn(ctx({ activeSurface: "graph" })).has("app.editor.outline")).toBe(false);
  });

  it("New file follows the workspace gate, not the file surface", () => {
    expect(idsIn(ctx({ activeSurface: "graph" })).has("app.file.new")).toBe(true);
    expect(
      idsIn(ctx({ terminalOnly: true, activeSurface: "terminal" })).has("app.file.new"),
    ).toBe(false);
  });
});

describe("graph surface commands", () => {
  it("appear only on a graph surface", () => {
    const onGraph = idsIn(ctx({ activeSurface: "graph" }));
    for (const id of [
      "app.graph.surfaceTheme.light",
      "app.graph.copyLink",
      "app.graph.depth.increase",
      "app.graph.filter.contact",
      "app.graph.filter.media",
      "app.graph.reload",
    ]) {
      expect(onGraph.has(id)).toBe(true);
    }
    expect(idsIn(ctx({ activeSurface: "file" })).has("app.graph.copyLink")).toBe(false);
    expect(idsIn(ctx({ activeSurface: "file" })).has("app.graph.reload")).toBe(false);
  });
});

describe("file browser surface commands", () => {
  it("appear only on a file browser surface", () => {
    const onBrowser = idsIn(ctx({ activeSurface: "browser" }));
    for (const id of [
      "app.browser.surfaceTheme.dark",
      "app.browser.expandAll",
      "app.browser.importContacts",
      "app.browser.newGraph",
      "app.browser.newTerminal",
      "app.browser.uploadSelection",
    ]) {
      expect(onBrowser.has(id)).toBe(true);
    }
    expect(idsIn(ctx({ activeSurface: "file" })).has("app.browser.newGraph")).toBe(false);
  });

  it("workspace-wide browser commands are available off the browser surface", () => {
    const onFile = idsIn(ctx({ activeSurface: "file" }));
    for (const id of [
      "app.browser.newFsEntry",
      "app.browser.toggleLeftDock",
      "app.browser.toggleRightDock",
    ]) {
      expect(onFile.has(id)).toBe(true);
    }
    const inStandalone = idsIn(
      ctx({ terminalOnly: true, activeSurface: "terminal" }),
    );
    expect(inStandalone.has("app.browser.newFsEntry")).toBe(false);
    expect(inStandalone.has("app.browser.toggleLeftDock")).toBe(false);
    expect(inStandalone.has("app.browser.toggleRightDock")).toBe(false);
  });
});

describe("terminal surface commands", () => {
  it("appear only on a workspace terminal surface", () => {
    const onTerminal = idsIn(ctx({ activeSurface: "terminal" }));
    for (const id of [
      "app.terminal.broadcastToggle",
      "app.terminal.copyCwd",
      "app.terminal.newFsEntry",
      "app.terminal.backend.toggle",
      "app.terminal.secretMasking.toggle",
      "terminal.richPrompt",
    ]) {
      expect(onTerminal.has(id)).toBe(true);
    }
    expect(idsIn(ctx({ activeSurface: "file" })).has("terminal.richPrompt")).toBe(
      false,
    );
    // newFsEntry writes through the workspace file API and Rich Prompt drafts
    // into the workspace drafts dir; the global backend toggle needs the
    // workspace tenant's /api/config route. A standalone terminal tenant
    // deliberately serves none of those.
    const inStandalone = idsIn(
      ctx({ terminalOnly: true, activeSurface: "terminal" }),
    );
    for (const id of [
      "terminal.richPrompt",
      "app.terminal.newFsEntry",
      "app.terminal.backend.toggle",
    ]) {
      expect(inStandalone.has(id)).toBe(false);
    }
    expect(inStandalone.has("app.terminal.secretMasking.toggle")).toBe(true);
    // Copying the cwd needs no workspace: it prefers the absolute path the
    // PTY reports. The right-click row it replaced had no workspace gate, so
    // gating it here left a standalone terminal with no way to reach it.
    expect(inStandalone.has("app.terminal.copyCwd")).toBe(true);
  });

  it("restart drops its confirm when no live session is left to stop", () => {
    const restart = availableCommands(ctx({ activeSurface: "terminal" })).find(
      (candidate) => candidate.id === "app.terminal.restart",
    );
    // No layout is mounted here, so there is no active terminal and no live
    // session id: the exited-terminal path, where warning about stopping a
    // running shell would be a lie.
    expect(restart?.confirm).toBeUndefined();
  });

  it("names the current engine and the new-terminal-only contract", () => {
    const original = workspace.info;
    try {
      workspace.info = {
        preferences: { terminal: { ghostty: false } },
      } as NonNullable<typeof workspace.info>;
      const command = availableCommands(ctx({ activeSurface: "terminal" })).find(
        (candidate) => candidate.id === "app.terminal.backend.toggle",
      );
      expect(command?.category).toBe("Terminal");
      expect(command?.keywords).toEqual(
        expect.arrayContaining(["ghostty", "xterm"]),
      );
      expect(command?.title).toContain("xterm");
      expect(command?.title).toContain("newly opened terminals only");

      workspace.info.preferences.terminal.ghostty = true;
      expect(command?.title).toContain("ghostty");
    } finally {
      workspace.info = original;
    }
  });
});

describe("dashboard surface commands", () => {
  it("appear only on a dashboard surface", () => {
    const onDash = idsIn(ctx({ activeSurface: "dashboard" }));
    for (const id of [
      "app.dashboard.surfaceTheme.dark",
      "app.dashboard.nextSlide",
      "app.dashboard.prevSlide",
      "app.dashboard.slide.workspace",
      "app.dashboard.slide.indexing",
      "app.dashboard.slide.about",
    ]) {
      expect(onDash.has(id)).toBe(true);
    }
    expect(idsIn(ctx({ activeSurface: "file" })).has("app.dashboard.nextSlide")).toBe(false);
    expect(
      idsIn(ctx({ activeSurface: "file" })).has("app.dashboard.slide.about"),
    ).toBe(false);
  });
});

describe("new diagram command", () => {
  it("follows the workspace gate, independent of the active surface", () => {
    expect(idsIn(ctx({ activeSurface: "file" })).has("app.diagram.new")).toBe(true);
    expect(idsIn(ctx({ activeSurface: null })).has("app.diagram.new")).toBe(true);
    expect(
      idsIn(ctx({ terminalOnly: true, activeSurface: "terminal" })).has("app.diagram.new"),
    ).toBe(false);
  });
});

describe("new slide deck command", () => {
  it("follows the workspace gate, independent of the active surface", () => {
    expect(idsIn(ctx({ activeSurface: "file" })).has("app.slides.new")).toBe(true);
    expect(idsIn(ctx({ activeSurface: null })).has("app.slides.new")).toBe(true);
    expect(
      idsIn(ctx({ terminalOnly: true, activeSurface: "terminal" })).has("app.slides.new"),
    ).toBe(false);
  });
});

describe("surface commands in a standalone terminal window", () => {
  it("hide every editor, graph, and dashboard entry", () => {
    const inTerminal = idsIn(ctx({ terminalOnly: true, activeSurface: "terminal" }));
    for (const id of [
      "app.editor.outline",
      "app.browser.newGraph",
      "app.graph.copyLink",
      "app.dashboard.nextSlide",
      "app.dashboard.slide.about",
      "terminal.richPrompt",
    ]) {
      expect(inTerminal.has(id)).toBe(false);
    }
  });
});
