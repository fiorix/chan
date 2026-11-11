// @vitest-environment jsdom
//
// Copying from and pasting into a ghostty terminal. Every copy path of a
// mounted TerminalTab on the ghostty backend writes the same text through
// chan's writer, `writeClipboardText`: the copy chord, the menu's Copy and Copy
// Scrollback, and ghostty-web's own copies on mouse release and double click. A
// command longer than the terminal is wide copies as one line. Every paste path
// sends the program the same cleaned bytes. Each copy case runs in a browser,
// where the writer is `navigator.clipboard.writeText`, and on chan-desktop,
// where it is the native `write_clipboard_text` and any write to the web
// clipboard went around it. ClipboardItem exists, as in Chrome and WebKit, so a
// copy that writes the clipboard itself, the way ghostty-web's does, shows as a
// `write`. The terminal is a stand-in for ghostty-web's Terminal over the
// binding on the vendored core, carrying ghostty-web's own SelectionManager and
// its mouse handling, as the find tests' stand-in does, and ghostty-web's
// paste: its listeners on the element frame a native paste and an
// `insertFromPaste` input as the clipboard holds them, as does its `paste`, and
// `input` hands the program what it is given.

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
import type { VtTerminal } from "../terminal/ghosttyVt";
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
  const { SelectionManager } = await import("ghostty-web");
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
  ghostty.module = new WebAssembly.Module(readFileSync("vendor/ghostty-vt/ghostty-vt.wasm"));
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
  __testSetStandalonePreferences(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/// Mount a terminal that spawns on ghostty, attach its session and print
/// the command and a prompt after it.
async function renderGhostty() {
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
  await output(socket, `\x1b[2J\x1b[3J\x1b[H${COMMAND}\r\n$ `);
  await vi.waitFor(() => expect(term.wasmTerm.isRowWrapped(1), "the command wrapped on screen").toBe(true));
  return { target, term };
}

/// The user's drag from one screen cell to another, handled by
/// ghostty-web's own mouse code; its release copies.
function drag(term: GhosttyStandIn, from: { col: number; row: number }, to: { col: number; row: number }): void {
  const at = (cell: { col: number; row: number }) => ({ clientX: cell.col * 8 + 1, clientY: cell.row * 16 + 1 });
  term.canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...at(from) }));
  term.canvas.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, ...at(to) }));
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
