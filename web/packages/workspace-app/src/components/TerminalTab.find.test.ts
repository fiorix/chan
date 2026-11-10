// @vitest-environment jsdom

// Terminal find. The contracts pinned here:
//
// 1. The xterm Terminal is constructed with `allowProposedApi: true`.
//    xterm gates registerDecoration behind that flag, and the search
//    addon's decorated find throws without it -- the find bar "matches
//    nothing" because the search dies mid-keystroke.
// 2. The find command family (app.find.open / next / prev) reaches the
//    focused terminal over the chan:command bus. On desktop the key
//    bridge claims the find chords before the webview sees the keydown
//    and fires these commands; App.svelte serves them for file tabs
//    only, so the terminal must serve itself or the chord is dead on
//    a terminal pane. With the keyboard inside the active terminal tab
//    the bridge releases Mod+F in both forms and Ctrl+G, and the tab
//    takes those as keys: its root opens the bar on `terminal.find`,
//    and the find input steps on the Find next chord.
// 3. Direction. Typing selects the newest match, the bottom-most in the
//    buffer: the selection is cleared and the addon's reverse search
//    starts from the bottom. Enter and app.find.next step to older
//    output (findPrevious); Shift+Enter and app.find.prev step to newer
//    output (findNext).
// 4. The count. The bar reads `k of n` with k counting from the newest
//    match, fed by the addon's onDidChangeResults: `0 of 0` without a
//    match, `? of 1000+` at the highlight limit, blank once the bar
//    closes or the query empties, and kept blank when the addon's refresh
//    after output fires after that. A screen reader hears the count through
//    a status region that takes it once it settles, not on every frame.
// 5. Ghostty. A ghostty terminal has the same bar, menu row, commands,
//    direction and count, found by libghostty-vt's search on chan's
//    binding: the active match is ghostty-web's selection, the total
//    carries a `+` while the scan runs, and Escape clears the selection.
//    Escape hands the keyboard to the terminal with no later refocus, so a
//    bar reopened at once keeps it. A click in the bar keeps the highlight,
//    and a selection the user drags stays theirs; a click elsewhere in the
//    page clears the selection, as ghostty-web does.
//
// The xterm component cases run on terminal and addon doubles that record
// the calls. The block after them runs the real addon over a real xterm in
// jsdom to pin what the doubles stand in for: where findPrevious lands from
// a cleared and from a kept selection, the top-down order of resultIndex,
// and what the addon reports at its highlight limit. The next block mounts
// the tab with the doubles backed by a real xterm and the real addon, for
// what the addon reports on its own: its refresh after output. The ghostty
// cases run the binding over the vendored core inside a ghostty-web terminal
// stand-in that carries ghostty-web's own SelectionManager, mouse handling
// included, with animation frames run by the case.

import { readFileSync } from "node:fs";
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import TerminalTab from "./TerminalTab.svelte";
import terminalTabSource from "./TerminalTab.svelte?raw";
import { hydrateOverrides } from "../state/keymapOverrides.svelte";
import type { TerminalTab as TerminalTabState } from "../state/tabs.svelte";
import { terminalTab } from "../__tests__/tabs";
import { terminalPreferences } from "../__tests__/standalone";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { closeTabMenu } from "../state/tabMenu.svelte";
import { FIND_ANNOUNCE_INTERVAL_MS } from "../terminal/findAnnouncer";
import { confirmState, resolveConfirm } from "../state/confirm.svelte";
import { type SearchState, VtSearch, type VtTerminal } from "../terminal/ghosttyVt";

type ResultsEvent = { resultIndex: number; resultCount: number };

const mounted: Array<Record<string, any>> = [];
const terminalOptions: Array<Record<string, unknown>> = [];
/// Every selection and search call in order, so a case can read that typing
/// clears the selection before the reverse search runs.
const calls: Array<{ name: string; query?: string; opts?: unknown }> = [];
let resultsListener: ((e: ResultsEvent) => void) | null = null;
/// While `on`, each xterm double is backed by a real xterm that parses its
/// writes and holds its selection, and each search addon double hands every
/// call to a real addon loaded into that xterm.
const realXterm = vi.hoisted(() => ({ on: false, terminals: [] as Array<{ model: any }> }));

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

class TestWebSocket {
  static OPEN = 1;
  static all: TestWebSocket[] = [];

  readyState = TestWebSocket.OPEN;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void | Promise<void>) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor() {
    TestWebSocket.all.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

vi.mock("@xterm/xterm", async () => {
  const actual = await vi.importActual<typeof import("@xterm/xterm")>("@xterm/xterm");
  return {
    Terminal: class {
      cols = 80;
      rows = 24;
      options: Record<string, unknown> = {};
      model: InstanceType<typeof actual.Terminal> | null = null;

      constructor(options: Record<string, unknown> = {}) {
        terminalOptions.push(options);
        if (realXterm.on) {
          this.model = new actual.Terminal({ allowProposedApi: true, cols: 40, rows: 10, scrollback: 1000 });
          realXterm.terminals.push(this);
        }
      }

      loadAddon(addon: { real?: { activate(terminal: unknown): void } | null }) {
        if (this.model && addon.real) this.model.loadAddon(addon.real as never);
      }
      open(element: HTMLElement) {
        this.model?.open(element);
      }
      attachCustomKeyEventHandler() {}
      onData() {}
      onBinary() {}
      onResize() {}
      write(data: string | Uint8Array, done?: () => void) {
        this.model?.write(data, done);
      }
      writeln() {}
      resize() {}
      focus() {}
      clearSelection() {
        calls.push({ name: "clearSelection" });
        this.model?.clearSelection();
      }
      dispose() {
        this.model?.dispose();
      }
    },
  };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock("@xterm/addon-search", async () => {
  const actual = await vi.importActual<typeof import("@xterm/addon-search")>("@xterm/addon-search");
  return {
    SearchAddon: class {
      real: InstanceType<typeof actual.SearchAddon> | null;
      constructor(options?: { highlightLimit?: number }) {
        this.real = realXterm.on ? new actual.SearchAddon(options) : null;
      }
      findNext(query: string, opts: any) {
        calls.push({ name: "findNext", query, opts });
        return this.real?.findNext(query, opts) ?? false;
      }
      findPrevious(query: string, opts: any) {
        calls.push({ name: "findPrevious", query, opts });
        return this.real?.findPrevious(query, opts) ?? false;
      }
      clearDecorations() {
        calls.push({ name: "clearDecorations" });
        this.real?.clearDecorations();
      }
      onDidChangeResults(listener: (e: ResultsEvent) => void) {
        if (this.real) return this.real.onDidChangeResults(listener);
        resultsListener = listener;
        return { dispose() {} };
      }
    },
  };
});

vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class {
    serialize() {
      return "";
    }
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {},
}));

type Anchor = { col: number; absoluteRow: number };

/// What a case reads of a ghostty terminal stand-in.
type GhosttyStandIn = {
  wasmTerm: VtTerminal;
  cols: number;
  rows: number;
  viewportY: number;
  focused: number;
  /// ghostty-web's canvas, in the element the terminal opened in.
  canvas: HTMLCanvasElement;
  /// The element the terminal opened in, and the keys that reached it.
  element: HTMLElement | null;
  keys: string[];
  selectionManager: { selectionStart: Anchor | null; selectionEnd: Anchor | null };
  resize(cols: number, rows: number): void;
};

const ghostty = vi.hoisted(() => ({
  module: null as WebAssembly.Module | null,
  terminals: [] as GhosttyStandIn[],
}));

// The ghostty kit over the vendored core, with a stand-in for ghostty-web's
// Terminal that holds what TerminalTab and find reach: the binding's
// terminal as its core, ghostty-web's own SelectionManager over it, its
// viewport offset (lines scrolled back from the bottom, clamped to the
// history, back to the bottom after a write), writeln as a write with CRLF,
// a resize that hands the core the new grid and fires the resize event, and
// focus as ghostty-web's: open() makes the element it opens in focusable,
// reads keys there and puts its canvas in it, and focus() focuses that
// element, then again on a zero-delay timer.
vi.mock("../terminal/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../terminal/backend")>();
  const { SelectionManager } = await import("ghostty-web");
  class Terminal {
    cols = 80;
    rows = 24;
    viewportY = 0;
    focused = 0;
    options: Record<string, any>;
    wasmTerm: any = undefined;
    selectionManager: any = undefined;
    canvas = document.createElement("canvas");
    renderer = {
      getMetrics: () => ({ width: 8, height: 16, baseline: 12 }),
      getCanvas: () => this.canvas,
      ctx: {},
      render() {},
    };
    buffer = { active: { type: "normal", length: 24, getLine: () => undefined }, alternate: {} };
    constructor(options: Record<string, any>) {
      this.options = options;
      ghostty.terminals.push(this as unknown as GhosttyStandIn);
    }
    element: HTMLElement | null = null;
    keys: string[] = [];
    open(element: HTMLElement) {
      this.element = element;
      if (!element.hasAttribute("tabindex")) element.setAttribute("tabindex", "0");
      element.addEventListener("keydown", (e) => this.keys.push(e.key));
      element.append(this.canvas);
      this.wasmTerm = this.options.ghostty.createTerminal(this.cols, this.rows, {
        scrollbackLimit: this.options.scrollback,
      });
      this.selectionManager = new SelectionManager(
        this as never,
        this.renderer as never,
        this.wasmTerm,
        document.createElement("textarea"),
      );
    }
    attachCustomKeyEventHandler() {}
    attachCustomWheelEventHandler() {}
    onData() {
      return { dispose() {} };
    }
    resizeListeners = new Set<(size: { cols: number; rows: number }) => void>();
    onResize(listener: (size: { cols: number; rows: number }) => void) {
      this.resizeListeners.add(listener);
      return { dispose: () => this.resizeListeners.delete(listener) };
    }
    hasMouseTracking() {
      return false;
    }
    hasFocusEvents() {
      return false;
    }
    getMode() {
      return false;
    }
    hasBracketedPaste() {
      return false;
    }
    write(data: string | Uint8Array) {
      this.wasmTerm.write(data);
      this.viewportY = 0;
    }
    writeln(data: string) {
      this.write(`${data}\r\n`);
    }
    paste() {}
    resize(cols: number, rows: number) {
      if (cols === this.cols && rows === this.rows) return;
      this.cols = cols;
      this.rows = rows;
      this.wasmTerm.resize(cols, rows);
      for (const listener of this.resizeListeners) listener({ cols, rows });
    }
    focus() {
      this.focused += 1;
      this.element?.focus();
      setTimeout(() => this.element?.focus(), 0);
    }
    blur() {}
    getSelection() {
      return this.selectionManager.getSelection();
    }
    hasSelection() {
      return this.selectionManager.hasSelection();
    }
    getViewportY() {
      return this.viewportY;
    }
    getScrollbackLength() {
      return this.wasmTerm.getScrollbackLength();
    }
    scrollLines(amount: number) {
      this.scrollToLine(this.viewportY - amount);
    }
    scrollToLine(line: number) {
      this.viewportY = Math.max(0, Math.min(this.getScrollbackLength(), line));
    }
    selectAll() {}
    clearSelection() {
      this.selectionManager.clearSelection();
    }
    dispose() {
      this.element = null;
      this.selectionManager?.dispose();
      this.wasmTerm?.free();
    }
  }
  return {
    ...actual,
    loadGhosttyKit: async () => actual.ghosttyKitFrom(ghostty.module!, { Terminal: Terminal as never }),
  };
});
// Renderer hooks the stand-in has no renderer for.
vi.mock("../terminal/ghosttyCompat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../terminal/ghosttyCompat")>()),
  measureXtermCellDimensions: () => ({ width: 8, height: 16 }),
  alignGhosttyRendererToXterm: () => true,
  installGhosttyCustomGlyphs: () => true,
  installGhosttyOverlayScrollbar: () => true,
  gateGhosttyScrollbarClicks: () => () => {},
}));

globalThis.ResizeObserver = TestResizeObserver as any;
globalThis.WebSocket = TestWebSocket as any;
const syncFrame = ((cb: FrameRequestCallback) => {
  cb(0);
  return 0;
}) as typeof requestAnimationFrame;
const ownCancelFrame = globalThis.cancelAnimationFrame;
globalThis.requestAnimationFrame = syncFrame;
// The real xterm the last block opens parses colours through a scratch
// canvas and reads matchMedia from its renderer; jsdom has neither.
HTMLCanvasElement.prototype.getContext = (() => ({
  createLinearGradient: () => ({ addColorStop() {} }),
  measureText: () => ({ width: 8 }),
  fillRect() {},
  clearRect() {},
  fillText() {},
})) as any;
(window as { matchMedia?: unknown }).matchMedia ??= (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
});

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  terminalOptions.splice(0);
  calls.splice(0);
  resultsListener = null;
  realXterm.on = false;
  realXterm.terminals.splice(0);
  TestWebSocket.all.splice(0);
  ghostty.terminals.splice(0);
  globalThis.requestAnimationFrame = syncFrame;
  globalThis.cancelAnimationFrame = ownCancelFrame;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

async function renderTerminal(tab: TerminalTabState, focused: boolean) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(TerminalTab, {
    target,
    props: { tab, paneId: "pane-1", active: true, focused },
  });
  mounted.push(component);
  await tick();
  await tick();
  return { component, target };
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

function callNames(): string[] {
  return calls.map((c) => c.name);
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
async function restartTerminal(): Promise<TestWebSocket> {
  const sockets = TestWebSocket.all.length;
  fireCommand("app.terminal.restart");
  expect(confirmState.open, "a terminal with a session asks before it restarts").toBe(true);
  resolveConfirm(true);
  await vi.waitFor(() => expect(TestWebSocket.all).toHaveLength(sockets + 1));
  await tick();
  return TestWebSocket.all.at(-1)!;
}

function pressEnter(input: HTMLInputElement, shiftKey = false): void {
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey, bubbles: true }));
}

async function reportResults(e: ResultsEvent): Promise<void> {
  expect(resultsListener, "the component subscribed to the addon's results").not.toBeNull();
  resultsListener!(e);
  await tick();
}

describe("terminal find construction", () => {
  test("constructs xterm with allowProposedApi so decorated search works", async () => {
    await renderTerminal(terminalTab(), true);

    expect(terminalOptions.length).toBeGreaterThan(0);
    expect(terminalOptions.at(-1)?.allowProposedApi).toBe(true);
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

  test("an unfocused terminal ignores app.find.open", async () => {
    await renderTerminal(terminalTab(), false);

    fireCommand("app.find.open");
    await tick();
    await tick();

    expect(findInput()).toBeNull();
  });

  test("typing clears the selection and runs a decorated findPrevious", async () => {
    // The reverse search starts at the bottom of the buffer only from no
    // selection; the real-addon block below shows what a kept selection
    // does to it.
    await renderTerminal(terminalTab(), true);
    calls.splice(0);
    await openFindWithQuery("needle");

    expect(callNames()).toEqual(["clearSelection", "findPrevious"]);
    const search = calls[1]!;
    expect(search.query).toBe("needle");
    expect((search.opts as { decorations?: unknown }).decorations).toBeTruthy();
  });

  test("Enter steps to older output and Shift+Enter to newer", async () => {
    await renderTerminal(terminalTab(), true);
    const input = await openFindWithQuery("needle");

    calls.splice(0);
    pressEnter(input);
    expect(callNames()).toEqual(["findPrevious"]);
    expect(calls[0]!.query).toBe("needle");
    expect((calls[0]!.opts as { decorations?: unknown }).decorations).toBeTruthy();

    calls.splice(0);
    pressEnter(input, true);
    expect(callNames()).toEqual(["findNext"]);
    expect(calls[0]!.query).toBe("needle");
  });

  test("app.find.next steps to older output and app.find.prev to newer", async () => {
    await renderTerminal(terminalTab(), true);
    await openFindWithQuery("needle");

    calls.splice(0);
    fireCommand("app.find.next");
    expect(callNames()).toEqual(["findPrevious"]);
    expect(calls[0]!.query).toBe("needle");

    calls.splice(0);
    fireCommand("app.find.prev");
    expect(callNames()).toEqual(["findNext"]);
    expect(calls[0]!.query).toBe("needle");
  });

  test("app.find.next without an open find bar is inert", async () => {
    await renderTerminal(terminalTab(), true);

    fireCommand("app.find.next");

    expect(calls).toHaveLength(0);
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
    await renderTerminal(terminalTab(), true);
    await openFindWithQuery("needle");

    // The addon indexes top-down: the newest match is the last index.
    await reportResults({ resultIndex: 2, resultCount: 3 });
    expect(countElement()?.textContent).toBe("1 of 3");

    await reportResults({ resultIndex: 0, resultCount: 3 });
    expect(countElement()?.textContent).toBe("3 of 3");
  });

  test("is heard through a named status region, the shown count hidden from screen readers", async () => {
    await renderTerminal(terminalTab(), true);
    await openFindWithQuery("needle");
    await reportResults({ resultIndex: 0, resultCount: 1 });

    const region = statusRegion();
    expect(region?.getAttribute("aria-label")).toBe("find matches");
    expect(region?.textContent, "a final count is heard at once").toBe("1 of 1");
    expect(countElement()?.textContent).toBe("1 of 1");
    expect(countElement()?.getAttribute("aria-hidden")).toBe("true");
    expect(countElement()?.getAttribute("role")).toBeNull();
  });

  test("reads 0 of 0 when nothing matches", async () => {
    await renderTerminal(terminalTab(), true);
    await openFindWithQuery("needle");

    await reportResults({ resultIndex: -1, resultCount: 0 });

    expect(countElement()?.textContent).toBe("0 of 0");
  });

  test("reads ? of 1000+ at the highlight limit whichever match is selected", async () => {
    // The addon stops listing at the limit, so its total is a floor and an
    // index among the listed thousand says nothing about the distance from
    // the newest match.
    await renderTerminal(terminalTab(), true);
    await openFindWithQuery("needle");

    await reportResults({ resultIndex: -1, resultCount: 1000 });
    expect(countElement()?.textContent).toBe("? of 1000+");

    await reportResults({ resultIndex: 999, resultCount: 1000 });
    expect(countElement()?.textContent).toBe("? of 1000+");
  });

  test("goes blank when the query empties and clears the decorations", async () => {
    await renderTerminal(terminalTab(), true);
    const input = await openFindWithQuery("needle");
    await reportResults({ resultIndex: 2, resultCount: 3 });
    expect(countElement()?.textContent).toBe("1 of 3");

    calls.splice(0);
    typeQuery(input, "");
    await tick();

    expect(callNames()).toEqual(["clearDecorations"]);
    expect(countElement()?.textContent).toBe("");
  });

  test("Escape closes the bar, clears the decorations and drops the count", async () => {
    await renderTerminal(terminalTab(), true);
    const input = await openFindWithQuery("needle");
    await reportResults({ resultIndex: 2, resultCount: 3 });

    calls.splice(0);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(findInput()).toBeNull();
    expect(callNames()).toEqual(["clearDecorations"]);

    // Reopening shows the kept query with no stale count beside it.
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

  /// A bar open on "needle" in a mounted xterm terminal, the input focused,
  /// as the bridge reads focus to tell a terminal tab from the page.
  async function openBar(): Promise<HTMLInputElement> {
    await renderTerminal(terminalTab(), true);
    const input = await openFindWithQuery("needle");
    expect(document.activeElement, "the find input holds the keyboard").toBe(input);
    expect(input.closest(".terminal-tab.active"), "inside the active terminal tab").not.toBeNull();
    calls.splice(0);
    return input;
  }

  /// Press a key in the input and return the steps it made, in order.
  function press(input: HTMLInputElement, init: KeyboardEventInit): { steps: string[]; event: KeyboardEvent } {
    calls.splice(0);
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    input.dispatchEvent(event);
    return { steps: callNames(), event };
  }

  const G = { key: "g", code: "KeyG" };
  const SHIFT_G = { key: "G", code: "KeyG", shiftKey: true };

  test.each(["linux", "windows"] as const)("on the %s desktop Ctrl+G steps to older output once", async (os) => {
    const input = await openBar();
    onDesktop(os);

    const next = press(input, { ...G, ctrlKey: true });
    expect(next.steps).toEqual(["findPrevious"]);
    expect(calls[0]!.query).toBe("needle");
    expect(next.event.defaultPrevented).toBe(true);

    // Ctrl+Shift+G is the bridge's: its command steps to newer output, and
    // the key never reaches the input to step again.
    expect(press(input, { ...SHIFT_G, ctrlKey: true }).steps).toEqual(["findNext"]);
  });

  test("on the macOS desktop Cmd+G steps once, through the bridge's command, and Ctrl+G is no find chord", async () => {
    const input = await openBar();
    onDesktop("mac");

    expect(press(input, { ...G, metaKey: true }).steps).toEqual(["findPrevious"]);
    expect(press(input, { ...SHIFT_G, metaKey: true }).steps).toEqual(["findNext"]);
    // The bridge leaves Ctrl+G to the tab on macOS too, where it is not the
    // Find next chord.
    const control = press(input, { ...G, ctrlKey: true });
    expect(control.steps).toEqual([]);
    expect(control.event.defaultPrevented).toBe(false);
  });

  // The pair to the case above: the input does answer Cmd+G on the macOS
  // desktop, so the single step there is the bridge taking the key first.
  test.each([
    ["mac", { metaKey: true }],
    ["linux", { ctrlKey: true }],
  ] as const)("on the %s desktop without its bridge both chords step from the input", async (os, mod) => {
    const input = await openBar();
    onDesktop(os, false);

    expect(press(input, { ...G, ...mod }).steps).toEqual(["findPrevious"]);
    expect(press(input, { ...SHIFT_G, ...mod }).steps).toEqual(["findNext"]);
  });

  test.each([
    ["linux", { ctrlKey: true }],
    ["mac", { metaKey: true }],
  ] as const)("in a browser on %s the keys are left alone", async (os, mod) => {
    const input = await openBar();
    inBrowser(os);

    for (const key of [G, SHIFT_G]) {
      const pressed = press(input, { ...key, ...mod });
      expect(pressed.steps).toEqual([]);
      expect(pressed.event.defaultPrevented, "the browser keeps its own find keys").toBe(false);
    }
  });

  test("a remapped Find next is the chord the input steps on", async () => {
    const input = await openBar();
    onDesktop("linux");
    hydrateOverrides({ "app.find.next": { linux: "Mod+Alt+N" } });

    expect(press(input, { key: "n", code: "KeyN", ctrlKey: true, altKey: true }).steps).toEqual(["findPrevious"]);
    expect(press(input, { ...G, ctrlKey: true }).steps, "the chord it replaced").toEqual([]);
  });
});

describe("the real search addon over a real xterm", () => {
  const decorations = {
    decorations: {
      matchBackground: "#7c5cff",
      matchOverviewRuler: "#7c5cff",
      activeMatchBackground: "#58a6ff",
      activeMatchColorOverviewRuler: "#58a6ff",
    },
  };

  /// A 20x5 terminal with the lines written one per row and the cursor on an
  /// empty row after the last; the search addon loaded with the highlight
  /// limit the component uses, and its result events recorded.
  async function openTerminal(lines: string[]) {
    const { Terminal } = await vi.importActual<typeof import("@xterm/xterm")>("@xterm/xterm");
    const { SearchAddon } =
      await vi.importActual<typeof import("@xterm/addon-search")>("@xterm/addon-search");
    const host = document.createElement("div");
    document.body.append(host);
    const term = new Terminal({ allowProposedApi: true, cols: 20, rows: 5, scrollback: 5000 });
    term.open(host);
    const search = new SearchAddon({ highlightLimit: 1000 });
    term.loadAddon(search);
    const events: ResultsEvent[] = [];
    search.onDidChangeResults((e) => events.push({ ...e }));
    await new Promise<void>((resolve) => term.write([...lines, ""].join("\r\n"), resolve));
    return { term, search, events };
  }

  function selectedRow(term: import("@xterm/xterm").Terminal): number | undefined {
    return term.getSelectionPosition()?.start.y;
  }

  test("findPrevious lands on the newest match from a cleared selection only", async () => {
    const { term, search } = await openTerminal(["ne a", "nee b", "xx", "ne c", "zz"]);

    // The first keystroke: nothing selected, so the reverse search starts
    // at the bottom of the buffer.
    term.clearSelection();
    expect(search.findPrevious("ne", decorations)).toBe(true);
    expect(selectedRow(term)).toBe(3);

    // A longer query, the way typing goes on; its only match is above.
    term.clearSelection();
    search.findPrevious("nee", decorations);
    expect(selectedRow(term)).toBe(1);

    // Shortened back with the selection kept, as the addon's own refresh
    // does: the selection expands in place and the newer match on row 3
    // is never reached. `incremental` changes nothing in this addon.
    search.findPrevious("ne", { ...decorations, incremental: true });
    expect(selectedRow(term)).toBe(1);

    // Cleared first, the same call lands on the newest match again.
    term.clearSelection();
    search.findPrevious("ne", decorations);
    expect(selectedRow(term)).toBe(3);

    term.dispose();
  });

  test("resultIndex counts from the top, so the newest match is resultCount - 1", async () => {
    const { term, search, events } = await openTerminal(["ne a", "nee b", "xx", "ne c", "zz"]);

    term.clearSelection();
    search.findPrevious("ne", decorations);
    expect(selectedRow(term)).toBe(3);
    expect(events.at(-1)).toEqual({ resultIndex: 2, resultCount: 3 });

    // Older steps walk up the buffer and the index down; the top wraps to
    // the bottom.
    search.findPrevious("ne", decorations);
    expect(selectedRow(term)).toBe(1);
    expect(events.at(-1)).toEqual({ resultIndex: 1, resultCount: 3 });
    search.findPrevious("ne", decorations);
    expect(selectedRow(term)).toBe(0);
    expect(events.at(-1)).toEqual({ resultIndex: 0, resultCount: 3 });
    search.findPrevious("ne", decorations);
    expect(selectedRow(term)).toBe(3);
    expect(events.at(-1)).toEqual({ resultIndex: 2, resultCount: 3 });

    // A newer step walks down the buffer; the bottom wraps to the top.
    search.findNext("ne", decorations);
    expect(selectedRow(term)).toBe(0);
    expect(events.at(-1)).toEqual({ resultIndex: 0, resultCount: 3 });
    search.findNext("ne", decorations);
    expect(selectedRow(term)).toBe(1);
    expect(events.at(-1)).toEqual({ resultIndex: 1, resultCount: 3 });

    // No match: no index, zero results.
    term.clearSelection();
    expect(search.findPrevious("qq", decorations)).toBe(false);
    expect(events.at(-1)).toEqual({ resultIndex: -1, resultCount: 0 });

    term.dispose();
  });

  test("at the highlight limit the list is the oldest thousand", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 1001; i += 1) lines.push(`m${i}`);
    const { term, search, events } = await openTerminal(lines);

    // The newest match is outside the list: no index, the total capped.
    term.clearSelection();
    search.findPrevious("m", decorations);
    expect(selectedRow(term)).toBe(1000);
    expect(events.at(-1)).toEqual({ resultIndex: -1, resultCount: 1000 });

    // One step older is the last listed match, reported as if it were the
    // newest of exactly a thousand: the reason the component shows no
    // index at the limit.
    search.findPrevious("m", decorations);
    expect(selectedRow(term)).toBe(999);
    expect(events.at(-1)).toEqual({ resultIndex: 999, resultCount: 1000 });

    term.dispose();
  });
});

describe("the real search addon in the mounted tab", () => {
  // The addon refreshes its search 200 ms after each write it parses, from
  // the term it cached and with the options of the last search, and reports
  // the outcome through onDidChangeResults. clearFind drops that term, but a
  // refresh already pending still fires: it takes the empty-term path, which
  // reports no results.
  const NEEDLES = ["needle a", "b", "needle c", "d", "needle e"].join("\r\n") + "\r\n";

  /// Mount an xterm terminal, attach its session and print `text` down it,
  /// parsed by the real xterm behind the double.
  async function renderXterm(text: string) {
    realXterm.on = true;
    await renderTerminal(terminalTab(), true);
    await vi.waitFor(() => expect(TestWebSocket.all).toHaveLength(1));
    return attachXterm(TestWebSocket.all[0]!, "sess-1", text);
  }

  /// Attach the session behind the newest terminal's `socket` and print
  /// `text` down it.
  async function attachXterm(socket: TestWebSocket, id: string, text: string) {
    const model = realXterm.terminals.at(-1)!.model;
    socket.onopen?.();
    await socket.onmessage?.({
      data: JSON.stringify({ type: "session", id, seq: 0, generation: 1, missed_bytes: 0, bytes_since_focus: 0 }),
    });
    await socket.onmessage?.({ data: JSON.stringify({ type: "ready", cols: 80, rows: 24 }) });
    const print = async (out: string) => {
      const bytes = new TextEncoder().encode(out);
      const buffer = new ArrayBuffer(bytes.length);
      new Uint8Array(buffer).set(bytes);
      await socket.onmessage?.({ data: buffer });
    };
    await print(text);
    await vi.waitFor(() => expect(model.buffer.active.getLine(4)?.translateToString(true)).toBe("needle e"));
    return { model, print };
  }

  function pressEscape(input: HTMLInputElement): void {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  async function reopen(): Promise<void> {
    fireCommand("app.find.open");
    await tick();
    await tick();
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  test("output in an open bar refreshes the count", async () => {
    const { print } = await renderXterm(NEEDLES);
    const input = await openFindWithQuery("needle");
    expect(countElement()?.textContent).toBe("1 of 3");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await print("needle f\r\n");
    vi.advanceTimersByTime(1);
    expect(countElement()?.textContent, "the refresh waits 200 ms").toBe("1 of 3");
    vi.advanceTimersByTime(200);
    await tick();
    // The refresh keeps the selection, so the selected match is now the
    // second newest of four.
    expect(countElement()?.textContent).toBe("2 of 4");
    expect(input.value).toBe("needle");
  });

  test.each(["before", "after"])("a refresh pending at Escape that fires %s the bar reopens leaves its count blank", async (fires) => {
    const { print } = await renderXterm(NEEDLES);
    const input = await openFindWithQuery("needle");
    expect(countElement()?.textContent).toBe("1 of 3");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await print("more\r\n");
    vi.advanceTimersByTime(1);
    pressEscape(input);
    await tick();
    expect(findInput()).toBeNull();

    if (fires === "before") {
      vi.advanceTimersByTime(250);
      await tick();
      await reopen();
    } else {
      await reopen();
      vi.advanceTimersByTime(250);
      await tick();
    }
    expect(findInput()?.value).toBe("needle");
    expect(countElement()?.textContent).toBe("");

    // The bar's own search counts again.
    pressEnter(findInput()!);
    await tick();
    expect(countElement()?.textContent).toMatch(/^[123] of 3$/);
  });

  // A restart builds a new terminal in the same tab. The bar searched the
  // one torn down, so it closes with it; left open it would show its query
  // over a terminal it has not searched, with no count and no highlight.
  test("a restart closes the bar, and the kept query searches the new terminal", async () => {
    const first = await renderXterm(NEEDLES);
    await openFindWithQuery("needle");
    expect(countElement()?.textContent).toBe("1 of 3");

    const socket = await restartTerminal();
    expect(realXterm.terminals, "restart built a second terminal").toHaveLength(2);
    expect(findInput(), "the bar closed with the terminal it searched").toBeNull();

    const { model } = await attachXterm(socket, "sess-2", NEEDLES);
    expect(model).not.toBe(first.model);
    await reopen();
    expect(findInput()?.value).toBe("needle");
    expect(countElement()?.textContent).toBe("");
    pressEnter(findInput()!);
    await tick();
    expect(countElement()?.textContent).toBe("1 of 3");
    expect(model.getSelection()).toBe("needle");
  });

  test("a refresh pending when the query empties leaves the count blank", async () => {
    const { print } = await renderXterm(NEEDLES);
    const input = await openFindWithQuery("needle");
    expect(countElement()?.textContent).toBe("1 of 3");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await print("more\r\n");
    vi.advanceTimersByTime(1);
    typeQuery(input, "");
    await tick();
    expect(countElement()?.textContent).toBe("");
    vi.advanceTimersByTime(250);
    await tick();
    expect(countElement()?.textContent).toBe("");
  });
});

describe("terminal find on the ghostty backend", () => {
  /// Six rows from the top of a cleared screen, needles on rows 1, 3 and 5.
  const NEEDLES = "\x1b[2J\x1b[3J\x1b[H" + ["a", "needle b", "c", "needle d", "e", "needle f"].join("\r\n");
  const match = (row: number) => ({ start: { col: 0, absoluteRow: row }, end: { col: 5, absoluteRow: row } });

  beforeAll(() => {
    ghostty.module = new WebAssembly.Module(readFileSync("vendor/ghostty-vt/ghostty-vt.wasm"));
  });

  beforeEach(() => {
    __testSetStandalonePreferences(terminalPreferences({ ghostty: true }));
  });

  afterEach(() => {
    __testSetStandalonePreferences(null);
  });

  /// Mount a terminal that spawns on ghostty, attach its session and print
  /// `text` down it.
  async function renderGhostty(text: string): Promise<GhosttyStandIn> {
    await renderTerminal(terminalTab(), true);
    await vi.waitFor(() => expect(TestWebSocket.all).toHaveLength(1));
    const term = ghostty.terminals.at(-1)!;
    expect(term.wasmTerm, "the terminal runs on the binding").toBeTruthy();
    const socket = TestWebSocket.all[0]!;
    socket.onopen?.();
    await socket.onmessage?.({
      data: JSON.stringify({ type: "session", id: "sess-1", seq: 0, generation: 1, missed_bytes: 0, bytes_since_focus: 0 }),
    });
    await socket.onmessage?.({ data: JSON.stringify({ type: "ready", cols: 80, rows: 24 }) });
    await output(text);
    await vi.waitFor(() => expect(term.wasmTerm.plainText()).toContain("needle f"));
    return term;
  }

  /// `text` as PTY output down the attached session.
  async function output(text: string): Promise<void> {
    const bytes = new TextEncoder().encode(text);
    const buffer = new ArrayBuffer(bytes.length);
    new Uint8Array(buffer).set(bytes);
    await TestWebSocket.all[0]!.onmessage?.({ data: buffer });
  }

  /// Animation frames held until the case runs them, from here to the end
  /// of the case.
  function holdFrames() {
    const queue = new Map<number, FrameRequestCallback>();
    let next = 1;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      const id = next++;
      queue.set(id, cb);
      return id;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) => {
      queue.delete(id);
    }) as typeof cancelAnimationFrame;
    const frame = () => {
      const runs = [...queue.values()];
      queue.clear();
      for (const run of runs) run(0);
    };
    return {
      pending: () => queue.size,
      frame,
      settle() {
        for (let i = 0; queue.size; i++) {
          if (i > 1000) throw new Error("animation frames never stopped");
          frame();
        }
      },
    };
  }

  function selection(term: GhosttyStandIn) {
    const { selectionStart: start, selectionEnd: end } = term.selectionManager;
    return start && end ? { start, end } : null;
  }

  /// Open the bar, type "needle" and let its scan finish; frames stay held.
  async function findNeedle(term: GhosttyStandIn) {
    const frames = holdFrames();
    const input = await openFindWithQuery("needle");
    frames.settle();
    await tick();
    expect(selection(term)).toEqual(match(5));
    expect(countElement()?.textContent).toBe("1 of 3");
    return { input, frames };
  }

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
    expect(selection(term)).toEqual(match(5));
    expect(countElement()?.textContent).toBe("1 of 3+");
    frames.settle();
    await tick();
    expect(countElement()?.textContent).toBe("1 of 3");
    expect(selection(term)).toEqual(match(5));
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
      const total = term.wasmTerm.plainText()!.split("needle").length - 1;
      expect(shown, "the shown count is every frame's own").toEqual(read);
      expect(new Set(shown).size, "and it grew over the scan").toBeGreaterThan(3);
      expect(shown.at(-1)).toBe(`1 of ${total}`);
      expect(heard.slice(0, -1).every((text) => text === ""), "nothing heard while partial").toBe(true);
      expect(heard.at(-1), "the settled count heard once the scan completes").toBe(`1 of ${total}`);
      expect(selection(term)).toEqual(match(3005));

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
    expect(selection(term), "nothing selected while the scan runs").toBeNull();
    expect(countElement()?.textContent).toBe("");
    const shown: string[] = [];
    while (frames.pending()) {
      frames.frame();
      await tick();
      shown.push(countElement()!.textContent!);
      if (frames.pending()) expect(selection(term), "nothing selected while the scan runs").toBeNull();
    }
    const total = term.wasmTerm.plainText()!.split("needle").length - 1;
    expect(shown.length).toBeGreaterThan(2);
    for (const text of shown.slice(0, -1)) expect(text).toMatch(/^\? of \d+\+$/);
    expect(shown.at(-1)).toBe(`${total} of ${total}`);
    expect(selection(term)).toEqual({ start: { col: 6, absoluteRow: 5 }, end: { col: 11, absoluteRow: 5 } });
  });

  test("Enter steps to older output and Shift+Enter to newer", async () => {
    const term = await renderGhostty(NEEDLES);
    const { input } = await findNeedle(term);

    pressEnter(input);
    await tick();
    expect(selection(term)).toEqual(match(3));
    expect(countElement()?.textContent).toBe("2 of 3");

    pressEnter(input);
    await tick();
    expect(selection(term)).toEqual(match(1));
    expect(countElement()?.textContent).toBe("3 of 3");

    pressEnter(input, true);
    await tick();
    expect(selection(term)).toEqual(match(3));
    expect(countElement()?.textContent).toBe("2 of 3");
  });

  test("app.find.next steps to older output and app.find.prev to newer, both wrapping", async () => {
    const term = await renderGhostty(NEEDLES);
    await findNeedle(term);

    fireCommand("app.find.prev");
    await tick();
    expect(selection(term), "newer than the newest wraps to the oldest").toEqual(match(1));
    expect(countElement()?.textContent).toBe("3 of 3");

    fireCommand("app.find.next");
    await tick();
    expect(selection(term), "older than the oldest wraps to the newest").toEqual(match(5));
    expect(countElement()?.textContent).toBe("1 of 3");
  });

  test("reads 0 of 0 when nothing matches", async () => {
    const term = await renderGhostty(NEEDLES);
    const frames = holdFrames();
    await openFindWithQuery("absent");
    frames.settle();
    await tick();
    expect(countElement()?.textContent).toBe("0 of 0");
    expect(selection(term)).toBeNull();
  });

  test("Escape closes the bar, clears the selection and the count, and focuses the terminal", async () => {
    const term = await renderGhostty(NEEDLES);
    const { input, frames } = await findNeedle(term);
    const free = vi.spyOn(VtSearch.prototype, "free");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(findInput()).toBeNull();
    expect(selection(term)).toBeNull();
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
    expect(selection(term)).toEqual(match(5));
    expect(countElement()?.textContent).toBe("1 of 3+");
    frames.settle();
    await tick();
    expect(countElement()?.textContent).toBe("1 of 3");
  });

  // ghostty-web's focus() focuses again on a zero-delay timer. A bar that
  // reopens before that timer runs, as a quick Escape and find chord can,
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
        expect(term.keys).toEqual(["a"]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test("an emptied query clears the selection and the count", async () => {
    const term = await renderGhostty(NEEDLES);
    const { input } = await findNeedle(term);
    typeQuery(input, "");
    await tick();
    expect(selection(term)).toBeNull();
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
  /// handled by ghostty-web's own mouse code; returns the clipboard writes
  /// its release made. The canvas has the grid's size, 8 by 16 pixels a cell.
  function drag(term: GhosttyStandIn, from: { col: number; row: number }, to: { col: number; row: number }) {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    vi.spyOn(term.canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, term.cols * 8, term.rows * 16));
    const at = (cell: { col: number; row: number }) => ({ clientX: cell.col * 8 + 1, clientY: cell.row * 16 + 1 });
    try {
      term.canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...at(from) }));
      term.canvas.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, ...at(to) }));
      term.canvas.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, ...at(to) }));
      term.canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1, ...at(to) }));
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
    return writeText;
  }

  // ghostty-web drops its selection on a click anywhere outside its canvas,
  // and find's highlight is that selection. The bar is the terminal's own:
  // a click in it keeps the highlight.
  test.each(["input", "count", "box"] as const)("a click on the find bar's %s keeps find's highlight", async (part) => {
    const term = await renderGhostty(NEEDLES);
    const { input, frames } = await findNeedle(term);
    const target = { input, count: countElement()!, box: document.querySelector(".terminal-find")! }[part];
    click(target);
    expect(selection(term)).toEqual(match(5));
    await output("\r\nmore");
    frames.settle();
    await tick();
    expect(selection(term), "a later frame keeps it too").toEqual(match(5));
    expect(countElement()?.textContent).toBe("1 of 3");
    pressEnter(input);
    await tick();
    expect(selection(term)).toEqual(match(3));
  });

  test("a click elsewhere in the page still clears the selection, and find leaves it cleared", async () => {
    const term = await renderGhostty(NEEDLES);
    const { input, frames } = await findNeedle(term);
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    click(elsewhere);
    expect(selection(term), "ghostty-web's click outside its canvas").toBeNull();
    await output("\r\nmore");
    frames.settle();
    await tick();
    expect(selection(term)).toBeNull();
    expect(countElement()?.textContent).toBe("1 of 3");
    pressEnter(input);
    await tick();
    expect(selection(term), "a step highlights again").toEqual(match(3));
  });

  test("a selection the user drags after find's highlight stays theirs through a click in the bar", async () => {
    const term = await renderGhostty(NEEDLES);
    const { input, frames } = await findNeedle(term);
    const copied = drag(term, { col: 0, row: 0 }, { col: 2, row: 1 });
    const users = { start: { col: 0, absoluteRow: 0 }, end: { col: 2, absoluteRow: 1 } };
    expect(selection(term), "ghostty-web made the user's selection").toEqual(users);
    expect(copied, "and copied it on release").toHaveBeenCalledTimes(1);
    click(input);
    expect(selection(term)).toEqual(users);
    await output("\r\nmore needle");
    frames.settle();
    await tick();
    expect(selection(term), "find does not take it over").toEqual(users);
    expect(countElement()?.textContent).toBe("2 of 4");
  });

  test("a resize drops the highlight, keeps the total with no index, and Enter starts the walk over", async () => {
    const term = await renderGhostty(NEEDLES);
    const { input, frames } = await findNeedle(term);
    pressEnter(input);
    await tick();
    expect(selection(term)).toEqual(match(3));
    expect(countElement()?.textContent).toBe("2 of 3");

    // ghostty-web's own resize, where the fit and a broadcast grid end.
    term.resize(60, 24);
    expect(selection(term), "gone before ghostty-web repaints").toBeNull();
    frames.settle();
    await tick();
    expect(countElement()?.textContent).toBe("? of 3");

    pressEnter(input);
    await tick();
    expect(selection(term)).toEqual(match(5));
    expect(countElement()?.textContent).toBe("1 of 3");
  });

  test("a line chan prints when the session ends counts in an open bar", async () => {
    const term = await renderGhostty(`${NEEDLES}\r\na job ended`);
    const frames = holdFrames();
    await openFindWithQuery("ended");
    frames.settle();
    await tick();
    const earlier = { start: { col: 6, absoluteRow: 6 }, end: { col: 10, absoluteRow: 6 } };
    expect(selection(term)).toEqual(earlier);
    expect(countElement()?.textContent).toBe("1 of 1");

    await TestWebSocket.all[0]!.onmessage?.({ data: JSON.stringify({ type: "closed", reason: "idle" }) });
    expect(term.wasmTerm.plainText()).toContain("session ended (idle)");
    expect(frames.pending(), "find heard the line").toBe(1);
    frames.settle();
    await tick();
    // The core keeps the selection on its text; the line's match is newer.
    expect(countElement()?.textContent).toBe("2 of 2");
    expect(selection(term)).toEqual(earlier);
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

  test("every write the tab makes reaches a ghostty terminal through the viewport controller", () => {
    // The controller tells find of each write, and a write around it leaves
    // the count and the highlight behind. On ghostty the PTY writer handed
    // to ptyWrites is the controller's write, chan's own lines take it in
    // writeChanLine, and that helper's xterm arm is the one writeln.
    const { calls, unread } = writeCalls(terminalTabSource);
    expect(calls.sort()).toEqual(["ghosttyViewport.write", "ptyWrites.write", "term.writeln", "viewport.write"]);
    expect(unread, "no write method is reached another way").toBe(0);
    const helper = terminalTabSource.slice(terminalTabSource.indexOf("function writeChanLine("));
    expect(helper.slice(0, helper.indexOf("\n  }\n"))).toContain("else term?.writeln(line);");
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
    await vi.waitFor(() => expect(ghostty.terminals).toHaveLength(2));
    expect(findInput(), "the bar closed with the terminal it searched").toBeNull();
    expect(free).toHaveBeenCalledTimes(1);

    const next = ghostty.terminals.at(-1)!;
    const socket = TestWebSocket.all.at(-1)!;
    socket.onopen?.();
    await socket.onmessage?.({
      data: JSON.stringify({ type: "session", id: "sess-2", seq: 0, generation: 1, missed_bytes: 0, bytes_since_focus: 0 }),
    });
    await socket.onmessage?.({ data: JSON.stringify({ type: "ready", cols: 80, rows: 24 }) });
    const bytes = new TextEncoder().encode(NEEDLES);
    const buffer = new ArrayBuffer(bytes.length);
    new Uint8Array(buffer).set(bytes);
    await socket.onmessage?.({ data: buffer });
    await vi.waitFor(() => expect(next.wasmTerm.plainText()).toContain("needle f"));
    expect(document.activeElement, "the new terminal reads the keyboard").toBe(next.element);

    fireCommand("app.find.open");
    await tick();
    await tick();
    expect(findInput()?.value).toBe("needle");
    expect(countElement()?.textContent).toBe("");
    pressEnter(findInput()!);
    frames.settle();
    await tick();
    expect(selection(next)).toEqual(match(5));
    expect(countElement()?.textContent).toBe("1 of 3");
  });

  test("the terminal's teardown frees the open bar's search", async () => {
    const term = await renderGhostty(NEEDLES);
    await findNeedle(term);
    const free = vi.spyOn(VtSearch.prototype, "free");
    for (const component of mounted.splice(0)) unmount(component);
    expect(free).toHaveBeenCalledTimes(1);
  });
});
