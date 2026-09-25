// @vitest-environment jsdom
//
// FileEditorTab, mounted over the in-memory demo workspace with its real
// editors. The tab menu and the body menu are opened the way the pane opens
// them (openTabMenu, a right-click in the editor body) and driven by clicks.

import { EditorView } from "@codemirror/view";
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import FileEditorTab from "./FileEditorTab.svelte";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { bufferKey, readEditorBuffer, SESSION_ID } from "../state/editorBuffer";
import { assignOverride, clearOverride } from "../state/keymapOverrides.svelte";
import { chordFor } from "../state/shortcuts";
import type { MockWorkspaceStore } from "../demo/store";
import { fileOps, refreshTree, refreshWorkspace } from "../state/store.svelte";
import { closeTabMenu, openTabMenu, tabMenu } from "../state/tabMenu.svelte";
import { layout, type FileTab, type LeafNode } from "../state/tabs.svelte";

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
    repoRoot: null,
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
    const remove = vi.spyOn(fileOps, "remove").mockResolvedValue(undefined);
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
  /// A buffer another page load left behind for the tab's path. It is dated
  /// ahead of any save the doc session reports, so only the component's own
  /// decisions can retire it.
  function strandBuffer(path: string, content: string): void {
    localStorage.setItem(
      bufferKey(path),
      JSON.stringify({
        content,
        updatedAt: Date.now() + 86_400_000,
        path,
        sessionId: "an-earlier-load",
      }),
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
    await new Promise((r) => setTimeout(r, 650));
    expect(readEditorBuffer("notes/plan.md")?.content, "the write queued before the close was cancelled").toBe(
      "# Plan\n\nUnsaved edit.\n",
    );
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
