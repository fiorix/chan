// @vitest-environment jsdom
//
// A pane body's centre takes the drops the tab strip takes, with the strip
// drawn or auto-hidden: a tab from another pane of this window moves in, a
// tab from another window of this scope is rebuilt there, and a file dragged
// from the file tree opens there, except over an editor or a terminal's Rich
// Prompt, which types the path the drag carries. Only a tab from this window
// meets the edge bands, where it splits the pane; an empty pane's whole body
// is the centre. This pane's own tab dropped back on its own centre stays
// where it is. A drag the pane does not take, an OS file among them, passes
// through to the terminal or editor under it.

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());

import { demoData, mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { fileTab, readTab, resetLayout, terminalTab } from "../__tests__/tabs";
import { clearRecentlyClosedTabsForTest, layout, type LeafNode, type Tab } from "../state/tabs.svelte";
import { showRichPromptForTab } from "../state/richPrompt.svelte";
import { EditorView } from "@codemirror/view";

stubAppEnvironment();

afterEach(async () => {
  clearRecentlyClosedTabsForTest();
  await settle();
  await unmountApp();
  vi.restoreAllMocks();
});

const TAB_MIME = "application/x-md-tab";
const CROSS_MIME = "application/x-chan-tab+json";
const FILE_MIME = "application/x-md-file";
const TREE_MOVE_MIME = "application/x-chan-tree-move";
const SCOPE_PREFIX = "application/x-chan-tab-scope+";
const THEIRS = SCOPE_PREFIX + "6f74686572";

const FILES = [
  { path: "README.md", kind: "document" as const, size: 5, mtime: 100, content: "hello" },
  { path: "left-1.md", kind: "document" as const, size: 5, mtime: 100, content: "saved" },
  { path: "left-2.md", kind: "document" as const, size: 5, mtime: 100, content: "saved" },
  { path: "right.md", kind: "document" as const, size: 5, mtime: 100, content: "saved" },
];

/// A drag's data as the page reads it: a dragover sees the types and not the
/// values, as a browser shows them, and a format is read as the browser reads
/// it, lowercased with "text" meaning "text/plain". CodeMirror asks for
/// "Text", so without that its drop handler would find nothing to type.
class DragData {
  store = new Map<string, string>();
  protected = false;
  effectAllowed = "";
  dropEffect = "";
  constructor(entries: Record<string, string> = {}) {
    for (const [type, value] of Object.entries(entries)) this.store.set(type, value);
  }
  setData(type: string, value: string): void {
    this.store.set(type, value);
  }
  getData(type: string): string {
    const format = type.toLowerCase() === "text" ? "text/plain" : type.toLowerCase();
    return this.protected ? "" : (this.store.get(format) ?? "");
  }
  get types(): string[] {
    return [...this.store.keys()];
  }
  setDragImage(): void {}
}

function fire(el: Element, type: string, data: DragData, clientX = 0, clientY = 0): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: data });
  Object.defineProperties(event, { clientX: { value: clientX }, clientY: { value: clientY } });
  data.protected = type === "dragover" || type === "dragenter";
  try {
    el.dispatchEvent(event);
  } finally {
    data.protected = false;
  }
  return event;
}

async function mount(autoHide: boolean, right: Tab[], left: Tab[] = defaultLeft()): Promise<void> {
  await mountApp(demoData(FILES), { preferences: { pane_strip_auto_hide: autoHide } });
  resetLayout(left, { id: "pane-left" });
  layout.nodes["pane-right"] = { kind: "leaf", id: "pane-right", tabs: right, activeTabId: right[0]?.id ?? null };
  layout.nodes["split"] = { kind: "split", id: "split", direction: "row", ratio: 0.5, a: "pane-left", b: "pane-right" };
  layout.rootId = "split";
  await settle();
}

/// Two terminals, so the left strip is drawn under auto-hide and a tab of it
/// can be dragged.
function defaultLeft(): Tab[] {
  return [terminalTab({ id: "l1", title: "Left one" }), terminalTab({ id: "l2", title: "Left two" })];
}

function paneEl(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`.pane[data-pane-id="${id}"]`);
  if (!el) throw new Error(`no pane ${id} is drawn`);
  return el;
}

/// The pane's body, given a box: jsdom lays out nothing.
function body(id: string, width = 800, height = 600): HTMLElement {
  const el = paneEl(id).querySelector<HTMLElement>(".editor-wrap")!;
  el.getBoundingClientRect = () => new DOMRect(0, 0, width, height);
  return el;
}

function stripTab(id: string, index: number): HTMLElement {
  return paneEl(id).querySelectorAll<HTMLElement>('.tab[draggable="true"]')[index]!;
}

function zones(el: HTMLElement): string[] {
  return [...el.classList].filter((name) => name.startsWith("body-drop-"));
}

function tabIds(id: string): string[] {
  const node = layout.nodes[id];
  return node?.kind === "leaf" ? node.tabs.map((t) => t.id) : [];
}

function leafCount(): number {
  return Object.values(layout.nodes).filter((n) => n.kind === "leaf").length;
}

/// This window's drag scope, as its own dragstart stamps it.
function ourScope(): string {
  const data = new DragData();
  fire(stripTab("pane-left", 0), "dragstart", data);
  data.dropEffect = "none";
  fire(stripTab("pane-left", 0), "dragend", data);
  const scope = data.types.find((type) => type.startsWith(SCOPE_PREFIX));
  if (!scope) throw new Error("the dragstart stamped no scope");
  return scope;
}

function stripHidden(id: string): boolean {
  return paneEl(id).querySelector(".tabs")!.classList.contains("auto-hidden");
}

/// A file dragged from the file tree, as FileTree's dragstart writes it: the
/// tree's own move type, the pane's open-in-pane type, and the path as plain
/// text for an editor to type.
function treeDrag(path: string): DragData {
  return new DragData({
    [TREE_MOVE_MIME]: JSON.stringify({ path, isDir: false, paths: [path] }),
    [FILE_MIME]: JSON.stringify({ path }),
    "text/plain": path,
  });
}

/// The right pane's tabs, files by path and the rest by id.
function rightPaths(): string[] {
  const right = layout.nodes["pane-right"] as LeafNode;
  return right.tabs.map((t) => (t.kind === "file" ? t.path : t.id));
}

describe.each([false, true])("with pane_strip_auto_hide %s, the centre of a pane's body", (autoHide) => {
  test("takes a tab from another pane of this window and appends it to the visible side", async () => {
    await mount(autoHide, [terminalTab({ id: "r1", title: "Right" })]);
    expect(stripHidden("pane-right"), "the lone right tab's strip follows the preference").toBe(autoHide);
    const target = body("pane-right");
    const tab = stripTab("pane-left", 1);
    const data = new DragData();
    fire(tab, "dragstart", data);
    try {
      expect(fire(target, "dragover", data, 400, 300).defaultPrevented).toBe(true);
      expect(data.dropEffect).toBe("move");
      await settle();
      expect(zones(target)).toEqual(["body-drop-centre"]);
      expect(fire(target, "drop", data, 400, 300).defaultPrevented).toBe(true);
    } finally {
      fire(tab, "dragend", data);
    }
    await settle();
    expect(tabIds("pane-right")).toEqual(["r1", "l2"]);
    expect(tabIds("pane-left")).toEqual(["l1"]);
    expect(leafCount(), "a centre drop splits nothing").toBe(2);
    expect(zones(target)).toEqual([]);
  });

  test("rebuilds a tab from another window of this scope, and refuses one from another scope", async () => {
    await mount(autoHide, [terminalTab({ id: "r1", title: "Right" })]);
    const target = body("pane-right");
    const from = JSON.stringify({ fromPaneId: "pane-right", fromSide: "a", tabId: "far", fromWindow: "another-window" });
    const cross = JSON.stringify({ kind: "file", path: "README.md" });

    const foreign = new DragData({ [TAB_MIME]: from, [CROSS_MIME]: cross, [THEIRS]: "1" });
    expect(fire(target, "dragover", foreign, 400, 300).defaultPrevented).toBe(false);
    expect(foreign.dropEffect, "another scope keeps the no-drop cursor").toBe("none");
    await settle();
    expect(zones(target)).toEqual([]);
    expect(fire(target, "drop", foreign, 400, 300).defaultPrevented).toBe(false);
    await settle();
    expect(tabIds("pane-right")).toEqual(["r1"]);

    // Near an edge too: a tab from another window cannot split this pane, so
    // the whole body is its centre.
    const ours = new DragData({ [TAB_MIME]: from, [CROSS_MIME]: cross, [ourScope()]: "1" });
    expect(fire(target, "dragover", ours, 799, 300).defaultPrevented).toBe(true);
    expect(ours.dropEffect).toBe("move");
    await settle();
    expect(zones(target)).toEqual(["body-drop-centre"]);
    expect(fire(target, "drop", ours, 799, 300).defaultPrevented, "a rebuilt tab claims the drop").toBe(true);
    await settle();
    const right = layout.nodes["pane-right"] as LeafNode;
    expect(right.tabs.map((t) => (t.kind === "file" ? t.path : t.id))).toEqual(["r1", "README.md"]);
    expect(leafCount()).toBe(2);
  });

  test("leaves a file dragged from the file tree to an editor, which types its path", async () => {
    await mount(autoHide, [fileTab({ id: "right", path: "right.md" })]);
    const target = body("pane-right");
    const content = target.querySelector(".cm-content");
    expect(content, "the right pane shows an editor").not.toBeNull();
    const data = treeDrag("README.md");
    expect(fire(content!, "dragover", data, 400, 300).defaultPrevented, "the pane leaves the dragover to the editor").toBe(false);
    await settle();
    expect(zones(target), "no centre over an editor").toEqual([]);
    fire(content!, "drop", data, 400, 300);
    await settle();
    expect(rightPaths()).toEqual(["right.md"]);
    expect(readTab("right")?.content, "the editor typed the dragged path").toContain("README.md");
  });

  test("still takes a tab dragged over an editor in its centre", async () => {
    await mount(autoHide, [fileTab({ id: "right", path: "right.md" })]);
    const target = body("pane-right");
    const content = target.querySelector(".cm-content")!;
    const tab = stripTab("pane-left", 1);
    const data = new DragData();
    fire(tab, "dragstart", data);
    try {
      expect(fire(content, "dragover", data, 400, 300).defaultPrevented).toBe(true);
      await settle();
      expect(zones(target)).toEqual(["body-drop-centre"]);
      expect(fire(content, "drop", data, 400, 300).defaultPrevented).toBe(true);
    } finally {
      fire(tab, "dragend", data);
    }
    await settle();
    expect(rightPaths()).toEqual(["right.md", "l2"]);
    expect(readTab("right")?.content, "a tab drag types nothing").toBe("saved");
  });

  test("leaves a file dragged to a terminal's Rich Prompt, which types its path", async () => {
    await mount(autoHide, [terminalTab({ id: "r1", title: "Right", terminalSessionId: "sess-r1" })]);
    showRichPromptForTab("r1");
    const target = body("pane-right");
    const composer = await vi.waitFor(() => {
      const editor = target.querySelector<HTMLElement>(".terminal-composer .cm-editor");
      if (!editor) throw new Error(`the terminal shows no Rich Prompt editor: ${target.querySelector(".terminal-composer")?.outerHTML.slice(0, 300) ?? "no composer"}`);
      return editor;
    }, { timeout: 5_000 });
    const content = composer.querySelector(".cm-content")!;
    const data = treeDrag("README.md");
    expect(fire(content, "dragover", data, 400, 300).defaultPrevented, "the pane leaves the dragover to the composer").toBe(false);
    await settle();
    expect(zones(target), "no centre over the composer").toEqual([]);
    fire(content, "drop", data, 400, 300);
    await settle();
    expect(rightPaths()).toEqual(["r1"]);
    expect(EditorView.findFromDOM(composer)?.state.doc.toString(), "the composer typed the dragged path").toContain("README.md");
  });

  test("opens a file dragged from the file tree over a terminal's screen", async () => {
    await mount(autoHide, [terminalTab({ id: "r1", title: "Right", terminalSessionId: "sess-r1" })]);
    const target = body("pane-right");
    const screen = target.querySelector<HTMLElement>(".terminal-host");
    expect(screen, "the right pane docks its terminal").not.toBeNull();
    const data = treeDrag("README.md");
    expect(fire(screen!, "dragover", data, 799, 300).defaultPrevented).toBe(true);
    expect(data.dropEffect).toBe("copy");
    await settle();
    expect(zones(target)).toEqual(["body-drop-centre"]);
    expect(fire(screen!, "drop", data, 799, 300).defaultPrevented).toBe(true);
    await settle();
    expect(rightPaths()).toEqual(["r1", "README.md"]);
    expect(zones(target)).toEqual([]);
  });

  test("opens a file dragged from the file tree over an empty pane", async () => {
    await mount(autoHide, []);
    const target = body("pane-right");
    const data = treeDrag("README.md");
    expect(fire(target, "dragover", data, 20, 300).defaultPrevented).toBe(true);
    await settle();
    expect(zones(target)).toEqual(["body-drop-centre"]);
    expect(fire(target, "drop", data, 20, 300).defaultPrevented).toBe(true);
    await settle();
    expect(rightPaths()).toEqual(["README.md"]);
    expect(leafCount()).toBe(2);
  });

  test("of an empty pane is its whole body: a tab dropped at its edge fills it and splits nothing", async () => {
    await mount(autoHide, []);
    const target = body("pane-right");
    const tab = stripTab("pane-left", 1);
    const data = new DragData();
    fire(tab, "dragstart", data);
    try {
      expect(fire(target, "dragover", data, 799, 300).defaultPrevented).toBe(true);
      await settle();
      expect(zones(target)).toEqual(["body-drop-centre"]);
      expect(fire(target, "drop", data, 799, 300).defaultPrevented).toBe(true);
    } finally {
      fire(tab, "dragend", data);
    }
    await settle();
    expect(tabIds("pane-right")).toEqual(["l2"]);
    expect(leafCount()).toBe(2);
  });
});

describe("a pane body's edges and its own tabs", () => {
  test("an edge band splits, and its width follows the body's size", async () => {
    await mount(false, [terminalTab({ id: "r1", title: "Right" })]);
    const tab = stripTab("pane-left", 1);
    const data = new DragData();
    fire(tab, "dragstart", data);
    try {
      // 150px from the left is past a large body's 120px band, and inside a
      // small body's quarter.
      const large = body("pane-right", 1600, 900);
      fire(large, "dragover", data, 150, 450);
      await settle();
      expect(zones(large)).toEqual(["body-drop-centre"]);
      const small = body("pane-right", 400, 300);
      fire(small, "dragover", data, 90, 150);
      await settle();
      expect(zones(small)).toEqual(["body-drop-left"]);
      expect(fire(small, "drop", data, 90, 150).defaultPrevented).toBe(true);
    } finally {
      fire(tab, "dragend", data);
    }
    await settle();
    expect(leafCount(), "the edge drop split the right pane").toBe(3);
    const split = Object.values(layout.nodes).find((n) => n.kind === "split" && n.b === "pane-right");
    if (split?.kind !== "split") throw new Error("no split before the right pane");
    expect(tabIds(split.a)).toEqual(["l2"]);
  });

  test("a pane's own tab dropped on its own centre stays where it is; at an edge it still splits", async () => {
    await mount(false, [terminalTab({ id: "r1", title: "Right" })]);
    const own = body("pane-left");
    const before = (layout.nodes["pane-left"] as LeafNode).tabs.slice();
    const tab = stripTab("pane-left", 0);
    const data = new DragData();
    fire(tab, "dragstart", data);
    try {
      expect(fire(own, "dragover", data, 400, 300).defaultPrevented).toBe(false);
      expect(data.dropEffect).toBe("none");
      await settle();
      expect(zones(own)).toEqual([]);
      expect(fire(own, "drop", data, 400, 300).defaultPrevented).toBe(false);
    } finally {
      fire(tab, "dragend", data);
    }
    await settle();
    const after = (layout.nodes["pane-left"] as LeafNode).tabs;
    expect(after.map((t) => t.id)).toEqual(["l1", "l2"]);
    expect(after.every((t, i) => t === before[i]), "the tabs are the same objects, not copies a reorder made").toBe(true);

    const again = new DragData();
    const first = stripTab("pane-left", 0);
    fire(first, "dragstart", again);
    try {
      expect(fire(own, "dragover", again, 799, 300).defaultPrevented).toBe(true);
      await settle();
      expect(zones(own)).toEqual(["body-drop-right"]);
      expect(fire(own, "drop", again, 799, 300).defaultPrevented).toBe(true);
    } finally {
      fire(first, "dragend", again);
    }
    await settle();
    expect(tabIds("pane-left")).toEqual(["l2"]);
    const split = Object.values(layout.nodes).find((n) => n.kind === "split" && n.a === "pane-left");
    if (split?.kind !== "split") throw new Error("no split after the left pane");
    expect(tabIds(split.b)).toEqual(["l1"]);
  });

  test("the centre highlight clears on dragleave and on dragend", async () => {
    await mount(true, [terminalTab({ id: "r1", title: "Right" })]);
    const target = body("pane-right");
    const tab = stripTab("pane-left", 1);
    const data = new DragData();
    fire(tab, "dragstart", data);
    fire(target, "dragover", data, 400, 300);
    await settle();
    expect(zones(target)).toEqual(["body-drop-centre"]);
    fire(target, "dragleave", data);
    await settle();
    expect(zones(target), "dragleave clears it").toEqual([]);

    fire(target, "dragover", data, 400, 300);
    await settle();
    expect(zones(target)).toEqual(["body-drop-centre"]);
    data.dropEffect = "none";
    fire(tab, "dragend", data);
    await settle();
    expect(zones(target), "dragend clears it").toEqual([]);
    expect(tabIds("pane-left")).toEqual(["l1", "l2"]);
  });

  test("a tmux pane takes no body drop", async () => {
    await mount(true, [terminalTab({ id: "tmux", terminalSessionId: "s0", tmuxPane: { connection: 1, pane: "%0" } })]);
    const target = body("pane-right");
    const tab = stripTab("pane-left", 1);
    const data = new DragData();
    fire(tab, "dragstart", data);
    try {
      expect(fire(target, "dragover", data, 400, 300).defaultPrevented).toBe(false);
      await settle();
      expect(zones(target)).toEqual([]);
      expect(fire(target, "drop", data, 400, 300).defaultPrevented).toBe(false);
    } finally {
      data.dropEffect = "none";
      fire(tab, "dragend", data);
    }
    await settle();
    expect(tabIds("pane-right")).toEqual(["tmux"]);
    expect(tabIds("pane-left")).toEqual(["l1", "l2"]);
  });
});

describe("an OS file over a terminal", () => {
  test("passes through the pane's body to the terminal, which takes the drop", async () => {
    await mount(true, [terminalTab({ id: "r1", title: "Right", terminalSessionId: "sess-r1" })]);
    const target = body("pane-right");
    const host = target.querySelector<HTMLElement>(".terminal-host");
    expect(host, "the right pane docks its terminal").not.toBeNull();
    // At the terminal's element a capture listener runs before the terminal's
    // own drop handler and a later bubble listener after it, so the pair
    // reads whether anything above the terminal claimed the drop and whether
    // the terminal did. The window's drop guard cancels every OS file
    // dragover on the way down, and leaves the drop to a drop zone.
    const reached: string[] = [];
    host!.addEventListener("dragover", () => reached.push("terminal dragover"));
    host!.addEventListener("drop", (e) => reached.push(`terminal drop, claimed before its handler: ${e.defaultPrevented}`), true);
    host!.addEventListener("drop", (e) => reached.push(`terminal drop, claimed after its handler: ${e.defaultPrevented}`));
    const onWindow = (e: Event) => reached.push(`window ${e.type}`);
    window.addEventListener("dragover", onWindow);
    window.addEventListener("drop", onWindow);
    try {
      const data = new DragData({ Files: "" });
      data.dropEffect = "copy";
      fire(host!, "dragover", data, 400, 300);
      expect(data.dropEffect, "the pane leaves the cursor to the terminal").toBe("copy");
      await settle();
      expect(zones(target)).toEqual([]);
      fire(host!, "drop", data, 400, 300);
    } finally {
      window.removeEventListener("dragover", onWindow);
      window.removeEventListener("drop", onWindow);
    }
    expect(reached).toEqual([
      "terminal dragover",
      "window dragover",
      "terminal drop, claimed before its handler: false",
      "terminal drop, claimed after its handler: true",
      "window drop",
    ]);
  });
});
