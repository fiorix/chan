// @vitest-environment jsdom
//
// Download and Export to PDF on the editor: the two actions of the Details
// inspector that take the open file out of the window. Each is offered on
// every file tab, a draft's included (Export on Markdown alone), says why
// where it is not, and hands the file's path to the function the inspector's
// own row calls. A workspace's draft goes by its draft identity and leaves no
// record that would store its client path. Both read the server's copy, so
// a draft with text the server lacks is saved first, and a save that fails
// refuses the action. A file that is no draft is read as the server holds
// it, with no save asked.

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
import type { FileWriteResponse } from "../../api/types";
import { exportPathToPdf } from "../fileActionExecutors";
import { fileOps, ui } from "../store.svelte";
import { registerPendingEditFlush, setTabContent, type FileTab } from "../tabs.svelte";
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

// The server's copy trails the editor by the autosave's delay, and for as
// long as a save keeps failing. A download or an export of it would carry
// the older text and still report success.
describe("on a tab with text the server does not hold", () => {
  const DRAFT = draftPath("untitled");

  /// What reaches the server and what leaves the window, in the order it
  /// happened. A write answers when `answer` says, so a test can look between
  /// the request and its answer.
  function traffic(answer: () => Promise<void> = async () => {}) {
    const seen: string[] = [];
    vi.spyOn(api, "write").mockImplementation(async (path, content) => {
      seen.push(`write ${path}: ${content}`);
      await answer();
      return { mtime: 2, mtime_ns: "2" } as FileWriteResponse;
    });
    vi.spyOn(fileOps, "downloadPath").mockImplementation((path) => void seen.push(`download ${path}`));
    vi.spyOn(fileOps, "downloadPathWithProgress").mockImplementation((path) => void seen.push(`download ${path}`));
    vi.mocked(exportPathToPdf).mockImplementation(async (path) => void seen.push(`export ${path}`));
    return seen;
  }

  function seat(tab: FileTab): FileTab {
    return resetLayout([tab]).tabs[0] as FileTab;
  }

  test("a draft is saved before Download asks for it and before Export reads it", async () => {
    let answered: () => void = () => {};
    const seen = traffic(() => new Promise<void>((resolve) => (answered = resolve)));
    const tab = seat(fileTab({ id: "draft", path: DRAFT, content: "typed", saved: "" }));

    command(DOWNLOAD).run();
    await vi.waitFor(() => expect(seen).toEqual([`write ${DRAFT}: typed`]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen, "nothing leaves while the save is unanswered").toEqual([`write ${DRAFT}: typed`]);
    answered();
    await vi.waitFor(() => expect(seen).toEqual([`write ${DRAFT}: typed`, `download ${DRAFT}`]));
    expect(tab.saved).toBe("typed");

    seen.splice(0);
    setTabContent(tab, "typed more");
    command(EXPORT).run();
    await vi.waitFor(() => expect(seen).toEqual([`write ${DRAFT}: typed more`]));
    answered();
    await vi.waitFor(() => expect(seen).toEqual([`write ${DRAFT}: typed more`, `export ${DRAFT}`]));
  });

  test("a save that fails refuses both, with the reason on the status line", async () => {
    const seen = traffic(async () => {
      throw new Error("no space left on device");
    });
    seat(fileTab({ id: "draft", path: DRAFT, content: "typed", saved: "" }));

    for (const id of [DOWNLOAD, EXPORT]) {
      ui.status = null;
      command(id).run();
      await vi.waitFor(() =>
        expect(ui.status, id).toMatch(/was not saved because the save request failed \(no space left on device\)\.$/),
      );
    }
    expect(seen, "two saves tried, nothing sent").toEqual([`write ${DRAFT}: typed`, `write ${DRAFT}: typed`]);
  });

  test("a mounted editor's buffered input is committed first, and is what the save writes", async () => {
    const seen = traffic();
    const tab = seat(fileTab({ id: "draft", path: DRAFT }));
    const forget = registerPendingEditFlush(tab.id, () => setTabContent(tab, "drawn"));

    command(DOWNLOAD).run();
    forget();

    await vi.waitFor(() => expect(seen).toEqual([`write ${DRAFT}: drawn`, `download ${DRAFT}`]));
  });

  test("an editor that cannot commit its input refuses both and says so", async () => {
    const seen = traffic();
    const tab = seat(fileTab({ id: "draft", path: DRAFT }));
    const forget = registerPendingEditFlush(tab.id, () => {
      throw new Error("scene export failed");
    });

    for (const id of [DOWNLOAD, EXPORT]) {
      ui.status = null;
      command(id).run();
      await vi.waitFor(() =>
        expect(ui.status, id).toMatch(/was not saved because its editor could not commit its input \(scene export failed\)\.$/),
      );
    }
    forget();
    expect(seen).toEqual([]);
  });

  // No live session holds this file's edits, so its server copy trails the
  // editor as a draft's does; the actions still read that copy as it is.
  test("a file that is no draft is neither committed nor saved, and both start at once", async () => {
    const seen = traffic();
    const tab = seat(fileTab({ id: "note", path: "notes/a.md", content: "typed", saved: "older" }));
    const commit = vi.fn(() => setTabContent(tab, "typed more"));
    const forget = registerPendingEditFlush(tab.id, commit);

    command(DOWNLOAD).run();
    command(EXPORT).run();
    forget();

    expect(seen, "both left inside the call, with no write").toEqual(["download notes/a.md", "export notes/a.md"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen, "and no write came after").toEqual(["download notes/a.md", "export notes/a.md"]);
    expect(commit, "the editor's buffered input was not committed").not.toHaveBeenCalled();
    expect([tab.content, tab.saved]).toEqual(["typed", "older"]);
  });

  // A standalone window's draft is a file of the machine, and a draft all the
  // same: it saves by the autosave alone.
  test("a standalone window's draft is saved before Download asks for it and before Export reads it", async () => {
    h.caps.workspace = false;
    standaloneDrafts.dir = "home/me/.chan/Drafts";
    const path = "home/me/.chan/Drafts/untitled/draft.md";
    const seen = traffic();
    const tab = seat(fileTab({ id: "draft", path, content: "typed", saved: "" }));

    command(DOWNLOAD).run();
    await vi.waitFor(() => expect(seen).toEqual([`write ${path}: typed`, `download ${path}`]));

    seen.splice(0);
    setTabContent(tab, "typed more");
    command(EXPORT).run();
    await vi.waitFor(() => expect(seen).toEqual([`write ${path}: typed more`, `export ${path}`]));
  });

  test("a tab the server is level with asks for no save and starts at once", () => {
    const seen = traffic();
    seat(fileTab({ id: "draft", path: DRAFT }));

    command(DOWNLOAD).run();
    command(EXPORT).run();

    expect(seen).toEqual([`download ${DRAFT}`, `export ${DRAFT}`]);
  });
});
