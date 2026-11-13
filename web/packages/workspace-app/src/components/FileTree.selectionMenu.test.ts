// @vitest-environment jsdom
//
// The Files tree's right-click menu. It opens with a "From selection" label;
// a folder's menu then offers "New file or directory", one row that makes
// either. The entry's actions follow (the same set the inspector offers):
// Open, which opens a file in an editor, Open in new file browser, which
// opens a folder in a new Files tab with its inspector open, New terminal
// here and New graph here with their chords, and the transfer and viewer
// rows, and for a document Export to PDF, which renders it and downloads the
// PDF. After a separator come the clipboard rows and the marking toggle, then
// the tree's own Copy path, Rename or move and Delete, which asks before it
// deletes, and at the foot a Flip pane row in a Files tab and the launcher's
// row. A docked tree offers the same rows, without Flip pane.
//
// The menu types no action's words itself: each row is held to the title of
// the catalog command that does the same for the selection, to the shortcut
// table's label for the launcher, or to a named exemption. The commands the
// rows are worded from are offered for a selection when the menu offers the
// row for it, and a row runs for its entry what its command runs for the
// selection.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());

// The PDF engine and the browser download stand in; the export between them
// runs for real.
const PDF = vi.hoisted(() => new Uint8Array([37, 80, 68, 70]));
vi.mock("../editor/pdf_export", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../editor/pdf_export")>()),
  exportMarkdownToPdf: vi.fn(async () => PDF),
}));
vi.mock("../api/download", () => ({ downloadBytes: vi.fn() }));

import { api } from "../api/client";
import { downloadBytes } from "../api/download";
import { exportMarkdownToPdf } from "../editor/pdf_export";
import { demoData, mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { resetLayout } from "../__tests__/tabs";
import {
  commandById,
  commandContext,
  commandState,
  commandUnavailableReason,
  type Command,
} from "../state/commands";
import { chordFor, SHORTCUTS } from "../state/shortcuts";
import {
  browserSidePanes,
  closeCommandLauncher,
  fbSelectSingle,
  launcherPanel,
  ui,
} from "../state/store.svelte";
import { layout, openBrowserInActivePane, type LeafNode, type Tab } from "../state/tabs.svelte";

stubAppEnvironment();

beforeEach(async () => {
  await mountApp(
    demoData([
      { path: "a.md", kind: "document", size: 5, mtime: 100, content: "hello" },
      { path: "clip.mp4", kind: "binary", size: 10, mtime: 100 },
      { path: "docs/sub/b.md", kind: "document", size: 5, mtime: 100, content: "hello" },
    ]),
  );
  resetLayout([]);
  openBrowserInActivePane();
  await settle();
  await vi.waitFor(() => expect(row("a.md")).toBeDefined());
});

afterEach(async () => {
  // The viewer's own Close also takes its Escape listener off the document.
  document.querySelectorAll<HTMLButtonElement>(".md-video-viewer button").forEach((close) => close.click());
  browserSidePanes.left = false;
  await unmountApp();
});

function row(path: string, scope: ParentNode = document): HTMLElement | undefined {
  return [...scope.querySelectorAll<HTMLElement>('[role="treeitem"], [role="option"]')].find((el) => {
    const title = el.title.replace(/ \(.*\)$/, "");
    return title === path || title.endsWith(`/${path}`);
  });
}

async function menuFor(path: string, scope: ParentNode = document): Promise<HTMLElement> {
  row(path, scope)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  await settle();
  return document.querySelector<HTMLElement>(".ctx")!;
}

/// The menu read top to bottom: the label, each row's label, and "---" for
/// a separator.
function lines(menu: HTMLElement): string[] {
  return [...menu.children].map((child) => {
    if (child.classList.contains("ctx-sep")) return "---";
    if (child.classList.contains("from-selection-label")) return child.textContent!.trim();
    return (child.querySelector(".menu-row-label") ?? child.querySelector("span"))!.textContent!.trim();
  });
}

function item(menu: HTMLElement, label: string): HTMLButtonElement {
  return [...menu.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => (button.querySelector(".menu-row-label") ?? button.querySelector("span"))?.textContent?.trim() === label,
  )!;
}

function chord(menu: HTMLElement, label: string): string {
  return item(menu, label).querySelector(".menu-row-chord")?.textContent ?? "";
}

function tabs(): Tab[] {
  return (layout.nodes[layout.activePaneId] as LeafNode).tabs;
}

function command(id: string): Command {
  const found = commandById(id);
  if (!found) throw new Error(`no catalog command ${id}`);
  return found;
}

/// Where a menu row takes its words: the title of a catalog command, the
/// shortcut table's label for a chord the catalog does not list, or words of
/// its own with the reason it has them.
type Words = { command: string } | { shortcut: string } | { own: string; because: string };

function wordsOf(source: Words | "---"): string {
  if (source === "---") return source;
  if ("command" in source) return command(source.command).title;
  if ("shortcut" in source) {
    const shortcut = SHORTCUTS.find((candidate) => candidate.id === source.shortcut);
    if (!shortcut) throw new Error(`no shortcut ${source.shortcut}`);
    return shortcut.label;
  }
  return source.own;
}

const HEADING: Words = { own: "From selection", because: "a heading over the rows, not an action" };
/// The rows every entry's menu ends with in a Files tab.
const TAIL: (Words | "---")[] = [
  "---",
  { command: "app.browser.copySelection" },
  { command: "app.browser.cutSelection" },
  { command: "app.browser.pasteSelection" },
  { command: "app.browser.selectMultiple" },
  "---",
  { command: "app.browser.copyPath" },
  { command: "app.browser.renameSelection" },
  { command: "app.browser.deleteSelection" },
  "---",
  { command: "app.pane.flip" },
  { shortcut: "app.launcher.toggle" },
];

describe("a folder's menu", () => {
  test("reads From selection, New file or directory, its actions, then the tree's own rows, Flip pane and the launcher", async () => {
    const menu = lines(await menuFor("docs"));

    expect(menu).toEqual([
      "From selection", "New file or directory", "Open in new file browser", "Upload", "Download",
      "New terminal here", "New graph here",
      "---", "Copy", "Cut", "Paste", "Select multiple",
      "---", "Copy path", "Rename or move", "Delete",
      "---", "Flip pane", "Command launcher",
    ]);
  });

  test("Open in new file browser opens a Files tab on the folder with its inspector open", async () => {
    item(await menuFor("docs"), "Open in new file browser").click();
    await settle();

    expect(tabs().at(-1)).toMatchObject({ kind: "browser", directory: "docs", inspectorOpen: true });
  });

  test("New terminal here opens a terminal in the folder, under the new-terminal chord", async () => {
    const menu = await menuFor("docs");
    expect(chord(menu, "New terminal here")).toBe(chordFor("app.terminal.toggle") ?? "");

    item(menu, "New terminal here").click();
    await settle();

    expect(tabs().at(-1)).toMatchObject({ kind: "terminal", cwd: "docs" });
  });

  test("New graph here opens a graph, under the graph chord", async () => {
    const menu = await menuFor("docs");
    expect(chord(menu, "New graph here")).toBe(chordFor("app.graph.toggle") ?? "");

    item(menu, "New graph here").click();
    await settle();

    expect(tabs().at(-1)?.kind).toBe("graph");
  });
});

describe("the menu's words", () => {
  test("every row of a folder's menu is a command's title, the launcher's shortcut label or a named exemption", async () => {
    expect(lines(await menuFor("docs"))).toEqual(
      [
        HEADING,
        { command: "app.browser.newFsEntry" },
        { command: "app.browser.openInBrowser" },
        { command: "app.browser.uploadSelection" },
        { command: "app.browser.downloadSelection" },
        { command: "app.browser.newTerminal" },
        { command: "app.browser.newGraph" },
        ...TAIL,
      ].map(wordsOf),
    );
  });

  test("every row of a document's menu is held the same way", async () => {
    expect(lines(await menuFor("a.md"))).toEqual(
      [
        HEADING,
        { command: "app.browser.open" },
        { command: "app.browser.openInBrowser" },
        { command: "app.browser.downloadSelection" },
        { command: "app.browser.newTerminal" },
        { command: "app.browser.exportPdf" },
        { command: "app.browser.newGraph" },
        { command: "app.browser.uploadSelection" },
        ...TAIL,
      ].map(wordsOf),
    );
  });

  test("every row of a media file's menu is held the same way, with one View for every kind", async () => {
    expect(lines(await menuFor("clip.mp4"))).toEqual(
      [
        HEADING,
        { command: "app.browser.viewMedia" },
        { command: "app.browser.downloadSelection" },
        { command: "app.browser.newTerminal" },
        { command: "app.browser.newGraph" },
        { command: "app.browser.uploadSelection" },
        ...TAIL,
      ].map(wordsOf),
    );
  });
});

describe("a file's menu", () => {
  test("has no New file or directory row", async () => {
    expect(lines(await menuFor("a.md"))).not.toContain("New file or directory");
  });

  test("Open opens the file in an editor", async () => {
    item(await menuFor("a.md"), "Open").click();

    await vi.waitFor(() => expect(tabs().at(-1)).toMatchObject({ kind: "file", path: "a.md" }));
  });

  test("Open in new file browser opens a Files tab on the file's folder with the file selected", async () => {
    item(await menuFor("a.md"), "Open in new file browser").click();
    await settle();

    expect(tabs().at(-1)).toMatchObject({ kind: "browser", directory: "", selected: "a.md", inspectorOpen: true });
    expect(document.querySelector(".ctx")).toBeNull();
  });

  test("View opens a video in its viewer", async () => {
    item(await menuFor("clip.mp4"), "View").click();
    await settle();

    expect(document.querySelector(".md-video-viewer")).not.toBeNull();
  });

  test("Export to PDF renders the document and downloads the PDF", async () => {
    item(await menuFor("a.md"), "Export to PDF").click();

    await vi.waitFor(() => expect(downloadBytes).toHaveBeenCalledWith(PDF, "a.pdf", "application/pdf"));
    expect(exportMarkdownToPdf).toHaveBeenCalledWith(expect.objectContaining({ path: "a.md", markdown: "hello" }));
    expect(document.querySelector(".ctx")).toBeNull();
  });

  test("Delete shows its chord and deletes only after a destructive confirm", async () => {
    const menu = await menuFor("a.md");
    expect(chord(menu, "Delete")).toBe("Delete");

    item(menu, "Delete").click();
    await settle();
    await expect(api.read("a.md")).resolves.toBeDefined();
    const confirm = document.querySelector<HTMLButtonElement>(".actions button.ok")!;
    expect(confirm.classList.contains("destructive")).toBe(true);
    confirm.click();

    await vi.waitFor(() => expect(api.read("a.md")).rejects.toThrow());
  });

  test("Flip pane flips the pane, under the flip chord", async () => {
    const menu = await menuFor("a.md");
    expect(chord(menu, "Flip pane")).toBe(chordFor("app.pane.flip") ?? "");

    item(menu, "Flip pane").click();
    await settle();

    expect((layout.nodes[layout.activePaneId] as LeafNode).side).toBe("b");
  });

  test("Select multiple is a toggle: the row draws a check while rows are being marked, and its command flips the same switch", async () => {
    const select = command("app.browser.selectMultiple");
    let row = item(await menuFor("a.md"), select.title);
    expect(row.getAttribute("role")).toBe("menuitemcheckbox");
    expect(row.getAttribute("aria-checked")).toBe("false");
    expect(row.querySelector(".lucide-check")).toBeNull();
    expect(chord(row.closest<HTMLElement>(".ctx")!, select.title)).toBe("F8");

    row.click();
    await settle();
    expect(document.querySelector(".ctx"), "the toggle closes the menu").toBeNull();
    expect(commandState(select.id)).toBe(true);

    row = item(await menuFor("a.md"), select.title);
    expect(row.getAttribute("aria-checked")).toBe("true");
    expect(row.querySelector(".lucide-check")).not.toBeNull();
    document.body.click();
    await settle();

    select.run();
    await settle();
    row = item(await menuFor("a.md"), select.title);
    expect(row.getAttribute("aria-checked")).toBe("false");
  });

  test("the launcher row closes the menu and opens the launcher with the keyboard back on the list", async () => {
    // What held the keyboard as the launcher was asked for is what the
    // launcher hands it back to when it closes.
    const heldAtOpen: (string | null)[] = [];
    const onCommand = (e: Event): void => {
      if ((e as CustomEvent).detail?.name !== "app.launcher.toggle") return;
      heldAtOpen.push(document.activeElement?.getAttribute("role") ?? null);
    };
    window.addEventListener("chan:command", onCommand);
    try {
      const menu = await menuFor("a.md");
      const label = wordsOf({ shortcut: "app.launcher.toggle" });
      expect(chord(menu, label)).toBe(chordFor("app.launcher.toggle") ?? "");
      item(menu, label).click();
      await settle();

      expect(heldAtOpen).toEqual(["listbox"]);
      expect(document.querySelector(".ctx")).toBeNull();
      expect(launcherPanel.open).toBe(true);
    } finally {
      window.removeEventListener("chan:command", onCommand);
      closeCommandLauncher();
    }
  });
});

describe("the commands the rows are worded from", () => {
  function offered(id: string): boolean {
    const found = command(id);
    return found.available(commandContext());
  }

  function reason(id: string): string | null {
    return commandUnavailableReason(command(id), commandContext());
  }

  test("are offered for a selection when the menu offers the row for it", async () => {
    fbSelectSingle("a.md");
    expect([offered("app.browser.open"), offered("app.browser.viewMedia"), offered("app.browser.exportPdf")]).toEqual([
      true, false, true,
    ]);
    expect(reason("app.browser.viewMedia")).toBe("Needs an image, a video, an audio file or a PDF");

    fbSelectSingle("clip.mp4");
    expect([offered("app.browser.open"), offered("app.browser.viewMedia"), offered("app.browser.exportPdf")]).toEqual([
      false, true, false,
    ]);
    expect(reason("app.browser.open")).toBe("Needs a directory or a file an editor opens");
    expect(reason("app.browser.exportPdf")).toBe("Needs a markdown file");

    fbSelectSingle("docs");
    expect([offered("app.browser.open"), offered("app.browser.viewMedia"), offered("app.browser.exportPdf")]).toEqual([
      true, false, false,
    ]);

    fbSelectSingle(null);
    for (const id of ["app.browser.open", "app.browser.viewMedia", "app.browser.exportPdf"]) {
      expect(offered(id), id).toBe(false);
      expect(reason(id), id).toBe("Needs a selection");
    }
  });

  test("Open opens the selected file in an editor, as its row does", async () => {
    fbSelectSingle("a.md");
    command("app.browser.open").run();

    await vi.waitFor(() => expect(tabs().at(-1)).toMatchObject({ kind: "file", path: "a.md" }));
  });

  test("View opens the selected video in its viewer, as its row does", async () => {
    fbSelectSingle("clip.mp4");
    command("app.browser.viewMedia").run();
    await settle();

    expect(document.querySelector(".md-video-viewer")).not.toBeNull();
  });

  test("Export to PDF renders the selected document and downloads the PDF, as its row does", async () => {
    vi.mocked(downloadBytes).mockClear();
    fbSelectSingle("a.md");
    command("app.browser.exportPdf").run();

    await vi.waitFor(() => expect(downloadBytes).toHaveBeenCalledWith(PDF, "a.pdf", "application/pdf"));
  });

  test("Copy path copies the selection's path and reports as its row does: copied, or why not", async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const viaCommand = async (): Promise<string> => {
      ui.status = "";
      fbSelectSingle("a.md");
      command("app.browser.copyPath").run();
      await settle();
      return ui.status;
    };
    const viaRow = async (): Promise<string> => {
      ui.status = "";
      item(await menuFor("a.md"), "Copy path").click();
      await settle();
      return ui.status;
    };
    try {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
      expect([await viaCommand(), await viaRow()]).toEqual([
        "copy failed: Clipboard unavailable", "copy failed: Clipboard unavailable",
      ]);

      const writeText = vi.fn(async (_text: string): Promise<void> => { throw new Error("denied"); });
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      expect([await viaCommand(), await viaRow()]).toEqual(["copy failed: denied", "copy failed: denied"]);

      writeText.mockResolvedValue(undefined);
      expect([await viaCommand(), await viaRow()]).toEqual(["Copied path", "Copied path"]);
      expect(writeText.mock.calls.slice(-2)).toEqual([["a.md"], ["a.md"]]);
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});

describe("the docked tree", () => {
  test("offers the Files tab's rows, without Flip pane", async () => {
    const inTab = lines(await menuFor("a.md"));
    document.body.click();
    await settle();
    expect(document.querySelector(".ctx")).toBeNull();

    browserSidePanes.left = true;
    await settle();
    const dock = document.querySelector<HTMLElement>(".browser-side-pane")!;
    await vi.waitFor(() => expect(row("a.md", dock)).toBeDefined());
    const docked = lines(await menuFor("a.md", dock));

    expect(inTab).toContain("Flip pane");
    expect(docked).toEqual(inTab.filter((row) => row !== "Flip pane"));
  });
});


test("Copy path reports an unavailable or refused clipboard and confirms a successful write", async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  try {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    item(await menuFor("a.md"), "Copy path").click();
    await settle();
    expect(ui.status).toBe("copy failed: Clipboard unavailable");

    const writeText = vi.fn(async (_text: string): Promise<void> => { throw new Error("denied"); });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    item(await menuFor("a.md"), "Copy path").click();
    await settle();
    expect(ui.status).toBe("copy failed: denied");

    writeText.mockResolvedValueOnce(undefined);
    item(await menuFor("a.md"), "Copy path").click();
    await settle();
    expect(writeText).toHaveBeenLastCalledWith("a.md");
    expect(ui.status).toBe("Copied path");
  } finally {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});
