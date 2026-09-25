// @vitest-environment jsdom
//
// FileInfoBody, mounted. The inspector reads its entry from the tree store and
// its reports from the api client; both are stubbed here so each test hands the
// component one entry and reads what it renders and what it calls.

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import FileInfoBody from "./FileInfoBody.svelte";
import fileInfoSource from "./FileInfoBody.svelte?raw";
import { classifyFileActions } from "../state/fileActions";
import { terminalFromHereTarget } from "../terminal/fromHere";
import type { TreeEntry } from "../api/types";

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
}));

vi.mock("../state/windowCaps", () => ({ windowCaps: h.caps }));

vi.mock("../api/client", () => ({
  api: {
    inspector: vi.fn(async () => null),
    reportDir: vi.fn(async () => null),
    reportPrefix: vi.fn(async () => null),
    reportFileStream: vi.fn(async () => null),
    graphStream: vi.fn(async () => null),
    backlinksStream: vi.fn(async () => {}),
  },
  withTokenQuery: (u: string) => `${u}?token=inspector-test`,
}));

vi.mock("../state/store.svelte", () => ({
  copyTextToClipboard: vi.fn(async () => {}),
  draftsDir: () => h.draftsDir,
  isDraftPath: (p: string) => p === h.draftsDir || p.startsWith(`${h.draftsDir}/`),
  setTransientStatus: vi.fn(),
  ui: { status: "", statusKind: "transient" },
  workspace: { info: { root: "/home/me/ws/", label: "ws" } },
  fileOps: {
    downloadPathWithProgress: vi.fn(),
    uploadFilesTo: vi.fn(async () => {}),
    replaceFileAt: vi.fn(async () => {}),
  },
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

vi.mock("../state/tabs.svelte", () => ({ openTerminalInActivePane: vi.fn() }));
vi.mock("../state/mediaOpen", () => ({
  openMediaViewer: vi.fn(() => true),
  dirImageSet: () => [],
}));
vi.mock("../state/imageZoom", () => ({ openImageZoom: vi.fn() }));
vi.mock("../state/videoViewer", () => ({ openVideoViewer: vi.fn() }));
vi.mock("../state/fileActionExecutors", () => ({ exportPathToPdf: vi.fn(async () => {}) }));

import { fileOps, revealPathInBrowser } from "../state/store.svelte";
import { openTerminalInActivePane } from "../state/tabs.svelte";
import { openMediaViewer } from "../state/mediaOpen";
import { exportPathToPdf } from "../state/fileActionExecutors";

type Props = {
  path: string | null;
  onOpen?: () => void;
  onReveal?: () => void;
  onSetAsScope?: () => void;
  onNewTerminal?: () => void;
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

beforeEach(() => {
  h.entries = [];
  h.caps.workspace = true;
  h.draftsDir = ".Drafts";
});

afterEach(() => {
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("the actions section", () => {
  test("a directory offers Open with upload, download, terminal and graph behind the caret", async () => {
    h.entries = [dir("docs"), file("docs/a.md")];
    const onSetAsScope = vi.fn();
    const target = await render({ path: "docs", onSetAsScope });

    expect(pill(target).textContent?.trim()).toBe("Open");
    expect(target.querySelector(".action-menu"), "the menu starts closed").toBeNull();
    expect(openMenu(target)).toEqual([
      "Upload file here",
      "Download tarball",
      "New terminal here",
      "Graph from here",
    ]);
    expect(caret(target)?.getAttribute("aria-expanded")).toBe("true");
  });

  test("picking a menu item runs it and closes the menu", async () => {
    h.entries = [dir("docs")];
    const onSetAsScope = vi.fn();
    const target = await render({ path: "docs", onSetAsScope });

    openMenu(target);
    menuItem(target, "Download tarball").click();
    flushSync();

    expect(fileOps.downloadPathWithProgress).toHaveBeenCalledWith("docs", true);
    expect(target.querySelector(".action-menu")).toBeNull();

    openMenu(target);
    menuItem(target, "Graph from here").click();
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

    expect(openMenu(target)).toEqual(["Download file", "New terminal here", "Export to PDF"]);
    menuItem(target, "Export to PDF").click();
    expect(exportPathToPdf).toHaveBeenCalledWith("notes/plan.md");
  });

  test("with no Open the editor's details panel leads with Show file", async () => {
    h.entries = [file("notes/plan.md")];
    const onReveal = vi.fn();
    const target = await render({ path: "notes/plan.md", onReveal });

    expect(pill(target).textContent?.trim()).toBe("Show file");
    pill(target).click();
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  test("media keeps a per-kind label and opens through the shared media router", async () => {
    const cases: Array<[string, string]> = [
      ["pics/cat.png", "View / Zoom"],
      ["clips/intro.mp4", "View Video"],
      ["sound/theme.mp3", "View Audio"],
      ["papers/spec.pdf", "View PDF"],
    ];
    h.entries = cases.map(([p]) => file(p, "media"));
    for (const [path, label] of cases) {
      const target = await render({ path });
      expect(pill(target).textContent?.trim(), path).toBe(label);
      pill(target).click();
      expect(openMediaViewer).toHaveBeenLastCalledWith(path);
    }
  });

  test("the pill has no caret when there is nothing behind it", async () => {
    // A binary file with no graph host: download is the only action.
    h.entries = [file("bin/tool", "binary")];
    const target = await render({ path: "bin/tool" });

    expect(pill(target).textContent?.trim()).toBe("Download file");
    expect(caret(target)).toBeNull();
    pill(target).click();
    expect(fileOps.downloadPathWithProgress).toHaveBeenCalledWith("bin/tool", false);
  });

  test("the rendered actions are the shared classifier's, in its order", async () => {
    // Applicability is the classifier's decision (the FileTree menu reads the
    // same one); the inspector maps ids to labels. Render each shape and
    // compare against the classifier directly.
    const label: Record<string, string> = {
      open: "Open",
      showFile: "Show file",
      download: "Download file",
      upload: "Upload file here",
      newTerminal: "New terminal here",
      exportPdf: "Export to PDF",
      graphFromHere: "Graph from here",
      viewMedia: "View / Zoom",
    };
    const shapes: Array<{ entry: Entry; props: Omit<Props, "path"> }> = [
      { entry: file("a.md"), props: { onOpen() {}, onReveal() {}, onSetAsScope() {} } },
      { entry: file("src/main.rs", "text"), props: { onOpen() {} } },
      { entry: file("img/a.png", "media"), props: { onSetAsScope() {} } },
      { entry: file("blob.bin", "binary"), props: { onSetAsScope() {} } },
    ];
    h.entries = shapes.map((s) => s.entry);
    for (const { entry, props } of shapes) {
      const set = classifyFileActions(
        { path: entry.path, isDir: false, serverKind: entry.kind, isDraft: false },
        { open: !!props.onOpen, reveal: !!props.onReveal, graph: !!props.onSetAsScope, upload: true },
      );
      const target = await render({ path: entry.path, ...props });
      expect(pill(target).textContent?.trim(), entry.path).toBe(label[set.main]);
      const rendered = set.secondary.length > 0 ? openMenu(target) : [];
      expect(rendered, entry.path).toEqual(set.secondary.map((id) => label[id]));
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

    expect(pill(target).textContent?.trim()).toBe("Terminal from here");
    expect(caret(target)).toBeNull();
    pill(target).click();

    // The draft file skips the host override and seeds its own name.
    expect(onNewTerminal).not.toHaveBeenCalled();
    expect(openTerminalInActivePane).toHaveBeenCalledWith(
      terminalFromHereTarget(".Drafts/idea/a b.md", false),
    );
  });

  test("a draft directory roots the terminal in itself", async () => {
    h.entries = [dir(".Drafts/idea")];
    const target = await render({ path: ".Drafts/idea" });

    expect(pill(target).textContent?.trim()).toBe("Terminal from here");
    pill(target).click();
    expect(openTerminalInActivePane).toHaveBeenCalledWith(
      terminalFromHereTarget(".Drafts/idea", true),
    );
  });

  test("Upload opens the picker and sends the picked files to the directory", async () => {
    h.entries = [dir("docs")];
    const target = await render({ path: "docs" });
    const picker = target.querySelector<HTMLInputElement>("input.file-picker")!;
    const pick = vi.spyOn(picker, "click").mockImplementation(() => {});

    openMenu(target);
    menuItem(target, "Upload file here").click();
    expect(pick).toHaveBeenCalledTimes(1);

    const picked = [new File(["x"], "x.txt")];
    Object.defineProperty(picker, "files", { configurable: true, value: picked });
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(fileOps.uploadFilesTo).toHaveBeenCalledWith("docs", picked);
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

  test("the chip and the notice paint with the drafts palette tokens", () => {
    // Build-time contract: the Drafts tint comes from the shared palette
    // tokens. vitest drops component CSS, so the stylesheet is read as text.
    expect(styleRule(".kind-chip.drafts-chip")).toContain("background: var(--fb-drafts-fg);");
    const notice = styleRule(".drafts-notice");
    expect(notice).toContain("background: var(--fb-drafts-bg);");
    expect(notice).toContain("border-left: 3px solid var(--fb-drafts-fg);");
  });
});

/// The body of one rule in the component's stylesheet.
function styleRule(selector: string): string {
  const css = fileInfoSource.slice(fileInfoSource.indexOf("<style>"));
  const at = css.indexOf(`\n  ${selector} {`);
  expect(at, `${selector} has a rule`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
}
