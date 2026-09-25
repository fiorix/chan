// @vitest-environment jsdom
//
// Keyboard focus follows the active tab. A chord switch (Cmd+Shift+[/],
// Ctrl+Alt+1..9), an open from `cs open` or the File Browser, and a press on
// a tab in the strip each send a focus pulse: the pulse blurs whatever held
// focus, and the surface of the focused tab takes the keyboard. A left
// release on a terminal or file tab pulses again, so the focus the press gave
// the tab itself moves on to its surface. A terminal that stops being focused
// lets go of its xterm. A Pane is mounted over the demo workspace with a
// terminal (the stand-in xterm) and real editors.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import Pane from "./Pane.svelte";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { refreshTree, refreshWorkspace } from "../state/store.svelte";
import {
  bumpTabFocusPulse,
  layout,
  openInPane,
  selectNextTabInActivePane,
  selectPrevTabInActivePane,
  selectTabAtIndexInActivePane,
  tabFocusPulse,
  type FileTab,
  type LeafNode,
  type Tab,
} from "../state/tabs.svelte";
import { installTerminalDom, resetTerminals, terminalTab, xterm, type FakeTerminal } from "../__tests__/terminalTab";

installTerminalDom();
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);

const PANE = "focus-follow-pane";
const RICH = "notes/plan.md";
const PLAIN = "notes/code.md";
const FRESH = "notes/new.md";

const mounted: Array<Record<string, unknown>> = [];
let timers: TimerTrack;

beforeEach(async () => {
  timers = trackTimers();
  // The editors measure on animation frames; the harness's synchronous
  // frame would run those measures inside an update.
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
  installDemoWorkspace({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1, fileCount: 3, textCount: 3 },
    files: [
      { path: RICH, kind: "document", size: 13, mtime: 1, content: "wysiwyg body\n" },
      { path: PLAIN, kind: "document", size: 12, mtime: 1, content: "source body\n" },
      { path: FRESH, kind: "document", size: 9, mtime: 1, content: "new body\n" },
    ],
  });
  await refreshWorkspace();
  await refreshTree();
});

afterEach(async () => {
  for (const app of mounted.splice(0)) unmount(app);
  resetTerminals();
  await settle(2);
  uninstallDemoWorkspace();
  timers.release();
});

function fileTab(path: string, content: string, over: Partial<FileTab> = {}): FileTab {
  return {
    kind: "file",
    fileKind: "document",
    id: `file:${path}`,
    path,
    content,
    saved: content,
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

const rich = (): FileTab => fileTab(RICH, "wysiwyg body\n");
const plain = (): FileTab => fileTab(PLAIN, "source body\n", { mode: "source" });

async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/// Mounts a Pane holding `tabs` (a terminal first) with the first one active.
async function mountPane(tabs: Tab[]): Promise<{ target: HTMLElement; term: FakeTerminal }> {
  layout.nodes = { [PANE]: { kind: "leaf", id: PANE, tabs, activeTabId: tabs[0]!.id } };
  layout.rootId = PANE;
  layout.activePaneId = PANE;
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(Pane, { target, props: { pane: layout.nodes[PANE] as LeafNode } }));
  await vi.waitFor(() => expect(xterm.terminals.length).toBeGreaterThan(0));
  await settle();
  return { target, term: xterm.terminals.at(-1)! };
}

function paneTabs(): Tab[] {
  return (layout.nodes[PANE] as LeafNode).tabs;
}

function activeTab(): Tab | undefined {
  const pane = layout.nodes[PANE] as LeafNode;
  return pane.tabs.find((t) => t.id === pane.activeTabId);
}

/// The text of the editor that holds the keyboard, or "" when none does.
function focusedEditor(): string {
  return document.activeElement?.closest(".cm-content")?.textContent ?? "";
}

function stripTab(target: HTMLElement, index: number): HTMLElement {
  const tab = target.querySelectorAll<HTMLElement>(".tabs > .tab")[index];
  if (!tab) throw new Error(`no tab ${index} in the strip`);
  return tab;
}

function press(el: HTMLElement, type: "mousedown" | "mouseup", button = 0): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button }));
}

describe("the focus pulse", () => {
  test("counts up and blurs whatever held focus", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const before = tabFocusPulse.value;

    bumpTabFocusPulse();
    expect(tabFocusPulse.value).toBe(before + 1);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("a chord switch", () => {
  test("pulses once per switch, and the keyboard follows between the terminal and the editors", async () => {
    const { term } = await mountPane([terminalTab(), rich(), plain()]);
    const blurs = term.blurCount;

    let pulse = tabFocusPulse.value;
    selectNextTabInActivePane();
    await settle();
    expect(tabFocusPulse.value).toBe(pulse + 1);
    expect(focusedEditor()).toContain("wysiwyg body");
    expect(term.blurCount, "the terminal lets go of its xterm").toBeGreaterThan(blurs);

    pulse = tabFocusPulse.value;
    selectTabAtIndexInActivePane(2);
    await settle();
    expect(tabFocusPulse.value).toBe(pulse + 1);
    expect(focusedEditor(), "a source-mode tab focuses its source editor").toContain("source body");

    pulse = tabFocusPulse.value;
    selectPrevTabInActivePane();
    await settle();
    expect(tabFocusPulse.value).toBe(pulse + 1);
    expect(focusedEditor()).toContain("wysiwyg body");

    const focuses = term.focusCount;
    selectPrevTabInActivePane();
    await settle();
    expect(focusedEditor(), "the editor gives up the keyboard").toBe("");
    expect(term.focusCount, "the terminal takes it").toBeGreaterThan(focuses);
  });
});

describe("opening a file", () => {
  test("in a new tab pulses once and moves the keyboard from the terminal into its editor", async () => {
    const { term } = await mountPane([terminalTab()]);
    const blurs = term.blurCount;
    const pulse = tabFocusPulse.value;

    await openInPane(PANE, FRESH);
    await settle();
    expect(paneTabs().map((t) => t.kind)).toEqual(["terminal", "file"]);
    expect(tabFocusPulse.value).toBe(pulse + 1);
    expect(focusedEditor()).toContain("new body");
    expect(term.blurCount).toBeGreaterThan(blurs);
  });

  test("already open, re-activates its tab, pulses once and moves the keyboard into its editor", async () => {
    await mountPane([terminalTab(), rich()]);
    const pulse = tabFocusPulse.value;

    await openInPane(PANE, RICH);
    await settle();
    expect(paneTabs()).toHaveLength(2);
    expect(activeTab()?.kind).toBe("file");
    expect(tabFocusPulse.value).toBe(pulse + 1);
    expect(focusedEditor()).toContain("wysiwyg body");
  });
});

describe("the tab strip", () => {
  test("a press on the active editor's tab gives the editor the keyboard back", async () => {
    const { target } = await mountPane([terminalTab(), rich()]);
    selectNextTabInActivePane();
    await settle();
    const tab = stripTab(target, 1);
    tab.focus();

    press(tab, "mousedown");
    await settle();
    expect(focusedEditor()).toContain("wysiwyg body");
  });

  test("the left release pulses again, so the editor wins over the tab the press focused", async () => {
    const { target } = await mountPane([terminalTab(), rich()]);
    const tab = stripTab(target, 1);
    press(tab, "mousedown");
    await settle();
    // The browser's default action for the press focuses the tab itself.
    tab.focus();

    press(tab, "mouseup", 2);
    await settle();
    expect(document.activeElement, "a right release leaves focus where it is").toBe(tab);

    press(tab, "mouseup");
    await settle();
    expect(focusedEditor()).toContain("wysiwyg body");
  });
});
