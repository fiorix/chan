// @vitest-environment jsdom

// The terminal find bar over the shared real widget and vendored core:
// command routing, keyboard stepping, counts and announcements, selection
// ownership, and search lifetime. Frames are controlled by each scan case.

import { readFileSync } from "node:fs";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Terminal } from "@chan/ghostty-web-ng";
import { type SearchState, VtSearch } from "@chan/ghostty-web-ng/vt";
import TerminalTab from "./TerminalTab.svelte";
import terminalTabSource from "./TerminalTab.svelte?raw";
import { allCommands } from "../state/commands";
import { hydrateOverrides } from "../state/keymapOverrides.svelte";
import type { TerminalTab as TerminalTabState } from "../state/tabs.svelte";
import { modelPointerCapture, mousePointer } from "../__tests__/pointer";
import { terminalPreferences } from "../__tests__/standalone";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { closeTabMenu } from "../state/tabMenu.svelte";
import { FIND_ANNOUNCE_INTERVAL_MS } from "../terminal/findAnnouncer";
import { confirmState, resolveConfirm } from "../state/confirm.svelte";
import { ghosttyFixture, mountGhosttyTerminal, openedGhostty } from "../__tests__/ghosttyTab";
import {
  attach,
  installTerminalDom,
  output as socketOutput,
  receive,
  resetTerminals,
  seatTerminals,
  sentFrames,
  TerminalSocket,
  terminalTab,
} from "../__tests__/terminalTab";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

installTerminalDom();

beforeEach(() => __testSetStandalonePreferences(terminalPreferences()));
afterEach(() => {
  resetTerminals();
  __testSetStandalonePreferences(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function renderTerminal(tab: TerminalTabState, focused: boolean) {
  const [seated] = seatTerminals([tab]);
  return mountGhosttyTerminal(TerminalTab, seated!, { focused });
}

// Six rows from the top of a cleared screen, needles on rows 1, 3 and 5.
const NEEDLES = "\x1b[2J\x1b[3J\x1b[H" + ["a", "needle b", "c", "needle d", "e", "needle f"].join("\r\n");
const match = (row: number) => ({ start: { col: 0, absoluteRow: row }, end: { col: 5, absoluteRow: row } });

async function renderGhostty(text = NEEDLES): Promise<Terminal> {
  const { term } = await renderTerminal(terminalTab(), true);
  const socket = TerminalSocket.all[0]!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  await output(text);
  expect(term.wasmTerm!.plainText()).toContain(text.split("\r\n").at(-1)!);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return term;
}

async function output(text: string): Promise<void> {
  await socketOutput(TerminalSocket.all[0]!, text);
}

function activeHighlight(term: Terminal) {
  return term.highlights.get("search-active")?.ranges[0] ?? null;
}

// Finite work (search and fitting) drains; a callback that reschedules
// itself, such as the widget's render loop, stays live for the next frame.
function holdFrames() {
  const queue = new Map<number, FrameRequestCallback>();
  const recurring = new Set<FrameRequestCallback>();
  let next = 1;
  globalThis.requestAnimationFrame = (cb) => {
    const id = next++;
    queue.set(id, cb);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => { queue.delete(id); };
  const pending = () => [...queue.values()].filter((cb) => !recurring.has(cb)).length;
  const frame = () => {
    const runs = [...queue.entries()];
    for (const [id, run] of runs) {
      if (!queue.delete(id)) continue;
      run(0);
      if ([...queue.values()].includes(run)) recurring.add(run);
    }
  };
  return {
    pending,
    frame,
    settle() {
      for (let i = 0; pending(); i++) {
        if (i > 1000) throw new Error("finite animation-frame work never stopped");
        frame();
      }
    },
  };
}

async function findNeedle(term: Terminal) {
  const frames = holdFrames();
  const input = await openFindWithQuery("needle");
  frames.settle();
  await tick();
  expect(activeHighlight(term)).toEqual(match(5));
  expect(term.getSelectionRange()).toBeNull();
  expect(countElement()?.textContent).toBe("1 of 3");
  return { input, frames };
}

function fireCommand(name: string): void {
  window.dispatchEvent(new CustomEvent("chan:command", { detail: { name } }));
}

function findInput(): HTMLInputElement | null {
  return document.querySelector(".terminal-find input.find");
}

function countElement(): HTMLElement | null {
  return document.querySelector(".terminal-find .find-count");
}

/// The bar's live region, what a screen reader hears of the count.
function statusRegion(): HTMLElement | null {
  return document.querySelector('.terminal-find [role="status"]');
}

function typeQuery(input: HTMLInputElement, query: string): void {
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function openFindWithQuery(query: string): Promise<HTMLInputElement> {
  fireCommand("app.find.open");
  await tick();
  await tick();
  const input = findInput();
  expect(input).not.toBeNull();
  typeQuery(input!, query);
  await tick();
  return input!;
}

/// Restart the focused terminal and answer its confirm; resolves once the
/// new terminal has dialled its own socket.
async function restartTerminal(): Promise<TerminalSocket> {
  const sockets = TerminalSocket.all.length;
  fireCommand("app.terminal.restart");
  expect(confirmState.open, "a terminal with a session asks before it restarts").toBe(true);
  resolveConfirm(true);
  await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(sockets + 1));
  await tick();
  return TerminalSocket.all.at(-1)!;
}

function pressEnter(input: HTMLInputElement, shiftKey = false): void {
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey, bubbles: true }));
}

describe("find and user selection coexistence", () => {
  test.each(["Escape", "empty query"] as const)("query and steps preserve selection, and %s clears only search-active", async (close) => {
    const term = await renderGhostty();
    const users = { start: { col: 0, absoluteRow: 1 }, end: { col: 7, absoluteRow: 1 } };
    term.setSelection(users);
    const text = term.getSelection();
    term.highlights.set("annotation", [match(3)]);
    const frames = holdFrames();
    const input = await openFindWithQuery("needle");
    frames.settle();
    await tick();
    expect(term.getSelectionRange(), "query preserves the user's range").toEqual(users);
    expect(term.getSelection()).toBe(text);
    expect(activeHighlight(term)).toEqual(match(5));
    pressEnter(input);
    await tick();
    expect(activeHighlight(term)).toEqual(match(3));
    expect(term.getSelectionRange(), "stepping preserves the user's range").toEqual(users);
    typeQuery(input, "needle b");
    frames.settle();
    await tick();
    expect(activeHighlight(term)).toEqual(users);
    expect(term.getSelectionRange()).toEqual(users);
    if (close === "Escape") input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    else typeQuery(input, "");
    await tick();
    expect(activeHighlight(term)).toBeNull();
    expect(term.getSelectionRange()).toEqual(users);
    expect(term.getSelection()).toBe(text);
    expect(term.highlights.get("annotation")?.ranges).toEqual([match(3)]);
  });
});

// Find paints its match and leaves the selection to the user, so the menu's
// Copy and the Copy command read the match from its highlight.
describe("Copy with a find match showing", () => {
  function clipboardWrites() {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    return writeText;
  }
  afterEach(() => { delete (navigator as { clipboard?: unknown }).clipboard; });

  async function copied(writeText: ReturnType<typeof clipboardWrites>, by: () => void): Promise<string[]> {
    writeText.mockClear();
    by();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
    return writeText.mock.calls.map(([text]) => text);
  }
  const command = () => fireCommand("terminal.copy");
  const chord = () => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "terminal.copy", chord: true } }));
  const SCROLLBACK = "a\nneedle b\nc\nneedle d\ne\nneedle f";

  test("copies the match with nothing selected, the selection when there is one, and the scrollback once the bar closes", async () => {
    const term = await renderGhostty();
    const writeText = clipboardWrites();
    const { input, frames } = await findNeedle(term);
    expect(await copied(writeText, command), "the newest match").toEqual(["needle"]);
    expect(term.getSelectionRange(), "the copy selects nothing").toBeNull();
    expect(activeHighlight(term)).toEqual(match(5));

    pressEnter(input);
    await tick();
    expect(activeHighlight(term)).toEqual(match(3));
    typeQuery(input, "needle d");
    frames.settle();
    await tick();
    expect(activeHighlight(term)).toEqual({ start: { col: 0, absoluteRow: 3 }, end: { col: 7, absoluteRow: 3 } });
    expect(await copied(writeText, command), "the match the bar shows now").toEqual(["needle d"]);
    expect(await copied(writeText, chord), "the copy chord stays the selection's alone").toEqual([]);

    term.setSelection({ start: { col: 0, absoluteRow: 1 }, end: { col: 7, absoluteRow: 1 } });
    expect(await copied(writeText, command), "the user's selection wins").toEqual(["needle b"]);
    expect(await copied(writeText, chord)).toEqual(["needle b"]);
    term.clearSelection();

    findInput()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(findInput()).toBeNull();
    expect(await copied(writeText, command), "no bar, no match: the scrollback").toEqual([SCROLLBACK]);
  });

  test("copies the scrollback while the bar's query matches nothing", async () => {
    const term = await renderGhostty();
    const writeText = clipboardWrites();
    const frames = holdFrames();
    await openFindWithQuery("absent");
    frames.settle();
    await tick();
    expect(activeHighlight(term)).toBeNull();
    expect(await copied(writeText, command)).toEqual([SCROLLBACK]);
  });
});

describe("terminal find command routing", () => {
  test("app.find.open opens the find bar on the focused terminal", async () => {
    await renderTerminal(terminalTab(), true);
    expect(findInput()).toBeNull();

    fireCommand("app.find.open");
    await tick();
    await tick();

    expect(findInput()).not.toBeNull();
  });

  test("the catalog's Find command opens the bar on the focused terminal, under the terminal's own find id", async () => {
    await renderTerminal(terminalTab(), true);
    expect(findInput()).toBeNull();

    const command = allCommands().find((c) => c.id === "terminal.find");
    expect(command, "the terminal's find is a catalog command").toBeDefined();
    command!.run();
    await tick();
    await tick();

    expect(findInput()).not.toBeNull();
  });

  test("an unfocused terminal ignores app.find.open", async () => {
    await renderTerminal(terminalTab(), false);

    fireCommand("app.find.open");
    await tick();
    await tick();

    expect(findInput()).toBeNull();
  });

  test("typing a changed query highlights its newest match without creating a selection", async () => {
    const term = await renderGhostty("\x1b[2J\x1b[3J\x1b[Hne a\r\nnee b\r\nxx\r\nne c");
    const frames = holdFrames();
    const input = await openFindWithQuery("nee");
    frames.settle();
    await tick();
    expect(activeHighlight(term)).toEqual({ start: { col: 0, absoluteRow: 1 }, end: { col: 2, absoluteRow: 1 } });
    expect(term.getSelection()).toBe("");

    typeQuery(input, "ne");
    frames.settle();
    await tick();
    expect(activeHighlight(term)).toEqual({ start: { col: 0, absoluteRow: 3 }, end: { col: 1, absoluteRow: 3 } });
    expect(term.getSelection()).toBe("");
    expect(countElement()?.textContent).toBe("1 of 3");
  });

  test("Enter steps to older output and Shift+Enter to newer", async () => {
    const term = await renderGhostty();
    const { input } = await findNeedle(term);
    pressEnter(input);
    await tick();
    expect(activeHighlight(term)).toEqual(match(3));
    expect(countElement()?.textContent).toBe("2 of 3");
    pressEnter(input, true);
    await tick();
    expect(activeHighlight(term)).toEqual(match(5));
    expect(countElement()?.textContent).toBe("1 of 3");
  });

  test("app.find.next steps to older output and app.find.prev to newer", async () => {
    const term = await renderGhostty();
    await findNeedle(term);
    fireCommand("app.find.next");
    await tick();
    expect(activeHighlight(term)).toEqual(match(3));
    expect(countElement()?.textContent).toBe("2 of 3");
    fireCommand("app.find.prev");
    await tick();
    expect(activeHighlight(term)).toEqual(match(5));
    expect(countElement()?.textContent).toBe("1 of 3");
  });

  test("app.find.next without an open find bar is inert", async () => {
    const term = await renderGhostty();
    const { input } = await findNeedle(term);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(findInput()).toBeNull();
    term.select(0, 0, 1);
    expect(term.getSelection()).toBe("a");
    expect(activeHighlight(term), "closing the bar drops the highlight").toBeNull();
    fireCommand("app.find.next");
    await tick();
    expect(findInput()).toBeNull();
    expect(term.getSelection()).toBe("a");
    expect(activeHighlight(term), "the step highlights nothing").toBeNull();
  });
});

// The row names the chord that opens this bar, `terminal.find`: Cmd+F on
// macOS and Ctrl+Shift+F elsewhere, in the desktop app and in a browser. The
// page's own find chord is a different key off macOS, where Ctrl+F is the
// shell's, and has no browser form.
describe("the terminal menu's Find row", () => {
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)";
  const LINUX = "Mozilla/5.0 (X11; Linux x86_64)";
  const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
  const tauri = window as unknown as { __TAURI_INTERNALS__?: unknown };

  afterEach(() => {
    delete tauri.__TAURI_INTERNALS__;
    // The menu's state outlives the component, and a menu left open is
    // drawn at the next mount, before that case names its platform.
    closeTabMenu();
  });

  test.each([
    ["the Linux desktop", LINUX, true, "Ctrl+Shift+F"],
    ["the Windows desktop", WINDOWS, true, "Ctrl+Shift+F"],
    ["the macOS desktop", MAC, true, "Cmd+F"],
    ["a browser on Linux", LINUX, false, "Ctrl+Shift+F"],
    ["a browser on macOS", MAC, false, "Cmd+F"],
  ] as const)("on %s shows the chord that opens the bar", async (_where, agent, desktop, chord) => {
    await renderTerminal(terminalTab(), true);
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agent);
    if (desktop) tauri.__TAURI_INTERNALS__ = {};
    document
      .querySelector(".terminal-tab")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await tick();
    await tick();
    const row = [...document.body.querySelectorAll<HTMLButtonElement>("button.mbtn")].find(
      (b) => b.querySelector(".mbtn-label")?.textContent?.trim() === "Find",
    );
    expect(row, "the body menu offers Find").toBeTruthy();
    expect(row!.querySelector(".mbtn-chord")?.textContent?.trim()).toBe(chord);

    // The same chord, pressed in the terminal, opens the bar.
    const mod = agent === MAC ? { metaKey: true } : { ctrlKey: true, shiftKey: true };
    document
      .querySelector(".terminal-tab")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: agent === MAC ? "f" : "F", code: "KeyF", bubbles: true, cancelable: true, ...mod }));
    await tick();
    await tick();
    expect(findInput()).not.toBeNull();
  });
});

describe("terminal find count", () => {
  test("reads k of n with k counting from the newest match", async () => {
    const term = await renderGhostty();
    const { input } = await findNeedle(term);
    expect(countElement()?.textContent).toBe("1 of 3");
    pressEnter(input);
    pressEnter(input);
    await tick();
    expect(activeHighlight(term)).toEqual(match(1));
    expect(countElement()?.textContent).toBe("3 of 3");
  });

  test("is heard through a named status region, the shown count hidden from screen readers", async () => {
    await renderGhostty("needle");
    const frames = holdFrames();
    await openFindWithQuery("needle");
    frames.settle();
    await tick();
    const region = statusRegion();
    expect(region?.getAttribute("aria-label")).toBe("find matches");
    expect(region?.textContent, "a final count is heard at once").toBe("1 of 1");
    expect(countElement()?.textContent).toBe("1 of 1");
    expect(countElement()?.getAttribute("aria-hidden")).toBe("true");
    expect(countElement()?.getAttribute("role")).toBeNull();
  });

  test("reads 0 of 0 when nothing matches", async () => {
    const term = await renderGhostty();
    const frames = holdFrames();
    await openFindWithQuery("absent");
    frames.settle();
    await tick();
    expect(term.getSelection()).toBe("");
    expect(countElement()?.textContent).toBe("0 of 0");
  });


  test("goes blank when the query empties and clears the highlight", async () => {
    const term = await renderGhostty();
    const { input, frames } = await findNeedle(term);
    typeQuery(input, "");
    frames.settle();
    await tick();
    expect(activeHighlight(term)).toBeNull();
    expect(term.hasSelection()).toBe(false);
    expect(term.getSelection()).toBe("");
    expect(countElement()?.textContent).toBe("");
  });

  test("Escape closes the bar, clears the highlight and drops the count", async () => {
    const term = await renderGhostty();
    const { input } = await findNeedle(term);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(findInput()).toBeNull();
    expect(activeHighlight(term)).toBeNull();
    expect(term.hasSelection()).toBe(false);
    expect(term.getSelection()).toBe("");
    fireCommand("app.find.open");
    await tick();
    await tick();
    expect(findInput()?.value).toBe("needle");
    expect(countElement()?.textContent).toBe("");
  });
});

// Find next and Find previous are the desktop's chords (Cmd+G and Cmd+Shift+G
// on macOS, Ctrl+G and Ctrl+Shift+G elsewhere), and its key bridge claims
// them ahead of the page and sends the command. Ctrl+G is the exception: it
// is BEL to a shell, so the bridge leaves it to a focused terminal tab, and
// the find input is inside that tab. The input therefore steps on the chord
// itself. Each desktop case runs chan-desktop's own bridge script over this
// window, so a key the bridge claims and a key the input takes are counted
// together: one press, one step.
describe("the find stepping chords in the find input", () => {
  const AGENTS = {
    mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
    linux: "Mozilla/5.0 (X11; Linux x86_64)",
    windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  } as const;
  const KEY_BRIDGE = readFileSync("../../../desktop/src-tauri/src/key_bridge.js", "utf8");
  const tauri = window as unknown as { __TAURI_INTERNALS__?: unknown };
  let removeBridge: (() => void) | null = null;

  afterEach(() => {
    removeBridge?.();
    removeBridge = null;
    delete tauri.__TAURI_INTERNALS__;
    hydrateOverrides(null);
  });

  /// The rest of the case runs in a browser on `os`.
  function inBrowser(os: keyof typeof AGENTS): void {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(AGENTS[os]);
  }

  /// The rest of the case runs in the desktop app on `os`, with its key
  /// bridge listening on the window in the capture phase unless `bridge` is
  /// false, the state of a window whose bridge did not survive a navigation.
  function onDesktop(os: keyof typeof AGENTS, bridge = true): void {
    inBrowser(os);
    tauri.__TAURI_INTERNALS__ = {};
    if (!bridge) return;
    const added: Array<[string, EventListener, boolean]> = [];
    const host = {
      addEventListener(type: string, listener: EventListener, capture: boolean) {
        added.push([type, listener, capture]);
        window.addEventListener(type, listener, capture);
      },
      dispatchEvent: (event: Event) => window.dispatchEvent(event),
    };
    new Function("window", "location", "CustomEvent", "navigator", KEY_BRIDGE)(
      host,
      { pathname: "/" },
      CustomEvent,
      { userAgent: AGENTS[os] },
    );
    expect(added.map(([type, , capture]) => [type, capture]), "the bridge listens for keys").toEqual([["keydown", true]]);
    removeBridge = () => {
      for (const [type, listener, capture] of added) window.removeEventListener(type, listener, capture);
    };
  }

  let term: Terminal;

  async function openBar(): Promise<HTMLInputElement> {
    term = await renderGhostty();
    const { input } = await findNeedle(term);
    expect(document.activeElement, "the find input holds the keyboard").toBe(input);
    expect(input.closest(".terminal-tab.active"), "inside the active terminal tab").not.toBeNull();
    return input;
  }

  async function press(input: HTMLInputElement, init: KeyboardEventInit, row: number, count: string): Promise<KeyboardEvent> {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    input.dispatchEvent(event);
    await tick();
    expect(activeHighlight(term)).toEqual(match(row));
    expect(term.getSelectionRange()).toBeNull();
    expect(countElement()?.textContent).toBe(count);
    return event;
  }

  const G = { key: "g", code: "KeyG" };
  const SHIFT_G = { key: "G", code: "KeyG", shiftKey: true };

  test.each(["linux", "windows"] as const)("on the %s desktop Ctrl+G steps to older output once", async (os) => {
    const input = await openBar();
    onDesktop(os);
    const next = await press(input, { ...G, ctrlKey: true }, 3, "2 of 3");
    expect(next.defaultPrevented).toBe(true);
    await press(input, { ...SHIFT_G, ctrlKey: true }, 5, "1 of 3");
  });

  test("on the macOS desktop Cmd+G steps once, through the bridge's command, and Ctrl+G is no find chord", async () => {
    const input = await openBar();
    onDesktop("mac");
    await press(input, { ...G, metaKey: true }, 3, "2 of 3");
    await press(input, { ...SHIFT_G, metaKey: true }, 5, "1 of 3");
    const control = await press(input, { ...G, ctrlKey: true }, 5, "1 of 3");
    expect(control.defaultPrevented).toBe(false);
  });

  test.each([
    ["mac", { metaKey: true }],
    ["linux", { ctrlKey: true }],
  ] as const)("on the %s desktop without its bridge both chords step from the input", async (os, mod) => {
    const input = await openBar();
    onDesktop(os, false);
    await press(input, { ...G, ...mod }, 3, "2 of 3");
    await press(input, { ...SHIFT_G, ...mod }, 5, "1 of 3");
  });

  test.each([
    ["linux", { ctrlKey: true }],
    ["mac", { metaKey: true }],
  ] as const)("in a browser on %s the keys are left alone", async (os, mod) => {
    const input = await openBar();
    inBrowser(os);
    for (const key of [G, SHIFT_G]) {
      const pressed = await press(input, { ...key, ...mod }, 5, "1 of 3");
      expect(pressed.defaultPrevented, "the browser keeps its own find keys").toBe(false);
    }
  });

  test("a remapped Find next is the chord the input steps on", async () => {
    const input = await openBar();
    onDesktop("linux");
    hydrateOverrides({ "app.find.next": { linux: "Mod+Alt+N" } });
    await press(input, { key: "n", code: "KeyN", ctrlKey: true, altKey: true }, 3, "2 of 3");
    await press(input, { ...G, ctrlKey: true }, 3, "2 of 3");
  });
});

describe("terminal find on the ghostty backend", () => {
  test("the menu's Find row opens the bar, as app.find.open does", async () => {
    await renderGhostty(NEEDLES);
    document
      .querySelector(".terminal-tab")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await tick();
    await tick();
    const row = [...document.body.querySelectorAll<HTMLButtonElement>("button.mbtn")].find(
      (b) => b.querySelector(".mbtn-label")?.textContent?.trim() === "Find",
    );
    expect(row, "the body menu offers Find").toBeTruthy();
    row!.click();
    await tick();
    await tick();
    expect(findInput()).not.toBeNull();
  });

  test("typing selects the newest match, with a plus on the total while the scan runs", async () => {
    const term = await renderGhostty(NEEDLES);
    const frames = holdFrames();
    fireCommand("app.find.open");
    await tick();
    await tick();
    // One unit of the core's scan per frame: each clock read is past the
    // last frame's budget.
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 5));
    typeQuery(findInput()!, "needle");
    expect(frames.pending(), "the scan waits for a frame").toBe(1);
    frames.frame();
    await tick();
    expect(activeHighlight(term)).toEqual(match(5));
    expect(countElement()?.textContent).toBe("1 of 3+");
    frames.settle();
    await tick();
    expect(countElement()?.textContent).toBe("1 of 3");
    expect(activeHighlight(term)).toEqual(match(5));
  });

  // A screen reader speaks each change to a live region; the shown count
  // follows every frame of a scan.
  test("the status region is silent while the scan runs and says the count it settles on", async () => {
    // Three thousand rows above NEEDLES, a needle on every tenth: the scan
    // takes many frames.
    const many = Array.from({ length: 3000 }, (_, i) => `row ${i}${i % 10 === 5 ? " needle" : ""}`).join("\r\n");
    const term = await renderGhostty(`${many}\r\n${NEEDLES.slice(NEEDLES.indexOf("a"))}`);
    const frames = holdFrames();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireCommand("app.find.open");
      await tick();
      await tick();
      // One unit of the core's scan per frame: each clock read is past the
      // last frame's budget.
      let clock = 0;
      vi.spyOn(performance, "now").mockImplementation(() => (clock += 5));
      const states = vi.spyOn(VtSearch.prototype, "state");
      typeQuery(findInput()!, "needle");
      /// Per frame: the count of the search state find read last, the count
      /// shown and the count heard.
      const read: string[] = [];
      const shown: string[] = [];
      const heard: string[] = [];
      while (frames.pending()) {
        frames.frame();
        await tick();
        const state = states.mock.results.at(-1)!.value as SearchState;
        read.push(`${state.index! + 1} of ${state.total}${state.complete ? "" : "+"}`);
        shown.push(countElement()!.textContent!);
        heard.push(statusRegion()!.textContent!);
      }
      const total = term.wasmTerm!.plainText()!.split("needle").length - 1;
      expect(shown, "the shown count is every frame's own").toEqual(read);
      expect(new Set(shown).size, "and it grew over the scan").toBeGreaterThan(3);
      expect(shown.at(-1)).toBe(`1 of ${total}`);
      expect(heard.slice(0, -1).every((text) => text === ""), "nothing heard while partial").toBe(true);
      expect(heard.at(-1), "the settled count heard once the scan completes").toBe(`1 of ${total}`);
      expect(activeHighlight(term)).toEqual(match(3005));

      // Enter steps at once on the screen; the region holds the step until
      // an interval has passed since it last spoke.
      pressEnter(findInput()!);
      await tick();
      expect(countElement()?.textContent).toBe(`2 of ${total}`);
      expect(statusRegion()?.textContent).toBe(`1 of ${total}`);
      vi.advanceTimersByTime(FIND_ANNOUNCE_INTERVAL_MS);
      await tick();
      expect(statusRegion()?.textContent).toBe(`2 of ${total}`);

      // A new query whose scan is held part way: its partial count is heard
      // once it has stood for an interval.
      vi.advanceTimersByTime(FIND_ANNOUNCE_INTERVAL_MS);
      typeQuery(findInput()!, "row 29");
      frames.frame();
      await tick();
      const partial = countElement()!.textContent!;
      expect(partial).toMatch(/^1 of \d+\+$/);
      expect(statusRegion()?.textContent).toBe(`2 of ${total}`);
      vi.advanceTimersByTime(FIND_ANNOUNCE_INTERVAL_MS - 1);
      await tick();
      expect(statusRegion()?.textContent).toBe(`2 of ${total}`);
      vi.advanceTimersByTime(1);
      await tick();
      expect(statusRegion()?.textContent).toBe(partial);
    } finally {
      vi.useRealTimers();
    }
  });

  test("Shift+Enter right after the bar reopens waits for the scan and lands on the oldest match", async () => {
    // Three thousand rows above NEEDLES, a needle on every tenth: the scan
    // takes many frames, and the oldest needle is on row 5.
    const many = Array.from({ length: 3000 }, (_, i) => `row ${i}${i % 10 === 5 ? " needle" : ""}`).join("\r\n");
    const term = await renderGhostty(`${many}\r\n${NEEDLES.slice(NEEDLES.indexOf("a"))}`);
    const frames = holdFrames();
    const input = await openFindWithQuery("needle");
    frames.settle();
    await tick();
    pressEnter(input);
    await tick();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(findInput()).toBeNull();
    fireCommand("app.find.open");
    await tick();
    await tick();
    expect(findInput()?.value).toBe("needle");
    // One unit of the core's scan per frame: each clock read is past the
    // last frame's budget.
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 5));

    pressEnter(findInput()!, true);
    await tick();
    expect(activeHighlight(term), "nothing selected while the scan runs").toBeNull();
    expect(countElement()?.textContent).toBe("");
    const shown: string[] = [];
    do {
      expect(shown.length, "the scan completes within 1000 frames").toBeLessThan(1000);
      frames.frame();
      await tick();
      shown.push(countElement()!.textContent!);
      if (shown.at(-1)!.endsWith("+")) expect(activeHighlight(term), "nothing selected while the scan runs").toBeNull();
    } while (shown.at(-1)!.endsWith("+"));
    const total = term.wasmTerm!.plainText()!.split("needle").length - 1;
    expect(shown.length).toBeGreaterThan(2);
    for (const text of shown.slice(0, -1)) expect(text).toMatch(/^\? of \d+\+$/);
    expect(shown.at(-1)).toBe(`${total} of ${total}`);
    expect(activeHighlight(term)).toEqual({ start: { col: 6, absoluteRow: 5 }, end: { col: 11, absoluteRow: 5 } });
  });

  test("Enter steps to older output and Shift+Enter to newer", async () => {
    const term = await renderGhostty(NEEDLES);
    const { input } = await findNeedle(term);

    pressEnter(input);
    await tick();
    expect(activeHighlight(term)).toEqual(match(3));
    expect(countElement()?.textContent).toBe("2 of 3");

    pressEnter(input);
    await tick();
    expect(activeHighlight(term)).toEqual(match(1));
    expect(countElement()?.textContent).toBe("3 of 3");

    pressEnter(input, true);
    await tick();
    expect(activeHighlight(term)).toEqual(match(3));
    expect(countElement()?.textContent).toBe("2 of 3");
  });

  test("app.find.next steps to older output and app.find.prev to newer, both wrapping", async () => {
    const term = await renderGhostty(NEEDLES);
    await findNeedle(term);

    fireCommand("app.find.prev");
    await tick();
    expect(activeHighlight(term), "newer than the newest wraps to the oldest").toEqual(match(1));
    expect(countElement()?.textContent).toBe("3 of 3");

    fireCommand("app.find.next");
    await tick();
    expect(activeHighlight(term), "older than the oldest wraps to the newest").toEqual(match(5));
    expect(countElement()?.textContent).toBe("1 of 3");
  });

  test("reads 0 of 0 when nothing matches", async () => {
    const term = await renderGhostty(NEEDLES);
    const frames = holdFrames();
    await openFindWithQuery("absent");
    frames.settle();
    await tick();
    expect(countElement()?.textContent).toBe("0 of 0");
    expect(activeHighlight(term)).toBeNull();
  });

  test("Escape closes the bar, clears the highlight and the count, and focuses the terminal", async () => {
    const term = await renderGhostty(NEEDLES);
    const { input, frames } = await findNeedle(term);
    const free = vi.spyOn(VtSearch.prototype, "free");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(findInput()).toBeNull();
    expect(activeHighlight(term)).toBeNull();
    expect(free).toHaveBeenCalledTimes(1);
    expect(document.activeElement, "the element the terminal reads keys from").toBe(term.element);

    // Reopening shows the kept query with no stale count beside it; Enter
    // searches again and lands on the newest match while the scan finishes.
    fireCommand("app.find.open");
    await tick();
    await tick();
    expect(findInput()?.value).toBe("needle");
    expect(countElement()?.textContent).toBe("");
    pressEnter(findInput()!);
    await tick();
    expect(activeHighlight(term)).toEqual(match(5));
    expect(countElement()?.textContent).toBe("1 of 3+");
    frames.settle();
    await tick();
    expect(countElement()?.textContent).toBe("1 of 3");
  });

  // A bar that reopens during the same task or just after Escape closes it
  // keeps the keyboard, and the next Escape is the bar's.
  test.each(["in Escape's own task", "once Escape has closed it"])(
    "a bar reopened %s keeps the keyboard",
    async (when) => {
      const term = await renderGhostty(NEEDLES);
      // The mount's own refocus timer runs first.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const { input } = await findNeedle(term);
      expect(document.activeElement, "the open bar holds the keyboard").toBe(input);
      const press = (key: string) =>
        document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        press("Escape");
        if (when === "once Escape has closed it") {
          await tick();
          expect(findInput()).toBeNull();
          expect(document.activeElement).toBe(term.element);
        }
        fireCommand("app.find.open");
        await tick();
        await tick();
        const reopened = findInput();
        expect(document.activeElement, "the reopened bar takes the keyboard").toBe(reopened);
        vi.runAllTimers();
        expect(document.activeElement, "no refocus takes it back").toBe(reopened);

        // Escape closes the bar without reaching the terminal, and the key
        // after it does reach the terminal.
        press("Escape");
        await tick();
        expect(findInput()).toBeNull();
        press("a");
        expect(sentFrames(TerminalSocket.all[0]!).filter((f) => f.type === "input").map((f) => f.data)).toEqual(["a"]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test("an emptied query clears the highlight and the count", async () => {
    const term = await renderGhostty(NEEDLES);
    const { input } = await findNeedle(term);
    typeQuery(input, "");
    await tick();
    expect(activeHighlight(term)).toBeNull();
    expect(countElement()?.textContent).toBe("");
  });

  /// A click as a mouse makes one on `target`: pressed and released there.
  function click(target: Element, at = { clientX: 0, clientY: 0 }): void {
    const init = { bubbles: true, cancelable: true, button: 0, ...at };
    target.dispatchEvent(new MouseEvent("mousedown", init));
    target.dispatchEvent(new MouseEvent("mouseup", init));
    target.dispatchEvent(new MouseEvent("click", { ...init, detail: 1 }));
  }

  /// The user's drag over the terminal from one screen cell to another,
  /// handled by ghostty-web's own pointer code; returns the clipboard writes
  /// its release made. The canvas uses the widget's current CSS-pixel grid.
  function drag(term: Terminal, from: { col: number; row: number }, to: { col: number; row: number }) {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const canvas = term.element!.querySelector("canvas")!;
    modelPointerCapture(canvas);
    const { width, height } = term.getMetrics()!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, term.cols * width, term.rows * height));
    const at = (cell: { col: number; row: number }) => ({ clientX: cell.col * width + 1, clientY: cell.row * height + 1 });
    try {
      mousePointer(canvas, "pointerdown", at(from));
      mousePointer(canvas, "pointermove", at(to));
      mousePointer(canvas, "pointerup", at(to));
      canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1, ...at(to) }));
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
    return writeText;
  }

  // The widget keeps its selection on outside clicks, including the find bar.
  test.each(["input", "count", "box"] as const)("a click on the find bar's %s keeps find's highlight", async (part) => {
    const term = await renderGhostty(NEEDLES);
    const { input, frames } = await findNeedle(term);
    const target = { input, count: countElement()!, box: document.querySelector(".terminal-find")! }[part];
    click(target);
    expect(activeHighlight(term)).toEqual(match(5));
    await output("\r\nmore");
    frames.settle();
    await tick();
    expect(activeHighlight(term), "a later frame keeps it too").toEqual(match(5));
    expect(countElement()?.textContent).toBe("1 of 3");
    pressEnter(input);
    await tick();
    expect(activeHighlight(term)).toEqual(match(3));
  });

  test("a click elsewhere in the page keeps the selection and find highlight", async () => {
    const term = await renderGhostty(NEEDLES);
    const { input, frames } = await findNeedle(term);
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    click(elsewhere);
    expect(activeHighlight(term), "an outside click keeps the highlight").toEqual(match(5));
    await output("\r\nmore");
    frames.settle();
    await tick();
    expect(activeHighlight(term), "a later frame keeps it too").toEqual(match(5));
    expect(countElement()?.textContent).toBe("1 of 3");
    pressEnter(input);
    await tick();
    expect(activeHighlight(term), "a step highlights again").toEqual(match(3));
  });

  test("a tap in the terminal leaves find's highlight in place", async () => {
    const term = await renderGhostty(NEEDLES);
    const { input, frames } = await findNeedle(term);
    const canvas = term.element!.querySelector("canvas")!;
    modelPointerCapture(canvas);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, term.cols * 8, term.rows * 19));
    const at = { clientX: 2 * 8 + 1, clientY: 2 * 19 + 1 };
    term.select(0, 0, 1);
    expect(term.getSelectionRange(), "a selection for the tap to clear").not.toBeNull();
    mousePointer(canvas, "pointerdown", at);
    mousePointer(canvas, "pointerup", at);
    expect(term.getSelectionRange(), "the tap reached the widget").toBeNull();
    expect(activeHighlight(term), "a press clears only the user selection").toEqual(match(5));
    await output("\r\nmore");
    frames.settle();
    await tick();
    expect(activeHighlight(term), "find keeps its active match").toEqual(match(5));
    expect(countElement()?.textContent).toBe("1 of 3");
    pressEnter(input);
    await tick();
    expect(activeHighlight(term), "a step highlights again").toEqual(match(3));
  });

  test("a selection the user drags after find's highlight stays theirs through a click in the bar", async () => {
    const term = await renderGhostty(NEEDLES);
    const { input, frames } = await findNeedle(term);
    const copied = drag(term, { col: 0, row: 0 }, { col: 2, row: 1 });
    const users = { start: { col: 0, absoluteRow: 0 }, end: { col: 2, absoluteRow: 1 } };
    expect(term.getSelectionRange(), "the widget made the user's selection").toEqual(users);
    expect(activeHighlight(term)).toEqual(match(5));
    expect(copied, "and copied it on release").toHaveBeenCalledTimes(1);
    click(input);
    expect(term.getSelectionRange()).toEqual(users);
    expect(activeHighlight(term)).toEqual(match(5));
    await output("\r\nmore needle");
    frames.settle();
    await tick();
    expect(term.getSelectionRange(), "find does not take it over").toEqual(users);
    expect(activeHighlight(term)).toEqual(match(5));
    expect(countElement()?.textContent).toBe("2 of 4");
  });

  test("a resize keeps the match highlighted and counted, and Enter goes on from it", async () => {
    const term = await renderGhostty(NEEDLES);
    const { input, frames } = await findNeedle(term);
    pressEnter(input);
    await tick();
    expect(activeHighlight(term)).toEqual(match(3));
    expect(countElement()?.textContent).toBe("2 of 3");

    // ghostty-web's own resize, where the fit and a broadcast grid end. The
    // rows are short and keep their places; the core still forgets its
    // selected match and scans again.
    term.resize(60, 24);
    expect(activeHighlight(term), "kept before ghostty-web repaints").toEqual(match(3));
    frames.settle();
    await tick();
    expect(activeHighlight(term)).toEqual(match(3));
    expect(countElement()?.textContent).toBe("2 of 3");

    pressEnter(input);
    await tick();
    expect(activeHighlight(term)).toEqual(match(1));
    expect(countElement()?.textContent).toBe("3 of 3");
  });

  test("a line chan prints when the session ends counts in an open bar", async () => {
    const term = await renderGhostty(`${NEEDLES}\r\na job ended`);
    const frames = holdFrames();
    await openFindWithQuery("ended");
    frames.settle();
    await tick();
    const earlier = { start: { col: 6, absoluteRow: 6 }, end: { col: 10, absoluteRow: 6 } };
    expect(activeHighlight(term)).toEqual(earlier);
    expect(countElement()?.textContent).toBe("1 of 1");

    await TerminalSocket.all[0]!.onmessage?.({ data: JSON.stringify({ type: "closed", reason: "idle" }) });
    expect(term.wasmTerm!.plainText()).toContain("session ended (idle)");
    expect(frames.pending(), "find heard the line").toBe(1);
    frames.settle();
    await tick();
    // The core keeps the selection on its text; the line's match is newer.
    expect(countElement()?.textContent).toBe("2 of 2");
    expect(activeHighlight(term)).toEqual(earlier);
  });

  /// Each call of a write method in `source`, as the name written to and the
  /// method (`term.write`), read through an optional chain, a non-null
  /// assertion or a cast in parentheses. `unread` counts the mentions of a
  /// write method that no call accounts for, such as a call on an indexed or
  /// returned terminal, or the method handed on uncalled.
  function writeCalls(source: string): { calls: string[]; unread: number } {
    const calls = [...source.matchAll(/\b(\w+)!?(?:\s+as\s+[^()]*)?\)?[!?]?\.(write|writeln)\(/g)].map(
      (m) => `${m[1]}.${m[2]}`,
    );
    const mentions = source.match(/\.(?:write|writeln)\b/g)?.length ?? 0;
    return { calls, unread: mentions - calls.length };
  }

  test("every write the tab makes reaches the terminal through the viewport controller", () => {
    // The controller tells find of each write, and a write around it leaves
    // the count and the highlight behind. The PTY writer handed to
    // ptyWrites is the controller's write, and chan's own lines take it in
    // writeChanLine.
    const { calls, unread } = writeCalls(terminalTabSource);
    expect(calls.sort()).toEqual(["ghosttyViewport.write", "ptyWrites.write", "viewport.write"]);
    expect(unread, "no write method is reached another way").toBe(0);
    const helper = terminalTabSource.slice(terminalTabSource.indexOf("function writeChanLine("));
    expect(helper.slice(0, helper.indexOf("\n  }\n"))).toContain("ghosttyViewport?.write(");
  });

  test("the write scan reads a call through an assertion, a cast or an optional chain, and counts what it cannot name", () => {
    const source = [
      "term!.write(bytes);",
      "(term as Terminal).write(bytes);",
      "(term as unknown as Terminal)?.writeln(line);",
      "this.term?.writeln(line);",
    ].join("\n");
    expect(writeCalls(source)).toEqual({
      calls: ["term.write", "term.write", "term.writeln", "term.writeln"],
      unread: 0,
    });
    expect(writeCalls("terms[0].write(bytes);\nonData(term.writeln);")).toEqual({ calls: [], unread: 2 });
  });

  test("a restart closes the bar and frees its search, and the kept query searches the new terminal", async () => {
    const term = await renderGhostty(NEEDLES);
    const { frames } = await findNeedle(term);
    const free = vi.spyOn(VtSearch.prototype, "free");

    await restartTerminal();
    frames.settle();
    await vi.waitFor(() => expect(ghosttyFixture.terminals).toHaveLength(2));
    expect(findInput(), "the bar closed with the terminal it searched").toBeNull();
    expect(free).toHaveBeenCalledTimes(1);

    const next = await openedGhostty();
    const socket = TerminalSocket.all.at(-1)!;
    socket.onopen?.();
    await socket.onmessage?.({
      data: JSON.stringify({ type: "session", id: "sess-2", seq: 0, generation: 1, missed_bytes: 0, bytes_since_focus: 0 }),
    });
    await socket.onmessage?.({ data: JSON.stringify({ type: "ready", cols: 80, rows: 24 }) });
    const bytes = new TextEncoder().encode(NEEDLES);
    const buffer = new ArrayBuffer(bytes.length);
    new Uint8Array(buffer).set(bytes);
    await socket.onmessage?.({ data: buffer });
    await vi.waitFor(() => expect(next.wasmTerm!.plainText()).toContain("needle f"));
    expect(document.activeElement, "the new terminal reads the keyboard").toBe(next.element);

    fireCommand("app.find.open");
    await tick();
    await tick();
    expect(findInput()?.value).toBe("needle");
    expect(countElement()?.textContent).toBe("");
    pressEnter(findInput()!);
    frames.settle();
    await tick();
    expect(activeHighlight(next)).toEqual(match(5));
    expect(countElement()?.textContent).toBe("1 of 3");
  });

  test("the terminal's teardown frees the open bar's search", async () => {
    const term = await renderGhostty(NEEDLES);
    await findNeedle(term);
    const free = vi.spyOn(VtSearch.prototype, "free");
    resetTerminals();
    expect(free).toHaveBeenCalledTimes(1);
  });
});
