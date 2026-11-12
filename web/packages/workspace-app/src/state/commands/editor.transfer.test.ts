// @vitest-environment jsdom
//
// Download and Export to PDF on the editor: the two actions of the Details
// inspector that take the open file out of the window. Each is offered where
// the inspector offers it (any file but a draft; Export on Markdown alone),
// says why where it is not, and hands the file's path to the function the
// inspector's own row calls.

import { afterEach, describe, expect, test, vi } from "vitest";
import { draftPath } from "../../__tests__/drafts";
import { fileTab, resetLayout } from "../../__tests__/tabs";
import {
  availableCommands,
  commandById,
  commandUnavailableReason,
  type Command,
  type CommandContext,
} from "../commands";
import { fileOps } from "../store.svelte";

vi.mock("../fileActionExecutors", () => ({ exportPathToPdf: vi.fn(async () => {}) }));

import { exportPathToPdf } from "../fileActionExecutors";

import "./editor";

const DOWNLOAD = "app.editor.download";
const EXPORT = "app.editor.exportPdf";

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

function command(id: string): Command {
  const found = commandById(id);
  if (!found) throw new Error(`no command ${id}`);
  return found;
}

function offered(id: string): boolean {
  return availableCommands(onFileSurface()).some((candidate) => candidate.id === id);
}

function reason(id: string): string | null {
  return commandUnavailableReason(command(id), onFileSurface());
}

afterEach(() => {
  resetLayout([]);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Download and Export to PDF on the editor", () => {
  test("are both offered on a Markdown file, and each takes the file's path to its function", () => {
    resetLayout([fileTab({ id: "note", path: "notes/a.md" })]);
    const download = vi.spyOn(fileOps, "downloadPathWithProgress").mockImplementation(() => {});

    expect([offered(DOWNLOAD), offered(EXPORT)]).toEqual([true, true]);
    command(DOWNLOAD).run();
    command(EXPORT).run();

    expect(download.mock.calls).toEqual([["notes/a.md", false]]);
    expect(vi.mocked(exportPathToPdf).mock.calls).toEqual([["notes/a.md"]]);
  });

  test("a file that is not Markdown downloads and does not export", () => {
    resetLayout([fileTab({ id: "code", path: "src/main.rs", fileKind: "text", mode: "source" })]);

    expect([offered(DOWNLOAD), offered(EXPORT)]).toEqual([true, false]);
    expect(reason(EXPORT)).toBe("Needs a Markdown file");
    command(EXPORT).run();
    expect(exportPathToPdf).not.toHaveBeenCalled();
  });

  test("a draft offers neither, says so, and a stale run does nothing", () => {
    resetLayout([fileTab({ id: "draft", path: draftPath("untitled") })]);
    const download = vi.spyOn(fileOps, "downloadPathWithProgress").mockImplementation(() => {});

    expect([offered(DOWNLOAD), offered(EXPORT)]).toEqual([false, false]);
    expect([reason(DOWNLOAD), reason(EXPORT)]).toEqual([
      "Needs a file that is not a draft",
      "Needs a file that is not a draft",
    ]);
    command(DOWNLOAD).run();
    command(EXPORT).run();
    expect(download).not.toHaveBeenCalled();
    expect(exportPathToPdf).not.toHaveBeenCalled();
  });

  test("are the editor's own: actions, listed on a file tab", () => {
    for (const id of [DOWNLOAD, EXPORT]) {
      const { scope, surface, kind, category, requirement } = command(id);
      expect({ scope, surface, kind, category, requirement }, id).toEqual({
        scope: "app",
        surface: "file",
        kind: undefined,
        category: "Editor",
        requirement: "files",
      });
    }
    expect([command(DOWNLOAD).title, command(EXPORT).title]).toEqual(["Download", "Export to PDF"]);
  });
});
