// @vitest-environment jsdom
//
// Download and Export to PDF on the editor: the two actions of the Details
// inspector that take the open file out of the window. Each is offered on
// every file tab, a draft's included (Export on Markdown alone), says why
// where it is not, and hands the file's path to the function the inspector's
// own row calls. A workspace's draft goes by its draft identity and leaves no
// record that would store its client path.

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

const h = vi.hoisted(() => ({
  caps: { workspace: true, files: true, drafts: true, terminal: true },
  desktop: false,
  desktopDownloads: [] as unknown[][],
}));

vi.mock("../windowCaps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../windowCaps")>()),
  windowCaps: h.caps,
}));

vi.mock("../../api/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/desktop")>()),
  isTauriDesktop: () => h.desktop,
  runDesktopDownload: async (...args: unknown[]) => {
    h.desktopDownloads.push(args);
    return "/home/me/Downloads/draft.md";
  },
}));

vi.mock("../fileActionExecutors", () => ({ exportPathToPdf: vi.fn(async () => {}) }));

import { api } from "../../api/client";
import { exportPathToPdf } from "../fileActionExecutors";
import { fileOps } from "../store.svelte";
import { standaloneDrafts } from "../workspace.svelte";

import "./editor";

const DOWNLOAD = "app.editor.download";
const EXPORT = "app.editor.exportPdf";

function onFileSurface(): CommandContext {
  return {
    terminalOnly: false,
    terminalControl: false,
    caps: { ...h.caps },
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

/// The two ways a download leaves the window from the store, each recording
/// the path it was handed and doing nothing.
function downloads() {
  return {
    tracked: vi.spyOn(fileOps, "downloadPathWithProgress").mockImplementation(() => {}),
    plain: vi.spyOn(fileOps, "downloadPath").mockImplementation(() => {}),
  };
}

afterEach(() => {
  resetLayout([]);
  h.caps.workspace = true;
  h.desktop = false;
  h.desktopDownloads.splice(0);
  standaloneDrafts.dir = null;
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

describe("on a workspace's draft", () => {
  const DRAFT = draftPath("untitled");

  test("both are offered", () => {
    resetLayout([fileTab({ id: "draft", path: DRAFT })]);

    expect([offered(DOWNLOAD), offered(EXPORT)]).toEqual([true, true]);
  });

  test("Download asks the browser for the draft by its identity, and Export reads the draft", () => {
    resetLayout([fileTab({ id: "draft", path: DRAFT })]);
    const { tracked, plain } = downloads();

    command(DOWNLOAD).run();
    command(EXPORT).run();

    expect(plain.mock.calls).toEqual([[DRAFT, false]]);
    expect(tracked, "the tracked download would store the draft's client path").not.toHaveBeenCalled();
    expect(vi.mocked(exportPathToPdf).mock.calls).toEqual([[DRAFT]]);
    // The address the browser's download asks for names the draft's root and
    // lifetime beside its own path, never the client path.
    const asked = new URL(api.downloadUrl(DRAFT), "http://chan.test");
    expect(asked.pathname.endsWith("/api/fs/untitled/draft.md")).toBe(true);
    expect([
      asked.searchParams.get("download"),
      asked.searchParams.get("root"),
      asked.searchParams.get("draft_id"),
    ]).toEqual(["1", "draft", "life-untitled"]);
  });

  test("on the desktop Download goes to the Downloads folder under the draft's file name, with no source kept to retry from", () => {
    h.desktop = true;
    resetLayout([fileTab({ id: "draft", path: DRAFT })]);
    const { tracked, plain } = downloads();

    command(DOWNLOAD).run();

    expect(h.desktopDownloads).toEqual([
      [new URL(api.downloadUrl(DRAFT), window.location.href).toString(), "draft.md"],
    ]);
    expect([tracked.mock.calls, plain.mock.calls]).toEqual([[], []]);
  });

  test("a draft that is not Markdown downloads and does not export", () => {
    resetLayout([
      fileTab({ id: "board", path: draftPath("board", "board.excalidraw"), fileKind: "text", mode: "source" }),
    ]);
    const { plain } = downloads();

    expect([offered(DOWNLOAD), offered(EXPORT)]).toEqual([true, false]);
    expect(reason(EXPORT)).toBe("Needs a Markdown file");
    command(DOWNLOAD).run();
    command(EXPORT).run();
    expect(plain.mock.calls).toEqual([[draftPath("board", "board.excalidraw"), false]]);
    expect(exportPathToPdf).not.toHaveBeenCalled();
  });
});

// A standalone window keeps its drafts as files under its drafts directory,
// so one downloads and exports as any file of the machine does.
describe("on a standalone window's draft", () => {
  const DRAFT = "home/me/.chan/Drafts/untitled/draft.md";

  test("both are offered and each takes the draft's path where any file's goes", () => {
    h.caps.workspace = false;
    standaloneDrafts.dir = "home/me/.chan/Drafts";
    resetLayout([fileTab({ id: "draft", path: DRAFT })]);
    const { tracked, plain } = downloads();

    expect([offered(DOWNLOAD), offered(EXPORT)]).toEqual([true, true]);
    command(DOWNLOAD).run();
    command(EXPORT).run();

    expect(tracked.mock.calls).toEqual([[DRAFT, false]]);
    expect(plain).not.toHaveBeenCalled();
    expect(vi.mocked(exportPathToPdf).mock.calls).toEqual([[DRAFT]]);
  });
});
