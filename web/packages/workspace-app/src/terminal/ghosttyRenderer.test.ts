// The ghostty widget's renderer over chan's binding on the vendored core,
// wired the way Terminal.open() wires them, over a software canvas that keeps
// the text the renderer hands it and the colour it fills that text in. The
// test writes the bytes and issues the frames.

import { readFileSync } from "node:fs";
import { CanvasRenderer, SelectionManager, Terminal, type ITheme } from "@chan/ghostty-web-ng";
import { GhosttyVt, VtCells, type VtTerminal } from "@chan/ghostty-web-ng/vt";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { expectPixel, SoftwareCanvasContext, sourceOver, type Rgba } from "../__tests__/softwareCanvas";
import { transparentColor } from "./backgroundOpacity";
import { alignGhosttyRendererToXterm, type CellDimensions } from "./ghosttyCompat";

const VENDORED = "../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";
const COLS = 12;
const ROWS = 3;

/// A software context that also keeps each text it is asked to fill, at
/// the point the renderer draws it from, with the fill and the alpha it is
/// drawn in, and each line it strokes, from the point the line starts.
class TextRecordingContext extends SoftwareCanvasContext {
  readonly texts: { text: string; x: number; y: number; fill: string; alpha: number }[] = [];
  readonly strokes: { x: number; y: number; stroke: string }[] = [];
  #from = { x: 0, y: 0 };

  override fillText(text = "", x = 0, y = 0): void {
    this.texts.push({ text, x, y, fill: this.fillStyle, alpha: this.globalAlpha });
  }

  override moveTo(x = 0, y = 0): void {
    this.#from = { x, y };
  }

  override stroke(): void {
    this.strokes.push({ ...this.#from, stroke: this.strokeStyle });
  }
}

/// One cell's cluster and the columns it takes.
type Cluster = [text: string, width: number];

/// A row as its clusters: the bytes that write it, and the text each cell
/// that paints should hand the canvas, by column. A wide cell paints once,
/// from its first column, and a cell nothing was written to as a space.
function row(clusters: Cluster[]): { bytes: string; cells: [number, string][] } {
  const cells: [number, string][] = [];
  let col = 0;
  for (const [text, width] of clusters) {
    cells.push([col, text]);
    col += width;
  }
  for (; col < COLS; col += 1) cells.push([col, " "]);
  return { bytes: clusters.map(([text]) => text).join(""), cells };
}

function ascii(text: string): Cluster[] {
  return [...text].map((char) => [char, 1]);
}

// A combining mark, a wide character made wide by its variation selector,
// and an emoji ZWJ sequence, each a cluster of several codepoints in one
// cell; and three others of the same kinds for the screen rows.
const E_ACUTE = "e\u0301";
const N_TILDE = "n\u0303";
const HEART = "\u2764\ufe0f";
const FAMILY = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}";
const A_DIAERESIS = "a\u0308";
const PLANE = "\u2708\ufe0f";
const CODER = "\u{1f469}\u200d\u{1f4bb}";

const HISTORY = [
  row([[E_ACUTE, 1], [" ", 1], [HEART, 2], [" ", 1], [FAMILY, 2], [" ", 1], ["x", 1]]),
  row([[FAMILY, 2], [N_TILDE, 1], [HEART, 2], ...ascii("ok"), [E_ACUTE, 1]]),
  row([...ascii("ab"), [E_ACUTE, 1], [N_TILDE, 1], [HEART, 2], [FAMILY, 2]]),
];

// The screen rows below them. Each holds something else at the columns
// where the history row of the same index holds a cluster: other clusters,
// plain text, nothing.
const SCREEN = [
  row([[A_DIAERESIS, 1], [" ", 1], [PLANE, 2], [" ", 1], [CODER, 2]]),
  row(ascii("plain text")),
  row([]),
];

// A history and a screen for a view scrolled back by fewer rows than the
// screen holds. Each row holds a cluster at a column no other row starts
// one in, so a row drawn with another row's clusters paints letters there.
const PARTIAL_ROWS = 4;
const PARTIAL_HISTORY = [
  row([["h", 1], [N_TILDE, 1], ...ascii("0 history")]),
  row([...ascii("h1"), [E_ACUTE, 1], ...ascii(" one")]),
  row([...ascii("h2   "), [FAMILY, 2], ...ascii(" two")]),
];
const PARTIAL_SCREEN = [
  row([...ascii("s0 scree"), [HEART, 2]]),
  row([[A_DIAERESIS, 1], ...ascii(" s1 screen")]),
  row([...ascii("s2 screen!"), [PLANE, 2]]),
  row([...ascii("s3 "), [CODER, 2], ...ascii(" end")]),
];

/// The whole cluster the core holds at column `col` of screen row `y`, or
/// of history row `y` with `history`.
function clusterAt(core: VtTerminal, y: number, col: number, history = false): string | null {
  const cells = new VtCells();
  if (!(history ? core.readHistoryRow(y, cells) : core.readRow(y, cells))) return null;
  return cells.at(col)?.cluster ?? null;
}

/// The cells of a row that hold a cluster of several codepoints.
function clusters(cells: [number, string][]): [number, string][] {
  return cells.filter(([, text]) => [...text].length > 1);
}

describe("the ghostty renderer scrolled back", () => {
  let vendored: WebAssembly.Module;

  beforeAll(async () => {
    vendored = await WebAssembly.compile(readFileSync(VENDORED));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /// A `rows`-row terminal that has been written `lines`, one per row.
  async function scrolledBack(rows: number, lines: { bytes: string }[]) {
    const contexts = new WeakMap<HTMLCanvasElement, TextRecordingContext>();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      function (this: HTMLCanvasElement) {
        const existing = contexts.get(this);
        if (existing) return existing as unknown as CanvasRenderingContext2D;
        const created = new TextRecordingContext(this);
        contexts.set(this, created);
        return created as unknown as CanvasRenderingContext2D;
      } as unknown as typeof HTMLCanvasElement.prototype.getContext,
    );
    const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
    const term = new Terminal({ ghostty: vt, cols: COLS, rows });
    term.wasmTerm = vt.createTerminal(COLS, rows, { scrollbackLimit: 100 });
    const canvas = document.createElement("canvas");
    const renderer = new CanvasRenderer(canvas, { devicePixelRatio: 1 });
    renderer.resize(COLS, rows);
    term.renderer = renderer;
    const context = contexts.get(canvas)!;
    term.wasmTerm.write("\x1b[?25l" + lines.map((r) => r.bytes).join("\r\n"));
    return {
      term,
      /// One frame as the widget's render loop issues it.
      frame() {
        context.texts.length = 0;
        renderer.render(term.wasmTerm!, false, term.getViewportY(), 0);
      },
      /// What the last frame painted on view row `y`: each cell's text by
      /// its column.
      painted(y: number): [number, string][] {
        const { width, height, baseline } = renderer.getMetrics();
        return context.texts
          .filter((t) => t.y === y * height + baseline)
          .map((t): [number, string] => [t.x / width, t.text])
          .sort(([a], [b]) => a - b);
      },
    };
  }

  test("a history row paints its own grapheme clusters", async () => {
    const screen = await scrolledBack(ROWS, [...HISTORY, ...SCREEN]);
    expect(screen.term.getScrollbackLength()).toBe(HISTORY.length);
    // The core holds each cluster in the history row it was written to, at
    // the column the row's layout gives it.
    for (const [offset, { cells }] of HISTORY.entries()) {
      for (const [col, text] of cells) {
        if ([...text].length > 1) {
          expect(clusterAt(screen.term.wasmTerm!, offset, col, true), `history ${offset}, column ${col}`).toBe(text);
        }
      }
    }

    // The whole view from history: view row y is history row y.
    screen.term.scrollLines(-ROWS);
    expect(screen.term.getViewportY()).toBe(ROWS);
    screen.frame();
    for (const [y, { cells }] of HISTORY.entries()) {
      expect.soft(screen.painted(y), `view row ${y}`).toEqual(cells);
    }

    // One row back: the newest history row on top, screen rows below it.
    screen.term.scrollLines(ROWS - 1);
    expect(screen.term.getViewportY()).toBe(1);
    screen.frame();
    expect.soft(screen.painted(0), "view row 0, one row back").toEqual(HISTORY[HISTORY.length - 1].cells);
  });

  test("a partly scrolled view paints every row's own grapheme clusters", async () => {
    const screen = await scrolledBack(PARTIAL_ROWS, [...PARTIAL_HISTORY, ...PARTIAL_SCREEN]);
    const core = screen.term.wasmTerm!;
    expect(screen.term.getScrollbackLength()).toBe(PARTIAL_HISTORY.length);
    // The core holds each cluster in the row it was written to.
    for (const [offset, { cells }] of PARTIAL_HISTORY.entries()) {
      for (const [col, text] of clusters(cells)) {
        expect(clusterAt(core, offset, col, true), `history ${offset}, column ${col}`).toBe(text);
      }
    }
    for (const [y, { cells }] of PARTIAL_SCREEN.entries()) {
      for (const [col, text] of clusters(cells)) {
        expect(clusterAt(core, y, col), `screen row ${y}, column ${col}`).toBe(text);
      }
    }

    // Two rows back: the two newest history rows on top, the screen's first
    // two rows below them.
    screen.term.scrollLines(-2);
    expect(screen.term.getViewportY()).toBe(2);
    screen.frame();
    const view = [...PARTIAL_HISTORY.slice(-2), ...PARTIAL_SCREEN.slice(0, 2)];
    for (const [y, { cells }] of view.entries()) {
      expect.soft(screen.painted(y), `view row ${y}`).toEqual(cells);
    }
  });
});

/// A canvas colour as its red, green and blue channels, from the `#rrggbb`
/// a theme names or the `rgb()` the renderer fills a cell's own colour in.
function channels(style: string): string {
  const hex = style.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const value = Number.parseInt(hex[1], 16);
    return `${(value >> 16) & 255},${(value >> 8) & 255},${value & 255}`;
  }
  const functional = style.match(/^rgba?\(([^)]+)\)$/);
  if (!functional) throw new Error(`unsupported canvas colour: ${style}`);
  return functional[1].split(",").slice(0, 3).map((part) => Number(part.trim())).join(",");
}

describe("the ghostty renderer's selected text", () => {
  const cols = 24;
  const rows = 4;

  /// TerminalTab's terminalTheme() at its dark fallbacks, with the one
  /// palette colour the rows use: a translucent selection background and no
  /// selection foreground, as chan's themes name none.
  const THEME: ITheme = {
    background: "#1c1c1e",
    foreground: "#ebebf0",
    cursor: "#58a6ff",
    selectionBackground: "rgba(88, 166, 255, 0.35)",
    red: "#ff6b6b",
  };

  // Red, the default colour, inverse video, faint red and underlined red,
  // by the columns each takes.
  const ROW = "\x1b[31mred\x1b[0m def \x1b[7minv\x1b[0m \x1b[2;31mdim\x1b[0m \x1b[4;31mul\x1b[0m";
  const RED = [0, 1, 2];
  const DEFAULT = [4, 5, 6];
  const INVERSE = [8, 9, 10];
  const FAINT = [12, 13, 14];
  const UNDERLINED = [16, 17];
  const WRITTEN = [...RED, ...DEFAULT, ...INVERSE, ...FAINT, ...UNDERLINED];

  let vendored: WebAssembly.Module;

  beforeAll(async () => {
    vendored = await WebAssembly.compile(readFileSync(VENDORED));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  /// A terminal whose first two rows hold the same cells, with ghostty-web's
  /// own selection over the whole of the first, its core and its renderer
  /// built from `theme` as open() builds them.
  async function selected(theme: ITheme, bytes = "") {
    const contexts = new WeakMap<HTMLCanvasElement, TextRecordingContext>();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      function (this: HTMLCanvasElement) {
        const existing = contexts.get(this);
        if (existing) return existing as unknown as CanvasRenderingContext2D;
        const created = new TextRecordingContext(this);
        contexts.set(this, created);
        return created as unknown as CanvasRenderingContext2D;
      } as unknown as typeof HTMLCanvasElement.prototype.getContext,
    );
    const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
    const term = new Terminal({ ghostty: vt, cols, rows, theme });
    const config = (term as unknown as { buildWasmConfig(): Parameters<GhosttyVt["createTerminal"]>[2] }).buildWasmConfig();
    term.wasmTerm = vt.createTerminal(cols, rows, config);
    const canvas = document.createElement("canvas");
    const host = document.createElement("div");
    host.append(canvas);
    document.body.append(host);
    (term as unknown as { element: HTMLElement }).element = host;
    const renderer = new CanvasRenderer(canvas, { devicePixelRatio: 1, theme });
    renderer.resize(cols, rows);
    term.renderer = renderer;
    const manager = new SelectionManager(term, renderer, term.wasmTerm, document.createElement("textarea"));
    (term as unknown as { selectionManager: SelectionManager }).selectionManager = manager;
    renderer.setSelectionManager(manager);
    term.wasmTerm.write("\x1b[?25l" + ROW + "\r\n" + ROW + bytes);
    term.select(0, 0, cols);
    const context = contexts.get(canvas)!;
    const { width, height, baseline } = renderer.getMetrics();
    return {
      renderer,
      context,
      /// One full frame as the widget's render loop issues it.
      frame() {
        context.texts.length = 0;
        context.strokes.length = 0;
        renderer.render(term.wasmTerm!, true, term.getViewportY(), 0);
      },
      /// The colour and alpha each written cell of view row `y` drew its
      /// glyph in, by column, from the row's own pass.
      glyphs(y: number): Map<number, { text: string; fill: string; alpha: number }> {
        const painted = new Map<number, { text: string; fill: string; alpha: number }>();
        for (const t of context.texts) {
          const col = t.x / width;
          if (t.y !== y * height + baseline || !WRITTEN.includes(col) || painted.has(col)) continue;
          painted.set(col, { text: t.text, fill: channels(t.fill), alpha: t.alpha });
        }
        return painted;
      },
      /// The colour each underline under view row `y` is stroked in, by
      /// column.
      underlines(y: number): Map<number, string> {
        const lines = new Map<number, string>();
        for (const s of context.strokes) {
          if (s.y !== y * height + baseline + 2) continue;
          lines.set(s.x / width, channels(s.stroke));
        }
        return lines;
      },
      cell: { width, height },
    };
  }

  test("a selected cell draws its glyph in the colour it has unselected", async () => {
    const screen = await selected(THEME);
    screen.frame();
    const chosen = screen.glyphs(0);
    const plain = screen.glyphs(1);
    expect([...chosen.keys()].sort((a, b) => a - b)).toEqual(WRITTEN);
    for (const col of WRITTEN) {
      expect.soft(chosen.get(col), `column ${col}`).toEqual(plain.get(col));
    }
    // Each in the colour it was written in: red, the default foreground,
    // inverse video's default background, and red at half strength.
    for (const col of RED) expect.soft(chosen.get(col)?.fill, `red, column ${col}`).toBe(channels(THEME.red!));
    for (const col of DEFAULT) expect.soft(chosen.get(col)?.fill, `default, column ${col}`).toBe(channels(THEME.foreground!));
    for (const col of INVERSE) expect.soft(chosen.get(col)?.fill, `inverse, column ${col}`).toBe(channels(THEME.background!));
    for (const col of FAINT) {
      expect.soft(chosen.get(col), `faint, column ${col}`).toMatchObject({ fill: channels(THEME.red!), alpha: 0.5 });
    }
    // An underline follows its glyph.
    for (const col of UNDERLINED) {
      expect.soft(screen.underlines(0).get(col), `underline, column ${col}`).toBe(channels(THEME.red!));
    }
  });

  test("a theme that names a selection foreground draws selected glyphs in it", async () => {
    const theme = { ...THEME, selectionForeground: "#204060" };
    const screen = await selected(theme);
    screen.frame();
    const chosen = screen.glyphs(0);
    expect([...chosen.keys()].sort((a, b) => a - b)).toEqual(WRITTEN);
    for (const col of WRITTEN) {
      expect.soft(chosen.get(col)?.fill, `column ${col}`).toBe(channels("#204060"));
    }
    for (const col of UNDERLINED) {
      expect.soft(screen.underlines(0).get(col), `underline, column ${col}`).toBe(channels("#204060"));
    }
    // The unselected row keeps its own colours.
    for (const col of RED) expect.soft(screen.glyphs(1).get(col)?.fill, `row 1, column ${col}`).toBe(channels(THEME.red!));

    // A theme switch that drops it puts the selected cells back in their
    // own colours.
    screen.renderer.setTheme(THEME);
    screen.frame();
    for (const col of RED) expect.soft(screen.glyphs(0).get(col)?.fill, `after the switch, column ${col}`).toBe(channels(THEME.red!));
  });

  test("the selection background and a cursor's glyph on a selected cell stay as they were", async () => {
    // A visible block cursor parked on the first row's red "e".
    const screen = await selected(THEME, "\x1b[?25h\x1b[1;2H");
    screen.frame();
    // The selection background over the theme's, filled whole: no glyph
    // colour reaches the cell's pixels.
    const { width, height } = screen.cell;
    const at = screen.context.pixelAt(4.5 * width, 0.5 * height);
    expectPixel(at, sourceOver({ r: 88, g: 166, b: 255, a: 0.35 }, { r: 28, g: 28, b: 30, a: 1 }));
    // The cursor, drawn after the rows, redraws its glyph in the cursor
    // accent, the renderer's default since the theme names none.
    const cursorGlyph = screen.context.texts.filter((t) => t.x === width && t.text === "e").at(-1);
    expect(cursorGlyph && channels(cursorGlyph.fill)).toBe(channels("#1e1e1e"));
  });
});

/// A canvas colour as a pixel, from the `#rrggbb` a theme names or the
/// `rgb()` and `rgba()` the renderer and a see-through theme fill in.
function pixel(style: string): Rgba {
  const [r, g, b] = channels(style).split(",").map(Number);
  const alpha = style.match(/^rgba\((?:[^,]+,){3}([^)]+)\)$/);
  return { r, g, b, a: alpha ? Number(alpha[1]) : 1 };
}

describe("the ghostty renderer's cell backgrounds", () => {
  const cols = 24;
  const rows = 3;

  /// TerminalTab's terminalTheme() at its fallbacks, each with its palette's
  /// black, opaque and as a see-through window builds it: the background at
  /// alpha 0, which the widget hands the core as black.
  const DARK: ITheme = { background: "#1c1c1e", foreground: "#ebebf0", cursor: "#58a6ff", black: "#0c0c0d" };
  const LIGHT: ITheme = { background: "#ffffff", foreground: "#1c1c1e", cursor: "#0969da", black: "#24292f" };
  const THEMES: [string, ITheme][] = [
    ["dark", DARK],
    ["light", LIGHT],
    ["dark, see-through", { ...DARK, background: transparentColor(DARK.background!) }],
    ["light, see-through", { ...LIGHT, background: transparentColor(LIGHT.background!) }],
  ];

  // By column: default cells; pure black named as RGB, from the 256-colour
  // table and by inverse video over a black foreground; cells erased in RGB
  // black and in the table's black; the palette's black; inverse video over
  // the default colours; and default cells between them and after.
  const ROW =
    "df \x1b[48;2;0;0;0mrg\x1b[0m \x1b[48;5;16m16\x1b[0m \x1b[7;38;2;0;0;0miv\x1b[0m " +
    "\x1b[48;2;0;0;0m\x1b[3X\x1b[0m\x1b[3C\x1b[48;5;16m\x1b[3X\x1b[0m\x1b[3C " +
    "\x1b[40mpb\x1b[0m \x1b[7mx\x1b[0m";
  const BLACK = [3, 4, 6, 7, 9, 10, 12, 13, 14, 15, 16, 17];
  const PALETTE_BLACK = [19, 20];
  const INVERSE = [22];
  const DEFAULT = Array.from({ length: cols }, (_, x) => x).filter(
    (x) => !BLACK.includes(x) && !PALETTE_BLACK.includes(x) && !INVERSE.includes(x),
  );

  let vendored: WebAssembly.Module;

  beforeAll(async () => {
    vendored = await WebAssembly.compile(readFileSync(VENDORED));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /// A terminal built from `theme` as open() builds it, its core and its
  /// renderer, written `bytes` with the cursor hidden.
  async function painted(theme: ITheme, bytes: string) {
    const contexts = new WeakMap<HTMLCanvasElement, SoftwareCanvasContext>();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      function (this: HTMLCanvasElement) {
        const existing = contexts.get(this);
        if (existing) return existing as unknown as CanvasRenderingContext2D;
        const created = new SoftwareCanvasContext(this);
        contexts.set(this, created);
        return created as unknown as CanvasRenderingContext2D;
      } as unknown as typeof HTMLCanvasElement.prototype.getContext,
    );
    const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
    const term = new Terminal({ ghostty: vt, cols, rows, theme });
    const config = (term as unknown as { buildWasmConfig(): Parameters<GhosttyVt["createTerminal"]>[2] }).buildWasmConfig();
    term.wasmTerm = vt.createTerminal(cols, rows, config);
    const canvas = document.createElement("canvas");
    const renderer = new CanvasRenderer(canvas, { devicePixelRatio: 1, theme });
    renderer.resize(cols, rows);
    term.renderer = renderer;
    term.wasmTerm.write("\x1b[?25l" + bytes);
    const context = contexts.get(canvas)!;
    const { width, height } = renderer.getMetrics();
    return {
      term,
      /// One full frame as the widget's render loop issues it.
      frame() {
        renderer.render(term.wasmTerm!, true, term.getViewportY(), 0);
      },
      /// The pixel at the middle of the cell at column `x` of view row `y`.
      /// The software canvas paints no glyphs, so it is the cell's
      /// background over the row's.
      at(x: number, y: number): Rgba {
        return context.pixelAt((x + 0.5) * width, (y + 0.5) * height);
      },
    };
  }

  /// What each cell of the row paints under `theme`: pure black, the
  /// palette's black and inverse video's default foreground over the row's
  /// theme fill, and the theme fill alone where the background is the
  /// default, clear in a see-through window.
  function expected(theme: ITheme): Map<number, Rgba> {
    const clear = { r: 0, g: 0, b: 0, a: 0 };
    const row = sourceOver(pixel(theme.background!), clear);
    const cells = new Map<number, Rgba>();
    for (const x of DEFAULT) cells.set(x, row);
    for (const x of BLACK) cells.set(x, sourceOver(pixel("#000000"), row));
    for (const x of PALETTE_BLACK) cells.set(x, sourceOver(pixel(theme.black!), row));
    for (const x of INVERSE) cells.set(x, sourceOver(pixel(theme.foreground!), row));
    return cells;
  }

  function expectRow(screen: Awaited<ReturnType<typeof painted>>, y: number, theme: ITheme, where: string): void {
    for (const [x, want] of expected(theme)) {
      const got = screen.at(x, y);
      for (const channel of ["r", "g", "b", "a"] as const) {
        expect.soft(got[channel], `${where}, column ${x}, ${channel}`).toBeCloseTo(want[channel], 6);
      }
    }
  }

  test.each(THEMES)("a screen row paints the backgrounds a program set, pure black included (%s)", async (_name, theme) => {
    const screen = await painted(theme, ROW);
    screen.frame();
    expectRow(screen, 0, theme, "screen row 0");
  });

  test.each(THEMES)("a history row paints the backgrounds a program set, pure black included (%s)", async (_name, theme) => {
    const screen = await painted(theme, ROW + "\r\n".repeat(rows));
    expect(screen.term.getScrollbackLength()).toBe(1);
    screen.term.scrollLines(-1);
    expect(screen.term.getViewportY()).toBe(1);
    screen.frame();
    expectRow(screen, 0, theme, "history row 0 at view row 0");
  });
});

type Point = { x: number; y: number };
type Clip = { left: number; right: number; top: number; bottom: number };

/// One stroke as the canvas held it when stroked: its colour, width, dash
/// pattern and clip, the straight segments of its path and its curves, each
/// curve as points along it.
type Stroke = {
  style: string;
  width: number;
  dash: number[];
  dashOffset: number;
  clip: Clip | null;
  lines: [Point, Point][];
  curves: Point[][];
};

/// A software context that also keeps each glyph it fills, with the colour
/// it is filled in, and each stroke with its path, its colour and the dash
/// and clip state it is stroked under, which save and restore keep.
class PathRecordingContext extends SoftwareCanvasContext {
  readonly texts: { text: string; x: number; y: number; fill: string }[] = [];
  readonly strokes: Stroke[] = [];
  #dash: number[] = [];
  #clip: Clip | null = null;
  #rect: Clip | null = null;
  #lines: [Point, Point][] = [];
  #curves: Point[][] = [];
  #at: Point = { x: 0, y: 0 };
  #states: { dash: number[]; dashOffset: number; clip: Clip | null; strokeStyle: string; lineWidth: number }[] = [];

  override fillText(text = "", x = 0, y = 0): void {
    this.texts.push({ text, x, y, fill: this.fillStyle });
  }

  override save(): void {
    super.save();
    const { lineDashOffset: dashOffset, strokeStyle, lineWidth } = this;
    this.#states.push({ dash: this.#dash, dashOffset, clip: this.#clip, strokeStyle, lineWidth });
  }

  override restore(): void {
    super.restore();
    const state = this.#states.pop();
    if (!state) return;
    this.#dash = state.dash;
    this.#clip = state.clip;
    this.lineDashOffset = state.dashOffset;
    this.strokeStyle = state.strokeStyle;
    this.lineWidth = state.lineWidth;
  }

  override beginPath(): void {
    this.#lines = [];
    this.#curves = [];
    this.#rect = null;
  }

  override moveTo(x = 0, y = 0): void {
    this.#at = { x, y };
  }

  override lineTo(x = 0, y = 0): void {
    this.#lines.push([this.#at, { x, y }]);
    this.#at = { x, y };
  }

  override quadraticCurveTo(cx = 0, cy = 0, x = 0, y = 0): void {
    const from = this.#at;
    const at = (t: number, a: number, c: number, b: number) => (1 - t) * (1 - t) * a + 2 * (1 - t) * t * c + t * t * b;
    const points: Point[] = [];
    for (let i = 0; i <= 16; i++) points.push({ x: at(i / 16, from.x, cx, x), y: at(i / 16, from.y, cy, y) });
    this.#curves.push(points);
    this.#at = { x, y };
  }

  override rect(x = 0, y = 0, width = 0, height = 0): void {
    this.#rect = { left: x, right: x + width, top: y, bottom: y + height };
  }

  override clip(): void {
    const rect = this.#rect;
    if (!rect) return;
    const clip = this.#clip;
    this.#clip = clip
      ? {
          left: Math.max(clip.left, rect.left),
          right: Math.min(clip.right, rect.right),
          top: Math.max(clip.top, rect.top),
          bottom: Math.min(clip.bottom, rect.bottom),
        }
      : rect;
  }

  override setLineDash(dash: number[] = []): void {
    this.#dash = [...dash];
  }

  override stroke(): void {
    this.strokes.push({
      style: this.strokeStyle,
      width: this.lineWidth,
      dash: this.#dash,
      dashOffset: this.lineDashOffset,
      clip: this.#clip,
      lines: this.#lines,
      curves: this.#curves,
    });
  }
}

/// The spans along x that a straight line from `from` to `to` inks under a
/// dash pattern, as the canvas lays a pattern along each subpath: from its
/// start, `offset` into the pattern.
function dashed(from: number, to: number, dash: number[], offset: number): [number, number][] {
  if (dash.length === 0) return [[from, to]];
  const pattern = dash.length % 2 === 0 ? dash : [...dash, ...dash];
  const period = pattern.reduce((a, b) => a + b, 0);
  const spans: [number, number][] = [];
  let at = -(((offset % period) + period) % period);
  for (let i = 0; at < to - from; i = (i + 1) % pattern.length) {
    const end = at + pattern[i];
    if (i % 2 === 0 && Math.min(end, to - from) > Math.max(at, 0)) {
      spans.push([from + Math.max(at, 0), from + Math.min(end, to - from)]);
    }
    at = end;
  }
  return spans;
}

/// What one stroke inks: each straight line as the spans it inks along x at
/// its height, and each curve as its points, within the stroke's clip.
type Ink = { style: string; width: number; runs: { from: number; to: number; y: number }[]; curves: Point[][]; clip: Clip | null };

function ink(stroke: Stroke): Ink {
  const left = stroke.clip?.left ?? -Infinity;
  const right = stroke.clip?.right ?? Infinity;
  const runs = stroke.lines.flatMap(([a, b]) => {
    expect(a.y, "a decoration's straight line is level").toBe(b.y);
    expect(a.x, "a decoration's straight line runs left to right").toBeLessThan(b.x);
    return dashed(a.x, b.x, stroke.dash, stroke.dashOffset)
      .map(([from, to]) => ({ from: Math.max(from, left), to: Math.min(to, right), y: a.y }))
      .filter((run) => run.to > run.from);
  });
  const curves = stroke.curves.map((points) => points.filter((p) => p.x >= left && p.x <= right));
  return { style: channels(stroke.style), width: stroke.width, runs, curves, clip: stroke.clip };
}

/// How many times a curve's points turn from falling to rising or back.
function turns(points: Point[]): number {
  let count = 0;
  let last = 0;
  for (let i = 1; i < points.length; i++) {
    const dy = Math.sign(points[i].y - points[i - 1].y);
    if (dy !== 0 && last !== 0 && dy !== last) count++;
    if (dy !== 0) last = dy;
  }
  return count;
}

describe("the ghostty renderer's underline styles and overline", () => {
  const cols = 40;
  const rows = 3;
  const THEME: ITheme = { background: "#1c1c1e", foreground: "#ebebf0", cursor: "#58a6ff" };
  const GLYPH = channels(THEME.foreground!);
  const RED = "255,0,0";

  // Each sample by name: its SGR, its text and the columns its text takes.
  // The row writes them in this order, a default space after each.
  const SAMPLES = {
    single: ["4", "S", 1],
    double: ["4:2", "D", 1],
    curly: ["4:3", "C", 1],
    dotted: ["4:4", "O", 1],
    dashed: ["4:5", "A", 1],
    overline: ["53", "V", 1],
    curlyRgb: ["4:3;58;2;255;0;0", "R", 1],
    singlePalette: ["4;58;5;196", "P", 1],
    resetColour: ["4;58;2;255;0;0m\x1b[59", "G", 1],
    struck: ["9;4:3;58;2;255;0;0", "T", 1],
    wideCurly: ["4:3", "漢", 2],
    wideDashed: ["4:5", "字", 2],
    plain: ["0", "plain", 5],
  } as const;
  type Sample = keyof typeof SAMPLES;
  const ROW = Object.values(SAMPLES)
    .map(([sgr, text]) => `\x1b[${sgr}m${text}\x1b[0m `)
    .join("");
  const COLUMN = {} as Record<Sample, number>;
  {
    let col = 0;
    for (const [name, [, , width]] of Object.entries(SAMPLES)) {
      COLUMN[name as Sample] = col;
      col += width + 1;
    }
  }

  let vendored: WebAssembly.Module;

  beforeAll(async () => {
    vendored = await WebAssembly.compile(readFileSync(VENDORED));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /// A terminal built from THEME as open() builds it, its core and its
  /// renderer, written `bytes` with the cursor hidden. The font measures
  /// `fontWidth` pixels a character; with `cell`, the renderer is aligned to
  /// that cell as TerminalTab aligns it to xterm.js's grid.
  async function painted(bytes: string, { fontWidth = 8, cell }: { fontWidth?: number; cell?: CellDimensions } = {}) {
    const contexts = new WeakMap<HTMLCanvasElement, PathRecordingContext>();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      function (this: HTMLCanvasElement) {
        const existing = contexts.get(this);
        if (existing) return existing as unknown as CanvasRenderingContext2D;
        const created = new PathRecordingContext(this, fontWidth);
        contexts.set(this, created);
        return created as unknown as CanvasRenderingContext2D;
      } as unknown as typeof HTMLCanvasElement.prototype.getContext,
    );
    const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
    const term = new Terminal({ ghostty: vt, cols, rows, theme: THEME });
    const config = (term as unknown as { buildWasmConfig(): Parameters<GhosttyVt["createTerminal"]>[2] }).buildWasmConfig();
    term.wasmTerm = vt.createTerminal(cols, rows, config);
    const canvas = document.createElement("canvas");
    const renderer = new CanvasRenderer(canvas, { devicePixelRatio: 1, theme: THEME });
    renderer.resize(cols, rows);
    if (cell) expect(alignGhosttyRendererToXterm(renderer, cell, cols, rows), "aligned").not.toBeNull();
    term.renderer = renderer;
    term.wasmTerm.write("\x1b[?25l" + bytes);
    const context = contexts.get(canvas)!;
    const metrics = renderer.getMetrics();
    return {
      term,
      renderer,
      metrics,
      /// One full frame as the widget's render loop issues it.
      frame() {
        context.texts.length = 0;
        context.strokes.length = 0;
        renderer.render(term.wasmTerm!, true, term.getViewportY(), 0);
      },
      /// What the strokes of the last frame ink over the cell at `col` of
      /// view row `y` that takes `width` columns, each stroke's ink cut to
      /// the cell, the strokes that ink nothing there left out.
      strokes(y: number, col: number, width = 1): Ink[] {
        const left = col * metrics.width;
        const right = (col + width) * metrics.width;
        const top = y * metrics.height;
        const bottom = top + metrics.height;
        const inside = (p: Point) => p.x >= left && p.x <= right && p.y >= top && p.y < bottom;
        return context.strokes
          .map(ink)
          .map((s) => ({
            ...s,
            runs: s.runs
              .map((r) => ({ ...r, from: Math.max(r.from, left), to: Math.min(r.to, right) }))
              .filter((r) => r.to > r.from && r.y >= top && r.y < bottom),
            curves: s.curves.map((c) => c.filter(inside)).filter((c) => c.length > 0),
          }))
          .filter((s) => s.runs.length > 0 || s.curves.length > 0);
      },
      /// The colour the glyph at `col` of view row `y` is filled in.
      glyph(y: number, col: number): string | undefined {
        const t = context.texts.find((t) => t.x === col * metrics.width && t.y === y * metrics.height + metrics.baseline);
        return t && channels(t.fill);
      },
    };
  }

  type Screen = Awaited<ReturnType<typeof painted>>;

  /// The one stroke under a sample's cell on view row `y`, its spans in
  /// cell coordinates: x from the cell's left, y from its top.
  function underline(screen: Screen, y: number, name: Sample): Ink {
    const [, , width] = SAMPLES[name];
    const marks = screen.strokes(y, COLUMN[name], width);
    expect(marks, `${name}: one stroke`).toHaveLength(1);
    const left = COLUMN[name] * screen.metrics.width;
    const top = y * screen.metrics.height;
    const [mark] = marks;
    return {
      ...mark,
      runs: mark.runs.map((r) => ({ from: r.from - left, to: r.to - left, y: r.y - top })),
      curves: mark.curves.map((c) => c.map((p) => ({ x: p.x - left, y: p.y - top }))),
    };
  }

  /// Each underline style's shape, in the glyph's colour, below the
  /// baseline and inside the cell.
  function expectShapes(screen: Screen, y: number): void {
    const { width, height, baseline } = screen.metrics;
    const below = baseline + 2;
    const level = (ink: Ink) => ink.runs.map((r) => r.y);

    // A single underline: one line across the cell, two pixels below the
    // baseline, one pixel wide.
    const single = underline(screen, y, "single");
    expect.soft(single.runs, "single").toEqual([{ from: 0, to: width, y: below }]);
    expect.soft(single.curves, "single").toEqual([]);
    expect.soft(single.style, "single").toBe(GLYPH);
    expect.soft(single.width, "single").toBe(1);

    // Double: two lines across the cell, each on a whole pixel row with an
    // empty row between them, the first on the single underline's line.
    // Lines that straddle rows run together into one band.
    const double = underline(screen, y, "double");
    const lines = level(double);
    expect.soft(double.runs.map((r) => [r.from, r.to]), "double: across the cell").toEqual([[0, width], [0, width]]);
    expect.soft(lines.map((l) => l % 1), "double: on whole pixel rows").toEqual([0.5, 0.5]);
    expect.soft(lines[1] - lines[0], "double: a row between").toBe(2);
    expect.soft(Math.abs(lines[0] - below), "double: the first on the single's line").toBeLessThanOrEqual(0.5);
    expect.soft(lines[1] + 0.5, "double: inside the cell").toBeLessThanOrEqual(height);
    expect.soft(double.style, "double").toBe(GLYPH);

    // Curly: a wave across the cell that falls and rises between the double
    // underline's rows, kept to the cell.
    const curly = underline(screen, y, "curly");
    expect.soft(curly.runs, "curly").toEqual([]);
    const points = curly.curves.flat();
    expect.soft(points.length, "curly: a curve").toBeGreaterThan(0);
    if (points.length > 0) {
      const xs = points.map((p) => p.x);
      const ys = points.map((p) => p.y);
      expect.soft([Math.min(...xs), Math.max(...xs)], "curly spans the cell").toEqual([0, width]);
      expect.soft(Math.max(...ys) - Math.min(...ys), "curly: its height").toBeGreaterThanOrEqual(1.5);
      expect.soft([Math.min(...ys) % 1, Math.max(...ys) % 1], "curly: its crests on whole pixel rows").toEqual([0.5, 0.5]);
      expect.soft(Math.min(...ys), "curly: below the baseline").toBeGreaterThan(baseline);
      expect.soft(Math.max(...ys) + 0.5, "curly: inside the cell").toBeLessThanOrEqual(height);
      expect.soft(turns(points), "curly: turns").toBeGreaterThanOrEqual(2);
    }
    expect.soft(curly.style, "curly").toBe(GLYPH);

    // Dotted: dots of a pixel along the single underline's line, a pixel
    // apart.
    const dotted = underline(screen, y, "dotted");
    expect.soft(new Set(level(dotted)), "dotted").toEqual(new Set([below]));
    expect.soft(dotted.runs.length, "dotted: dots").toBeGreaterThanOrEqual(width / 2 - 1);
    for (const run of dotted.runs) expect.soft(run.to - run.from, "dotted: a dot").toBeLessThanOrEqual(1);
    expect.soft(dotted.style, "dotted").toBe(GLYPH);

    // Dashed: one dash in the cell, along the single underline's line,
    // shorter than the cell and longer than a dot.
    const dashes = underline(screen, y, "dashed");
    expect.soft(level(dashes), "dashed").toEqual([below]);
    const [dash] = dashes.runs;
    expect.soft(dash && dash.to - dash.from, "dashed: a dash").toBeGreaterThan(2);
    expect.soft(dash && dash.to - dash.from, "dashed: a dash").toBeLessThan(width);
    expect.soft(dashes.style, "dashed").toBe(GLYPH);

    // Overline: one line across the cell along its top pixel row.
    const overline = underline(screen, y, "overline");
    expect.soft(overline.runs, "overline").toEqual([{ from: 0, to: width, y: 0.5 }]);
    expect.soft(overline.style, "overline").toBe(GLYPH);
  }

  test("each underline style draws its own shape across the cell, and overline a line along its top", async () => {
    const screen = await painted(ROW);
    screen.frame();
    expectShapes(screen, 0);
  });

  test("an underline takes the colour SGR 58 gives it, while the glyph keeps its own", async () => {
    const screen = await painted(ROW);
    screen.frame();
    // RGB red on a curly underline, the 256-colour table's red on a single
    // one; SGR 59 puts an underline back in the glyph's colour.
    expect.soft(underline(screen, 0, "curlyRgb").style, "curly in RGB red").toBe(RED);
    expect.soft(underline(screen, 0, "curlyRgb").curves.length, "curly in RGB red: a wave").toBeGreaterThan(0);
    expect.soft(underline(screen, 0, "singlePalette").style, "single in colour 196").toBe(RED);
    expect.soft(underline(screen, 0, "resetColour").style, "after SGR 59").toBe(GLYPH);
    for (const name of ["curlyRgb", "singlePalette", "resetColour", "struck"] as const) {
      expect.soft(screen.glyph(0, COLUMN[name]), `${name}: the glyph`).toBe(GLYPH);
    }
  });

  test("a wide character's underline runs across both its columns", async () => {
    const screen = await painted(ROW);
    screen.frame();
    const { width } = screen.metrics;
    // A wave in each column, the two meeting at the boundary.
    const wave = underline(screen, 0, "wideCurly");
    for (const half of [0, 1]) {
      const points = wave.curves.flat().filter((p) => p.x >= half * width && p.x <= (half + 1) * width);
      expect.soft(turns(points), `curly, column ${half}: turns`).toBeGreaterThanOrEqual(2);
    }
    const xs = wave.curves.flat().map((p) => p.x);
    expect.soft([Math.min(...xs), Math.max(...xs)], "curly spans both columns").toEqual([0, 2 * width]);
    // A dash in each column.
    const dashes = underline(screen, 0, "wideDashed").runs;
    expect.soft(dashes.map((r) => Math.floor(r.from / width)), "a dash per column").toEqual([0, 1]);
  });

  test("strikethrough, a hovered link and a cell with no decoration draw as before", async () => {
    const screen = await painted(ROW);
    const { width, height, baseline } = screen.metrics;
    screen.frame();
    // Strikethrough stays a line across the middle in the glyph's colour,
    // beside a red curly underline.
    const struck = screen.strokes(0, COLUMN.struck);
    const strike = struck.find((s) => s.runs.some((r) => r.y === height / 2));
    expect.soft(strike?.style, "strikethrough").toBe(GLYPH);
    expect.soft(strike?.runs, "strikethrough").toEqual([{ from: COLUMN.struck * width, to: (COLUMN.struck + 1) * width, y: height / 2 }]);
    expect.soft(struck.filter((s) => s !== strike).map((s) => s.style), "its underline").toEqual([RED]);
    // A cell with none of the attributes strokes nothing.
    for (let col = COLUMN.plain; col < COLUMN.plain + 5; col++) {
      expect.soft(screen.strokes(0, col), `plain, column ${col}`).toEqual([]);
    }
    // A hovered link's underline is one straight line in the hover colour.
    screen.renderer.setHoveredLinkRange({ startX: COLUMN.plain, startY: 0, endX: COLUMN.plain + 4, endY: 0 });
    screen.frame();
    for (let col = COLUMN.plain; col < COLUMN.plain + 5; col++) {
      const marks = screen.strokes(0, col);
      expect.soft(marks.map((m) => [m.style, m.runs]), `hovered, column ${col}`).toEqual([
        [channels("#4a90e2"), [{ from: col * width, to: (col + 1) * width, y: baseline + 2 }]],
      ]);
    }
  });

  test.each([8, 9])("adjacent dotted cells keep one rhythm of dots, %i pixels a cell", async (fontWidth) => {
    // Dots a pixel long a pixel apart all along, where each cell starting
    // its own pattern would put two dots together at an odd column's edge.
    const screen = await painted("\x1b[4:4mdots\x1b[0m", { fontWidth });
    expect(screen.metrics.width).toBe(fontWidth);
    screen.frame();
    const runs = screen
      .strokes(0, 0, 4)
      .flatMap((s) => s.runs)
      .sort((a, b) => a.from - b.from);
    expect(runs.length).toBeGreaterThanOrEqual(2 * fontWidth - 1);
    for (const [i, run] of runs.entries()) {
      expect.soft(run.to - run.from, `dot ${i}`).toBe(1);
      if (i > 0) expect.soft(run.from - runs[i - 1].to, `gap before dot ${i}`).toBe(1);
    }
  });

  test("a double or curly underline keeps inside a cell aligned shorter than the font's", async () => {
    // The font's cell is 19 pixels with its baseline at 14; aligned to a
    // 17-pixel cell the baseline moves up a pixel, and a second line two
    // rows below a single underline's would reach past the cell's bottom.
    const screen = await painted(ROW, { cell: { width: 8, height: 17 } });
    const { height, baseline } = screen.metrics;
    expect([height, baseline]).toEqual([17, 13]);
    screen.frame();
    // A single underline stays where it is, two pixels below the baseline.
    expect.soft(underline(screen, 0, "single").runs.map((r) => r.y), "single").toEqual([baseline + 2]);
    // The double's lines, a row between them, and the wave rise to fit.
    const double = underline(screen, 0, "double").runs.map((r) => r.y);
    expect.soft(double.length, "double: two lines").toBe(2);
    expect.soft(double[1] - double[0], "double: apart").toBe(2);
    expect.soft(Math.max(...double) + 0.5, "double: inside the cell").toBeLessThanOrEqual(height);
    const wave = underline(screen, 0, "curly").curves.flat().map((p) => p.y);
    expect.soft(Math.max(...wave) - Math.min(...wave), "curly: its height").toBeGreaterThanOrEqual(1.5);
    expect.soft(Math.max(...wave) + 0.5, "curly: inside the cell").toBeLessThanOrEqual(height);
  });

  test("a history row draws the same decorations", async () => {
    const screen = await painted(ROW + "\r\n".repeat(rows));
    expect(screen.term.getScrollbackLength()).toBe(1);
    screen.term.scrollLines(-1);
    expect(screen.term.getViewportY()).toBe(1);
    screen.frame();
    expectShapes(screen, 0);
    expect.soft(underline(screen, 0, "curlyRgb").style, "curly in RGB red").toBe(RED);
  });
});
