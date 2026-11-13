// @vitest-environment jsdom
//
// FileInfoBody, mounted. The inspector reads its entry from the tree store and
// its reports from the api client; both are stubbed here so each test hands the
// component one entry and reads what it renders and what it calls.

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import FileInfoBody from "./FileInfoBody.svelte";
import { classifyFileActions, type FileActionId } from "../state/fileActions";
import {
  allCommands,
  commandById,
  registerCommands,
  unregisterCommands,
  type Command,
} from "../state/commands";
import { ApiError } from "../api/errors";
import { terminalFromHereTarget } from "../terminal/fromHere";
import type { TreeEntry } from "../api/types";
import { AUDIO_UNSUPPORTED_MESSAGE } from "../state/audioViewer";
import { graphData, invalidateGraph } from "../state/graphData.svelte";
import type { GraphView, ReportFileStats, ReportPrefix } from "../api/types";

type Entry = {
  path: string;
  is_dir: boolean;
  kind?: TreeEntry["kind"];
  size: number;
  mtime: number | null;
};

const h = vi.hoisted(() => ({
  entries: [] as Entry[],
  caps: { workspace: true, files: true, drafts: true, terminal: true },
  draftsDir: ".Drafts",
  prefixReport: null as unknown,
  fileReport: null as unknown,
}));

vi.mock("../state/windowCaps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/windowCaps")>()),
  windowCaps: h.caps,
}));

vi.mock("../api/client", () => ({
  api: {
    inspector: vi.fn(async () => null),
    reportDir: vi.fn(async () => h.prefixReport),
    reportPrefix: vi.fn(async () => null),
    reportFileStream: vi.fn(async () => h.fileReport),
    graphStream: vi.fn(async () => null),
    backlinksStream: vi.fn(async () => {}),
  },
  withTokenQuery: (u: string) => `${u}?token=inspector-test`,
  fileUrl: (p: string) => `/api/fs/${encodeURIComponent(p).replace(/%2F/g, "/")}?token=inspector-test`,
}));

// The store and the tab state are the real modules with the members this
// body reads replaced: the action pill loads the command catalog, whose
// modules import the rest of both.
vi.mock("../state/store.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/store.svelte")>()),
  copyTextToClipboard: vi.fn(async () => {}),
  draftsDir: () => h.draftsDir,
  isDraftPath: (p: string) => p === h.draftsDir || p.startsWith(`${h.draftsDir}/`),
  setTransientStatus: vi.fn(),
  ui: { status: "", statusKind: "transient" },
  workspace: { info: { root: "/home/me/ws/", label: "ws" } },
  fileOps: {
    downloadPathWithProgress: vi.fn(),
  },
  raiseReplacePicker: vi.fn(),
  raiseUploadPicker: vi.fn(),
  loadTreeDir: vi.fn(async () => {}),
  openGraphAtNode: vi.fn(),
  openGraphForContact: vi.fn(),
  openGraphForLanguage: vi.fn(),
  openGraphForMention: vi.fn(),
  openGraphForTag: vi.fn(),
  revealPathInBrowser: vi.fn(),
  tree: {
    get entries() {
      return h.entries;
    },
    loadingDirs: {},
    loadedDirs: {},
    dirErrors: {},
  },
}));

vi.mock("../state/tabs.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/tabs.svelte")>()),
  openTerminalInActivePane: vi.fn(),
}));
vi.mock("../state/mediaOpen", () => ({
  openMediaViewer: vi.fn(() => true),
  dirImageSet: () => [],
}));
vi.mock("../state/imageZoom", () => ({ openImageZoom: vi.fn() }));
vi.mock("../state/videoViewer", () => ({ openVideoViewer: vi.fn() }));
vi.mock("../state/fileActionExecutors", () => ({ exportPathToPdf: vi.fn(async () => {}) }));

import { api } from "../api/client";
import {
  fileOps,
  openGraphForContact,
  openGraphForLanguage,
  raiseReplacePicker,
  raiseUploadPicker,
  revealPathInBrowser,
  tree,
} from "../state/store.svelte";
import { openTerminalInActivePane } from "../state/tabs.svelte";
import { openMediaViewer } from "../state/mediaOpen";
import { exportPathToPdf } from "../state/fileActionExecutors";

type Props = {
  path: string | null;
  surface?: "file" | "browser";
  onOpen?: () => void;
  onReveal?: () => void;
  onSetAsScope?: () => void;
  onNewTerminal?: () => void;
  onDownload?: () => void;
  onExportPdf?: () => void;
  onContactNavigate?: (path: string) => void;
  showRefs?: boolean;
  allowUpload?: boolean;
};

const mounted: Array<Record<string, unknown>> = [];

function file(path: string, kind: TreeEntry["kind"] = "document"): Entry {
  return { path, is_dir: false, kind, size: 2048, mtime: 1_700_000_000 };
}

function dir(path: string): Entry {
  return { path, is_dir: true, size: 0, mtime: null };
}

async function render(props: Props): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(FileInfoBody, { target, props }));
  await settle();
  return target;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

function pill(target: HTMLElement): HTMLButtonElement {
  const main = target.querySelector<HTMLButtonElement>(".pill-main");
  if (!main) throw new Error("no action pill rendered");
  return main;
}

function caret(target: HTMLElement): HTMLButtonElement | null {
  return target.querySelector<HTMLButtonElement>(".pill-caret");
}

/// Opens the caret menu and returns its item labels, in order.
function openMenu(target: HTMLElement): string[] {
  const c = caret(target);
  if (!c) throw new Error("no caret rendered");
  c.click();
  flushSync();
  return [...target.querySelectorAll(".action-menu [role='menuitem']")].map(
    (el) => el.textContent?.trim() ?? "",
  );
}

function menuItem(target: HTMLElement, label: string): HTMLButtonElement {
  const item = [...target.querySelectorAll<HTMLButtonElement>(".action-menu-item")].find(
    (el) => el.textContent?.trim() === label,
  );
  if (!item) throw new Error(`no menu item ${label}`);
  return item;
}

/// The command each classifier action is where the inspector shows a
/// selection: the file browser's.
const BROWSER: Record<FileActionId, string> = {
  open: "app.browser.open",
  showFile: "app.browser.openInBrowser",
  viewMedia: "app.browser.viewMedia",
  download: "app.browser.downloadSelection",
  upload: "app.browser.uploadSelection",
  newTerminal: "app.browser.newTerminal",
  exportPdf: "app.browser.exportPdf",
  graphFromHere: "app.browser.newGraph",
};

/// The command each action is in the editor's Details panel: the editor's
/// own where it has one.
const EDITOR: Record<FileActionId, string> = {
  ...BROWSER,
  showFile: "app.editor.showInBrowser",
  download: "app.editor.download",
  newTerminal: "app.editor.terminalFromHere",
  exportPdf: "app.editor.exportPdf",
  graphFromHere: "app.editor.graphFromHere",
};

/// File browser commands the inspector names that the file browser's module
/// may not register in the catalog this test loads. A missing one is
/// registered here under its catalog title, so the row's words resolve.
const BROWSER_STAND_INS: Record<string, string> = {
  "app.browser.open": "Open",
  "app.browser.viewMedia": "View",
  "app.browser.exportPdf": "Export to PDF",
};

function registerMissingBrowserCommands(): void {
  registerCommands(
    Object.entries(BROWSER_STAND_INS)
      .filter(([id]) => !commandById(id))
      .map(([id, title]): Command => ({
        id,
        title,
        category: "File Browser",
        scope: "app",
        surface: "browser",
        requirement: "files",
        available: () => true,
        run: () => {},
      })),
  );
}

function title(id: string): string {
  const command = commandById(id);
  if (!command) throw new Error(`no command ${id}`);
  return command.title;
}

let catalog: Command[] | null = null;

/// Registers every command again under a title that spells its id, so a row
/// shows which command it was given.
function retitleCatalog(): void {
  catalog = allCommands();
  unregisterCommands(() => true);
  registerCommands(catalog.map((command) => ({ ...command, title: `<${command.id}>` })));
}

beforeEach(() => {
  let entries = $state<Entry[]>([]);
  Object.defineProperty(h, "entries", {
    configurable: true,
    get: () => entries,
    set: (value: Entry[]) => { entries = value; },
  });
  h.caps.workspace = true;
  h.draftsDir = ".Drafts";
  h.prefixReport = null;
  h.fileReport = null;
  registerMissingBrowserCommands();
});

afterEach(() => {
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  graphData.view = null;
  graphData.partial = false;
  if (catalog) {
    unregisterCommands(() => true);
    registerCommands(catalog);
    catalog = null;
  }
  vi.clearAllMocks();
});

describe("the actions section", () => {
  test("a directory offers Open with upload, download, terminal and graph behind the caret", async () => {
    h.entries = [dir("docs"), file("docs/a.md")];
    const onSetAsScope = vi.fn();
    const target = await render({ path: "docs", onSetAsScope });

    expect(pill(target).textContent?.trim()).toBe("Open");
    expect(target.querySelector(".action-menu"), "the menu starts closed").toBeNull();
    expect(openMenu(target)).toEqual(["Upload", "Download", "New terminal here", "New graph here"]);
    expect(caret(target)?.getAttribute("aria-expanded")).toBe("true");
    expect(caret(target)?.getAttribute("aria-haspopup")).toBe("menu");
    expect(target.querySelector(".action-menu")?.getAttribute("role")).toBe("menu");
  });

  test("picking a menu item runs it and closes the menu", async () => {
    h.entries = [dir("docs")];
    const onSetAsScope = vi.fn();
    const target = await render({ path: "docs", onSetAsScope });

    openMenu(target);
    menuItem(target, "Download").click();
    flushSync();

    expect(fileOps.downloadPathWithProgress).toHaveBeenCalledWith("docs", true);
    expect(target.querySelector(".action-menu")).toBeNull();

    openMenu(target);
    menuItem(target, "New graph here").click();
    expect(onSetAsScope).toHaveBeenCalledTimes(1);
  });

  test("Escape and a click outside close the menu", async () => {
    h.entries = [dir("docs")];
    const target = await render({ path: "docs" });

    openMenu(target);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    flushSync();
    expect(target.querySelector(".action-menu")).toBeNull();

    openMenu(target);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    flushSync();
    expect(target.querySelector(".action-menu")).toBeNull();
  });

  test("a directory's Open reveals it in a new File Browser tab unless the host reveals it", async () => {
    h.entries = [dir("docs")];
    const first = await render({ path: "docs" });
    pill(first).click();
    expect(revealPathInBrowser).toHaveBeenCalledWith("docs", {
      enter: true,
      inspectorOpen: true,
    });

    vi.clearAllMocks();
    const onReveal = vi.fn();
    const second = await render({ path: "docs", onReveal });
    pill(second).click();
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(revealPathInBrowser).not.toHaveBeenCalled();
  });

  test("an editable file opens through the host, and markdown exports to PDF", async () => {
    h.entries = [file("notes/plan.md")];
    const onOpen = vi.fn();
    const target = await render({ path: "notes/plan.md", onOpen });

    expect(pill(target).textContent?.trim()).toBe("Open");
    pill(target).click();
    expect(onOpen).toHaveBeenCalledTimes(1);

    expect(openMenu(target)).toEqual(["Download", "New terminal here", "Export to PDF"]);
    menuItem(target, "Export to PDF").click();
    expect(exportPathToPdf).toHaveBeenCalledWith("notes/plan.md");
  });

  test("with no Open the editor's details panel leads with Show in file browser", async () => {
    h.entries = [file("notes/plan.md")];
    const onReveal = vi.fn();
    const target = await render({ path: "notes/plan.md", surface: "file", onReveal });

    expect(pill(target).textContent?.trim()).toBe("Show in file browser");
    pill(target).click();
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  test("a host that opens and reveals offers the reveal behind the caret", async () => {
    h.entries = [file("notes/plan.md")];
    const onReveal = vi.fn();
    const target = await render({ path: "notes/plan.md", onOpen() {}, onReveal });

    expect(pill(target).textContent?.trim()).toBe("Open");
    expect(openMenu(target)[0]).toBe("Open in new file browser");
    menuItem(target, "Open in new file browser").click();
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  test("media leads with View whatever its kind, and opens through the shared media router", async () => {
    const paths = ["pics/cat.png", "clips/intro.mp4", "sound/theme.mp3", "papers/spec.pdf"];
    h.entries = paths.map((p) => file(p, "media"));
    for (const path of paths) {
      const target = await render({ path });
      expect(pill(target).textContent?.trim(), path).toBe("View");
      pill(target).click();
      expect(openMediaViewer).toHaveBeenLastCalledWith(path);
    }
  });

  test("the pill has no caret when there is nothing behind it", async () => {
    // A binary file with no graph host: download is the only action.
    h.entries = [file("bin/tool", "binary")];
    const target = await render({ path: "bin/tool" });

    expect(pill(target).textContent?.trim()).toBe("Download");
    expect(caret(target)).toBeNull();
    pill(target).click();
    expect(fileOps.downloadPathWithProgress).toHaveBeenCalledWith("bin/tool", false);
  });

  /// Every shape the classifier tells apart, on each host: a selection's
  /// inspector, which names the file browser's commands, and the editor's
  /// Details panel, which names the editor's.
  const SHAPES: Array<{ entry: Entry; props: Omit<Props, "path"> }> = [
    { entry: file("a.md"), props: { onOpen() {}, onReveal() {}, onSetAsScope() {} } },
    { entry: file("src/main.rs", "text"), props: { onOpen() {} } },
    { entry: file("img/a.png", "media"), props: { onSetAsScope() {} } },
    { entry: file("blob.bin", "binary"), props: { onSetAsScope() {} } },
    { entry: dir("docs"), props: { onSetAsScope() {} } },
    { entry: file(".Drafts/idea/a.md"), props: {} },
    { entry: file("b.md"), props: { surface: "file", onReveal() {}, onSetAsScope() {} } },
    { entry: file("src/lib.rs", "text"), props: { surface: "file", onReveal() {} } },
    { entry: file("tool.bin", "binary"), props: { surface: "file", onReveal() {}, onSetAsScope() {} } },
  ];

  /// Renders each shape and returns, per path, the rows it shows and the
  /// classifier's actions for it, main first.
  async function renderedActions(): Promise<
    Array<{ path: string; surface: "file" | "browser"; rows: string[]; actions: FileActionId[] }>
  > {
    h.entries = SHAPES.map((s) => s.entry);
    const out = [];
    for (const { entry, props } of SHAPES) {
      // Applicability is the classifier's decision (the FileTree menu reads
      // the same one); the inspector maps each action to a command.
      const set = classifyFileActions(
        {
          path: entry.path,
          isDir: entry.is_dir,
          serverKind: entry.kind,
          isDraft: entry.path.startsWith(`${h.draftsDir}/`),
        },
        { open: !!props.onOpen, reveal: !!props.onReveal, graph: !!props.onSetAsScope, upload: true },
      );
      const target = await render({ path: entry.path, ...props });
      const rows = [pill(target).textContent?.trim() ?? "", ...(caret(target) ? openMenu(target) : [])];
      out.push({
        path: entry.path,
        surface: props.surface ?? ("browser" as const),
        rows,
        actions: [set.main, ...set.secondary],
      });
    }
    return out;
  }

  test("every action is worded by the title of a registered command, in the classifier's order", async () => {
    for (const { path, surface, rows, actions } of await renderedActions()) {
      const ids = surface === "file" ? EDITOR : BROWSER;
      expect(rows, path).toEqual(actions.map((action) => title(ids[action])));
    }
  });

  test("an action is the editor's command in its Details panel and the file browser's elsewhere", async () => {
    retitleCatalog();
    for (const { path, surface, rows, actions } of await renderedActions()) {
      const ids = surface === "file" ? EDITOR : BROWSER;
      expect(rows, path).toEqual(actions.map((action) => `<${ids[action]}>`));
    }
  });

  test("a directory's terminal action roots a terminal in it", async () => {
    h.entries = [dir("src/lib")];
    const target = await render({ path: "src/lib" });
    openMenu(target);
    menuItem(target, "New terminal here").click();

    expect(openTerminalInActivePane).toHaveBeenCalledWith(terminalFromHereTarget("src/lib", true));
  });

  test("a file's terminal action opens in its parent with the name seeded", async () => {
    h.entries = [file("src/it's here.rs", "text")];
    const target = await render({ path: "src/it's here.rs", onOpen() {} });
    openMenu(target);
    menuItem(target, "New terminal here").click();

    expect(openTerminalInActivePane).toHaveBeenCalledWith(
      terminalFromHereTarget("src/it's here.rs", false),
    );
  });

  test("a host terminal handler takes over the directory action", async () => {
    h.entries = [dir("src")];
    const onNewTerminal = vi.fn();
    const target = await render({ path: "src", onNewTerminal });
    openMenu(target);
    menuItem(target, "New terminal here").click();

    expect(onNewTerminal).toHaveBeenCalledTimes(1);
    expect(openTerminalInActivePane).not.toHaveBeenCalled();
  });

  test("a draft file leads with a terminal in its parent, seeded with its name", async () => {
    h.entries = [dir(".Drafts/idea"), file(".Drafts/idea/a b.md")];
    const onNewTerminal = vi.fn();
    const target = await render({ path: ".Drafts/idea/a b.md", onNewTerminal });

    expect(pill(target).textContent?.trim()).toBe("New terminal here");
    expect(caret(target)).toBeNull();
    pill(target).click();

    // The draft file skips the host override and seeds its own name.
    expect(onNewTerminal).not.toHaveBeenCalled();
    expect(openTerminalInActivePane).toHaveBeenCalledWith(
      terminalFromHereTarget(".Drafts/idea/a b.md", false),
    );
  });

  test("on the editor's Details panel a draft file also downloads, and exports to PDF as Markdown", async () => {
    h.entries = [dir(".Drafts/idea"), file(".Drafts/idea/a.md")];
    const target = await render({ path: ".Drafts/idea/a.md", surface: "file" });

    expect(pill(target).textContent?.trim()).toBe(title(EDITOR.newTerminal));
    expect(openMenu(target)).toEqual([title(EDITOR.download), title(EDITOR.exportPdf)]);
    menuItem(target, title(EDITOR.download)).click();
    flushSync();
    expect(fileOps.downloadPathWithProgress).toHaveBeenCalledExactlyOnceWith(".Drafts/idea/a.md", false);

    openMenu(target);
    menuItem(target, title(EDITOR.exportPdf)).click();
    expect(exportPathToPdf).toHaveBeenCalledExactlyOnceWith(".Drafts/idea/a.md");
  });

  // The editor hands its own two for the file it has open, a draft too: they
  // save the tab before they read the server's copy.
  test("a host's own Download and Export to PDF run in place of the path's", async () => {
    h.entries = [file("notes/plan.md"), file(".Drafts/idea/a.md")];
    for (const path of ["notes/plan.md", ".Drafts/idea/a.md"]) {
      const onDownload = vi.fn();
      const onExportPdf = vi.fn();
      const target = await render({ path, surface: "file", onReveal() {}, onDownload, onExportPdf });

      openMenu(target);
      menuItem(target, title(EDITOR.download)).click();
      flushSync();
      openMenu(target);
      menuItem(target, title(EDITOR.exportPdf)).click();

      expect([onDownload.mock.calls.length, onExportPdf.mock.calls.length], path).toEqual([1, 1]);
      unmount(mounted.pop()!);
    }
    expect(fileOps.downloadPathWithProgress).not.toHaveBeenCalled();
    expect(exportPathToPdf).not.toHaveBeenCalled();
  });

  test("a draft that is not Markdown downloads there and has nothing to export", async () => {
    h.entries = [file(".Drafts/board/board.excalidraw", "text")];
    const target = await render({ path: ".Drafts/board/board.excalidraw", surface: "file" });

    expect(openMenu(target)).toEqual([title(EDITOR.download)]);
  });

  test("a draft's words on the editor's panel are the editor's commands'", async () => {
    retitleCatalog();
    h.entries = [file(".Drafts/idea/a.md")];
    const target = await render({ path: ".Drafts/idea/a.md", surface: "file" });

    expect([pill(target).textContent?.trim(), ...openMenu(target)]).toEqual([
      "<app.editor.terminalFromHere>",
      "<app.editor.download>",
      "<app.editor.exportPdf>",
    ]);
  });

  test("a selection's inspector offers a draft file the terminal alone, as the file browser's menu does", async () => {
    h.entries = [file(".Drafts/idea/a.md")];
    const target = await render({ path: ".Drafts/idea/a.md", onOpen() {}, onReveal() {}, onSetAsScope() {} });

    expect(pill(target).textContent?.trim()).toBe(title(BROWSER.newTerminal));
    expect(caret(target)).toBeNull();
  });

  test("the drafts directory itself keeps the terminal alone on the editor's panel", async () => {
    h.entries = [dir(".Drafts"), dir(".Drafts/idea")];
    for (const path of [".Drafts", ".Drafts/idea"]) {
      const target = await render({ path, surface: "file" });
      expect(pill(target).textContent?.trim(), path).toBe(title(EDITOR.newTerminal));
      expect(caret(target), path).toBeNull();
      unmount(mounted.pop()!);
    }
  });

  test("a draft directory roots the terminal in itself", async () => {
    h.entries = [dir(".Drafts/idea")];
    const target = await render({ path: ".Drafts/idea" });

    expect(pill(target).textContent?.trim()).toBe("New terminal here");
    pill(target).click();
    expect(openTerminalInActivePane).toHaveBeenCalledWith(
      terminalFromHereTarget(".Drafts/idea", true),
    );
  });

  test("Upload raises the picker that uploads into the directory, as the file browser's Upload does", async () => {
    h.entries = [dir("docs")];
    const target = await render({ path: "docs" });

    openMenu(target);
    menuItem(target, "Upload").click();

    expect(raiseUploadPicker).toHaveBeenCalledExactlyOnceWith("docs");
    expect(raiseReplacePicker).not.toHaveBeenCalled();
  });

  test("the path toggle reveals the absolute path and resets on a new selection", async () => {
    h.entries = [file("notes/plan.md"), file("notes/other.md")];
    const props = $state<Props>({ path: "notes/plan.md", onOpen() {} });
    const target = await render(props);
    const toggle = target.querySelector<HTMLButtonElement>(".path-toggle")!;

    expect(target.querySelector(".path-row")).toBeNull();
    toggle.click();
    flushSync();
    expect(target.querySelector(".path-row")?.textContent).toBe("/home/me/ws/notes/plan.md");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    openMenu(target);
    props.path = "notes/other.md";
    await settle();
    expect(target.querySelector(".path-row"), "the path row resets").toBeNull();
    expect(target.querySelector(".action-menu"), "the menu resets").toBeNull();
  });

  test("the actions render once, above the stats, on both branches", async () => {
    h.entries = [dir("docs"), file("docs/a.md")];
    for (const path of ["docs", "docs/a.md"]) {
      const target = await render({ path, onOpen() {} });
      const sections = target.querySelectorAll(".actions-section");
      expect(sections, path).toHaveLength(1);
      const stats = target.querySelector(".info > .meta-grid");
      expect(stats, path).not.toBeNull();
      expect(
        sections[0]!.compareDocumentPosition(stats!) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${path}: actions precede the stats`,
      ).toBeTruthy();
      unmount(mounted.pop()!);
    }
  });
});

describe("the Drafts directory", () => {
  test("a draft directory carries the DRAFTS chip and the drafts notice", async () => {
    // A configured name, so the chip and the notice have to come from
    // draftsDir() rather than a spelled-out default.
    h.draftsDir = "Scratch";
    h.entries = [dir("Scratch/idea")];
    const target = await render({ path: "Scratch/idea" });

    const chip = target.querySelector(".head .drafts-chip");
    expect(chip?.textContent?.trim()).toBe("DRAFTS");
    expect(target.querySelector(".head .kind-chip:not(.drafts-chip)")).toBeNull();
    const notice = target.querySelector(".drafts-notice[role='note']");
    expect(notice?.querySelector("strong")?.textContent).toBe(
      "Drafts are uncommitted scratch space.",
    );
    expect(notice?.querySelector("code")?.textContent).toBe("Scratch/untitled-N/");
  });

  test("any other directory, one named Drafts included, is a plain folder", async () => {
    h.draftsDir = "Scratch";
    h.entries = [dir("Drafts"), dir("docs")];
    const onSetAsScope = vi.fn();
    for (const path of ["Drafts", "docs"]) {
      const target = await render({ path, onSetAsScope });
      expect(target.querySelector(".drafts-chip"), path).toBeNull();
      expect(target.querySelector(".drafts-notice"), path).toBeNull();
      const chip = target.querySelector<HTMLButtonElement>(".head button.kind-chip");
      expect(chip?.textContent?.trim(), path).toBe("directory");
      chip!.click();
    }
    expect(onSetAsScope, "the folder chip scopes the graph").toHaveBeenCalledTimes(2);
  });
});

describe("the audio preview", () => {
  test("plays inline through a tokenized source, on demand", async () => {
    h.entries = [file("sound/a b.mp3", "media")];
    const target = await render({ path: "sound/a b.mp3" });

    const audio = target.querySelector<HTMLAudioElement>(".audio-preview audio");
    expect(audio).not.toBeNull();
    expect(audio!.getAttribute("src")).toBe("/api/fs/sound/a%20b.mp3?token=inspector-test");
    expect(audio!.hasAttribute("controls")).toBe(true);
    expect(audio!.getAttribute("preload")).toBe("metadata");
    expect(audio!.hasAttribute("autoplay"), "never starts on its own").toBe(false);
    expect(target.querySelector("video, .image-preview"), "audio is not another media kind").toBeNull();
  });

  test("a decode error stays on the inline player and clears on load or a new selection", async () => {
    h.entries = [file("sound/a.ogg", "media"), file("sound/b.ogg", "media")];
    const props = $state<Props>({ path: "sound/a.ogg" });
    const target = await render(props);
    const status = () => target.querySelector(".audio-preview [role='status']");

    target.querySelector("audio")!.dispatchEvent(new Event("error"));
    flushSync();
    expect(status()?.textContent).toBe(AUDIO_UNSUPPORTED_MESSAGE);

    target.querySelector("audio")!.dispatchEvent(new Event("loadedmetadata"));
    flushSync();
    expect(status()).toBeNull();

    target.querySelector("audio")!.dispatchEvent(new Event("error"));
    flushSync();
    expect(status()).not.toBeNull();
    props.path = "sound/b.ogg";
    await settle();
    expect(status(), "a new selection starts clean").toBeNull();
  });
});

describe("language and contact links open the graph", () => {
  const fileStats: ReportFileStats = {
    path: "src/main.rs",
    language: "Rust",
    code: 120,
    comments: 10,
    blanks: 5,
    complexity: 7,
    bytes: 4096,
  };
  const prefix: ReportPrefix = {
    totals: { files: 3, code: 300, comments: 20, blanks: 10, complexity: 9 },
    by_language: [
      { name: "Rust", files: 2, code: 250, comments: 15, blanks: 8, complexity: 7 },
      { name: "TOML", files: 1, code: 50, comments: 5, blanks: 2, complexity: 2 },
    ],
    cocomo: {
      model: "organic",
      effort_person_months: 1.2,
      schedule_months: 2.3,
      developers: 0.5,
      estimated_cost_usd: 1000,
    },
  };

  test("a file's language opens the graph on that language", async () => {
    h.fileReport = fileStats;
    h.entries = [file("src/main.rs", "text")];
    const target = await render({ path: "src/main.rs" });

    const link = target.querySelector<HTMLButtonElement>("button.lang-link");
    expect(link?.textContent).toBe("Rust");
    expect(link?.title).toBe("open in graph");
    link!.click();
    expect(openGraphForLanguage).toHaveBeenCalledWith("Rust");
  });

  test("each language row of a directory opens the graph on it", async () => {
    h.prefixReport = prefix;
    h.entries = [dir("src"), file("src/main.rs", "text")];
    const target = await render({ path: "src" });

    const names = [...target.querySelectorAll<HTMLButtonElement>("button.lang-name")];
    expect(names.map((b) => b.textContent)).toEqual(["Rust", "TOML"]);
    expect(names.every((b) => b.title === "open in graph")).toBe(true);
    names[1]!.click();
    expect(openGraphForLanguage).toHaveBeenCalledWith("TOML");
  });

  function mentionView(): GraphView {
    const view: GraphView = {
      nodes: [
        { kind: "file", id: "f:notes/a.md", label: "a.md", path: "notes/a.md" },
        { kind: "file", id: "f:Contacts/alice.md", label: "Alice", path: "Contacts/alice.md" },
      ],
      edges: [{ source: "f:notes/a.md", target: "f:Contacts/alice.md", kind: "mention" }],
    };
    return view;
  }

  test("a resolved contact opens the contact lens when the host binds nothing", async () => {
    graphData.view = mentionView();
    h.entries = [file("notes/a.md"), file("Contacts/alice.md", "contact")];
    const target = await render({ path: "notes/a.md", showRefs: true });

    const pill = target.querySelector<HTMLButtonElement>("button.ref.contact");
    expect(pill?.textContent).toBe("Alice");
    pill!.click();
    expect(openGraphForContact).toHaveBeenCalledWith("Contacts/alice.md");
  });

  test("a host contact handler takes the click instead", async () => {
    graphData.view = mentionView();
    h.entries = [file("notes/a.md"), file("Contacts/alice.md", "contact")];
    const onContactNavigate = vi.fn();
    const target = await render({ path: "notes/a.md", showRefs: true, onContactNavigate });

    target.querySelector<HTMLButtonElement>("button.ref.contact")!.click();
    expect(onContactNavigate).toHaveBeenCalledWith("Contacts/alice.md");
    expect(openGraphForContact).not.toHaveBeenCalled();
  });
});

describe("the report behind the inspector", () => {
  const prefix: ReportPrefix = {
    totals: { files: 1, code: 10, comments: 0, blanks: 0, complexity: 1 },
    by_language: [{ name: "Rust", files: 1, code: 10, comments: 0, blanks: 0, complexity: 1 }],
    cocomo: {
      model: "organic",
      effort_person_months: 0.1,
      schedule_months: 0.2,
      developers: 0.1,
      estimated_cost_usd: 10,
    },
  };

  test("a directory prefers the report cache and falls back to the walk on report_not_found", async () => {
    h.entries = [dir("src"), file("src/main.rs", "text")];
    vi.mocked(api.reportDir).mockRejectedValueOnce(new ApiError(404, "directory report not found", {
      error: "directory report not found", code: "report_not_found",
    }));
    vi.mocked(api.reportPrefix).mockResolvedValueOnce(prefix);
    const target = await render({ path: "src" });

    expect(api.reportDir).toHaveBeenCalledWith("src");
    expect(api.reportPrefix).toHaveBeenCalledWith("src");
    expect(target.querySelector("button.lang-name")?.textContent).toBe("Rust");
  });

  test("falls back on report_not_found through the real transport", async () => {
    const real = await vi.importActual<typeof import("../api/client")>("../api/client");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ error: "The cached directory report is unavailable.", code: "report_not_found" }),
      { status: 404, headers: { "content-type": "application/json" } },
    ));
    h.entries = [dir("src"), file("src/main.rs", "text")];
    vi.mocked(api.reportDir).mockImplementationOnce(real.api.reportDir);
    vi.mocked(api.reportPrefix).mockResolvedValueOnce(prefix);
    try {
      const target = await render({ path: "src" });
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/report/dir?path=src"),
        expect.objectContaining({ method: "GET" }));
      expect(api.reportPrefix).toHaveBeenCalledWith("src");
      expect(target.querySelector("button.lang-name")?.textContent).toBe("Rust");
    } finally {
      fetch.mockRestore();
    }
  });

  test.each([
    ["a plain Error", new Error("404 not found")],
    ["an ApiError without a code", new ApiError(404, "404 not found")],
    ["another code", new ApiError(404, "404 not found", { code: "other" })],
    ["another status", new ApiError(500, "404 not found", { code: "report_not_found" })],
  ])("shows the refusal without a walk for %s", async (_reason, error) => {
    h.entries = [dir("src"), file("src/main.rs", "text")];
    vi.mocked(api.reportDir).mockRejectedValueOnce(error);
    const target = await render({ path: "src" });
    expect(target.querySelector(".refs-error")?.textContent).toBe("report unavailable: 404 not found");
    expect(api.reportPrefix).not.toHaveBeenCalled();
  });

  test("without a workspace behind the window, nothing is requested and no report state shows", async () => {
    h.caps.workspace = false;
    h.prefixReport = prefix;
    h.entries = [dir("src"), file("src/main.rs", "text")];
    for (const path of ["src", "src/main.rs"]) {
      const target = await render({ path });
      expect(target.textContent, path).not.toContain("loading report");
      expect(target.querySelector(".refs-error"), path).toBeNull();
      expect(target.querySelector(".lang-name, .lang-link"), path).toBeNull();
    }
    expect(api.inspector).not.toHaveBeenCalled();
    expect(api.reportDir).not.toHaveBeenCalled();
    expect(api.reportPrefix).not.toHaveBeenCalled();
    expect(api.reportFileStream).not.toHaveBeenCalled();
  });

  test("standalone Details with references requested shows file facts without index requests", async () => {
    h.caps.workspace = false;
    h.entries = [file("notes/a.md")];
    const target = await render({ path: "notes/a.md", showRefs: true });

    expect(target.textContent).toContain("size");
    expect(target.textContent).toContain("modified");
    expect(target.textContent).not.toContain("backlinks");
    expect(api.inspector).not.toHaveBeenCalled();
    expect(api.reportFileStream).not.toHaveBeenCalled();
    expect(api.graphStream).not.toHaveBeenCalled();
    expect(api.backlinksStream).not.toHaveBeenCalled();
  });
});

/// A graph stream that fails on a later timer turn, every time it is asked.
function failingStream(): Promise<GraphView> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("stream down")), 0));
}

describe("the shared graph load", () => {
  // Unmount first: a body still mounted would answer the invalidation with a
  // load of its own, which the next test would then share.
  afterEach(() => {
    for (const app of mounted.splice(0)) unmount(app);
    invalidateGraph();
  });

  test("a first load says the references are loading until its stream completes", async () => {
    const a = { kind: "file", id: "f:notes/a.md", label: "a.md", path: "notes/a.md" } as const;
    const alice = { kind: "file", id: "f:Contacts/alice.md", label: "Alice", path: "Contacts/alice.md" } as const;
    const whole: GraphView = {
      nodes: [a, alice],
      edges: [{ source: a.id, target: alice.id, kind: "mention" }],
    } as unknown as GraphView;
    let finish!: (view: GraphView) => void;
    vi.mocked(api.graphStream).mockImplementation(async (_scope, opts) => {
      // The first batch holds the nodes; the edges are still to come.
      opts?.onNodes?.(whole.nodes, { nodes: whole.nodes, edges: [] });
      return new Promise<GraphView>((resolve) => {
        finish = resolve;
      });
    });
    h.entries = [file("notes/a.md"), file("Contacts/alice.md", "contact")];
    const target = await render({ path: "notes/a.md", showRefs: true });

    expect(target.textContent).toContain("loading references...");
    expect(target.querySelector("button.ref.contact")).toBeNull();

    finish(whole);
    await settle();
    expect(target.textContent).not.toContain("loading references...");
    expect(target.querySelector("button.ref.contact")?.textContent).toBe("Alice");
  });

  test("a gated graph shows pending counts while references rebuild", async () => {
    graphData.view = { nodes: [], edges: [] };
    graphData.gated = true;
    h.entries = [file("notes/a.md")];
    const target = await render({ path: "notes/a.md", showRefs: true });

    const tags = [...target.querySelectorAll(".meta-grid .k")].find((row) => row.textContent === "tags");
    expect(tags?.nextElementSibling?.textContent).toBe("...");
    expect(target.textContent).toContain("rebuilding references...");
  });

  test("directory relists retain streams while edits and selection changes refresh reports", async () => {
    const a = file("notes/a.md");
    h.entries = [a];
    vi.mocked(api.graphStream).mockResolvedValue({ nodes: [], edges: [] });
    const props = $state({ path: "notes/a.md", showRefs: true });
    await render(props);
    expect(api.reportFileStream).toHaveBeenCalledTimes(1);
    expect(api.backlinksStream).toHaveBeenCalledTimes(1);
    const reportSignal = vi.mocked(api.reportFileStream).mock.calls[0]![1]!.signal!;
    const backlinksSignal = vi.mocked(api.backlinksStream).mock.calls[0]![1]!.signal!;

    h.entries = [{ ...a }, file("notes/b.md")];
    await settle();
    expect(api.reportFileStream, "an unchanged entry keeps its report").toHaveBeenCalledTimes(1);
    expect(api.backlinksStream, "an unchanged entry keeps its backlinks").toHaveBeenCalledTimes(1);
    expect(reportSignal.aborted).toBe(false);
    expect(backlinksSignal.aborted).toBe(false);

    h.entries = [{ ...a, mtime: a.mtime! + 1 }, file("notes/b.md")];
    await settle();
    expect(api.reportFileStream, "an outside edit refreshes the file report").toHaveBeenCalledTimes(2);
    expect(reportSignal.aborted).toBe(true);
    expect(api.backlinksStream).toHaveBeenCalledTimes(1);
    expect(backlinksSignal.aborted).toBe(false);

    props.path = "notes/b.md";
    await settle();
    expect(api.reportFileStream).toHaveBeenCalledTimes(3);
    expect(api.reportFileStream).toHaveBeenLastCalledWith("notes/b.md", expect.any(Object));
    expect(api.backlinksStream).toHaveBeenCalledTimes(2);
    expect(backlinksSignal.aborted).toBe(true);

    h.entries = [dir("notes/b.md")];
    await settle();
    expect(api.reportDir).toHaveBeenLastCalledWith("notes/b.md");
    props.path = "";
    await settle();
    expect(api.reportDir).toHaveBeenLastCalledWith("");
  });

  test("a graph stream that keeps failing is started once while the file is shown", async () => {
    h.entries = [file("notes/a.md")];
    vi.mocked(api.graphStream).mockImplementation(failingStream);
    const target = await render({ path: "notes/a.md", showRefs: true });
    await settle();
    expect(api.graphStream).toHaveBeenCalledTimes(1);
    expect(target.textContent).toContain("references unavailable: stream down");
  });

  test("a graph that streams in batches starts the file's backlinks once", async () => {
    h.entries = [file("notes/a.md")];
    const node = { kind: "file", id: "notes/a.md", label: "a.md", path: "notes/a.md" } as const;
    vi.mocked(api.graphStream).mockImplementation(async (_scope, opts = {}) => {
      for (let batch = 0; batch < 3; batch += 1) {
        await new Promise((r) => setTimeout(r, 0));
        opts.onNodes?.([node], { nodes: [node], edges: [] });
      }
      return { nodes: [node], edges: [] };
    });
    await render({ path: "notes/a.md", showRefs: true });
    await settle();
    expect(api.graphStream).toHaveBeenCalledTimes(1);
    expect(api.backlinksStream).toHaveBeenCalledTimes(1);
  });

  test("an invalidated graph loads again while the file is shown", async () => {
    // A watcher event invalidates the graph; with no browser or graph tab open
    // nothing else reloads it for this inspector.
    h.entries = [file("notes/a.md")];
    vi.mocked(api.graphStream).mockResolvedValue({ nodes: [], edges: [] });
    await render({ path: "notes/a.md", showRefs: true });
    expect(api.graphStream).toHaveBeenCalledTimes(1);
    invalidateGraph();
    await settle();
    expect(api.graphStream).toHaveBeenCalledTimes(2);
  });
});

describe("a name that holds a backslash", () => {
  function title(target: HTMLElement): string {
    return target.querySelector("h3.title")?.textContent?.trim() ?? "";
  }

  test("titles a file by its whole name", async () => {
    h.entries = [file("a\\b.md"), file("dir/a\\b.md")];

    expect(title(await render({ path: "a\\b.md" }))).toBe("a\\b.md");
    expect(title(await render({ path: "dir/a\\b.md" }))).toBe("a\\b.md");
  });

  test("titles a folder by its whole name", async () => {
    h.entries = [dir("x\\y"), dir("dir/x\\y")];

    expect(title(await render({ path: "x\\y" }))).toBe("x\\y");
    expect(title(await render({ path: "dir/x\\y" }))).toBe("x\\y");
  });

  test("gives an image's preview its whole name", async () => {
    h.entries = [file("dir/a\\p.png", "media")];

    const target = await render({ path: "dir/a\\p.png" });
    expect(target.querySelector(".image-preview img")?.getAttribute("alt")).toBe("a\\p.png");
  });
});

// A selected path that is not in the loaded listing yet has an entry on its
// way, or one its folder could not list. Neither is an empty selection.
describe("a selected path with no entry yet", () => {
  afterEach(() => {
    delete (tree.dirErrors as Record<string, string>).notes;
  });

  test("says it is loading, not that nothing is selected", async () => {
    const target = await render({ path: "notes/a.md" });
    expect(target.textContent).not.toContain("click a file or directory to inspect");
    expect(target.querySelector(".empty-hint")?.textContent).toBe("Loading...");
  });

  test("gives the folder's listing error when it could not be listed", async () => {
    (tree.dirErrors as Record<string, string>).notes = "permission denied";
    const target = await render({ path: "notes/a.md" });
    expect(target.querySelector(".empty-hint")?.textContent).toBe("cannot list notes: permission denied");
  });
});
