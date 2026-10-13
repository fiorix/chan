// @vitest-environment jsdom
//
// Keyboard focus follows the active tab. A chord switch (Cmd+Shift+[/],
// Ctrl+Alt+1..9), an open from `cs open` or the File Browser, and a press on
// a tab in the strip each send a focus pulse: the pulse blurs whatever held
// focus, and the surface of the focused tab takes the keyboard. A terminal
// tab selects on its matching left release; a file tab still pulses on press
// and release. A terminal that stops being focused
// lets go of its xterm. The pane tree (Workspace, which draws the pane and
// docks its terminal into it) is mounted over the demo workspace with a
// terminal (the stand-in xterm) and real editors.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import Workspace from "./Workspace.svelte";
import Pane from "./Pane.svelte";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { demoSocketFactory } from "../demo/socket";
import { setSocketFactory } from "../api/transport";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { refreshTree, refreshWorkspace } from "../state/store.svelte";
import {
  bumpTabFocusPulse,
  layout,
  openInPane,
  paneMode,
  moveTab,
  selectNextTabInActivePane,
  selectPrevTabInActivePane,
  selectTabAtIndexInActivePane,
  setTerminalActivity,
  tabFocusPulse,
  type FileTab,
  type LeafNode,
  type Tab,
} from "../state/tabs.svelte";
import { fileTab as harnessFileTab } from "../__tests__/tabs";
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
const focusSends = new Map<string, boolean[]>();

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
  focusSends.clear();
  setSocketFactory((url) => {
    const socket = demoSocketFactory(url);
    if (url.includes("/api/terminal/ws")) {
      const tabId = new URL(url).searchParams.get("tab_id") ?? "";
      const send = socket.send.bind(socket);
      socket.send = ((data) => {
        if (typeof data === "string") {
          const frame = JSON.parse(data) as { type?: string; focused?: boolean };
          if (frame.type === "focus") {
            const values = focusSends.get(tabId) ?? [];
            values.push(frame.focused === true);
            focusSends.set(tabId, values);
          }
        }
        send(data);
      }) as WebSocket["send"];
    }
    return socket;
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
  return harnessFileTab({ id: `file:${path}`, path, content, saved: content, ...over });
}

const rich = (): FileTab => fileTab(RICH, "wysiwyg body\n");
const plain = (): FileTab => fileTab(PLAIN, "source body\n", { mode: "source" });

async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/// Mounts the pane tree over one pane holding `tabs` (a terminal first), with
/// the first one active.
async function mountPane(tabs: Tab[]): Promise<{ target: HTMLElement; term: FakeTerminal }> {
  layout.nodes = { [PANE]: { kind: "leaf", id: PANE, tabs, activeTabId: tabs[0]!.id } };
  layout.rootId = PANE;
  layout.activePaneId = PANE;
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(Workspace, { target }));
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

function focusMessages(tabId: string): boolean[] {
  return focusSends.get(tabId) ?? [];
}

function drag(el: HTMLElement, type: "dragstart" | "dragend", dropEffect = "none"): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { setData() {}, effectAllowed: "", dropEffect } });
  el.dispatchEvent(event);
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
  test("the document release listener is removed when the pane unmounts", async () => {
    const first = terminalTab({ id: "term-first" });
    layout.nodes = { [PANE]: { kind: "leaf", id: PANE, tabs: [first], activeTabId: first.id } };
    layout.rootId = PANE;
    layout.activePaneId = PANE;
    const added = vi.spyOn(document, "addEventListener");
    const removed = vi.spyOn(document, "removeEventListener");
    const addedWindow = vi.spyOn(window, "addEventListener");
    const removedWindow = vi.spyOn(window, "removeEventListener");
    const target = document.createElement("div");
    document.body.append(target);
    try {
      const component = mount(Pane, { target, props: { pane: layout.nodes[PANE] as LeafNode } });
      await tick();
      const releases = added.mock.calls.filter((call) => call[0] === "mouseup" && call.length === 2);
      expect(releases, "one pane-level outside-release handler is installed").toHaveLength(1);
      const handler = releases[0]![1];
      expect(added.mock.calls, "the same handler cancels a pointer press").toContainEqual(["pointercancel", handler]);
      expect(addedWindow.mock.calls, "the same handler cancels on window blur").toContainEqual(["blur", handler]);
      unmount(component);
      expect(removed.mock.calls, "the installed handler is removed on destroy").toContainEqual(releases[0]);
      expect(removed.mock.calls, "pointercancel is removed on destroy").toContainEqual(["pointercancel", handler]);
      expect(removedWindow.mock.calls, "blur is removed on destroy").toContainEqual(["blur", handler]);
    } finally {
      added.mockRestore();
      removed.mockRestore();
      addedWindow.mockRestore();
      removedWindow.mockRestore();
    }
  });

  test("a terminal selects only on its matching release", async () => {
    const first = terminalTab({ id: "term-first" });
    const second = terminalTab({ id: "term-second" });
    const { target } = await mountPane([first, second]);
    const secondTab = stripTab(target, 1);
    const pulse = tabFocusPulse.value;
    const marked = paneTabs()[1] as typeof second;
    setTerminalActivity(marked, true);
    expect(marked.terminalActivity, "the inactive terminal has unseen output").toBe(true);

    press(secondTab, "mousedown");
    await settle();
    expect(activeTab()?.id, "press keeps the old terminal selected").toBe(first.id);
    expect(tabFocusPulse.value, "press defers the focus pulse").toBe(pulse);
    expect(marked.terminalActivity, "the mark stays until the matching release").toBe(true);
    secondTab.focus();
    press(secondTab, "mouseup");
    expect(marked.terminalActivity, "the matching release clears the mark synchronously").toBeUndefined();
    await settle();
    expect(activeTab()?.id).toBe(second.id);
    expect(tabFocusPulse.value).toBe(pulse + 1);
  });

  test("an already-active terminal click sends one focus message with no false between", async () => {
    const first = terminalTab({ id: "term-first" });
    const { target } = await mountPane([first]);
    const tab = stripTab(target, 0);
    const before = focusMessages(first.id).length;
    press(tab, "mousedown");
    await settle();
    tab.focus();
    press(tab, "mouseup");
    await settle();
    expect(focusMessages(first.id).slice(before), "active-tab click sends one true and no false").toEqual([true]);
  });

  test.each([
    ["unmatched release", (firstTab: HTMLElement, _secondTab: HTMLElement) => press(firstTab, "mouseup")],
    ["outside document release", (_firstTab: HTMLElement, _secondTab: HTMLElement) => { document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 })); }],
    ["window blur", (_firstTab: HTMLElement, _secondTab: HTMLElement) => { window.dispatchEvent(new Event("blur")); }],
    ["pointer cancellation", (_firstTab: HTMLElement, _secondTab: HTMLElement) => { document.dispatchEvent(new Event("pointercancel", { bubbles: true })); }],
    ["drag end", (_firstTab: HTMLElement, secondTab: HTMLElement) => drag(secondTab, "dragend")],
  ])("a %s clears the pending terminal press", async (_name, cancel) => {
    const first = terminalTab({ id: "term-first" });
    const second = terminalTab({ id: "term-second" });
    const { target } = await mountPane([first, second]);
    const firstTab = stripTab(target, 0);
    const secondTab = stripTab(target, 1);
    const pulse = tabFocusPulse.value;
    press(secondTab, "mousedown");
    cancel(firstTab, secondTab);
    press(secondTab, "mouseup");
    await settle();
    expect(activeTab()?.id, "a cancelled press cannot select on a later release").toBe(first.id);
    expect(tabFocusPulse.value).toBe(pulse);
  });

  test("a removed tab clears its press even when the same tab returns before release", async () => {
    const first = terminalTab({ id: "term-first" });
    const second = terminalTab({ id: "term-second" });
    const { target } = await mountPane([first, second]);
    const secondTab = stripTab(target, 1);
    const pulse = tabFocusPulse.value;
    press(secondTab, "mousedown");
    paneTabs().splice(1, 1);
    await settle();
    paneTabs().push(second);
    await settle();
    const restored = stripTab(target, 1);
    press(restored, "mouseup");
    expect(activeTab()?.id).toBe(first.id);
    expect(tabFocusPulse.value).toBe(pulse);
  });

  test("a stale pane clears its press before it becomes live again", async () => {
    const first = terminalTab({ id: "term-first" });
    const second = terminalTab({ id: "term-second" });
    const { target } = await mountPane([first, second]);
    const secondTab = stripTab(target, 1);
    const pulse = tabFocusPulse.value;
    press(secondTab, "mousedown");
    paneMode.stale = true;
    await settle();
    paneMode.stale = false;
    await settle();
    press(secondTab, "mouseup");
    expect(activeTab()?.id).toBe(first.id);
    expect(tabFocusPulse.value).toBe(pulse);
  });

  test("a context menu consumes the press without replaying selection on release", async () => {
    const first = terminalTab({ id: "term-first" });
    const second = terminalTab({ id: "term-second" });
    const { target } = await mountPane([first, second]);
    const restored = stripTab(target, 1);
    press(restored, "mousedown");
    restored.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 0 }));
    await settle();
    const selected = tabFocusPulse.value;
    expect(activeTab()?.id).toBe(second.id);
    press(restored, "mouseup");
    expect(tabFocusPulse.value, "release after menu does not select again").toBe(selected);
  });

  test("a cancelled drag selects its source once at dragend and cannot replay the click", async () => {
    const first = terminalTab({ id: "term-first" });
    const second = terminalTab({ id: "term-second" });
    const { target } = await mountPane([first, second]);
    const secondTab = stripTab(target, 1);
    const pulse = tabFocusPulse.value;
    press(secondTab, "mousedown");
    drag(secondTab, "dragstart");
    await settle();
    expect(activeTab()?.id, "the native drag starts before selection").toBe(first.id);
    expect(tabFocusPulse.value).toBe(pulse);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    press(secondTab, "mouseup");
    expect(tabFocusPulse.value, "a release after dragstart cannot replay the click").toBe(pulse);
    drag(secondTab, "dragend");
    await settle();
    expect(activeTab()?.id).toBe(second.id);
    expect(tabFocusPulse.value).toBe(pulse + 1);
  });

  test("a same-pane drop selects its source with no second pulse at dragend", async () => {
    const first = terminalTab({ id: "term-first" });
    const second = terminalTab({ id: "term-second" });
    const { target } = await mountPane([first, second]);
    const secondTab = stripTab(target, 1);
    const pulse = tabFocusPulse.value;
    press(secondTab, "mousedown");
    const data = new Map<string, string>();
    const transfer = { setData(type: string, value: string) { data.set(type, value); }, getData(type: string) { return data.get(type) ?? ""; }, effectAllowed: "", dropEffect: "move", types: [] };
    const start = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(start, "dataTransfer", { value: transfer });
    secondTab.dispatchEvent(start);
    expect(activeTab()?.id).toBe(first.id);
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: transfer });
    stripTab(target, 0).dispatchEvent(drop);
    await settle();
    expect(paneTabs().map((tab) => tab.id)).toEqual([second.id, first.id]);
    expect(activeTab()?.id).toBe(second.id);
    const afterDrop = tabFocusPulse.value;
    drag(secondTab, "dragend", "move");
    await settle();
    expect(tabFocusPulse.value, "dragend cannot reselect a source selected by drop").toBe(afterDrop);
    expect(tabFocusPulse.value).toBe(pulse);
  });

  test("a drop into another pane leaves source selection to the target", async () => {
    const first = terminalTab({ id: "term-first" });
    const second = terminalTab({ id: "term-second" });
    const { target } = await mountPane([first, second]);
    layout.nodes.other = { kind: "leaf", id: "other", tabs: [terminalTab({ id: "term-other" })], activeTabId: "term-other" };
    const secondTab = stripTab(target, 1);
    press(secondTab, "mousedown");
    drag(secondTab, "dragstart");
    moveTab(PANE, second.id, "other");
    const pulse = tabFocusPulse.value;
    drag(secondTab, "dragend", "move");
    await settle();
    expect(activeTab()?.id).toBe(first.id);
    expect(layout.activePaneId).toBe("other");
    expect(tabFocusPulse.value, "the source pane cannot select a tab that moved out").toBe(pulse);
  });

  test("an accepted cross-window move does not select its departing source", async () => {
    const first = terminalTab({ id: "term-first" });
    const second = terminalTab({ id: "term-second" });
    const { target } = await mountPane([first, second]);
    const secondTab = stripTab(target, 1);
    press(secondTab, "mousedown");
    drag(secondTab, "dragstart");
    const pulse = tabFocusPulse.value;
    drag(secondTab, "dragend", "move");
    await settle();
    expect(activeTab()?.id).toBe(first.id);
    expect(tabFocusPulse.value, "a source moving to another window gets no focus pulse here").toBe(pulse);
  });

  test("a press that leaves the tab before becoming a drag selects at dragend", async () => {
    const first = terminalTab({ id: "term-first" });
    const second = terminalTab({ id: "term-second" });
    const { target } = await mountPane([first, second]);
    const secondTab = stripTab(target, 1);
    const pulse = tabFocusPulse.value;
    press(secondTab, "mousedown");
    secondTab.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
    drag(secondTab, "dragstart");
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    expect(activeTab()?.id).toBe(first.id);
    drag(secondTab, "dragend");
    await settle();
    expect(activeTab()?.id).toBe(second.id);
    expect(tabFocusPulse.value).toBe(pulse + 1);
  });

  test("a non-primary terminal press keeps press-time selection", async () => {
    const first = terminalTab({ id: "term-first" });
    const second = terminalTab({ id: "term-second" });
    const { target } = await mountPane([first, second]);
    const tab = stripTab(target, 1);
    const pulse = tabFocusPulse.value;
    press(tab, "mousedown", 2);
    expect(activeTab()?.id).toBe(second.id);
    expect(tabFocusPulse.value).toBeGreaterThan(pulse);
  });

  test("an inactive pane does not focus its current terminal before the held tab's release", async () => {
    const current = terminalTab({ id: "term-current" });
    const pressed = terminalTab({ id: "term-pressed" });
    const { target } = await mountPane([current, pressed]);
    layout.nodes.other = { kind: "leaf", id: "other", tabs: [terminalTab({ id: "term-other" })], activeTabId: "term-other" };
    layout.activePaneId = "other";
    await settle();
    const pressedTab = stripTab(target, 1);
    const before = focusMessages(current.id).length;
    press(pressedTab, "mousedown");
    await settle();
    expect(layout.activePaneId).toBe("other");
    expect(focusMessages(current.id).slice(before), "the third terminal gets no press report").toEqual([]);
    press(pressedTab, "mouseup");
    await settle();
    expect(layout.activePaneId).toBe(PANE);
    expect(activeTab()?.id).toBe(pressed.id);
  });

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
