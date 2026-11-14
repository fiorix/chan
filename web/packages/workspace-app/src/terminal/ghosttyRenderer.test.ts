// The ghostty widget's renderer over chan's binding on the vendored core,
// wired the way Terminal.open() wires them, over a software canvas that keeps
// the text the renderer hands it and the colour it fills that text in. The
// test writes the bytes and issues the frames.

import { readFileSync } from "node:fs";
import { CanvasRenderer, SelectionManager, Terminal, type ITheme } from "@chan/ghostty-web-ng";
import { GhosttyVt, VtCells, type VtTerminal } from "@chan/ghostty-web-ng/vt";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { expectPixel, SoftwareCanvasContext, sourceOver } from "../__tests__/softwareCanvas";

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
