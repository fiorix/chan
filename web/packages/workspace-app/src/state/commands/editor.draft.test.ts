// @vitest-environment jsdom
//
// The editor's commands that go by the active file's place in the workspace
// (its parent directory, a terminal there, a graph scoped to it, its row in
// the file browser) are not offered on a workspace's draft, which has none,
// and neither are Delete file and Duplicate file: a draft is no file of the
// workspace, and is discarded from its own flow. Save draft is offered on a
// draft alone. Copy path copies the draft's path as a person reads it.

import { afterEach, describe, expect, test, vi } from "vitest";
import { draftPath } from "../../__tests__/drafts";
import { fileTab, resetLayout } from "../../__tests__/tabs";
import { availableCommands, type CommandContext } from "../commands";

import "./editor";

const BY_PLACE = [
  "app.editor.copyParentPath",
  "app.editor.terminalFromHere",
  "app.editor.graphFromHere",
  "app.editor.showInBrowser",
  "app.file.delete",
  "app.file.duplicate",
];

function onFileSurface(): CommandContext {
  return {
    terminalOnly: false,
    terminalControl: false,
    caps: { workspace: true, files: true, drafts: true, terminal: true },
    activeSurface: "file",
    activeSide: null,
    activeTabId: null,
    activeExtensionId: null,
  };
}

function offered(): Set<string> {
  return new Set(availableCommands(onFileSurface()).map((command) => command.id));
}

afterEach(() => {
  resetLayout([]);
  vi.restoreAllMocks();
});

describe("the editor's commands on a workspace draft", () => {
  test("offer nothing that goes by the file's place in the workspace", () => {
    resetLayout([fileTab({ id: "draft-tab", path: draftPath("untitled") })]);

    for (const id of BY_PLACE) expect.soft(offered().has(id), id).toBe(false);
    expect(offered().has("app.editor.copyPath")).toBe(true);
    expect(offered().has("app.draft.save")).toBe(true);
  });

  test("offer all of them on a file of the workspace", () => {
    resetLayout([fileTab({ id: "note-tab", path: "notes/a.md" })]);

    for (const id of BY_PLACE) expect(offered().has(id), id).toBe(true);
    expect(offered().has("app.draft.save")).toBe(false);
  });

  test("Copy path copies the draft's path as a person reads it", async () => {
    resetLayout([fileTab({ id: "draft-tab", path: draftPath("untitled") })]);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    availableCommands(onFileSurface())
      .find((command) => command.id === "app.editor.copyPath")!
      .run();

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("Drafts/untitled/draft.md"));
  });
});
