// @vitest-environment jsdom

// Terminal find (issue #6). The contracts pinned here:
//
// 1. The xterm Terminal is constructed with `allowProposedApi: true`.
//    xterm gates registerDecoration behind that flag, and the search
//    addon's decorated find throws without it -- the find bar "matches
//    nothing" because the search dies mid-keystroke.
// 2. The find command family (app.find.open / next / prev) reaches the
//    focused terminal over the chan:command bus. On desktop the key
//    bridge claims Mod+F / Mod+G before the webview sees the keydown
//    and fires these commands; App.svelte serves them for file tabs
//    only, so the terminal must serve itself or the chord is dead on
//    a terminal pane.
// 3. Direction. Typing selects the newest match, the bottom-most in the
//    buffer: the selection is cleared and the addon's reverse search
//    starts from the bottom. Enter and app.find.next step to older
//    output (findPrevious); Shift+Enter and app.find.prev step to newer
//    output (findNext).
// 4. The count. The bar reads `k of n` with k counting from the newest
//    match, fed by the addon's onDidChangeResults: `0 of 0` without a
//    match, `? of 1000+` at the highlight limit, blank once the bar
//    closes or the query empties.
// 5. Ghostty. A ghostty terminal has the same bar, menu row, commands,
//    direction and count, found by libghostty-vt's search on chan's
//    binding: the active match is ghostty-web's selection, the total
//    carries a `+` while the scan runs, and Escape clears the selection.
//
// The xterm component cases run on terminal and addon doubles that record
// the calls. The block after them runs the real addon over a real xterm in
// jsdom to pin what the doubles stand in for: where findPrevious lands from
// a cleared and from a kept selection, the top-down order of resultIndex,
// and what the addon reports at its highlight limit. The ghostty cases run
// the binding over the vendored core inside a ghostty-web terminal stand-in
// that carries ghostty-web's own SelectionManager, with animation frames
// run by the case.

import { readFileSync } from "node:fs";
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import TerminalTab from "./TerminalTab.svelte";
import terminalTabSource from "./TerminalTab.svelte?raw";
import type { TerminalTab as TerminalTabState } from "../state/tabs.svelte";
import { terminalTab } from "../__tests__/tabs";
import { terminalPreferences } from "../__tests__/standalone";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { VtSearch, type VtTerminal } from "../terminal/ghosttyVt";

type ResultsEvent = { resultIndex: number; resultCount: number };

const mounted: Array<Record<string, any>> = [];
const terminalOptions: Array<Record<string, unknown>> = [];
/// Every selection and search call in order, so a case can read that typing
/// clears the selection before the reverse search runs.
const calls: Array<{ name: string; query?: string; opts?: unknown }> = [];
let resultsListener: ((e: ResultsEvent) => void) | null = null;

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

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};

    constructor(options: Record<string, unknown> = {}) {
      terminalOptions.push(options);
    }

    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData() {}
    onBinary() {}
    onResize() {}
    write() {}
    writeln() {}
    resize() {}
    focus() {}
    clearSelection() {
      calls.push({ name: "clearSelection" });
    }
    dispose() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext(query: string, opts: unknown) {
      calls.push({ name: "findNext", query, opts });
    }
    findPrevious(query: string, opts: unknown) {
      calls.push({ name: "findPrevious", query, opts });
    }
    clearDecorations() {
      calls.push({ name: "clearDecorations" });
    }
    onDidChangeResults(listener: (e: ResultsEvent) => void) {
      resultsListener = listener;
      return { dispose() {} };
    }
  },
}));

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
  viewportY: number;
  focused: number;
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
// and a resize that hands the core the new grid and fires the resize event.
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
    open() {
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

  test("is a named status region", async () => {
    await renderTerminal(terminalTab(), true);
    await openFindWithQuery("needle");
    await reportResults({ resultIndex: 0, resultCount: 1 });

    const count = countElement();
    expect(count?.getAttribute("role")).toBe("status");
    expect(count?.getAttribute("aria-label")).toBe("find matches");
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
    const bytes = new TextEncoder().encode(text);
    const buffer = new ArrayBuffer(bytes.length);
    new Uint8Array(buffer).set(bytes);
    await socket.onmessage?.({ data: buffer });
    await vi.waitFor(() => expect(term.wasmTerm.plainText()).toContain("needle f"));
    return term;
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
    const focused = term.focused;

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(findInput()).toBeNull();
    expect(selection(term)).toBeNull();
    expect(free).toHaveBeenCalledTimes(1);
    expect(term.focused).toBe(focused + 1);

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

  test("an emptied query clears the selection and the count", async () => {
    const term = await renderGhostty(NEEDLES);
    const { input } = await findNeedle(term);
    typeQuery(input, "");
    await tick();
    expect(selection(term)).toBeNull();
    expect(countElement()?.textContent).toBe("");
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

  test("every write the tab makes reaches a ghostty terminal through the viewport controller", () => {
    // The controller tells find of each write, and a write around it leaves
    // the count and the highlight behind. On ghostty the PTY writer handed
    // to ptyWrites is the controller's write, chan's own lines take it in
    // writeChanLine, and that helper's xterm arm is the one writeln.
    const writes = [...terminalTabSource.matchAll(/\b(\w+)\??\.(write|writeln)\(/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(writes.sort()).toEqual(["ghosttyViewport.write", "ptyWrites.write", "term.writeln", "viewport.write"]);
    const helper = terminalTabSource.slice(terminalTabSource.indexOf("function writeChanLine("));
    expect(helper.slice(0, helper.indexOf("\n  }\n"))).toContain("else term?.writeln(line);");
  });

  test("the terminal's teardown frees the open bar's search", async () => {
    const term = await renderGhostty(NEEDLES);
    await findNeedle(term);
    const free = vi.spyOn(VtSearch.prototype, "free");
    for (const component of mounted.splice(0)) unmount(component);
    expect(free).toHaveBeenCalledTimes(1);
  });
});
