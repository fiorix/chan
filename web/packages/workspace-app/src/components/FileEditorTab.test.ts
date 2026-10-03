// @vitest-environment jsdom
//
// FileEditorTab, mounted over the in-memory demo workspace with its real
// editors. The tab menu and the body menu are opened the way the pane opens
// them (openTabMenu, a right-click in the editor body) and driven by clicks.

import { highlightingFor } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import FileEditorTab from "./FileEditorTab.svelte";
import Pane from "./Pane.svelte";
import { api } from "../api/client";
import { ApiError } from "../api/errors";
import { setSocketFactory } from "../api/transport";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { demoSocketFactory } from "../demo/socket";
import { resetDocSyncForTests } from "../state/docSync.svelte";
import { resetSceneSyncForTests } from "../state/sceneSync.svelte";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { bufferKey, flushPendingBufferWrites, readEditorBuffer, SESSION_ID } from "../state/editorBuffer";
import { assignOverride, clearOverride } from "../state/keymapOverrides.svelte";
import { chordFor } from "../state/shortcuts";
import { allCommands } from "../state/commands";
import "../state/commands/install";
import type { MockWorkspaceStore } from "../demo/store";
import { githubDarkHighlight, githubLightHighlight } from "../editor/highlight";
import { ownershipWarnings } from "../__tests__/svelteWarnings";
import {
  fileOps,
  hybridSurfaceThemes,
  paneWidths,
  refreshTree,
  refreshWorkspace,
  ui,
} from "../state/store.svelte";
import { closeTabMenu, openTabMenu, tabMenu } from "../state/tabMenu.svelte";
import {
  bumpTabFocusPulse,
  closeFind,
  conflictDialog,
  dismissConflict,
  ensureTabSlidePreview,
  layout,
  markTabFileMissing,
  openFind,
  registerLiveSessionKind,
  rekeyTabsForRename,
  reloadTabFromDisk,
  saveTab,
  scheduleAutosave,
  setMode,
  setTabContent,
  type FileTab,
  type LeafNode,
} from "../state/tabs.svelte";

const h = vi.hoisted(() => ({
  urlUnderCursor: null as string | null,
  wikiUnderCursor: null as { target: string; anchorEl: HTMLElement } | null,
  previews: [] as Array<{ mode?: string; onClose?: () => void }>,
}));

vi.mock("../state/slidePreview", () => ({
  openSlidePreview: vi.fn((opts: { mode?: string; onClose?: () => void }) => {
    h.previews.push(opts);
    return { update() {}, close() {} };
  }),
}));

vi.mock("../editor/external_links", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../editor/external_links")>();
  return {
    ...actual,
    externalUrlAtCoords: () => h.urlUnderCursor,
    openExternalUrl: vi.fn(async () => {}),
  };
});

vi.mock("../editor/link_preview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../editor/link_preview")>();
  return {
    ...actual,
    internalLinkAtPoint: () => h.wikiUnderCursor,
    openLinkPreview: vi.fn(() => ({ dismiss() {} })),
  };
});

/// The board island, replaced by a probe that keeps the props FileEditorTab
/// hands it.
const island = vi.hoisted(() => {
  const island = {
    props: null as Record<string, unknown> | null,
    session: null as object | null,
    releases: 0,
    module: {
      default: (_anchor: unknown, props: Record<string, unknown>) => {
        island.props = props;
      },
    },
  };
  return island;
});

vi.mock("../editor/ExcalidrawCanvas.svelte", () => island.module);

/// With `island.session` set, a canvas tab is eligible for a live scene
/// session and gets that object as its session.
vi.mock("../state/sceneSync.svelte", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/sceneSync.svelte")>();
  return {
    ...actual,
    isSceneSyncEligible: (tab: { mode: string }) =>
      island.session ? tab.mode === "canvas" : actual.isSceneSyncEligible(tab as never),
    acquireSceneSession: (tab: { mode: string }) =>
      island.session ?? actual.acquireSceneSession(tab as never),
    releaseSceneSession: (id: string) => {
      island.releases += 1;
      if (!island.session) actual.releaseSceneSession(id);
    },
  };
});

vi.mock("../state/tabs.svelte", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/tabs.svelte")>();
  return { ...actual, saveDraftTabToWorkspace: vi.fn(async () => false) };
});

import { openExternalUrl } from "../editor/external_links";
import { openLinkPreview } from "../editor/link_preview";
import { saveDraftTabToWorkspace } from "../state/tabs.svelte";

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
HTMLElement.prototype.setPointerCapture = () => {};
HTMLElement.prototype.releasePointerCapture = () => {};
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  }),
});

const PANE = "file-editor-tab-pane";
const DOC = "# Plan\n\nThe first paragraph.\n";
const mounted: Array<Record<string, unknown>> = [];
let timers: TimerTrack;
let disk: MockWorkspaceStore;

function fileTab(over: Partial<FileTab> = {}): FileTab {
  return {
    kind: "file",
    fileKind: "document",
    id: "file-1",
    path: "notes/plan.md",
    content: DOC,
    saved: DOC,
    savedMtime: 1,
    mode: "wysiwyg",
    loading: false,
    error: null,
    fileMissing: null,
    inspectorOpen: false,
    outlineOpen: false,
    readMode: false,
    fsWritable: true,
    styleToolbarOpen: false,
    syntaxHighlight: true,
    highlightTrailingWhitespace: false,
    codeBlocksCollapsed: false,
    ...over,
  };
}

/// Seats the tab in a one-pane layout and returns the live (proxied) copy.
function seat(tab: FileTab): FileTab {
  layout.nodes = { [PANE]: { kind: "leaf", id: PANE, tabs: [tab], activeTabId: tab.id } };
  layout.rootId = PANE;
  layout.activePaneId = PANE;
  return (layout.nodes[PANE] as LeafNode).tabs[0] as FileTab;
}

async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function render(
  tab: FileTab,
  props: { active?: boolean; focused?: boolean } = {},
): Promise<{ target: HTMLElement; component: Record<string, unknown> }> {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(FileEditorTab, {
    target,
    props: { tab, active: props.active ?? true, focused: props.focused ?? false },
  });
  mounted.push(component);
  await settle();
  return { target, component };
}

/// Seats the tab alone in a pane and mounts the pane, the parent the app
/// mounts a tab body under: Svelte checks prop ownership only below a parent.
async function inPane(tab: FileTab): Promise<{ target: HTMLElement; tab: FileTab }> {
  const live = seat(tab);
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(Pane, { target, props: { pane: layout.nodes[PANE] as LeafNode } }));
  await settle();
  return { target, tab: live };
}

function editorView(target: HTMLElement): EditorView {
  const content = target.querySelector<HTMLElement>(".cm-content");
  if (!content) throw new Error("no editor rendered");
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error("no editor view");
  return view;
}

async function openMenu(tab: FileTab): Promise<void> {
  openTabMenu(tab.id, { left: 10, top: 10, right: 10, bottom: 10 });
  await settle(2);
}

function bubble(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".tab-menu-bubble");
}

/// The menu's rows in order: "---" for a separator, "Name" for the name row,
/// "Page width" for the slider row, else the button's label.
function menuRows(): string[] {
  const list = bubble()?.querySelector(".action-list");
  if (!list) return [];
  return [...list.children].map((el) => {
    if (el.getAttribute("role") === "separator") return "---";
    if (el.classList.contains("name-row")) return "Name";
    if (el.classList.contains("page-width-row")) return "Page width";
    return el.querySelector(".mbtn-label")?.textContent?.trim() ?? "?";
  });
}

function row(label: string): HTMLButtonElement {
  const found = [...(bubble()?.querySelectorAll<HTMLButtonElement>("button.mbtn") ?? [])].find(
    (b) => b.querySelector(".mbtn-label")?.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no menu row ${label}`);
  return found;
}

async function rightClickBody(target: HTMLElement): Promise<void> {
  target
    .querySelector(".editor-host")!
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }));
  await settle(2);
}

beforeEach(async () => {
  timers = trackTimers();
  disk = installDemoWorkspace({
    metadata: {
      workspaceRoot: "demo",
      label: "demo",
      generatedAt: 1_700_000_000_000,
      fileCount: 1,
      textCount: 1,
    },
    files: [{ path: "notes/plan.md", kind: "document", size: DOC.length, mtime: 100, content: DOC }],
  });
  await refreshWorkspace();
  h.urlUnderCursor = null;
  h.wikiUnderCursor = null;
  h.previews = [];
  island.props = null;
  island.session = null;
  localStorage.clear();
});

afterEach(async () => {
  closeTabMenu();
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  await settle(2);
  uninstallDemoWorkspace();
  timers.release();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("the tab menu", () => {
  test("is the Name row, the page width, the file actions and Close, in that order", async () => {
    const tab = seat(fileTab());
    await render(tab);
    await openMenu(tab);

    expect(menuRows()).toEqual([
      "Name",
      "---",
      "Page width",
      "---",
      "Copy path to file",
      "Delete",
      "Duplicate",
      "Reload from disk",
      "---",
      "Close",
    ]);
    expect(bubble()!.parentElement, "portaled to the page body").toBe(document.body);
    expect(bubble()!.querySelector<HTMLInputElement>(".name-input")!.value).toBe("notes/plan.md");
    expect(row("Close").querySelector(".mbtn-chord")?.textContent).toBe(chordFor("app.tab.close") ?? "");
  });

  test("a canvas tab has no page width row", async () => {
    const tab = seat(fileTab({ path: "boards/b.excalidraw", fileKind: "text", mode: "canvas", content: "{}", saved: "{}" }));
    await render(tab);
    await openMenu(tab);

    expect(menuRows()).not.toContain("Page width");
    expect(menuRows().slice(1)).toEqual([
      "---",
      "Copy path to file",
      "Delete",
      "Duplicate",
      "Reload from disk",
      "---",
      "Close",
    ]);
  });

  test("on macOS a canvas tab's Close advertises Cmd+W", async () => {
    // The canvas keeps Ctrl+D for Excalidraw's duplicate gesture, so the
    // menu names the app-level close that still works there.
    const ua = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
    });
    try {
      const tab = seat(fileTab({ path: "boards/b.excalidraw", fileKind: "text", mode: "canvas", content: "{}", saved: "{}" }));
      await render(tab);
      await openMenu(tab);
      expect(row("Close").querySelector(".mbtn-chord")?.textContent).toBe("Cmd+W");
    } finally {
      if (ua) Object.defineProperty(window.navigator, "userAgent", ua);
      else delete (window.navigator as { userAgent?: string }).userAgent;
    }
  });

  test("a draft tab offers Save to Workspace in place of the Name row", async () => {
    const tab = seat(fileTab({ path: ".Drafts/untitled-1/draft.md" }));
    await render(tab);
    await openMenu(tab);

    expect(menuRows()[0]).toBe("Save to Workspace");
    expect(bubble()!.querySelector(".name-row")).toBeNull();
    row("Save to Workspace").click();
    await settle(2);
    expect(saveDraftTabToWorkspace).toHaveBeenCalledWith(tab);
    expect(bubble(), "the menu closes").toBeNull();
  });

  test("the file actions copy the path, delete and duplicate this file", async () => {
    const tab = seat(fileTab());
    await render(tab);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const remove = vi.spyOn(fileOps, "remove").mockResolvedValue(true);
    const duplicate = vi.spyOn(fileOps, "duplicateFile").mockResolvedValue(undefined);

    await openMenu(tab);
    row("Copy path to file").click();
    await settle(2);
    expect(writeText).toHaveBeenCalledWith("notes/plan.md");
    expect(bubble(), "each action closes the menu").toBeNull();

    await openMenu(tab);
    row("Delete").click();
    await settle(2);
    expect(remove).toHaveBeenCalledWith("notes/plan.md", false);

    await openMenu(tab);
    row("Duplicate").click();
    await settle(2);
    expect(duplicate).toHaveBeenCalledWith("notes/plan.md");
  });
});

describe("the Name row", () => {
  test("Enter renames the file in place, keeping its extension", async () => {
    await refreshTree();
    const tab = seat(fileTab());
    await render(tab);
    await openMenu(tab);
    const input = bubble()!.querySelector<HTMLInputElement>(".name-input")!;

    input.focus();
    input.value = "  notes/renamed  ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle(10);

    expect(tab.path).toBe("notes/renamed.md");
    expect(disk.get("notes/renamed.md")?.content, "the file moved on disk").toBe(DOC);
    expect(disk.get("notes/plan.md")).toBeUndefined();
  });

  test("a name that gains a backslash is refused in the path prompt's words, and nothing is sent", async () => {
    await refreshTree();
    const tab = seat(fileTab());
    await render(tab);
    const move = vi.spyOn(api, "move");
    ui.status = null;
    await openMenu(tab);
    const input = bubble()!.querySelector<HTMLInputElement>(".name-input")!;

    input.focus();
    input.value = "notes/pl\\an";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle(10);

    expect(move, "no move is sent").not.toHaveBeenCalled();
    expect(ui.status).toBe("rename failed: \\ cannot be added to a name");
    expect(tab.path).toBe("notes/plan.md");
    expect(disk.get("notes/plan.md")?.content, "the file stays where it was").toBe(DOC);
  });

  test("a name that holds a backslash keeps it through a rename", async () => {
    disk.create("notes/a\\b.md", false, DOC);
    await refreshTree();
    const tab = seat(fileTab({ path: "notes/a\\b.md" }));
    await render(tab);
    ui.status = null;
    await openMenu(tab);
    const input = bubble()!.querySelector<HTMLInputElement>(".name-input")!;

    input.focus();
    input.value = "notes/a\\c";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle(10);

    expect(ui.status).toBeNull();
    expect(tab.path).toBe("notes/a\\c.md");
    expect(disk.get("notes/a\\c.md")?.content, "the file moved on disk").toBe(DOC);
  });

  test("Escape reverts the draft and renames nothing", async () => {
    const tab = seat(fileTab());
    await render(tab);
    const rename = vi.spyOn(fileOps, "renameInPlace");
    await openMenu(tab);
    const input = bubble()!.querySelector<HTMLInputElement>(".name-input")!;

    input.focus();
    input.value = "notes/other";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle(2);

    expect(rename).not.toHaveBeenCalled();
    expect(input.value).toBe("notes/plan.md");
    expect(tab.path).toBe("notes/plan.md");
  });

  test("a blur with an unchanged or empty draft renames nothing", async () => {
    const tab = seat(fileTab());
    await render(tab);
    const rename = vi.spyOn(fileOps, "renameInPlace");
    await openMenu(tab);
    const input = bubble()!.querySelector<HTMLInputElement>(".name-input")!;

    for (const draft of ["notes/plan.md", "   "]) {
      input.focus();
      input.value = draft;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.blur();
      await settle(2);
    }
    expect(rename).not.toHaveBeenCalled();
    expect(input.value).toBe("notes/plan.md");
  });
});

describe("the body menu", () => {
  test("a right-click in the editor opens Cut, Copy, Paste, Find and Reload", async () => {
    const tab = seat(fileTab());
    const { target } = await render(tab);
    await rightClickBody(target);

    expect(tabMenu.source).toBe("body");
    expect(menuRows()).toEqual(["Cut", "Copy", "Paste", "---", "Find", "---", "Reload from disk"]);
    expect(row("Cut").disabled, "nothing to cut without a selection").toBe(true);
    expect(row("Copy").disabled).toBe(true);
    expect(row("Paste").disabled).toBe(false);
  });

  test("a text selection enables Cut and Copy and adds Search selection", async () => {
    const tab = seat(fileTab());
    const { target } = await render(tab);
    const view = editorView(target);
    const at = view.state.doc.toString().indexOf("first");
    view.dispatch({ selection: { anchor: at, head: at + "first".length } });
    await rightClickBody(target);

    expect(row("Cut").disabled).toBe(false);
    expect(row("Copy").disabled).toBe(false);
    expect(menuRows()).toContain("Search selection");
  });

  test("Cut and Copy act on the editor's selection", async () => {
    const tab = seat(fileTab());
    const { target } = await render(tab);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const view = editorView(target);
    const at = view.state.doc.toString().indexOf("first");
    view.dispatch({ selection: { anchor: at, head: at + "first".length } });

    await rightClickBody(target);
    row("Copy").click();
    await settle(2);
    expect(writeText).toHaveBeenLastCalledWith("first");
    expect(view.state.doc.toString()).toContain("first");

    await rightClickBody(target);
    row("Cut").click();
    await settle(2);
    expect(writeText).toHaveBeenLastCalledWith("first");
    expect(view.state.doc.toString()).not.toContain("first");
  });

  test("Find opens this tab's find bar", async () => {
    const tab = seat(fileTab());
    const { target } = await render(tab);
    await rightClickBody(target);

    row("Find").click();
    await settle(2);
    expect(tab.find?.open).toBe(true);
    expect(bubble()).toBeNull();
  });

  test("on an external link it offers Open link and Copy link", async () => {
    const tab = seat(fileTab());
    const { target } = await render(tab);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    h.urlUnderCursor = "https://example.com/doc";

    await rightClickBody(target);
    expect(menuRows()).toEqual([
      "Cut",
      "Copy",
      "Paste",
      "---",
      "Open link",
      "Copy link",
      "---",
      "Find",
      "---",
      "Reload from disk",
    ]);
    row("Open link").click();
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/doc");

    await rightClickBody(target);
    row("Copy link").click();
    await settle(2);
    expect(writeText).toHaveBeenCalledWith("https://example.com/doc");
  });

  test("on an internal link it offers Preview, which opens the link preview", async () => {
    const tab = seat(fileTab());
    const { target } = await render(tab);
    const anchorEl = document.createElement("span");
    h.wikiUnderCursor = { target: "notes/other.md", anchorEl };

    await rightClickBody(target);
    expect(menuRows()).toContain("Preview");
    expect(menuRows()).not.toContain("Open link");
    row("Preview").click();

    expect(openLinkPreview).toHaveBeenCalledTimes(1);
    const [opts] = vi.mocked(openLinkPreview).mock.calls[0]!;
    expect(opts.hit).toEqual({ target: "notes/other.md", anchorEl });
    expect(opts.fromPath).toBe("notes/plan.md");
  });
});

describe("recovering unsaved work from an earlier page load", () => {
  /// A buffer another page load left behind for the tab's path.
  function strandBuffer(path: string, content: string): void {
    localStorage.setItem(
      bufferKey(path),
      JSON.stringify({ content, updatedAt: Date.now(), path, sessionId: "an-earlier-load" }),
    );
  }

  function banner(target: HTMLElement): HTMLElement | null {
    return target.querySelector<HTMLElement>(".recovery-banner");
  }

  test("offers a diverging buffer, and Restore puts it in the editor", async () => {
    strandBuffer("notes/plan.md", "# Plan\n\nWork that never reached disk.\n");
    const tab = seat(fileTab());
    const { target } = await render(tab);

    expect(banner(target)?.textContent).toContain("Unsaved changes from a previous session");
    [...banner(target)!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Restore")!.click();
    await settle(2);
    expect(tab.content).toBe("# Plan\n\nWork that never reached disk.\n");
    expect(banner(target)).toBeNull();
  });

  test("Restore in a pane puts the buffer in the tab without an ownership warning", async () => {
    const warnings = ownershipWarnings();
    strandBuffer("notes/plan.md", "# Plan\n\nWork that never reached disk.\n");
    const { target, tab } = await inPane(fileTab());

    [...banner(target)!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Restore")!.click();
    await settle(2);
    expect(tab.content).toBe("# Plan\n\nWork that never reached disk.\n");
    expect(warnings()).toEqual([]);
  });

  test("typing after a restore does not raise the banner again", async () => {
    // The decision reads the disk content, so it runs per load, not per
    // keystroke; an edit before the restored buffer is re-persisted must not
    // be mistaken for the earlier session's work.
    strandBuffer("notes/plan.md", "# Plan\n\nRecovered.\n");
    const tab = seat(fileTab());
    const { target } = await render(tab);
    [...banner(target)!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Restore")!.click();
    await settle(2);

    tab.content = "# Plan\n\nRecovered, then edited.\n";
    await settle(2);
    expect(banner(target)).toBeNull();
  });

  test("Discard drops the stored buffer for the path at once", async () => {
    strandBuffer("notes/plan.md", "stale work");
    const tab = seat(fileTab());
    const { target } = await render(tab);
    // A dirty editor: the persistence effect only queues a debounced write,
    // so what storage holds right after Discard is Discard's own doing.
    tab.content = "# Plan\n\nDirty.\n";
    await settle(2);

    [...banner(target)!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Discard")!.click();
    await tick();
    expect(banner(target)).toBeNull();
    expect(localStorage.getItem(bufferKey("notes/plan.md"))).toBeNull();
  });

  test("an offered buffer survives the clean editor, so a remount offers it again", async () => {
    strandBuffer("notes/plan.md", "stale work");
    const tab = seat(fileTab());
    const first = await render(tab);
    expect(banner(first.target)).not.toBeNull();

    unmount(mounted.pop()!);
    const second = await render(tab);
    expect(banner(second.target), "still offered after a tab switch").not.toBeNull();
  });

  test("nothing is offered or stored while the file is still loading", async () => {
    strandBuffer("notes/plan.md", "stale work");
    const tab = seat(fileTab({ loading: true, saved: undefined, content: "" }));
    const { target } = await render(tab);
    expect(banner(target)).toBeNull();

    tab.saved = DOC;
    tab.content = DOC;
    tab.loading = false;
    await settle(2);
    expect(banner(target), "offered once the disk content is in").not.toBeNull();
  });

  test("an edit is kept under the tab's path, and a close cancels the pending write", async () => {
    const tab = seat(fileTab());
    await render(tab);

    tab.content = "# Plan\n\nUnsaved edit.\n";
    await settle(2);
    await new Promise((r) => setTimeout(r, 650));
    const kept = readEditorBuffer("notes/plan.md");
    expect(kept?.content).toBe("# Plan\n\nUnsaved edit.\n");
    expect(kept?.path).toBe("notes/plan.md");
    expect(kept?.sessionId).toBe(SESSION_ID);

    tab.content = "# Plan\n\nA later edit.\n";
    await settle(2);
    unmount(mounted.pop()!);
    // Write whatever is still queued now, however long its debounce: the
    // close must have left nothing for this tab.
    flushPendingBufferWrites();
    expect(readEditorBuffer("notes/plan.md")?.content, "the write queued before the close was cancelled").toBe(
      "# Plan\n\nUnsaved edit.\n",
    );
  });

  // When the earlier page load stamped its buffer, and the mtime of a file
  // written a minute after that.
  const STAMPED_MS = 1_700_000_000_000;
  const WRITTEN_AFTER_NS = String((STAMPED_MS + 60_000) * 1_000_000);

  /// A buffer an earlier page load stamped for `tab`'s path, before the file
  /// the tab holds was written.
  function strandBufferBeforeTheWrite(tab: FileTab, content: string): FileTab {
    localStorage.setItem(
      bufferKey(tab.path),
      JSON.stringify({ content, updatedAt: STAMPED_MS, path: tab.path, sessionId: "an-earlier-load" }),
    );
    return { ...tab, savedMtimeNs: WRITTEN_AFTER_NS, savedMtime: Number(WRITTEN_AFTER_NS) / 1e9 };
  }

  /// What the tab's open offers and what stays stored for its path.
  const offered = (target: HTMLElement, tab: FileTab) => ({
    banner: banner(target) !== null,
    stored: readEditorBuffer(tab.path)?.content ?? null,
  });

  // A drawing's file as a scene session's authority writes it, holding one
  // stroke, and a board's serialization of the drawing with a second.
  const FIRST_STROKE = { id: "first", isDeleted: false, type: "rectangle", version: 1, versionNonce: 1 };
  const AUTHORITY_FILE = JSON.stringify(
    { type: "excalidraw", version: 2, source: "chan", elements: [FIRST_STROKE], appState: {}, files: {} },
    null,
    2,
  );
  const BOARD_BUFFER = JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "http://localhost",
      elements: [FIRST_STROKE, { ...FIRST_STROKE, id: "last-stroke", versionNonce: 2 }],
      appState: { gridSize: 20, gridStep: 5, gridModeEnabled: false, viewBackgroundColor: "#ffffff" },
      files: {},
    },
    null,
    2,
  );
  const drawing = (content: string) =>
    fileTab({ path: "boards/b.excalidraw", fileKind: "text", mode: "canvas", content, saved: content });

  test.each([
    ["a text file", () => fileTab(), "# Plan\n\nThe first paragraph.\n\nTyped and never saved.\n"],
    ["a drawing", () => drawing(AUTHORITY_FILE), BOARD_BUFFER],
  ])("%s written after the buffer's stamp without the buffer's last change leaves the buffer offered", async (_kind, open, unsaved) => {
    const tab = seat(strandBufferBeforeTheWrite(open(), unsaved));
    const { target } = await render(tab);
    const atOpen = offered(target, tab);
    [...(banner(target)?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.trim() === "Restore")?.click();
    await settle(2);

    expect({ atOpen, restored: tab.content === unsaved }).toEqual({
      atOpen: { banner: true, stored: unsaved },
      restored: true,
    });
  });

  test.each([
    ["a text file", () => fileTab()],
    ["a drawing", () => drawing(BOARD_BUFFER)],
  ])("a buffer whose content %s holds is not offered and is dropped", async (_kind, open) => {
    const held = open();
    const tab = seat(strandBufferBeforeTheWrite(held, held.content));
    const { target } = await render(tab);

    expect(offered(target, tab)).toEqual({ banner: false, stored: null });
  });
});

describe("the caret command", () => {
  test("moves the live editor's caret and clears itself", async () => {
    const tab = seat(fileTab());
    const { target } = await render(tab);
    const view = editorView(target);
    const at = view.state.doc.toString().indexOf("paragraph");

    tab.caretCommand = { from: at, to: at + 4 };
    await settle(2);
    expect(view.state.selection.main.from).toBe(at);
    expect(view.state.selection.main.to).toBe(at + 4);
    expect(tab.caretCommand).toBeUndefined();
  });
});

describe("the slide chord", () => {
  const DECK = "---\nchan:\n  kind: slides\n---\n\n# One\n\n---\n\n# Two\n";

  function press(el: Element, init: KeyboardEventInit): KeyboardEvent {
    const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(e);
    return e;
  }

  test("Mod+Enter previews a deck and Mod+Shift+Enter presents it, ahead of the editor", async () => {
    const tab = seat(fileTab({ path: "talks/deck.md", content: DECK, saved: DECK }));
    const { target } = await render(tab);
    const content = target.querySelector(".cm-content")!;

    const preview = press(content, { ctrlKey: true });
    await settle(2);
    expect(preview.defaultPrevented).toBe(true);
    expect(h.previews.map((p) => p.mode)).toEqual(["preview"]);
    expect(tab.slidePreview?.open).toBe(true);
    expect(editorView(target).state.doc.toString(), "the editor never saw the Enter").toBe(DECK);

    press(content, { ctrlKey: true, shiftKey: true });
    await settle(2);
    expect(tab.slidePreview?.mode).toBe("play");
  });

  test("Mod+Enter in a fence on a deck leaves the fence and opens no preview", async () => {
    const doc = `${DECK}\n\`\`\`js\nx\n\`\`\`\n`;
    const tab = seat(fileTab({ path: "talks/deck.md", content: doc, saved: doc }));
    const { target } = await render(tab);
    const view = editorView(target);
    const closer = view.state.doc.lineAt(doc.lastIndexOf("```")).number;
    view.dispatch({ selection: { anchor: doc.indexOf("x\n```") } });

    const e = press(target.querySelector(".cm-content")!, { ctrlKey: true });
    await settle(2);
    const caretLine = view.state.doc.lineAt(view.state.selection.main.head).number;
    expect({ claimed: e.defaultPrevented, previews: h.previews.length, belowCloser: caretLine > closer }).toEqual({
      claimed: true, previews: 0, belowCloser: true,
    });
  });

  test("Mod+Enter in a fence on a deck in read mode previews the deck and leaves the text alone", async () => {
    const doc = `${DECK}\n\`\`\`js\nx\n\`\`\`\n`;
    const tab = seat(fileTab({ path: "talks/deck.md", content: doc, saved: doc, readMode: true }));
    const { target } = await render(tab);
    const view = editorView(target);
    view.dispatch({ selection: { anchor: doc.indexOf("x\n```") } });

    const e = press(target.querySelector(".cm-content")!, { ctrlKey: true });
    await settle(2);
    expect({
      claimed: e.defaultPrevented,
      previews: h.previews.map((p) => p.mode),
      text: view.state.doc.toString(),
    }).toEqual({ claimed: true, previews: ["preview"], text: doc });
  });

  test("Mod+Enter on a date on a deck opens its calendar and no preview", async () => {
    const doc = `${DECK}\nDue 2026-09-27 here\n`;
    const tab = seat(fileTab({ path: "talks/deck.md", content: doc, saved: doc }));
    const { target } = await render(tab);
    const view = editorView(target);
    // The calendar anchors at the caret's coordinates, which jsdom cannot lay out.
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 0, right: 1, top: 0, bottom: 10 });
    view.dispatch({ selection: { anchor: doc.indexOf("2026-09-27") + 2 } });

    press(target.querySelector(".cm-content")!, { ctrlKey: true });
    await settle(2);
    const calendars = document.querySelectorAll(".md-date-popover").length;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect({ previews: h.previews.length, calendars }).toEqual({ previews: 0, calendars: 1 });
  });

  test("Mod+Enter with an image ring-selected on a deck goes to the image, not the preview", async () => {
    const doc = `${DECK}\n![a](a.png)\n`;
    const tab = seat(fileTab({ path: "talks/deck.md", content: doc, saved: doc }));
    const { target } = await render(tab);
    const wrap = target.querySelector<HTMLElement>(".cm-md-image-wrap")!;
    wrap.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(wrap.dataset.selected).toBe("true");

    press(target.querySelector(".cm-content")!, { ctrlKey: true });
    await settle(2);
    const zoomed = document.querySelectorAll(".md-image-zoom").length;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect({ previews: h.previews.length, ring: wrap.dataset.selected, zoomed }).toEqual({
      previews: 0, ring: undefined, zoomed: 1,
    });
    expect(document.querySelector(".md-image-zoom"), "the viewer closes on Escape").toBeNull();
  });

  test("the first preview state handed out is the state the tab holds", () => {
    const tab = seat(fileTab({ path: "talks/deck.md", content: DECK, saved: DECK }));
    const preview = ensureTabSlidePreview(tab);
    expect(preview).toBe(tab.slidePreview);

    // Once the tab has read a field, only a write through its own state
    // reaches that field.
    expect(tab.slidePreview?.index).toBe(0);
    preview.index = 2;
    expect(tab.slidePreview?.index).toBe(2);
  });

  test("a first Mod+Shift+Enter in a pane presents the deck without a stale-assignment warning", async () => {
    const warnings = ownershipWarnings();
    const { target, tab } = await inPane(fileTab({ path: "talks/deck.md", content: DECK, saved: DECK }));

    press(target.querySelector(".cm-content")!, { ctrlKey: true, shiftKey: true });
    await settle(2);
    expect(h.previews.map((p) => p.mode)).toEqual(["play"]);
    expect(tab.slidePreview).toEqual({ open: true, index: 0, mode: "play" });
    expect(warnings()).toEqual([]);
  });

  test("stands down off a deck, while loading, with Alt, or on the other platform's Mod", async () => {
    const plain = seat(fileTab());
    const a = await render(plain);
    press(a.target.querySelector(".cm-content")!, { ctrlKey: true });
    await settle(2);

    const deck = seat(fileTab({ id: "deck", path: "talks/deck.md", content: DECK, saved: DECK }));
    const b = await render(deck);
    const content = b.target.querySelector(".cm-content")!;
    press(content, { ctrlKey: true, altKey: true });
    press(content, { metaKey: true });
    deck.loading = true;
    await settle(2);
    press(content, { ctrlKey: true });
    await settle(2);

    expect(h.previews).toEqual([]);
  });

  test("ignores a form control in the editor host outside the editor", async () => {
    const tab = seat(fileTab({ path: "talks/deck.md", content: DECK, saved: DECK }));
    const { target } = await render(tab);
    const input = document.createElement("input");
    target.querySelector(".editor-host")!.append(input);

    press(input, { ctrlKey: true });
    await settle(2);
    expect(h.previews).toEqual([]);
  });

  test("a user chord for the preview supersedes the built-in one", async () => {
    const tab = seat(fileTab({ path: "talks/deck.md", content: DECK, saved: DECK }));
    const { target } = await render(tab);
    assignOverride("app.slides.preview", "Mod+J");
    try {
      press(target.querySelector(".cm-content")!, { ctrlKey: true });
      await settle(2);
      expect(h.previews).toEqual([]);
    } finally {
      clearOverride("app.slides.preview");
    }
  });

  test("closing the preview gives the editor its focus back", async () => {
    const tab = seat(fileTab({ path: "talks/deck.md", content: DECK, saved: DECK }));
    const { target } = await render(tab, { focused: true });
    press(target.querySelector(".cm-content")!, { ctrlKey: true });
    await settle(2);
    (document.activeElement as HTMLElement | null)?.blur();

    h.previews[0]!.onClose!();
    await settle(2);
    expect(tab.slidePreview?.open).toBe(false);
    expect(target.querySelector(".cm-content")!.contains(document.activeElement)).toBe(true);
  });
});

describe("the side panels' widths", () => {
  /// Drags a panel edge `dx` pixels, as a pointer would.
  function drag(handle: Element, dx: number): void {
    const at = (type: string, clientX: number) =>
      handle.dispatchEvent(
        Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }), { pointerId: 1 }),
      );
    at("pointerdown", 500);
    at("pointermove", 500 + dx);
    at("pointerup", 500 + dx);
  }

  test("the details and outline panels take the tab's own widths", async () => {
    const tab = seat(fileTab({ inspectorOpen: true, inspectorWidth: 310, outlineOpen: true, outlineWidth: 190 }));
    const { target } = await render(tab);

    expect(target.querySelector<HTMLElement>("aside.inspector.right")!.style.width).toBe("310px");
    expect(target.querySelector<HTMLElement>("aside.inspector.left")!.style.width).toBe("190px");
  });

  test("without them they use the shared widths, and a drag writes only the tab's", async () => {
    const sharedInspector = paneWidths.inspector;
    const sharedOutline = paneWidths.outline;
    const tab = seat(fileTab({ inspectorOpen: true, outlineOpen: true }));
    const { target } = await render(tab);
    const details = target.querySelector<HTMLElement>("aside.inspector.right")!;
    const outline = target.querySelector<HTMLElement>("aside.inspector.left")!;
    expect(details.style.width).toBe(`${sharedInspector}px`);
    expect(outline.style.width).toBe(`${sharedOutline}px`);

    drag(details.previousElementSibling!, -40);
    drag(outline.nextElementSibling!, 30);
    await settle(2);
    expect(tab.inspectorWidth).toBe(sharedInspector + 40);
    expect(tab.outlineWidth).toBe(sharedOutline + 30);
    expect(paneWidths.inspector).toBe(sharedInspector);
    expect(paneWidths.outline).toBe(sharedOutline);
  });

  test("a drag in a pane writes the tab's widths without an ownership warning", async () => {
    const warnings = ownershipWarnings();
    const { target, tab } = await inPane(
      fileTab({ inspectorOpen: true, inspectorWidth: 300, outlineOpen: true, outlineWidth: 200 }),
    );

    drag(target.querySelector("aside.inspector.right")!.previousElementSibling!, -40);
    drag(target.querySelector("aside.inspector.left")!.nextElementSibling!, 30);
    await settle(2);
    expect(tab.inspectorWidth).toBe(340);
    expect(tab.outlineWidth).toBe(230);
    expect(warnings()).toEqual([]);
  });
});

describe("the read-mode lamp", () => {
  test("a click in a pane toggles the tab's read mode without an ownership warning", async () => {
    const warnings = ownershipWarnings();
    const { target, tab } = await inPane(fileTab());
    const lamp = target.querySelector<HTMLButtonElement>(".wiki-statusbar button.lamp")!;

    lamp.click();
    await settle(2);
    expect(tab.readMode).toBe(true);
    expect(lamp.textContent?.trim()).toBe("read");
    lamp.click();
    await settle(2);
    expect(tab.readMode).toBe(false);
    expect(warnings()).toEqual([]);
  });
});

describe("the find bar", () => {
  function key(input: HTMLInputElement, init: KeyboardEventInit): void {
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  }

  function type(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  for (const mode of ["wysiwyg", "source"] as const) {
    test(`in a pane's ${mode} editor, a query, its stepping and the case toggle reach the tab without an ownership warning`, async () => {
      const warnings = ownershipWarnings();
      const { target, tab } = await inPane(fileTab({ mode }));
      openFind(tab.id);
      await settle(2);
      const input = target.querySelector<HTMLInputElement>(".find-input")!;

      // "p" is in "Plan" and twice in "paragraph"; only the last two match case.
      type(input, "p");
      await vi.waitFor(() => expect(tab.find?.matches).toHaveLength(3));
      expect(tab.find?.query).toBe("p");
      expect(tab.find?.currentIndex).toBe(0);
      key(input, { key: "Enter" });
      expect(tab.find?.currentIndex).toBe(1);
      key(input, { key: "Enter", shiftKey: true });
      expect(tab.find?.currentIndex).toBe(0);

      target.querySelector<HTMLButtonElement>('button[aria-label="match case"]')!.click();
      await vi.waitFor(() => expect(tab.find?.matches).toHaveLength(2));
      expect(tab.find?.caseSensitive).toBe(true);

      type(input, "");
      await settle(2);
      expect(tab.find?.matches).toEqual([]);
      expect(tab.find?.currentIndex).toBe(-1);
      expect(warnings()).toEqual([]);
    });
  }
});

describe("focus follows the active pane", () => {
  test("a focus pulse focuses only the editor of a focused tab", async () => {
    const tab = seat(fileTab());
    const { target } = await render(tab, { focused: false });
    (document.activeElement as HTMLElement | null)?.blur();

    bumpTabFocusPulse();
    await settle(2);
    expect(target.querySelector(".cm-content")!.contains(document.activeElement)).toBe(false);
  });

  test("in two panes, the pulse lands in the active pane's editor", async () => {
    const left = fileTab({ id: "left-file" });
    const right = fileTab({ id: "right-file", path: "notes/other.md" });
    layout.nodes = {
      root: { kind: "split", id: "root", direction: "row", ratio: 0.5, a: "pane-left", b: "pane-right" },
      "pane-left": { kind: "leaf", id: "pane-left", tabs: [left], activeTabId: left.id },
      "pane-right": { kind: "leaf", id: "pane-right", tabs: [right], activeTabId: right.id },
    } as typeof layout.nodes;
    layout.rootId = "root";
    layout.activePaneId = "pane-right";
    const hosts: Record<string, HTMLElement> = {};
    for (const id of ["pane-left", "pane-right"]) {
      const target = document.createElement("div");
      document.body.append(target);
      mounted.push(mount(Pane, { target, props: { pane: layout.nodes[id] as LeafNode } }));
      hosts[id] = target;
    }
    await settle();

    bumpTabFocusPulse();
    await settle(2);
    expect(hosts["pane-right"]!.querySelector(".cm-content")!.contains(document.activeElement)).toBe(true);
    expect(hosts["pane-left"]!.querySelector(".cm-content")!.contains(document.activeElement)).toBe(false);

    layout.activePaneId = "pane-left";
    await settle(2);
    expect(hosts["pane-left"]!.querySelector(".cm-content")!.contains(document.activeElement)).toBe(true);
  });

  test("a pane that gains and loses focus in one stack leaves its editor alone", async () => {
    const left = fileTab({ id: "left-file" });
    const right = fileTab({ id: "right-file", path: "notes/other.md" });
    layout.nodes = {
      root: { kind: "split", id: "root", direction: "row", ratio: 0.5, a: "pane-left", b: "pane-right" },
      "pane-left": { kind: "leaf", id: "pane-left", tabs: [left], activeTabId: left.id },
      "pane-right": { kind: "leaf", id: "pane-right", tabs: [right], activeTabId: right.id },
    } as typeof layout.nodes;
    layout.rootId = "root";
    layout.activePaneId = "pane-left";
    const hosts: Record<string, HTMLElement> = {};
    for (const id of ["pane-left", "pane-right"]) {
      const target = document.createElement("div");
      document.body.append(target);
      mounted.push(mount(Pane, { target, props: { pane: layout.nodes[id] as LeafNode } }));
      hosts[id] = target;
    }
    await settle();
    const rightFocused: EventTarget[] = [];
    hosts["pane-right"]!.addEventListener("focusin", (e) => rightFocused.push(e.target!));

    // The right pane becomes focused, and its effect defers the focus call to
    // a microtask; before that microtask runs, focus moves back. The deferred
    // call must see that and do nothing.
    layout.activePaneId = "pane-right";
    flushSync();
    layout.activePaneId = "pane-left";
    flushSync();
    await settle(2);
    expect(rightFocused, "the right editor never took focus").toEqual([]);
    expect(hosts["pane-left"]!.querySelector(".cm-content")!.contains(document.activeElement)).toBe(true);
  });

  for (const mode of ["wysiwyg", "source"] as const) {
    test(`a save mirrored into a ${mode} editor in another pane leaves focus where it was`, async () => {
      // A live doc session carries a save to a sibling as an update and the
      // mirror skips it; with sessions off the save is mirrored.
      localStorage.setItem("chan.docsync", "0");
      const left = fileTab({ id: "left-file" });
      const right = fileTab({ id: "right-file", mode });
      layout.nodes = {
        root: { kind: "split", id: "root", direction: "row", ratio: 0.5, a: "pane-left", b: "pane-right" },
        "pane-left": { kind: "leaf", id: "pane-left", tabs: [left], activeTabId: left.id },
        "pane-right": { kind: "leaf", id: "pane-right", tabs: [right], activeTabId: right.id },
      } as typeof layout.nodes;
      layout.rootId = "root";
      layout.activePaneId = "pane-left";
      const hosts: Record<string, HTMLElement> = {};
      for (const id of ["pane-left", "pane-right"]) {
        const target = document.createElement("div");
        document.body.append(target);
        mounted.push(mount(Pane, { target, props: { pane: layout.nodes[id] as LeafNode } }));
        hosts[id] = target;
      }
      await settle();
      bumpTabFocusPulse();
      await settle(2);
      const typing = editorView(hosts["pane-left"]!);
      const sibling = editorView(hosts["pane-right"]!);
      expect(typing.hasFocus, "the left editor is the one being typed in").toBe(true);

      typing.dispatch({ changes: { from: typing.state.doc.length, insert: "More.\n" } });
      flushSync();
      await saveTab((layout.nodes["pane-left"] as LeafNode).tabs[0]!);
      await settle();

      expect(sibling.state.doc.toString(), "the save reached the sibling").toBe(`${DOC}More.\n`);
      expect(sibling.hasFocus).toBe(false);
      expect(typing.hasFocus).toBe(true);
    });
  }
});

describe("an edit in a pane's editor", () => {
  for (const mode of ["wysiwyg", "source"] as const) {
    test(`reaches the tab from the ${mode} editor`, async () => {
      const warnings = ownershipWarnings();
      const { target, tab } = await inPane(fileTab({ mode }));
      const view = editorView(target);

      view.dispatch({ changes: { from: view.state.doc.length, insert: "More.\n" } });
      flushSync();
      expect(tab.content).toBe(`${DOC}More.\n`);
      expect(warnings()).toEqual([]);
    });
  }

  test("reaches the tab from a table cell", async () => {
    const warnings = ownershipWarnings();
    const csv = "name,count\nfigs,1\n";
    const { target, tab } = await inPane(
      fileTab({ path: "notes/stock.csv", fileKind: "text", mode: "table", content: csv, saved: csv }),
    );

    target.querySelector<HTMLElement>("tbody td > button")!.click();
    await settle(2);
    const input = target.querySelector<HTMLInputElement>("tbody td input")!;
    input.value = "plums";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle(2);
    expect(tab.content).toBe("name,count\nplums,1\n");
    expect(warnings()).toEqual([]);
  });
});

describe("a canvas tab", () => {
  const BOARD = '{"type":"excalidraw","elements":[]}';

  function canvasTab(over: Partial<FileTab> = {}): FileTab {
    return fileTab({
      id: "canvas-1",
      path: "notes/board.excalidraw",
      fileKind: "text",
      mode: "canvas",
      content: BOARD,
      saved: BOARD,
      ...over,
    });
  }

  test("reaches the board island only through a dynamic import", async () => {
    // A fresh module graph, with the island counting its evaluations.
    vi.resetModules();
    let loads = 0;
    vi.doMock("../editor/ExcalidrawCanvas.svelte", () => {
      loads += 1;
      return island.module;
    });
    await import("./FileEditorTab.svelte");
    expect(loads, "importing the tab does not evaluate the island").toBe(0);
  });

  test("loads the island the first time the tab is shown, not while it is hidden", async () => {
    const hidden = seat(canvasTab());
    await render(hidden, { active: false });
    expect(island.props).toBeNull();

    const shown = seat(canvasTab({ id: "canvas-2" }));
    await render(shown, { active: true });
    expect(island.props?.content).toBe(BOARD);
    expect(island.props?.active).toBe(true);
  });

  test("hands the island its read-only state and the live scene session", async () => {
    // A class instance: $state keeps it as is, where it would proxy a plain object.
    island.session = new (class LiveSession {})();
    const tab = seat(canvasTab({ readMode: true }));
    await render(tab);
    expect(island.props?.readonly).toBe(true);
    expect(island.props?.session).toBe(island.session);

    tab.readMode = false;
    await settle(2);
    expect(island.props?.readonly).toBe(false);
  });

  test("tells the island when its tab is hidden in the pane, and takes its scene into the buffer", async () => {
    const warnings = ownershipWarnings();
    const board = canvasTab();
    layout.nodes = {
      [PANE]: { kind: "leaf", id: PANE, tabs: [board, fileTab({ id: "doc-1" })], activeTabId: board.id },
    };
    layout.rootId = PANE;
    layout.activePaneId = PANE;
    const pane = layout.nodes[PANE] as LeafNode;
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(Pane, { target, props: { pane } }));
    await settle();
    expect(island.props?.active).toBe(true);

    pane.activeTabId = "doc-1";
    await settle(2);
    expect(island.props?.active).toBe(false);

    const next = '{"type":"excalidraw","elements":[{"id":"a"}]}';
    (island.props?.onSceneChange as (json: string) => void)(next);
    expect((pane.tabs[0] as FileTab).content).toBe(next);
    expect(warnings()).toEqual([]);
  });
});

describe("the editor surface's theme", () => {
  /// Which of the two syntax palettes the editor highlights with.
  function palette(view: EditorView): "dark" | "light" | null {
    const classes = highlightingFor(view.state, [tags.keyword]) ?? "";
    if (classes.includes(githubDarkHighlight.style([tags.keyword])!)) return "dark";
    if (classes.includes(githubLightHighlight.style([tags.keyword])!)) return "light";
    return null;
  }

  for (const mode of ["source", "wysiwyg"] as const) {
    test(`the ${mode} editor highlights with the editor surface's theme, and follows it`, async () => {
      const startTheme = ui.theme;
      ui.theme = "light";
      hybridSurfaceThemes.editor = "dark";
      hybridSurfaceThemes.terminal = "light";
      try {
        const tab = seat(fileTab({ mode }));
        const { target } = await render(tab);
        const view = editorView(target);
        expect(palette(view)).toBe("dark");

        delete hybridSurfaceThemes.editor;
        await settle(2);
        expect(palette(view), "back to the app theme").toBe("light");
      } finally {
        delete hybridSurfaceThemes.editor;
        delete hybridSurfaceThemes.terminal;
        ui.theme = startTheme;
      }
    });
  }
});

describe("the status line after a file action", () => {
  function setClipboard(writeText: (text: string) => Promise<void>): void {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  }

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    ui.status = null;
    ui.statusKind = null;
  });

  test("Copy path to file says so briefly, and a refused clipboard leaves a dismissable error", async () => {
    const tab = seat(fileTab());
    await render(tab);
    setClipboard(async () => {});
    await openMenu(tab);
    row("Copy path to file").click();
    await settle(2);
    expect([ui.status, ui.statusKind]).toEqual(["Copied file path", "transient"]);

    setClipboard(async () => {
      throw new Error("denied");
    });
    await openMenu(tab);
    row("Copy path to file").click();
    await settle(2);
    expect(ui.status).toMatch(/^copy failed: /);
    expect(ui.statusKind).toBe("persistent");
  });

  test("the launcher's Copy path to file notifies briefly", async () => {
    const tab = seat(fileTab());
    await render(tab, { focused: true });
    setClipboard(async () => {});
    await allCommands().find((c) => c.id === "app.editor.copyPath")!.run();
    await settle(2);
    expect([ui.status, ui.statusKind]).toEqual(["Copied file path", "transient"]);
  });

  test("re-opening a moved file asks the user to pick it in Files, until the tab goes", async () => {
    const tab = seat(fileTab({ path: "notes/moved.md", fileMissing: { path: "notes/moved.md", fragment: null } }));
    const { target, component } = await render(tab);
    const reopen = [...target.querySelectorAll<HTMLButtonElement>(".missing-actions button")].find(
      (b) => b.textContent?.trim() === "Re-open",
    );
    reopen!.click();
    await settle();
    expect(ui.status).toBe("Choose the moved file in Files to re-open this tab");

    unmount(component);
    mounted.splice(mounted.indexOf(component), 1);
    expect(ui.status).toBeNull();
  });
});

describe("outline navigation", () => {
  test.each(["wysiwyg", "source"] as const)("jumps to the outline line in %s when an indented heading is omitted", async (mode) => {
    const content = "# A\n\n   # B\n\n# C\n";
    const tab = seat(fileTab({ mode, outlineOpen: true, content, saved: content }));
    const { target } = await render(tab);
    const heading = [...target.querySelectorAll<HTMLButtonElement>(".outline-list button")]
      .find((button) => button.textContent?.trim() === "C");
    expect(heading).toBeDefined();
    heading!.click();
    await settle(2);

    expect(editorView(target).state.selection.main.head).toBe(content.indexOf("# C"));
  });
});

describe("closing the editor find bar", () => {
  test.each(["Escape", "close button"])("returns focus after %s", async (method) => {
    const tab = seat(fileTab());
    const { target } = await render(tab, { focused: true });
    openFind(tab.id);
    await settle();
    const input = target.querySelector<HTMLInputElement>(".find-input")!;
    expect(document.activeElement).toBe(input);
    if (method === "Escape") {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    } else {
      const button = target.querySelector<HTMLButtonElement>('[aria-label="close find bar"]')!;
      button.focus();
      button.click();
    }
    await settle();

    expect(tab.find?.open).toBe(false);
    expect(target.querySelector(".cm-content")!.contains(document.activeElement)).toBe(true);
  });

  test("keeps focus taken by another control when find closes", async () => {
    const tab = seat(fileTab());
    await render(tab, { focused: true });
    openFind(tab.id);
    await settle();
    const other = document.createElement("input");
    document.body.append(other);
    other.focus();
    closeFind(tab.id);
    await settle();

    expect(document.activeElement).toBe(other);
  });
});

describe("the source toolbar", () => {
  test("reserves top padding only while its toolbar is mounted", async () => {
    const tab = seat(fileTab({ mode: "source", styleToolbarOpen: true }));
    const { target } = await render(tab);
    const host = target.querySelector<HTMLElement>(".editor-host")!;
    expect(target.querySelector(".md-source")).not.toBeNull();
    expect(host.querySelector(".style-toolbar")).not.toBeNull();
    expect(host.style.getPropertyValue("--editor-top-pad")).toBe("2.5rem");

    tab.styleToolbarOpen = false;
    await settle();
    expect(host.querySelector(".style-toolbar")).toBeNull();
    expect(host.style.getPropertyValue("--editor-top-pad")).toBe("");

    tab.styleToolbarOpen = true;
    await settle();
    expect(host.querySelector(".style-toolbar")).not.toBeNull();
    expect(host.style.getPropertyValue("--editor-top-pad")).toBe("2.5rem");

    tab.fileKind = "text";
    tab.path = "notes/raw.log";
    await settle();
    expect(host.querySelector(".style-toolbar")).toBeNull();
    expect(host.style.getPropertyValue("--editor-top-pad")).toBe("");
  });
});

describe("a right-click in the JSON tree and the table", () => {
  function rightClick(el: Element): MouseEvent {
    const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
    el.dispatchEvent(e);
    return e;
  }

  test("a table cell keeps the browser's menu", async () => {
    const csv = "name,count\nfigs,1\n";
    const tab = seat(fileTab({ path: "notes/stock.csv", fileKind: "text", mode: "table", content: csv, saved: csv }));
    const { target } = await render(tab);

    const e = rightClick(target.querySelector("tbody td")!);
    await settle(2);
    expect({ prevented: e.defaultPrevented, menu: bubble() }).toEqual({ prevented: false, menu: null });
  });

  test("off the JSON tree the browser's menu stays, and a node still copies its path", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      const json = '{"a":1}';
      const tab = seat(fileTab({ path: "notes/data.json", fileKind: "text", mode: "pretty", content: json, saved: json }));
      const { target } = await render(tab);

      const off = rightClick(target.querySelector(".json-pretty")!);
      await settle(2);
      const node = [...target.querySelectorAll<HTMLElement>(".node")].find(
        (n) => n.querySelector(":scope > .key")?.textContent === '"a":',
      )!;
      const on = rightClick(node);
      await settle(2);
      expect({ off: off.defaultPrevented, menu: bubble(), on: on.defaultPrevented }).toEqual({
        off: false, menu: null, on: true,
      });
      expect(writeText).toHaveBeenCalledWith(node.title);
    } finally {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    }
  });
});

describe("the not-saved line", () => {
  // A live session reports what the file on disk lacks through the hook its
  // kind registers; this kind answers for the tab ids a test names and
  // defers on every other question. The real document sessions are off, so
  // it is the only one that answers.
  const unflushedIds = new Set<string>();
  registerLiveSessionKind({
    save: async () => "classic",
    release: () => {},
    savePaused: () => false,
    unflushed: (tabId) => unflushedIds.has(tabId),
    fallbackSaved: () => {},
  });

  beforeEach(() => {
    // No session of an earlier test may answer for this tab.
    resetDocSyncForTests();
    resetSceneSyncForTests();
    localStorage.setItem("chan.docsync", "0");
  });

  afterEach(() => {
    unflushedIds.clear();
    localStorage.removeItem("chan.docsync");
  });

  function line(target: HTMLElement): string | null {
    return target.querySelector(".editor-toolbar .error")?.textContent?.trim() ?? null;
  }

  test("a rejected text autosave keeps the typed editor and its reason", async () => {
    const tab = seat(fileTab({ id: "rejected-text", mode: "source", content: "typed text", saved: "old text" }));
    const { target } = await render(tab);
    vi.spyOn(api, "write").mockRejectedValue(new Error("disk full"));
    vi.useFakeTimers();
    try {
      scheduleAutosave(PANE, tab.id);
      await vi.advanceTimersByTimeAsync(900);
      await tick();
      expect(target.querySelector(".cm-content"), "typed editor stays mounted").not.toBeNull();
      expect(target.querySelector(".cm-content")?.textContent).toContain("typed text");
      expect(target.querySelector(".error-placeholder")).toBeNull();
      expect(line(target)).toBe("Not saved: the save request failed (disk full)");
      expect(tab.refusedUnwritten).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a failed text load still replaces the editor", async () => {
    const tab = seat(fileTab({ id: "failed-load", mode: "source" }));
    const { target } = await render(tab);
    vi.spyOn(api, "readStream").mockRejectedValue(new Error("read interrupted"));
    await reloadTabFromDisk(tab.id);
    await settle(2);
    expect(target.querySelector(".error-placeholder")?.textContent).toBe("read interrupted");
    expect(target.querySelector(".cm-content")).toBeNull();
  });

  test("shows a save error while a live session holds what the file lacks, the tab being clean", async () => {
    const tab = seat(fileTab({ id: "not-saved-1", saveError: "the server could not write it (disk full)" }));
    unflushedIds.add(tab.id);
    const { target } = await render(tab);
    expect({ line: line(target), editor: target.querySelector(".cm-content") !== null }).toEqual({
      line: "Not saved: the server could not write it (disk full)",
      editor: true,
    });
  });

  test("shows none once the file holds the buffer", async () => {
    const tab = seat(fileTab({ id: "not-saved-2", saveError: "the server could not write it (disk full)" }));
    const { target } = await render(tab);
    expect(line(target)).toBeNull();
  });

  test("keeps the editor and unsaved line when a live push has no answer", async () => {
    const tab = seat(fileTab({
      id: "not-saved-3",
      saveError: "the previous live push has not been confirmed",
      unresolvedLivePush: true,
      unresolvedLiveSave: true,
    }));
    const { target } = await render(tab);
    expect({ line: line(target), editor: target.querySelector(".cm-content") !== null }).toEqual({
      line: "Not saved: the previous live push has not been confirmed",
      editor: true,
    });
  });
});

describe("a drawing whose save is refused", () => {
  const PATH = "notes/board.excalidraw";
  const SAVED = '{"type":"excalidraw","elements":[]}';
  // What a typo in source mode leaves: a trailing comma.
  const BROKEN = '{"type":"excalidraw","elements":[],}';

  function reason(): string {
    try {
      JSON.parse(BROKEN);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error("the buffer parses");
  }

  /// The drawing on disk and open in source mode with the typo, after the
  /// save the autosave runs has refused it.
  async function refused() {
    disk.write(PATH, SAVED);
    const tab = seat(fileTab({ id: "board-1", path: PATH, fileKind: "text", mode: "source", content: BROKEN, saved: SAVED }));
    const { target } = await render(tab);
    const write = vi.spyOn(api, "write");
    await saveTab(tab);
    await settle();
    return { tab, target, write };
  }

  function toolbarLine(target: HTMLElement): string | undefined {
    return target.querySelector(".editor-toolbar .error")?.textContent?.trim();
  }

  test("keeps the editor with the buffer as typed and says that the file was not saved", async () => {
    const { target, write } = await refused();

    expect({
      line: toolbarLine(target),
      placeholder: target.querySelector(".error-placeholder") !== null,
      editor: target.querySelector(".cm-content") ? editorView(target).state.doc.toString() : null,
      writes: write.mock.calls.length,
      disk: disk.get(PATH)?.content,
    }).toEqual({
      line: `Not saved: the drawing does not parse (${reason()})`,
      placeholder: false,
      editor: BROKEN,
      writes: 0,
      disk: SAVED,
    });
  });

  test("writes the buffer at the next save once it parses, and the line goes", async () => {
    const { tab, target } = await refused();
    const fixed = '{"type":"excalidraw","elements":[] }';
    setTabContent(tab, fixed);
    await saveTab(tab);
    await settle();

    expect({
      line: toolbarLine(target),
      editor: target.querySelector(".cm-content") ? editorView(target).state.doc.toString() : null,
      disk: disk.get(PATH)?.content,
    }).toEqual({ line: undefined, editor: fixed, disk: fixed });
  });

  test("hides the line when the text is undone back to the file's", async () => {
    const { tab, target } = await refused();
    setTabContent(tab, SAVED);
    await settle();

    expect({
      line: toolbarLine(target),
      editor: target.querySelector(".cm-content") ? editorView(target).state.doc.toString() : null,
    }).toEqual({ line: undefined, editor: SAVED });
  });

  test("on the board keeps the board unmounted and points to source", async () => {
    const { tab, target } = await refused();
    setMode(tab, "canvas");
    await settle();

    expect({
      line: toolbarLine(target),
      board: island.props !== null,
      body: target.querySelector(".refused-placeholder")?.textContent?.trim(),
    }).toEqual({
      line: `Not saved: the drawing does not parse (${reason()})`,
      board: false,
      body: `This drawing has not been saved. Use Show source code (${chordFor("app.editor.toggleMode")}) to review it.`,
    });
    setTabContent(tab, SAVED);
    await settle();
    expect({
      line: toolbarLine(target),
      placeholder: target.querySelector(".refused-placeholder") !== null,
      board: island.props !== null,
      held: tab.refusedUnwritten,
    }).toEqual({ line: undefined, placeholder: false, board: true, held: false });
  });

  test("a missing file's state comes before the line", async () => {
    const { tab, target } = await refused();
    markTabFileMissing(tab.id);
    await settle();

    expect({
      toolbar: target.querySelector(".editor-toolbar")?.textContent?.trim(),
      line: toolbarLine(target),
    }).toEqual({ toolbar: "File moved or deleted", line: undefined });
  });

  test("a tab whose load failed still shows the error in place of the editor", async () => {
    const tab = seat(fileTab({ mode: "source" }));
    const { target } = await render(tab);
    vi.spyOn(api, "readStream").mockRejectedValue(new Error("read failed"));
    await reloadTabFromDisk(tab.id);
    await settle();

    expect({
      line: toolbarLine(target),
      placeholder: target.querySelector(".error-placeholder")?.textContent?.trim(),
      editor: target.querySelector(".cm-content") !== null,
    }).toEqual({ line: "read failed", placeholder: "read failed", editor: false });
  });

  describe("and the live sessions", () => {
    /// A session socket that answers only what a test feeds it.
    class SessionSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly url: string) {
        sessionSockets.push(this);
      }
      send(): void {}
      close(): void {
        this.readyState = 3;
      }
      open(): void {
        this.readyState = 1;
        this.onopen?.();
      }
      frame(f: unknown): void {
        this.onmessage?.({ data: JSON.stringify(f) });
      }
    }
    const sessionSockets: SessionSocket[] = [];
    const dialled = (kind: "scene" | "doc") => sessionSockets.filter((s) => s.url.includes(`/api/${kind}/ws`)).length;
    const FIXED = '{"type":"excalidraw","elements":[] }';

    /// Holds every write until the test lets it land.
    function heldWrites(write: { mockImplementation(fn: typeof api.write): unknown }, realWrite: typeof api.write) {
      const gate: { land?: () => void } = {};
      write.mockImplementation(
        (...args) =>
          new Promise((resolve) => {
            gate.land = () => resolve(realWrite(...args));
          }),
      );
      return gate;
    }

    async function autosaveFires(tabId: string): Promise<void> {
      scheduleAutosave(PANE, tabId);
      await new Promise((r) => setTimeout(r, 900));
      await settle();
    }

    beforeEach(() => {
      sessionSockets.length = 0;
      resetSceneSyncForTests();
      resetDocSyncForTests();
      setSocketFactory((url) =>
        url.includes("/api/scene/ws") || url.includes("/api/doc/ws")
          ? (new SessionSocket(url) as unknown as WebSocket)
          : demoSocketFactory(url),
      );
    });

    afterEach(() => {
      resetSceneSyncForTests();
      resetDocSyncForTests();
      setSocketFactory(demoSocketFactory);
    });

    test("a refused drawing switched to the board dials no scene session", async () => {
      const { tab } = await refused();
      setMode(tab, "canvas");
      await settle();

      expect({ scene: dialled("scene"), held: tab.refusedUnwritten }).toEqual({ scene: 0, held: true });
    });

    test("on the board a fixed text is written by the classic save, and the session comes after it lands", async () => {
      const realWrite = api.write.bind(api);
      const { tab, target, write } = await refused();
      const gate = heldWrites(write, realWrite);
      setTabContent(tab, FIXED);
      setMode(tab, "canvas");
      await settle();
      const pending = {
        held: tab.refusedUnwritten,
        placeholder: target.querySelector(".refused-placeholder") !== null,
        body: target.querySelector(".refused-placeholder")?.textContent?.trim(),
        board: island.props !== null,
      };
      await autosaveFires(tab.id);
      const inFlight = dialled("scene");
      gate.land?.();
      await settle();

      expect({
        pending,
        inFlight,
        scene: dialled("scene"),
        disk: disk.get(PATH)?.content,
        placeholder: target.querySelector(".refused-placeholder") !== null,
        board: island.props !== null,
      }).toEqual({
        pending: {
          held: true,
          placeholder: true,
          body: `This drawing has not been saved. Use Show source code (${chordFor("app.editor.toggleMode")}) to review it.`,
          board: false,
        },
        inFlight: 0, scene: 1, disk: FIXED, placeholder: false, board: true,
      });
    });

    test("a refused text's write carries the tokens of its load, not a snapshot's", async () => {
      const { tab, write } = await refused();
      setMode(tab, "canvas");
      await settle();
      for (const socket of sessionSockets) {
        socket.open();
        socket.frame({ type: "snapshot", version: 9, elements: [], appState: {}, files: {}, dirty: false, mtime_ns: "99000000000", cursors: [] });
      }
      await settle();
      setMode(tab, "source");
      // Back in source mode a session lingers before it lets the tab go.
      await vi.waitFor(() => expect(tab.doc).toBeUndefined());
      setTabContent(tab, FIXED);
      await saveTab(tab);

      expect(write.mock.calls.map((call) => call.slice(2))).toEqual([[null, 1, null]]);
    });

    test("a fixed drawing held by a conflict says it has not been saved", async () => {
      const { tab, target, write } = await refused();
      write.mockRejectedValue(
        new ApiError(409, "file changed on disk since it was read", {
          error: "file changed on disk since it was read",
          code: "write_conflict",
          current_mtime: 5,
          current_mtime_ns: "5",
        }),
      );
      setTabContent(tab, FIXED);
      setMode(tab, "canvas");
      await saveTab(tab);
      await settle();

      try {
        expect({
          conflict: conflictDialog.open,
          held: tab.refusedUnwritten,
          reason: toolbarLine(target),
          body: target.querySelector(".refused-placeholder")?.textContent?.trim(),
          board: island.props !== null,
          disk: disk.get(PATH)?.content,
        }).toEqual({
          conflict: true,
          held: true,
          reason: undefined,
          body: `This drawing has not been saved. Use Show source code (${chordFor("app.editor.toggleMode")}) to review it.`,
          board: false,
          disk: SAVED,
        });
      } finally {
        dismissConflict();
      }
    });

    test("a rename out of the check takes the line away and no document session until the write lands", async () => {
      const realWrite = api.write.bind(api);
      const { tab, target, write } = await refused();
      const gate = heldWrites(write, realWrite);
      rekeyTabsForRename(PATH, "notes/board.json");
      await settle();
      const renamed = { line: toolbarLine(target), doc: dialled("doc") };
      await autosaveFires(tab.id);
      const inFlight = dialled("doc");
      gate.land?.();
      await settle();

      expect({ renamed, inFlight, doc: dialled("doc"), disk: disk.get("notes/board.json")?.content }).toEqual({
        renamed: { line: undefined, doc: 0 }, inFlight: 0, doc: 1, disk: BROKEN,
      });
    });

    test("a text undone back to the file's clears both and takes its session again", async () => {
      const { tab } = await refused();
      setTabContent(tab, SAVED);
      setMode(tab, "canvas");
      await settle();

      expect({ reason: tab.saveError, held: tab.refusedUnwritten, scene: dialled("scene") }).toEqual({
        reason: null, held: false, scene: 1,
      });
    });

    test("a new reason while held dials nothing and releases nothing", async () => {
      const { tab } = await refused();
      const first = tab.saveError;
      const releases = island.releases;
      setTabContent(tab, '{"type":"excalidraw",,"elements":[]}');
      await saveTab(tab);
      await settle();

      expect({
        moved: tab.saveError !== first && typeof tab.saveError === "string",
        releases: island.releases - releases,
        scene: dialled("scene"),
        doc: dialled("doc"),
      }).toEqual({ moved: true, releases: 0, scene: 0, doc: 0 });
    });
  });
});
