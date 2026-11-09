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
//
// The component cases run on terminal and addon doubles that record the
// calls. The last block runs the real addon over a real xterm in jsdom
// to pin what the doubles stand in for: where findPrevious lands from a
// cleared and from a kept selection, the top-down order of resultIndex,
// and what the addon reports at its highlight limit.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import TerminalTab from "./TerminalTab.svelte";
import type { TerminalTab as TerminalTabState } from "../state/tabs.svelte";
import { terminalTab } from "../__tests__/tabs";

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

  readyState = TestWebSocket.OPEN;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void | Promise<void>) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

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

globalThis.ResizeObserver = TestResizeObserver as any;
globalThis.WebSocket = TestWebSocket as any;
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  cb(0);
  return 0;
}) as any;
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
