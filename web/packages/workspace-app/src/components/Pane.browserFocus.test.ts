// @vitest-environment jsdom
//
// A file browser tab takes the keyboard when its pane becomes the focused
// one, and only then. The whole app is mounted over the demo workspace with a
// terminal in the top pane, holding the keyboard in its textarea (the stand-in
// xterm), and a file browser tab in the bottom pane, listing a folder of three
// files. A key reaches the terminal when its target is inside the terminal's
// element, where xterm.js and ghostty-web listen.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/xterm")).webglAddonModule());

import { demoData, mountApp, press, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { terminalTab } from "../__tests__/tabs";
import { xterm } from "../__tests__/xterm";
import { fbTreeInstance } from "../state/store.svelte";
import { cancelPaneMode, closeTab, layout, paneMode, type BrowserTab, type Tab } from "../state/tabs.svelte";

stubAppEnvironment();

const TOP = "pane-terminal";
const BOTTOM = "pane-browser";
const BROWSER = "fb-keys";
const TERMINAL = "term-keys";

const files = ["docs/a.md", "docs/b.md", "docs/c.md"].map((path) => ({
  path,
  kind: "document" as const,
  size: 4,
  mtime: 100,
  content: "body",
}));

/// Every keydown whose target sat inside a terminal's element.
const terminalKeys: string[] = [];
function recordTerminalKeys(e: KeyboardEvent): void {
  if (e.target instanceof Element && e.target.closest(".terminal-tab")) terminalKeys.push(e.key);
}

beforeEach(async () => {
  xterm.textareaFocus = true;
  terminalKeys.length = 0;
  document.addEventListener("keydown", recordTerminalKeys, true);
  await mountApp(demoData(files));
});

afterEach(async () => {
  cancelPaneMode();
  document.removeEventListener("keydown", recordTerminalKeys, true);
  await unmountApp();
  xterm.terminals.splice(0);
  xterm.textareaFocus = false;
});

function browserTab(over: Partial<BrowserTab> = {}): BrowserTab {
  return {
    kind: "browser",
    id: BROWSER,
    title: "Files",
    inspectorOpen: false,
    directory: "docs",
    selected: "docs/a.md",
    selectedPaths: ["docs/a.md"],
    ...over,
  };
}

/// The terminal above the browser, split in a column, with `active` the
/// focused pane, laid out at once as a session restore lays it out.
async function layOut(
  { active = TOP, top = [terminalTab({ id: TERMINAL })], bottom = [browserTab()], bottomActive = bottom[0]?.id ?? null }:
    { active?: string; top?: Tab[]; bottom?: Tab[]; bottomActive?: string | null } = {},
): Promise<void> {
  layout.nodes = {
    root: { kind: "split", id: "root", direction: "column", a: TOP, b: BOTTOM, ratio: 0.5 },
    [TOP]: { kind: "leaf", id: TOP, tabs: top, activeTabId: top[0]?.id ?? null },
    [BOTTOM]: { kind: "leaf", id: BOTTOM, tabs: bottom, activeTabId: bottomActive },
  };
  layout.rootId = "root";
  layout.activePaneId = active;
  await settleLong();
  await vi.waitFor(() => expect(rows().length).toBe(3));
}

async function settleLong(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await settle();
    await new Promise((r) => setTimeout(r, 0));
  }
}

function pane(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`.pane[data-pane-id="${id}"]`);
  if (!el) throw new Error(`no pane ${id}`);
  return el;
}

function browser(): HTMLElement {
  const el = pane(BOTTOM).querySelector<HTMLElement>(".browser");
  if (!el) throw new Error("no file browser in the bottom pane");
  return el;
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`.pane[data-pane-id="${BOTTOM}"] .browser [aria-selected]`)];
}

function selected(): string | null {
  return fbTreeInstance(`fb-tab-${BROWSER}`)?.selection.path ?? null;
}

function terminalTextarea(): HTMLTextAreaElement {
  const textarea = xterm.terminals.at(-1)?.textarea;
  if (!textarea) throw new Error("the terminal opened no textarea");
  return textarea;
}

/// The terminal holding the keyboard, as after a press into it.
async function terminalHoldsKeyboard(): Promise<void> {
  terminalTextarea().focus();
  await settleLong();
  expect(document.activeElement, "the terminal holds the keyboard").toBe(terminalTextarea());
}

/// A key typed at whatever holds the keyboard, as the browser targets it.
async function typeKey(key: string, code = key): Promise<void> {
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true }));
  await settleLong();
}

/// A primary press and release as a browser runs them for a trusted event:
/// each listener's microtasks run before the press's default action, which
/// focuses the pressed element's nearest focusable ancestor, or leaves the
/// keyboard on the body when there is none, unless a listener prevented it.
async function click(el: HTMLElement): Promise<void> {
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
  el.dispatchEvent(down);
  await settle();
  if (!down.defaultPrevented) {
    const focusable = el.closest<HTMLElement>("[tabindex], button, input, textarea, select, a[href]");
    if (focusable) focusable.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  }
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  await settleLong();
}

/// The browser holds the keyboard, an ArrowDown there moves its selection,
/// and no key reached the terminal.
async function expectBrowserTakesKeys(): Promise<void> {
  expect(layout.activePaneId).toBe(BOTTOM);
  expect(browser().contains(document.activeElement), "the browser holds the keyboard").toBe(true);
  expect(selected()).toBe("docs/a.md");
  await typeKey("ArrowDown");
  expect(selected(), "an ArrowDown in the browser moves its selection").toBe("docs/b.md");
  expect(terminalKeys, "no key reached the terminal").toEqual([]);
}

describe("a pane focus move from a terminal to a file browser hands the browser the keyboard", () => {
  test("Next pane", async () => {
    await layOut();
    await terminalHoldsKeyboard();
    press({ key: "]", code: "BracketRight", altKey: true });
    await settleLong();
    await expectBrowserTakesKeys();
  });

  test("Previous pane", async () => {
    await layOut();
    await terminalHoldsKeyboard();
    press({ key: "[", code: "BracketLeft", altKey: true });
    await settleLong();
    await expectBrowserTakesKeys();
  });

  test("Hybrid Nav's commit", async () => {
    await layOut();
    await terminalHoldsKeyboard();
    press({ key: ".", code: "Period", ctrlKey: true });
    press({ key: "h", code: "KeyH" });
    await settleLong();
    expect(paneMode.active).toBe(true);
    press({ key: "ArrowDown", code: "ArrowDown" });
    press({ key: "Enter", code: "Enter" });
    await settleLong();
    expect(paneMode.active).toBe(false);
    await expectBrowserTakesKeys();
  });

  test("a press on the browser pane's strip dead zone", async () => {
    await layOut();
    await terminalHoldsKeyboard();
    const deadZone = pane(BOTTOM).querySelector<HTMLElement>(".tabs .dead-zone");
    if (!deadZone) throw new Error("no dead zone in the browser pane's strip");
    await click(deadZone);
    await expectBrowserTakesKeys();
  });

  test("a press on the browser's tab in the strip", async () => {
    await layOut();
    await terminalHoldsKeyboard();
    const tab = pane(BOTTOM).querySelector<HTMLElement>(".tabs .tab-row > .tab");
    if (!tab) throw new Error("no browser tab in the strip");
    await click(tab);
    await expectBrowserTakesKeys();
  });

  test("a press on the strip's dead zone of the focused browser pane takes the keyboard back from the body", async () => {
    await layOut({ active: BOTTOM });
    expect(browser().contains(document.activeElement), "the focused pane's browser holds the keyboard").toBe(true);
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    const deadZone = pane(BOTTOM).querySelector<HTMLElement>(".tabs .dead-zone");
    if (!deadZone) throw new Error("no dead zone in the browser pane's strip");
    await click(deadZone);
    await expectBrowserTakesKeys();
  });

  test("closing a browser tab shows the next one in the focused pane with the keyboard", async () => {
    const other = browserTab({ id: "fb-other", selected: "docs/c.md", selectedPaths: ["docs/c.md"] });
    await layOut({ active: BOTTOM, bottom: [browserTab(), other], bottomActive: other.id });
    (document.activeElement as HTMLElement | null)?.blur();
    await closeTab(BOTTOM, other.id);
    await settleLong();
    await expectBrowserTakesKeys();
  });

  test.each([
    { place: "the space beside a short listing", selector: ".tree-wrap" },
    { place: "the status line", selector: ".browser-status" },
  ])("a press on the browser's own chrome, $place", async ({ selector }) => {
    await layOut();
    await terminalHoldsKeyboard();
    const chrome = browser().querySelector<HTMLElement>(selector);
    if (!chrome) throw new Error(`no ${selector} in the browser`);
    await click(chrome);
    await expectBrowserTakesKeys();
  });

  test("a drag that selects the browser's text leaves the keyboard for the copy", async () => {
    await layOut({ active: BOTTOM });
    const status = browser().querySelector<HTMLElement>(".browser-status");
    const toolbar = browser().querySelector<HTMLElement>(".browser-toolbar");
    if (!status || !toolbar) throw new Error("no status line or toolbar in the browser");
    (document.activeElement as HTMLElement | null)?.blur();
    // A drag from the toolbar to the status line: the press leaves the
    // keyboard on the body (neither is focusable), the drag selects the text
    // between, and the click goes to the two ends' common ancestor.
    toolbar.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    await settle();
    const range = document.createRange();
    range.setStartBefore(toolbar);
    range.setEndAfter(status);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    status.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    browser().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await settleLong();
    expect(window.getSelection()?.isCollapsed).toBe(false);
    expect(document.activeElement).toBe(document.body);
    window.getSelection()?.removeAllRanges();
  });

  test("the browser keeps its selection and the keyboard comes back to the terminal on the way back", async () => {
    await layOut();
    await terminalHoldsKeyboard();
    press({ key: "]", code: "BracketRight", altKey: true });
    await settleLong();
    await typeKey("ArrowDown");
    expect(selected()).toBe("docs/b.md");

    press({ key: "]", code: "BracketRight", altKey: true });
    await settleLong();
    expect(layout.activePaneId).toBe(TOP);
    expect(document.activeElement, "the terminal takes the keyboard back").toBe(terminalTextarea());
    press({ key: "]", code: "BracketRight", altKey: true });
    await settleLong();
    expect(browser().contains(document.activeElement)).toBe(true);
    expect(selected(), "the browser kept its selection").toBe("docs/b.md");
  });
});

describe("nothing takes the keyboard without a focus move", () => {
  test("a browser tab mounted in a background pane leaves it on a field outside the panes", async () => {
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    await layOut({ top: [] });
    expect(layout.activePaneId).toBe(TOP);
    expect(document.activeElement, "the field keeps the keyboard").toBe(field);
  });

  test("Hybrid Nav's commit back to the terminal's pane leaves it in the terminal", async () => {
    await layOut();
    await terminalHoldsKeyboard();
    press({ key: ".", code: "Period", ctrlKey: true });
    press({ key: "h", code: "KeyH" });
    await settleLong();
    expect(paneMode.active).toBe(true);
    press({ key: "Enter", code: "Enter" });
    await settleLong();
    expect(paneMode.active).toBe(false);
    expect(layout.activePaneId).toBe(TOP);
    expect(document.activeElement, "the terminal takes the keyboard back").toBe(terminalTextarea());
    expect(browser().contains(document.activeElement)).toBe(false);
  });
});
