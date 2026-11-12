// @vitest-environment jsdom
//
// Copying from and pasting into a ghostty terminal. Every copy path of a
// mounted TerminalTab on the ghostty backend writes the same text through
// chan's writer, `writeClipboardText`: the copy chord, the menu's Copy and Copy
// Scrollback, and ghostty-web's own copies on mouse release, double and triple
// click. A command longer than the terminal is wide copies as one line, and a
// double or triple click takes a word or a line across the wrap. Every paste
// path sends the program the same cleaned bytes. Each copy case runs in a
// browser, where the writer is `navigator.clipboard.writeText`, and on
// chan-desktop, where it is the native `write_clipboard_text` and any write to
// the web clipboard went around it. ClipboardItem exists, as in Chrome and
// WebKit, so a copy that writes the clipboard itself, the way ghostty-web's
// does, shows as a `write`. The terminal is a stand-in for ghostty-web's
// Terminal over the binding on the vendored core, carrying ghostty-web's own
// SelectionManager and its mouse handling, as the find tests' stand-in does,
// and ghostty-web's paste: its listeners on the element frame a native paste
// and an `insertFromPaste` input as the clipboard holds them, as does its
// `paste`, and `input` hands the program what it is given.

import { readFileSync } from "node:fs";
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import type { VtTerminal } from "@chan/ghostty-web-ng/vt";
import { terminalPreferences } from "../__tests__/standalone";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { closeTabMenu } from "../state/tabMenu.svelte";
import {
  attach,
  installTerminalDom,
  menuRow,
  openBodyMenu,
  output,
  seatTerminals,
  sentFrames,
  TERMINAL_PANE,
  TerminalSocket,
  terminalTab,
  xterm,
  pressInTerminal,
  type FakeTerminal,
} from "../__tests__/terminalTab";

/// What a case reads of the ghostty terminal stand-in.
type GhosttyStandIn = {
  wasmTerm: VtTerminal;
  cols: number;
  rows: number;
  canvas: HTMLCanvasElement;
  element: HTMLElement | null;
};

const ghostty = vi.hoisted(() => ({
  module: null as WebAssembly.Module | null,
  terminals: [] as GhosttyStandIn[],
}));

// The ghostty kit over the vendored core, with a stand-in for ghostty-web's
// Terminal: the binding's terminal as its core, ghostty-web's own
// SelectionManager over it, a canvas of 8 by 16 pixels a cell in the
// element it opens in, and a viewport that stays at the bottom.
vi.mock("../terminal/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../terminal/backend")>();
  const { SelectionManager } = await import("@chan/ghostty-web-ng");
  class Terminal {
    cols = 80;
    rows = 24;
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
    element: HTMLElement | null = null;
    constructor(options: Record<string, any>) {
      this.options = options;
      ghostty.terminals.push(this as unknown as GhosttyStandIn);
    }
    dataHandlers: Array<(data: string) => void> = [];
    open(element: HTMLElement) {
      this.element = element;
      if (!element.hasAttribute("tabindex")) element.setAttribute("tabindex", "0");
      element.append(this.canvas);
      element.addEventListener("paste", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const text = (event as ClipboardEvent).clipboardData?.getData("text/plain");
        if (text) this.paste(text);
      });
      element.addEventListener("beforeinput", (event) => {
        const input = event as InputEvent;
        if (input.inputType !== "insertFromPaste" || !input.data) return;
        event.preventDefault();
        event.stopPropagation();
        this.paste(input.data);
      });
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
    onData(handler: (data: string) => void) {
      this.dataHandlers.push(handler);
      return { dispose: () => void this.dataHandlers.splice(this.dataHandlers.indexOf(handler), 1) };
    }
    fire(data: string) {
      for (const handler of [...this.dataHandlers]) handler(data);
    }
    onResize() {
      return { dispose() {} };
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
      return this.wasmTerm.hasBracketedPaste();
    }
    write(data: string | Uint8Array) {
      this.wasmTerm.write(data);
    }
    writeln(data: string) {
      this.write(`${data}\r\n`);
    }
    paste(text: string) {
      this.fire(this.hasBracketedPaste() ? `\x1b[200~${text}\x1b[201~` : text);
    }
    input(data: string, wasUserInput = false) {
      if (wasUserInput) this.fire(data);
      else this.write(data);
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      this.wasmTerm.resize(cols, rows);
    }
    focus() {
      this.element?.focus();
    }
    blur() {}
    getSelection() {
      return this.selectionManager.getSelection();
    }
    hasSelection() {
      return this.selectionManager.hasSelection();
    }
    getViewportY() {
      return 0;
    }
    getScrollbackLength() {
      return this.wasmTerm.getScrollbackLength();
    }
    scrollLines() {}
    scrollToLine() {}
    selectAll() {
      this.selectionManager.selectAll();
    }
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

installTerminalDom();

const LINUX = "Mozilla/5.0 (X11; Linux x86_64)";
/// A command longer than the terminal's 80 columns; its second row starts
/// with a space.
const COMMAND =
  "$ curl -fsSL https://downloads.example.test/tools/install.sh | sh -s -- --prefix /opt/tools --yes";

const mounted: Array<Record<string, unknown>> = [];
let clipboard: {
  write: ReturnType<typeof vi.fn>;
  writeText: ReturnType<typeof vi.fn>;
  readText: ReturnType<typeof vi.fn>;
};
const tauri = window as unknown as { __TAURI_INTERNALS__?: { invoke: ReturnType<typeof vi.fn> } };

beforeAll(() => {
  ghostty.module = new WebAssembly.Module(readFileSync("../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm"));
});

beforeEach(() => {
  __testSetStandalonePreferences(terminalPreferences({ ghostty: true }));
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(LINUX);
  vi.stubGlobal("ClipboardItem", class {
    constructor(readonly items: Record<string, Blob>) {}
  });
  clipboard = {
    write: vi.fn(async () => {}),
    writeText: vi.fn(async (_text: string) => {}),
    readText: vi.fn(async () => ""),
  };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
});

afterEach(() => {
  delete tauri.__TAURI_INTERNALS__;
  closeTabMenu();
  for (const component of mounted.splice(0)) unmount(component);
  TerminalSocket.all.splice(0);
  ghostty.terminals.splice(0);
  xterm.terminals.splice(0);
  __testSetStandalonePreferences(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/// A command whose path the 80 columns cut inside the word.
const PATH = `/var/log/${"deep/".repeat(16)}messages.log`;
const PATH_COMMAND = `$ cat ${PATH}`;

/// Mount a terminal that spawns on ghostty, attach its session and print
/// the command and a prompt after it.
async function renderGhostty(command = COMMAND) {
  const [tab] = seatTerminals([terminalTab()]);
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(
    mount(TerminalTab, { target, props: { tab: tab!, paneId: TERMINAL_PANE, side: "a", active: true, focused: true } }),
  );
  await tick();
  await tick();
  await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(1));
  await vi.waitFor(() => expect(ghostty.terminals.at(-1)?.wasmTerm).toBeTruthy());
  const term = ghostty.terminals.at(-1)!;
  const socket = TerminalSocket.all[0]!;
  await attach(socket);
  await output(socket, `\x1b[2J\x1b[3J\x1b[H${command}\r\n$ `);
  await vi.waitFor(() => expect(term.wasmTerm.isRowWrapped(1), "the command wrapped on screen").toBe(true));
  return { target, term };
}

/// The user's drag from one screen cell to another, handled by
/// ghostty-web's own mouse code; its release copies.
function drag(term: GhosttyStandIn, from: { col: number; row: number }, to: { col: number; row: number }): void {
  const at = (cell: { col: number; row: number }) => ({ clientX: cell.col * 8 + 1, clientY: cell.row * 16 + 1 });
  term.canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...at(from) }));
  term.canvas.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, ...at(to) }));
  term.canvas.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, ...at(to) }));
}

/// Where chan's writer puts a copy on each platform, and what reads it back.
const PLATFORMS = [
  {
    name: "a browser",
    enter() {},
    /// The texts chan's writer put on the clipboard since the last read.
    takeWrites(): string[] {
      const texts = clipboard.writeText.mock.calls.map(([text]) => text as string);
      clipboard.writeText.mockClear();
      return texts;
    },
    expectNoBypass() {
      expect(clipboard.write, "no copy wrote the clipboard itself").not.toHaveBeenCalled();
    },
  },
  {
    name: "chan-desktop",
    enter() {
      tauri.__TAURI_INTERNALS__ = { invoke: vi.fn(async () => undefined) };
    },
    takeWrites(): string[] {
      const invoke = tauri.__TAURI_INTERNALS__!.invoke;
      const texts = invoke.mock.calls
        .filter(([cmd]) => cmd === "write_clipboard_text")
        .map(([, args]) => (args as { text: string }).text);
      invoke.mockClear();
      return texts;
    },
    expectNoBypass() {
      expect(clipboard.write, "no copy wrote the web clipboard itself").not.toHaveBeenCalled();
      expect(clipboard.writeText, "no copy wrote the web clipboard around the native one").not.toHaveBeenCalled();
    },
  },
] as const;

describe.each(PLATFORMS)("every copy from a ghostty terminal in $name writes the same text through chan's writer", (platform) => {
  test("a wrapped command copies as one line on release, by the chord and by the menu's Copy", async () => {
    const { target, term } = await renderGhostty();
    platform.enter();
    const lastCol = COMMAND.length - 80 - 1;

    drag(term, { col: 0, row: 0 }, { col: lastCol, row: 1 });
    await tick();
    expect(platform.takeWrites(), "ghostty-web's copy on release").toEqual([COMMAND]);

    term.element!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "C", code: "KeyC", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
    );
    await tick();
    expect(platform.takeWrites(), "the copy chord").toEqual([COMMAND]);

    await openBodyMenu(target);
    menuRow("Copy").click();
    await tick();
    expect(platform.takeWrites(), "the menu's Copy").toEqual([COMMAND]);

    platform.expectNoBypass();
  });

  test("Copy Scrollback copies the wrapped command as one line", async () => {
    const { target } = await renderGhostty();
    platform.enter();
    await openBodyMenu(target);
    menuRow("Copy Scrollback").click();
    await tick();
    expect(platform.takeWrites()).toEqual([`${COMMAND}\n$`]);
    platform.expectNoBypass();
  });

  test("a double click copies the word under it through chan's writer", async () => {
    const { term } = await renderGhostty();
    platform.enter();
    term.canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2, clientX: 3 * 8 + 1, clientY: 1 }));
    await tick();
    expect(platform.takeWrites()).toEqual(["curl"]);
    platform.expectNoBypass();
  });

  test("a double click copies a word the wrap cut whole, and a triple click the whole wrapped command", async () => {
    const { term } = await renderGhostty(PATH_COMMAND);
    platform.enter();
    const click = (detail: number, col: number, row: number) =>
      term.canvas.dispatchEvent(
        new MouseEvent("click", { bubbles: true, detail, clientX: col * 8 + 1, clientY: row * 16 + 1 }),
      );
    click(2, 10, 0);
    await tick();
    expect(platform.takeWrites(), "a double click before the wrap").toEqual([PATH]);
    click(2, 3, 1);
    await tick();
    expect(platform.takeWrites(), "a double click after the wrap").toEqual([PATH]);
    click(3, 3, 1);
    await tick();
    expect(platform.takeWrites(), "a triple click").toEqual([PATH_COMMAND]);
    platform.expectNoBypass();
  });
});

describe("pasting into a ghostty terminal", () => {
  /// A text that would end its own bracket and colour the screen, with CRLF
  /// and LF line ends, and the same text as chan pastes it under bracketed
  /// paste.
  const HOSTILE = "echo one\x1b[201~; echo two\r\nprintf '\x1b[31mred'\x03\nlast";
  const CLEANED = "\x1b[200~echo one [201~; echo two\rprintf ' [31mred' \rlast\x1b[201~";

  function inputs(): string[] {
    return sentFrames(TerminalSocket.all[0]!)
      .filter((frame) => frame.type === "input")
      .map((frame) => frame.data as string);
  }

  test("the paste chord and the menu's Paste row send the same cleaned bytes, once each", async () => {
    const { target, term } = await renderGhostty();
    await output(TerminalSocket.all[0]!, "\x1b[?2004h");
    expect(term.wasmTerm.hasBracketedPaste()).toBe(true);
    const before = inputs().length;

    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: (type: string) => (type === "text/plain" ? HOSTILE : "") },
    });
    term.element!.dispatchEvent(paste);
    await tick();
    expect(inputs().slice(before), "the chord's native paste").toEqual([CLEANED]);

    clipboard.readText.mockResolvedValue(HOSTILE);
    await openBodyMenu(target);
    menuRow("Paste").click();
    await vi.waitFor(() => expect(inputs().length).toBe(before + 2));
    expect(inputs().slice(before + 1), "the menu's Paste row").toEqual([CLEANED]);

    term.element!.dispatchEvent(
      new InputEvent("beforeinput", { inputType: "insertFromPaste", data: HOSTILE, bubbles: true, cancelable: true }),
    );
    await tick();
    expect(inputs().slice(before + 2), "an insertFromPaste input").toEqual([CLEANED]);
  });
});

describe("the Linux desktop PRIMARY selection", () => {
  function desktop(primary: string | null = "from another application") {
    const invoke = vi.fn(async (cmd: string, _args?: unknown) => cmd === "read_primary_selection" ? primary : undefined);
    tauri.__TAURI_INTERNALS__ = { invoke };
    return invoke;
  }

  function middle(host: HTMLElement): MouseEvent {
    for (const type of ["mousedown", "mouseup"]) {
      host.dispatchEvent(new MouseEvent(type, { button: 1, bubbles: true, cancelable: true }));
    }
    const event = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true });
    host.dispatchEvent(event);
    return event;
  }

  function inputs(): string[] {
    return sentFrames(TerminalSocket.all[0]!).filter((f) => f.type === "input").map((f) => f.data as string);
  }

  /// A task after the current one: what chan defers past a release has run.
  function nextTask(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  test("ghostty mouse copies also write PRIMARY, while chord and menu copies leave PRIMARY alone", async () => {
    const invoke = desktop();
    const { term, target } = await renderGhostty(PATH_COMMAND);
    invoke.mockClear();
    drag(term, { col: 0, row: 0 }, { col: PATH_COMMAND.length - 81, row: 1 });
    await nextTask();
    expect(invoke.mock.calls).toEqual([
      ["write_clipboard_text", { text: PATH_COMMAND }], ["write_primary_selection", { text: PATH_COMMAND }],
    ]);
    invoke.mockClear();
    for (const [detail, text] of [[2, PATH], [3, PATH_COMMAND]] as const) {
      term.canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, detail, clientX: 25, clientY: 17 }));
      await tick();
      expect(invoke.mock.calls).toEqual([["write_clipboard_text", { text }], ["write_primary_selection", { text }]]);
      invoke.mockClear();
    }
    term.element!.dispatchEvent(new KeyboardEvent("keydown", {
      key: "C", code: "KeyC", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
    }));
    await tick();
    expect(invoke.mock.calls).toEqual([["write_clipboard_text", { text: PATH_COMMAND }]]);
    invoke.mockClear();
    await openBodyMenu(target);
    menuRow("Copy").click();
    await tick();
    expect(invoke.mock.calls).toEqual([["write_clipboard_text", { text: PATH_COMMAND }]]);
    expect(clipboard.write).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  test("middle click sends hostile PRIMARY through ghostty's cleaned paste exactly once", async () => {
    const invoke = desktop("echo one\x1b[201~; echo two\r\nprintf '\x1b[31mred'\x03\nlast");
    const { term } = await renderGhostty();
    await output(TerminalSocket.all[0]!, "\x1b[?2004h");
    invoke.mockClear();
    const before = inputs().length;
    const widget = vi.fn();
    term.element!.addEventListener("auxclick", widget);
    const event = middle(term.canvas);
    await vi.waitFor(() => expect(inputs().slice(before)).toEqual([
      "\x1b[200~echo one [201~; echo two\rprintf ' [31mred' \rlast\x1b[201~",
    ]));
    expect(event.defaultPrevented).toBe(true);
    expect(widget).not.toHaveBeenCalled();
    expect(invoke.mock.calls).toEqual([["read_primary_selection", undefined]]);
    expect(clipboard.readText).not.toHaveBeenCalled();
  });

  async function renderXterm() {
    __testSetStandalonePreferences(terminalPreferences({ ghostty: false }));
    const [tab] = seatTerminals([terminalTab()]);
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(TerminalTab, { target, props: { tab: tab!, paneId: TERMINAL_PANE, side: "a", active: true, focused: true } }));
    await tick();
    await vi.waitFor(() => expect(xterm.terminals).toHaveLength(1));
    await attach(TerminalSocket.all[0]!);
    return xterm.terminals[0]!;
  }

  test("xterm mouse selection writes its copy text only on release, never for a keyboard selection", async () => {
    const invoke = desktop();
    const term = await renderXterm();
    invoke.mockClear();
    term.changeSelection("a find result");
    expect(invoke).not.toHaveBeenCalled();
    term.element!.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    term.changeSelection("partial");
    expect(invoke).not.toHaveBeenCalled();
    term.changeSelection(COMMAND);
    document.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
    await nextTask();
    expect(invoke.mock.calls).toEqual([["write_primary_selection", { text: COMMAND }]]);
    invoke.mockClear();
    pressInTerminal(term, { key: "C", code: "KeyC", ctrlKey: true, shiftKey: true });
    await tick();
    expect(invoke.mock.calls).toEqual([["write_clipboard_text", { text: COMMAND }]]);
    invoke.mockClear();
    term.element!.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    term.changeSelection("");
    document.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
    await nextTask();
    expect(invoke).not.toHaveBeenCalled();
  });

  /// A release in the order WebKitGTK runs a trusted mouseup. xterm adds its
  /// document mouseup listener when a drag starts, after chan's, and
  /// announces the final selection from it; the engine runs a microtask
  /// checkpoint after each listener of an event it dispatches, so microtasks
  /// chan's listener queued run before xterm's listener does. A script's
  /// dispatchEvent runs every listener first. Here chan's listener runs, then
  /// its microtasks, then xterm's announcement.
  async function releaseAsTheEngineDoes(term: FakeTerminal, selection: string): Promise<void> {
    document.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
    await Promise.resolve();
    term.changeSelection(selection);
  }

  function pressLeft(term: FakeTerminal): void {
    term.element!.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
  }

  test("xterm writes PRIMARY once with the selection it announces on a trusted release, line break kept", async () => {
    const invoke = desktop();
    const term = await renderXterm();
    invoke.mockClear();
    const text = `primary-${"x".repeat(160)}-end\nwide:\u754c end`;
    pressLeft(term);
    await releaseAsTheEngineDoes(term, text);
    await nextTask();
    expect(invoke.mock.calls).toEqual([["write_primary_selection", { text }]]);
  });

  test("a press before the deferred read leaves the write to its own release", async () => {
    const invoke = desktop();
    const term = await renderXterm();
    invoke.mockClear();
    // The first click of a double click clears the selection; the second
    // press arrives before that release's read runs, and its release
    // announces the word.
    pressLeft(term);
    await releaseAsTheEngineDoes(term, "");
    pressLeft(term);
    await nextTask();
    await releaseAsTheEngineDoes(term, PATH);
    await nextTask();
    expect(invoke.mock.calls).toEqual([["write_primary_selection", { text: PATH }]]);
  });
  /// A right click as the engine dispatches it, at a cell of the terminal.
  function rightClick(on: Element): MouseEvent {
    const event = new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true, clientX: 25, clientY: 17 });
    on.dispatchEvent(event);
    return event;
  }

  test("a right click on ghostty opens chan's menu before ghostty-web selects its textarea", async () => {
    const invoke = desktop();
    const { term } = await renderGhostty(PATH_COMMAND);
    drag(term, { col: 0, row: 0 }, { col: PATH_COMMAND.length - 81, row: 1 });
    await tick();
    invoke.mockClear();
    const select = vi.spyOn(HTMLTextAreaElement.prototype, "select");
    const range = vi.spyOn(HTMLTextAreaElement.prototype, "setSelectionRange");
    const event = rightClick(term.canvas);
    await tick();
    await tick();
    expect(select, "a selected textarea is what WebKitGTK copies into PRIMARY").not.toHaveBeenCalled();
    expect(range).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    menuRow("Copy").click();
    await tick();
    expect(invoke.mock.calls).toEqual([["write_clipboard_text", { text: PATH_COMMAND }]]);
  });

  test("a right click on xterm opens chan's menu before xterm.js selects its textarea", async () => {
    const invoke = desktop();
    const term = await renderXterm();
    // xterm.js's own right-click handler on its element, which the stand-in
    // has none of: the selection goes into its textarea, selected, for a
    // browser menu's Copy.
    const widget = document.createElement("div");
    const textarea = document.createElement("textarea");
    term.element!.append(widget, textarea);
    widget.addEventListener("contextmenu", () => {
      textarea.value = term.getSelection();
      textarea.select();
    });
    term.changeSelection(COMMAND);
    invoke.mockClear();
    const select = vi.spyOn(HTMLTextAreaElement.prototype, "select");
    const event = rightClick(widget);
    await tick();
    await tick();
    expect(select, "a selected textarea is what WebKitGTK copies into PRIMARY").not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    menuRow("Copy").click();
    await tick();
    expect(invoke.mock.calls).toEqual([["write_clipboard_text", { text: COMMAND }]]);
  });

  test("in a browser ghostty-web's right click still selects its textarea under chan's menu", async () => {
    const { term } = await renderGhostty(PATH_COMMAND);
    drag(term, { col: 0, row: 0 }, { col: PATH_COMMAND.length - 81, row: 1 });
    await tick();
    const select = vi.spyOn(HTMLTextAreaElement.prototype, "select");
    const event = rightClick(term.canvas);
    await tick();
    await tick();
    expect(select).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(menuRow("Copy")).toBeTruthy();
  });

  test("an xterm drag that ends on its previous selection writes PRIMARY again", async () => {
    const invoke = desktop();
    const term = await renderXterm();
    pressLeft(term);
    await releaseAsTheEngineDoes(term, COMMAND);
    await nextTask();
    invoke.mockClear();
    // The same cells dragged again: on the way xterm puts the selection in
    // its textarea, which WebKitGTK copies into PRIMARY, and its release
    // announces nothing, since the selection did not change.
    pressLeft(term);
    term.element!.dispatchEvent(new MouseEvent("mousemove", { buttons: 1, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
    await nextTask();
    expect(invoke.mock.calls).toEqual([["write_primary_selection", { text: COMMAND }]]);
    invoke.mockClear();
    // A press and release with no move and no announcement writes nothing,
    // whatever selection is left.
    pressLeft(term);
    term.element!.dispatchEvent(new MouseEvent("mousemove", { buttons: 0, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
    await nextTask();
    expect(invoke).not.toHaveBeenCalled();
  });

  test("xterm middle click sends PRIMARY through its real paste encoder", async () => {
    const text = "one\r\ntwo\nthree\x1b[201~";
    const invoke = desktop(text);
    const term = await renderXterm();
    invoke.mockClear();
    const { Terminal } = await vi.importActual<typeof import("@xterm/xterm")>("@xterm/xterm");
    const real = new Terminal();
    // Its encoder needs only the hidden textarea; no renderer or display.
    (real as unknown as { _core: { textarea: HTMLTextAreaElement } })._core.textarea = document.createElement("textarea");
    const subscription = real.onData((data) => term.type(data));
    await new Promise<void>((resolve) => real.write("\x1b[?2004h", resolve));
    const paste = vi.spyOn(term, "paste").mockImplementation((value) => real.paste(value));
    const before = inputs().length;
    const event = middle(term.element!);
    await vi.waitFor(() => expect(inputs().slice(before)).toEqual(["\x1b[200~one\rtwo\rthree\x1b[201~\x1b[201~"]));
    expect(paste).toHaveBeenCalledExactlyOnceWith(text);
    subscription.dispose();
    real.dispose();
    expect(event.defaultPrevented).toBe(true);
    expect(invoke.mock.calls).toEqual([["read_primary_selection", undefined]]);
    expect(clipboard.readText).not.toHaveBeenCalled();
  });

  test.each(["ghostty", "xterm"])("%s installs no PRIMARY handler in a browser", async (backend) => {
    const term = backend === "ghostty" ? (await renderGhostty()).term : await renderXterm();
    const event = middle(term.element!);
    await tick();
    expect(event.defaultPrevented).toBe(false);
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(inputs()).toEqual([]);
  });

  test.each(["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", "Mozilla/5.0 (Windows NT 10.0)"])("non-Linux desktops keep native middle click (%s)", async (ua) => {
    const invoke = desktop();
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
    const { term } = await renderGhostty();
    invoke.mockClear();
    expect(middle(term.canvas).defaultPrevented).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  test("teardown ignores a delayed PRIMARY read and removes the mouse handlers", async () => {
    const invoke = desktop();
    const { term } = await renderGhostty();
    const host = term.element!;
    const encode = vi.spyOn(term.wasmTerm, "encodePaste");
    let finish!: (text: string) => void;
    invoke.mockImplementation((cmd) => cmd === "read_primary_selection"
      ? new Promise<string>((resolve) => { finish = resolve; }) : Promise.resolve(undefined));
    const before = inputs().length;
    middle(host);
    await unmount(mounted.pop()!);
    finish("must not reach a disposed terminal");
    // Drain the nested invoke/read continuations before the negative assertion.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inputs().length).toBe(before);
    expect(encode, "no paste reaches the freed core").not.toHaveBeenCalled();
    invoke.mockClear();
    expect(middle(host).defaultPrevented).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    const reached = vi.fn();
    host.addEventListener("contextmenu", reached);
    rightClick(host);
    expect(reached, "a right click reaches the host's own listeners again").toHaveBeenCalledOnce();
  });

  test.each([null, ""])("an absent or empty PRIMARY does not paste (%s)", async (text) => {
    const invoke = desktop(text);
    const { term } = await renderGhostty();
    const before = inputs().length;
    invoke.mockClear();
    middle(term.canvas);
    await tick();
    expect(invoke.mock.calls).toEqual([["read_primary_selection", undefined]]);
    expect(inputs().length).toBe(before);
  });
});
