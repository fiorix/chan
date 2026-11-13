// The ghostty widget's renderer over chan's binding on the vendored core,
// wired the way Terminal.open() wires them, over a software canvas that keeps
// the text the renderer hands it. The test writes the bytes and issues the
// frames.

import { readFileSync } from "node:fs";
import { CanvasRenderer, Terminal } from "@chan/ghostty-web-ng";
import { GhosttyVt } from "@chan/ghostty-web-ng/vt";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { SoftwareCanvasContext } from "../__tests__/softwareCanvas";

const VENDORED = "../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";
const COLS = 12;
const ROWS = 3;

/// A software context that also keeps each text it is asked to fill, at
/// the point the renderer draws it from.
class TextRecordingContext extends SoftwareCanvasContext {
  readonly texts: { text: string; x: number; y: number }[] = [];

  override fillText(text = "", x = 0, y = 0): void {
    this.texts.push({ text, x, y });
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
          expect(
            screen.term.wasmTerm!.getScrollbackGraphemeString(offset, col),
            `history ${offset}, column ${col}`,
          ).toBe(text);
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
        expect(core.getScrollbackGraphemeString(offset, col), `history ${offset}, column ${col}`).toBe(text);
      }
    }
    for (const [y, { cells }] of PARTIAL_SCREEN.entries()) {
      for (const [col, text] of clusters(cells)) {
        expect(core.getGraphemeString(y, col), `screen row ${y}, column ${col}`).toBe(text);
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
