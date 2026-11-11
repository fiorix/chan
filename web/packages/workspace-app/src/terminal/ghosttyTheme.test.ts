// @vitest-environment jsdom
//
// A theme switch on a live ghostty terminal. ghostty-web's Terminal is opened
// over chan's binding on the vendored core, its canvases software contexts
// that keep their pixels and its animation frames run by hand. A switch has
// to leave the core reporting, and resolving every cell with, the colors of a
// terminal opened in the new theme and fed the same output, the next frame
// has to paint every pixel that terminal paints, and nothing else may change.

import { readFileSync } from "node:fs";
import { Terminal, type GhosttyCell, type ITheme } from "@chan/ghostty-web-ng";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { SoftwareCanvasContext } from "../__tests__/softwareCanvas";
import { applyGhosttyTheme } from "./ghosttyTheme";
import { VtTerminal, GhosttyVt } from "./ghosttyVt";

const VENDORED = "vendor/ghostty-vt/ghostty-vt.wasm";
const COLS = 24;
const ROWS = 6;
/// What the software context's measureText reports per character, and the
/// row height ghostty-web derives from its fixed ascent and descent.
const CELL_WIDTH = 8;
const CELL_HEIGHT = 19;

const ANSI_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

/// chan's two terminal themes as the terminal tab builds them from the theme
/// tokens (`--bg`, `--text`, `--link`) and its fixed palettes.
const SELECTION = "rgba(88, 166, 255, 0.35)";
const DARK: ITheme = {
  background: "#1c1c1e",
  foreground: "#f5f5f7",
  cursor: "#58a6ff",
  selectionBackground: SELECTION,
  ...palette([
    "#0c0c0d", "#ff6b6b", "#6cd07a", "#e3b341", "#58a6ff", "#b07dff", "#5dd8d8", "#d8d8de",
    "#6c6c70", "#ff8585", "#8be89a", "#f2d16b", "#7dbdff", "#c8a6ff", "#7df0f0", "#ffffff",
  ]),
};
const LIGHT: ITheme = {
  background: "#ffffff",
  foreground: "#1c1c1e",
  cursor: "#0969da",
  selectionBackground: SELECTION,
  ...palette([
    "#24292f", "#cf222e", "#1a7f37", "#8a6300", "#0969da", "#8250df", "#1b7c83", "#4b5563",
    "#57606a", "#a40e26", "#116329", "#6f4e00", "#0550ae", "#6639ba", "#0a6b73", "#6e7781",
  ]),
};

function palette(colors: string[]): ITheme {
  return Object.fromEntries(ANSI_KEYS.map((key, i) => [key, colors[i]]));
}

/// The 16 colors as foreground on one row and background on the next, then
/// a 256-color, a truecolor and an inverse cell, which a switch must not move.
const COLOR_ROWS =
  [...Array(8).keys()].map((i) => `\x1b[${30 + i}mf\x1b[${90 + i}mF`).join("") + "\x1b[0m\r\n" +
  [...Array(8).keys()].map((i) => `\x1b[${40 + i}mb\x1b[${100 + i}mB`).join("") + "\x1b[0m\r\n" +
  "\x1b[38;5;196mx\x1b[48;5;21my\x1b[38;2;1;2;3mz\x1b[0m \x1b[7minverse\x1b[0m\r\n";
/// Plain lines that push the first copy of the colored rows into history, so
/// both the screen and the history hold every kind of cell.
const OUTPUT = COLOR_ROWS + "plain one\r\nplain two\r\nplain three\r\n" + COLOR_ROWS + "$ ";

let vendored: WebAssembly.Module;
let TERMINAL_DATA: Record<string, number> = {};
let frames: FrameRequestCallback[] = [];
const opened: Terminal[] = [];

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
  TERMINAL_DATA = terminalData(await WebAssembly.instantiate(vendored, {}));
});

beforeEach(() => {
  const contexts = new WeakMap<HTMLCanvasElement, SoftwareCanvasContext>();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    let context = contexts.get(this);
    if (!context) contexts.set(this, (context = new SoftwareCanvasContext(this, CELL_WIDTH)));
    return context as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  for (const term of opened.splice(0)) {
    term.dispose();
    term.element?.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/// A terminal as the terminal tab makes one, opened in `theme`.
async function openTerminal(theme: ITheme, output = OUTPUT): Promise<Terminal> {
  const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const term = new Terminal({
    cols: COLS,
    rows: ROWS,
    cursorBlink: false,
    cursorStyle: "block",
    ghostty: vt.asGhostty(),
    smoothScrollDuration: 0,
    theme: { ...theme },
  });
  const host = document.createElement("div");
  document.body.append(host);
  term.open(host);
  opened.push(term);
  term.write(output);
  frame();
  return term;
}

/// One animation frame: the callbacks queued so far, once.
function frame(): void {
  const due = frames.splice(0);
  for (const callback of due) callback(performance.now());
}

function core(term: Terminal): VtTerminal {
  const vt: unknown = term.wasmTerm;
  if (!(vt instanceof VtTerminal)) throw new Error("not chan's binding");
  return vt;
}

/// Every cell of the screen and of the history, as the renderer reads them.
function cells(term: Terminal): GhosttyCell[][] {
  const vt = core(term);
  const rows: GhosttyCell[][] = [];
  for (let y = 0; y < vt.getScrollbackLength(); y++) rows.push(vt.getScrollbackLine(y) ?? []);
  for (let y = 0; y < ROWS; y++) rows.push(vt.getLine(y) ?? []);
  return rows;
}

/// The core's own colors, read through its C API rather than the binding's
/// cache: the effective and default foreground, background and cursor, and
/// the effective and default 256-color palettes. An unset color is null.
function coreColors(term: Terminal): Record<string, number[] | null> {
  const vt = core(term) as unknown as {
    handle: number;
    wasm: {
      fn: { ghostty_terminal_get(terminal: number, data: number, out: number): number };
      alloc(len: number): number;
      free(ptr: number, len: number): void;
      bytes(): Uint8Array;
    };
  };
  const out: Record<string, number[] | null> = {};
  const buf = vt.wasm.alloc(768);
  try {
    for (const name of ["FOREGROUND", "BACKGROUND", "CURSOR", "PALETTE"]) {
      for (const data of [`COLOR_${name}`, `COLOR_${name}_DEFAULT`]) {
        const size = name === "PALETTE" ? 768 : 3;
        const value = TERMINAL_DATA[data];
        if (value === undefined) throw new Error(`no GhosttyTerminalData.${data} in the pinned build`);
        const result = vt.wasm.fn.ghostty_terminal_get(vt.handle, value, buf);
        out[data] = result === 0 ? [...vt.wasm.bytes().slice(buf, buf + size)] : null;
      }
    }
  } finally {
    vt.wasm.free(buf, 768);
  }
  return out;
}

/// `GhosttyTerminalData`'s values, from the pinned build's own type
/// description.
function terminalData(instance: WebAssembly.Instance): Record<string, number> {
  const exports = instance.exports as Record<string, unknown>;
  const ptr = (exports.ghostty_type_json as () => number)();
  const bytes = new Uint8Array((exports.memory as WebAssembly.Memory).buffer);
  let end = ptr;
  while (bytes[end] !== 0) end++;
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(ptr, end))) as {
    types: Record<string, { values?: Record<string, number> }>;
  };
  return json.types.GhosttyTerminalData?.values ?? {};
}

/// Every pixel of the terminal's canvas, as `r,g,b,a` strings.
function pixels(term: Terminal): string[] {
  const context = (term.renderer as unknown as { ctx: SoftwareCanvasContext }).ctx;
  const out: string[] = [];
  for (let y = 0; y < ROWS * CELL_HEIGHT; y++) {
    for (let x = 0; x < COLS * CELL_WIDTH; x++) {
      const p = context.pixelAt(x, y);
      out.push(`${p.r},${p.g},${p.b},${p.a}`);
    }
  }
  return out;
}

/// The pixel in the middle of cell (`col`, `row`) of the viewport.
function cellPixel(term: Terminal, col: number, row: number): string {
  const context = (term.renderer as unknown as { ctx: SoftwareCanvasContext }).ctx;
  const p = context.pixelAt(col * CELL_WIDTH + CELL_WIDTH / 2, row * CELL_HEIGHT + CELL_HEIGHT / 2);
  return `${p.r},${p.g},${p.b},${p.a}`;
}

function opaque(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},1`;
}

function rgb(hex: string): { r: number; g: number; b: number } {
  const value = Number.parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function fg(cell: GhosttyCell): string {
  return `#${[cell.fg_r, cell.fg_g, cell.fg_b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function bg(cell: GhosttyCell): string {
  return `#${[cell.bg_r, cell.bg_g, cell.bg_b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/// The screen's rows of the second copy of the colored rows.
const SCREEN_FG_ROW = 2;
const SCREEN_BG_ROW = 3;

describe("a theme switch on a live ghostty terminal", () => {
  test("the core reports the new defaults and palette and resolves every cell as a terminal opened in the theme", async () => {
    const term = await openTerminal(DARK);
    const before = cells(term);
    const beforeColors = coreColors(term);
    expect(core(term).getColors().background).toEqual(rgb(DARK.background!));

    expect(applyGhosttyTheme(term, LIGHT)).toBe(true);
    const fresh = await openTerminal(LIGHT);
    expect(coreColors(term), "the core's own colors").toEqual(coreColors(fresh));
    expect(core(term).getColors()).toEqual(core(fresh).getColors());
    expect(core(term).getColors().background).toEqual(rgb(LIGHT.background!));
    expect(cells(term), "every cell of the screen and the history").toEqual(cells(fresh));

    // The 16 colors are the light theme's, as foreground and as background.
    const screen = (row: number) => core(term).getLine(row)!;
    const fgRow = screen(SCREEN_FG_ROW).map(fg);
    const bgRow = screen(SCREEN_BG_ROW).map(bg);
    for (let i = 0; i < 8; i++) {
      expect(fgRow[2 * i], ANSI_KEYS[i]).toBe(LIGHT[ANSI_KEYS[i]]);
      expect(fgRow[2 * i + 1], ANSI_KEYS[8 + i]).toBe(LIGHT[ANSI_KEYS[8 + i]]);
      expect(bgRow[2 * i], ANSI_KEYS[i]).toBe(LIGHT[ANSI_KEYS[i]]);
      expect(bgRow[2 * i + 1], ANSI_KEYS[8 + i]).toBe(LIGHT[ANSI_KEYS[8 + i]]);
    }

    expect(applyGhosttyTheme(term, DARK)).toBe(true);
    expect(coreColors(term), "switched back, the core's colors").toEqual(beforeColors);
    expect(cells(term), "switched back, every cell").toEqual(before);
  });

  test("the next frame paints every pixel as a terminal opened in the theme, and switching back restores them", async () => {
    const term = await openTerminal(DARK);
    term.select(1, SCREEN_FG_ROW, 6);
    frame();
    const dark = pixels(term);
    expect(cellPixel(term, COLS - 1, 0), "an unstyled cell").toBe(opaque(DARK.background!));

    applyGhosttyTheme(term, LIGHT);
    frame();
    const fresh = await openTerminal(LIGHT);
    fresh.select(1, SCREEN_FG_ROW, 6);
    frame();
    expect(pixels(term)).toEqual(pixels(fresh));
    expect(cellPixel(term, COLS - 1, 0), "an unstyled cell").toBe(opaque(LIGHT.background!));
    expect(cellPixel(term, 2, SCREEN_BG_ROW), "a red background cell").toBe(opaque(LIGHT.red!));
    const cursor = core(term).getCursor();
    expect(cellPixel(term, cursor.x, cursor.y), "the cursor").toBe(opaque(LIGHT.cursor!));
    expect(pixels(term)).not.toEqual(dark);

    applyGhosttyTheme(term, DARK);
    frame();
    expect(pixels(term)).toEqual(dark);
  });

  test("colors the program set itself stay over the new defaults", async () => {
    // OSC 4 sets palette entry 1, OSC 10 the foreground, OSC 11 the
    // background and OSC 12 the cursor.
    const own =
      "\x1b]4;1;rgb:12/34/56\x07\x1b]10;rgb:aa/bb/cc\x07\x1b]11;rgb:20/30/40\x07\x1b]12;rgb:01/02/03\x07" + OUTPUT;
    const term = await openTerminal(DARK, own);
    applyGhosttyTheme(term, LIGHT);
    const fresh = await openTerminal(LIGHT, own);
    expect(coreColors(term)).toEqual(coreColors(fresh));
    expect(cells(term)).toEqual(cells(fresh));
    expect(fg(core(term).getLine(SCREEN_FG_ROW)![2]!), "the program's red").toBe("#123456");
    expect(core(term).getColors().background, "the program's background").toEqual(rgb("#203040"));
    expect(core(term).getColors().foreground, "the program's foreground").toEqual(rgb("#aabbcc"));
    expect(coreColors(term).COLOR_CURSOR, "the program's cursor").toEqual([1, 2, 3]);
  });

  test("a color the new theme leaves out takes upstream's default, as in a terminal opened in it", async () => {
    const { red: _red, cursor: _cursor, ...partial } = LIGHT;
    const term = await openTerminal(DARK);
    applyGhosttyTheme(term, partial);
    const fresh = await openTerminal(partial);
    expect(coreColors(term)).toEqual(coreColors(fresh));
    expect(cells(term)).toEqual(cells(fresh));
    expect(fg(core(term).getLine(SCREEN_FG_ROW)![2]!)).not.toBe(DARK.red);
  });

  test("a switch changes nothing else: output, input, selection, scroll position and focus", async () => {
    const long = [...Array(30).keys()].map((i) => `line ${i}`).join("\r\n") + "\r\n" + OUTPUT;
    const term = await openTerminal(DARK, long);
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    term.focus();
    term.scrollLines(-3);
    term.select(0, 1, 9);
    frame();
    const text = () => {
      const buffer = term.buffer.active;
      return [...Array(buffer.length).keys()].map((y) => buffer.getLine(y)?.translateToString(true));
    };
    const state = () => ({
      text: text(),
      history: term.getScrollbackLength(),
      viewport: term.getViewportY(),
      cursor: core(term).getCursor(),
      selection: term.getSelection(),
      selected: term.hasSelection(),
      focus: document.activeElement,
    });
    const before = state();
    expect(before.viewport).toBe(3);
    expect(before.selection).not.toBe("");

    applyGhosttyTheme(term, LIGHT);
    frame();
    applyGhosttyTheme(term, DARK);
    frame();
    expect(state()).toEqual(before);
    expect(sent, "nothing written to the program").toEqual([]);

    term.input("typed", true);
    expect(sent, "input after the switch reaches the program once").toEqual(["typed"]);
  });

  test("the widget holds the new theme without a warning, so a reset rebuilds the core in it", async () => {
    const warn = vi.spyOn(console, "warn");
    const term = await openTerminal(DARK);
    applyGhosttyTheme(term, LIGHT);
    expect(warn).not.toHaveBeenCalled();
    expect(term.options.theme).toEqual(LIGHT);

    term.reset();
    expect(core(term).getColors().background).toEqual(rgb(LIGHT.background!));
  });

  test("a terminal not yet open takes the theme when it opens", async () => {
    const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
    const term = new Terminal({ cols: COLS, rows: ROWS, ghostty: vt.asGhostty(), theme: { ...DARK } });
    expect(applyGhosttyTheme(term, LIGHT)).toBe(false);
    const host = document.createElement("div");
    document.body.append(host);
    term.open(host);
    opened.push(term);
    expect(core(term).getColors().background).toEqual(rgb(LIGHT.background!));
  });
});
