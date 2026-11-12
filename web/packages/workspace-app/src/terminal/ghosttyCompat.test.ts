import { readFileSync } from "node:fs";
import { CanvasRenderer, Terminal } from "@chan/ghostty-web-ng";
import { GhosttyVt } from "@chan/ghostty-web-ng/vt";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { expectPixel, SoftwareCanvasContext, sourceOver, type Rgba } from "../__tests__/softwareCanvas";
import {
  alignGhosttyRendererToXterm,
  type CellDimensions,
  gateGhosttyScrollbarClicks,
  installGhosttyCustomGlyphs,
  installGhosttyOverlayScrollbar,
  xtermCellDimensionsFromMeasurement,
} from "./ghosttyCompat";

const VENDORED = "../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";

let vendored: WebAssembly.Module;

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Ghostty xterm-compatible font metrics", () => {
  test("uses xterm's device-pixel rounding and line height", () => {
    expect(
      xtermCellDimensionsFromMeasurement(
        { width: 8.43, height: 16 },
        1,
        1.2,
      ),
    ).toEqual({ width: 8, height: 19 });
    expect(
      xtermCellDimensionsFromMeasurement(
        { width: 8.43, height: 16 },
        2,
        1.2,
      ),
    ).toEqual({ width: 8, height: 19 });
  });

  test("rejects unsettled or invalid measurements", () => {
    expect(
      xtermCellDimensionsFromMeasurement(
        { width: 0, height: 16 },
        1,
        1.2,
      ),
    ).toBeNull();
    expect(
      xtermCellDimensionsFromMeasurement(
        { width: 8, height: 16 },
        0,
        1.2,
      ),
    ).toBeNull();
  });

  test("centers Ghostty glyphs in the xterm-sized cell and resizes", () => {
    const renderer = {
      metrics: { width: 9, height: 15, baseline: 11 },
      getMetrics() {
        return { ...this.metrics };
      },
      resize: vi.fn(),
    };

    expect(
      alignGhosttyRendererToXterm(
        renderer as never,
        { width: 8, height: 19 },
        80,
        24,
      ),
    ).toEqual({ width: 8, height: 19, baseline: 13 });
    expect(renderer.metrics).toEqual({
      width: 8,
      height: 19,
      baseline: 13,
    });
    expect(renderer.resize).toHaveBeenCalledWith(80, 24);
  });

  test("fails open if ghostty-web changes its private metrics field", () => {
    const renderer = {
      getMetrics: () => ({ width: 9, height: 15, baseline: 11 }),
      resize: vi.fn(),
    };

    expect(
      alignGhosttyRendererToXterm(
        renderer as never,
        { width: 8, height: 19 },
        80,
        24,
      ),
    ).toBeNull();
    expect(renderer.resize).not.toHaveBeenCalled();
  });
});

// The glyph and overlay suites below drive the real CanvasRenderer and the
// real Terminal over chan's binding on the vendored core: each test writes
// the bytes that make its screen and lets the core hold it. The defects are
// upstream's own paint order and text hook, so a hand-rolled double would go
// green while the owner still saw them, and only the real build can tell us
// the adapter still binds to something that exists.

/// A software context that also keeps what the software canvas does not
/// model: each text with its style and where it is drawn from, each path
/// call, each stroke's style, and each fill with its style and alpha at the
/// moment it is made (alpha is state on the context, so it has to be read
/// then rather than after the cell is drawn).
class RecordingCanvasContext extends SoftwareCanvasContext {
  readonly texts: { text: string; x: number; y: number; style: string }[] = [];
  readonly paths: [string, ...number[]][] = [];
  readonly strokes: string[] = [];
  readonly fills: { rect: number[]; alpha: number; style: string }[] = [];

  override fillText(text = "", x = 0, y = 0): void {
    this.texts.push({ text, x, y, style: this.fillStyle });
  }

  override fillRect(x: number, y: number, width: number, height: number): void {
    this.fills.push({ rect: [x, y, width, height], alpha: this.globalAlpha, style: this.fillStyle });
    super.fillRect(x, y, width, height);
  }

  override moveTo(x = 0, y = 0): void {
    this.paths.push(["moveTo", x, y]);
  }

  override lineTo(x = 0, y = 0): void {
    this.paths.push(["lineTo", x, y]);
  }

  bezierCurveTo(...points: number[]): void {
    this.paths.push(["bezierCurveTo", ...points]);
  }

  override stroke(): void {
    this.strokes.push(this.strokeStyle);
  }
}

/// The binding's terminal on its own instance of the vendored core, as
/// backend.ts's kit hands one to each terminal, and the real renderer wired
/// the way Terminal.open() wires them, without the DOM and the render loop
/// open() starts: the test writes the bytes and issues the frames. With
/// `cell`, the renderer is aligned to that cell the way TerminalTab aligns it
/// to xterm's grid.
async function pinnedTerminal(options: {
  cols: number;
  rows: number;
  ratio: number;
  cell?: CellDimensions;
}) {
  const { cols, rows, ratio } = options;
  const contexts = new WeakMap<HTMLCanvasElement, RecordingCanvasContext>();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement) {
      const existing = contexts.get(this);
      if (existing) return existing as unknown as CanvasRenderingContext2D;
      const created = new RecordingCanvasContext(this);
      contexts.set(this, created);
      return created as unknown as CanvasRenderingContext2D;
    } as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
  const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const term = new Terminal({ ghostty: vt, cols, rows });
  const core = vt.createTerminal(cols, rows, { scrollbackLimit: 100 });
  term.wasmTerm = core;
  const canvas = document.createElement("canvas");
  const renderer = new CanvasRenderer(canvas, {
    devicePixelRatio: ratio,
    theme: { background: "#101010", foreground: "#e0e0e0" },
  });
  renderer.resize(cols, rows);
  if (options.cell) {
    expect(alignGhosttyRendererToXterm(renderer, options.cell, cols, rows)).not.toBeNull();
  }
  term.renderer = renderer;
  return {
    core,
    term,
    renderer,
    context: contexts.get(canvas)!,
    /// One frame as the widget's render loop issues it, at the given
    /// overlay opacity, through whatever render the renderer holds now.
    frame(opacity = 0): void {
      renderer.render(core, false, term.getViewportY(), opacity);
    },
  };
}

// The cells' own colour, so the adapters' strokes and fills can be told
// from the renderer's background fills and checked against the colour
// Ghostty resolved for the cell.
const GLYPH_COLOR = "\x1b[38;2;170;187;204m";
const GLYPH_STYLE = "rgb(170, 187, 204)";

/// A glyph screen with the custom glyphs installed.
async function glyphTerminal(cell?: CellDimensions, ratio = 1) {
  const screen = await pinnedTerminal({ cols: 10, rows: 4, ratio, cell });
  expect(installGhosttyCustomGlyphs(screen.renderer)).toBe(true);
  const { context, renderer } = screen;
  return {
    ...screen,
    /// Write `bytes` in the glyph colour and paint the frame they make.
    paint(bytes: string): void {
      screen.core.write("\x1b[?25l" + GLYPH_COLOR + bytes);
      screen.frame();
    },
    /// The fills the adapter made in the cells' colour, every frame so far.
    glyphFills(): { alpha: number; rect: number[] }[] {
      return context.fills
        .filter((fill) => fill.style === GLYPH_STYLE)
        .map(({ alpha, rect }) => ({ alpha, rect }));
    },
    /// The texts drawn in the cell at `column`, `row`, as text and style.
    textsAt(column: number, row: number): { text: string; style: string }[] {
      const { width, height, baseline } = renderer.getMetrics();
      return context.texts
        .filter((t) => t.x === column * width && t.y === row * height + baseline)
        .map(({ text, style }) => ({ text, style }));
    },
  };
}

/// Move the cursor to a 0-indexed cell. CUP is 1-indexed.
function cup(column: number, row: number): string {
  return `\x1b[${row + 1};${column + 1}H`;
}

describe("Ghostty custom box glyphs", () => {
  test("replaces a font horizontal rule with a full-cell path", async () => {
    const screen = await glyphTerminal();

    screen.paint(cup(2, 3) + "\u2500");

    // Ghostty paints the cell as a space; the font's rule never reaches it.
    expect(screen.textsAt(2, 3).map((t) => t.text)).toEqual([" "]);
    expect(screen.context.texts.filter((t) => t.text === "\u2500")).toEqual([]);
    expect(screen.context.paths).toContainEqual(["moveTo", 16, 66.5]);
    expect(screen.context.paths).toContainEqual(["lineTo", 24, 66.5]);
    expect(screen.context.strokes).toHaveLength(1);
    // Stroked in the colour Ghostty set for the cell's text.
    expect(screen.context.strokes[0]).toBe(GLYPH_STYLE);
  });

  test("draws rounded corners and leaves ordinary text on Ghostty", async () => {
    const screen = await glyphTerminal();

    screen.paint(cup(0, 0) + "\u256dA"); // a rounded corner, then a letter
    expect(screen.context.paths.some(([call]) => call === "bezierCurveTo")).toBe(true);

    expect(screen.textsAt(1, 0)).toEqual([{ text: "A", style: GLYPH_STYLE }]);
    expect(screen.context.strokes).toHaveLength(1);
  });

  test("fails open if ghostty-web changes its private text hook", () => {
    const renderer = {
      getMetrics: () => ({ width: 8, height: 19, baseline: 13 }),
      resize: vi.fn(),
    };
    expect(installGhosttyCustomGlyphs(renderer as never)).toBe(false);
  });
});

describe("Ghostty custom block glyphs", () => {
  // A block element is defined by the cell, not by a typeface. Every font
  // draws it at the glyph's own ink height, which under chan's 1.2 line
  // height leaves an unpainted strip at each cell boundary, so a bar chart
  // comes out banded. These pin the fill geometry that replaces it.

  test("a full block fills its whole cell", async () => {
    const screen = await glyphTerminal();

    screen.paint(cup(2, 3) + "\u2588"); // full block

    expect(screen.glyphFills()).toEqual([{ alpha: 1, rect: [16, 57, 8, 19] }]);
  });

  test("neighbouring blocks meet on one edge at a fractional cell size", async () => {
    // The seam this fix is about: at 8.4px per cell an unsnapped right edge
    // lands mid-pixel, the next cell's left edge lands on the same fraction,
    // and both antialias their own half of it.
    const screen = await glyphTerminal({ width: 8.4, height: 20.5 });

    screen.paint(cup(0, 0) + "\u2588\u2588" + cup(0, 1) + "\u2588"); // full blocks

    const [first, second, below] = screen.glyphFills().map((fill) => fill.rect);
    expect(first[0] + first[2]).toBe(second[0]);
    expect(first[1] + first[3]).toBe(below[1]);
    expect(Number.isInteger(second[0])).toBe(true);
  });

  test("a device pixel ratio snaps to half a CSS pixel", async () => {
    const screen = await glyphTerminal({ width: 8.4, height: 19 }, 2);

    screen.paint(cup(0, 0) + "\u2588\u2588"); // full blocks

    const [first, second] = screen.glyphFills().map((fill) => fill.rect);
    expect(first[2]).toBe(8.5);
    expect(second[0]).toBe(8.5);
  });

  test("partial blocks fill only their own fraction of the cell", async () => {
    const screen = await glyphTerminal({ width: 8, height: 16 });

    // One cell, three frames: each glyph replaces the one before it.
    screen.paint(cup(0, 0) + "\u2581"); // lower one eighth
    screen.paint(cup(0, 0) + "\u258c"); // left half
    screen.paint(cup(0, 0) + "\u2580"); // upper half

    expect(screen.glyphFills().map((fill) => fill.rect)).toEqual([
      [0, 14, 8, 2],
      [0, 0, 4, 16],
      [0, 0, 8, 8],
    ]);
  });

  test("quadrants fill their own corners", async () => {
    const screen = await glyphTerminal({ width: 8, height: 16 });

    screen.paint(cup(0, 0) + "\u259a"); // upper left + lower right

    expect(screen.glyphFills().map((fill) => fill.rect)).toEqual([
      [0, 0, 4, 8],
      [4, 8, 4, 8],
    ]);
  });

  test("shades cover the cell at reduced alpha, and faint halves it", async () => {
    const screen = await glyphTerminal({ width: 8, height: 16 });

    screen.paint(cup(0, 0) + "\u2592"); // medium shade
    // SGR 2, faint.
    screen.paint(cup(0, 0) + "\x1b[2m\u2592");

    expect(screen.glyphFills()).toEqual([
      { alpha: 0.5, rect: [0, 0, 8, 16] },
      { alpha: 0.25, rect: [0, 0, 8, 16] },
    ]);
  });

  test("an invisible block paints nothing but still clears its cell", async () => {
    const screen = await glyphTerminal();

    // SGR 8, invisible, over a background of its own.
    screen.paint(cup(1, 1) + "\x1b[8;48;2;40;80;160m\u2588");

    expect(screen.glyphFills()).toEqual([]);
    // No text either: the block never reaches the font, and Ghostty draws
    // no text for an invisible cell. Its background is painted like any
    // other cell's.
    expect(screen.textsAt(1, 1)).toEqual([]);
    expectPixel(screen.context.pixelAt(12, 28), { r: 40, g: 80, b: 160, a: 1 });
  });

  test("ordinary text and box glyphs keep their own paths", async () => {
    const screen = await glyphTerminal();

    screen.paint(cup(0, 0) + "\u2500"); // a horizontal rule
    expect(screen.glyphFills()).toEqual([]);
    expect(screen.context.strokes).toHaveLength(1);

    screen.paint(cup(0, 0) + "A");
    expect(screen.glyphFills()).toEqual([]);
    expect(screen.context.strokes).toHaveLength(1);
  });
});

const GHOSTTY_COLS = 24;
const GHOSTTY_ROWS = 8;
const GHOSTTY_CELL = { width: 8, height: 19 };
const GHOSTTY_DPR = 2;
const SCROLLBACK_LINES = 4;

// CSS geometry of the pinned build's overlay on this grid. The bar is 8px wide
// and sits 4px off the right edge; the strip upstream clears runs from 2px
// left of the bar to the canvas edge. At 24 columns of 8px that is the last
// cell and a half, the same proportion the owner sees at 100 columns.
const CANVAS_CSS_WIDTH = GHOSTTY_COLS * GHOSTTY_CELL.width;
const STRIP_X = CANVAS_CSS_WIDTH - 10;
// Inside the strip upstream clears, outside the bar it then draws: nothing
// ever paints here, so it reads as content or as nothing at all.
const ERASED_X = CANVAS_CSS_WIDTH - 2;
const CONTENT_X = 100;
// At viewportY 0 the thumb sits at the bottom of the track, so these sample a
// thumb pixel and a track-only pixel respectively.
const THUMB_Y = 100;
const TRACK_Y = 20;

const THEME_BACKGROUND: Rgba = { r: 16, g: 16, b: 16, a: 1 };
const CONTENT: Rgba = { r: 40, g: 80, b: 160, a: 1 };
const TRACK_OVER_CONTENT = sourceOver(
  { r: 128, g: 128, b: 128, a: 0.1 },
  CONTENT,
);
const THUMB_OVER_CONTENT = sourceOver(
  { r: 128, g: 128, b: 128, a: 0.3 },
  TRACK_OVER_CONTENT,
);

describe("Ghostty overlay scrollbar", () => {
  test("upstream erases the columns it covers and leaves them erased", async () => {
    const { renderer, context, screen } = await ghosttyScreen();

    screen.paint(renderer, 0);
    expectPixel(context.pixelAt(ERASED_X, THUMB_Y), CONTENT);

    // One frame with the overlay visible, then an idle frame without it. No
    // row is dirty by then, so upstream renders no row at all and nothing
    // repaints what the overlay erased.
    expect(screen.paint(renderer, 1)).toBe(0);
    expect(screen.paint(renderer, 0)).toBe(0);

    // The owner's report: a blank strip down the right edge that survives the
    // frame that drew it. What is left is the theme background, not content,
    // and it is background even where the bar itself never paints.
    expectPixel(context.pixelAt(ERASED_X, THUMB_Y), THEME_BACKGROUND);
    expectPixel(
      context.pixelAt(STRIP_X, THUMB_Y),
      sourceOver(
        { r: 128, g: 128, b: 128, a: 0.3 },
        sourceOver({ r: 128, g: 128, b: 128, a: 0.1 }, THEME_BACKGROUND),
      ),
    );
    expectPixel(context.pixelAt(CONTENT_X, THUMB_Y), CONTENT);
  });

  test("the adapter paints the bar onto the content it covers", async () => {
    const { renderer, context, screen } = await ghosttyScreen();
    expect(installGhosttyOverlayScrollbar(renderer)).toBe(true);

    screen.paint(renderer, 0);
    expectPixel(context.pixelAt(STRIP_X, THUMB_Y), CONTENT);

    screen.paint(renderer, 1);
    expectPixel(context.pixelAt(STRIP_X, THUMB_Y), THUMB_OVER_CONTENT);
    expectPixel(context.pixelAt(STRIP_X, TRACK_Y), TRACK_OVER_CONTENT);
    // The columns upstream cleared and never drew on hold content throughout.
    expectPixel(context.pixelAt(ERASED_X, THUMB_Y), CONTENT);

    // The overlay hides. Its pixels go back to content rather than staying a
    // strip, which is the owner's symptom and upstream's behavior above.
    screen.paint(renderer, 0);
    expectPixel(context.pixelAt(STRIP_X, THUMB_Y), CONTENT);
  });

  test("repeated frames composite to one pass, not to an opaque bar", async () => {
    const { renderer, context, screen } = await ghosttyScreen();
    expect(installGhosttyOverlayScrollbar(renderer)).toBe(true);

    screen.paint(renderer, 0);
    screen.paint(renderer, 1);
    const firstFrame = context.pixelAt(STRIP_X, THUMB_Y);
    for (let frame = 0; frame < 30; frame++) screen.paint(renderer, 1);

    // A translucent thumb repainted over its own previous pixels converges on
    // opacity, and a solid bar down the right edge is the reported defect in
    // another color. Thirty frames later the pixel is still the single-pass
    // composite of thumb over track over content.
    expectPixel(firstFrame, THUMB_OVER_CONTENT);
    expectPixel(context.pixelAt(STRIP_X, THUMB_Y), THUMB_OVER_CONTENT);
    expectPixel(context.pixelAt(STRIP_X, TRACK_Y), TRACK_OVER_CONTENT);
    // And the assertion is not vacuous: a second pass over pixels that were
    // not refreshed lands somewhere else, which is what the frames above
    // would have converged on without the forced repaint.
    expect(
      sourceOver({ r: 128, g: 128, b: 128, a: 0.3 }, THUMB_OVER_CONTENT).r,
    ).not.toBeCloseTo(THUMB_OVER_CONTENT.r, 6);
  });

  test("every overlay frame re-reads the rows the bar composites over", async () => {
    const { renderer, screen } = await ghosttyScreen();
    expect(installGhosttyOverlayScrollbar(renderer)).toBe(true);

    screen.paint(renderer, 0);
    // The screen is settled: no row is dirty and the viewport has not moved,
    // so upstream renders no row at all on an idle frame.
    expect(screen.paint(renderer, 0)).toBe(0);

    expect(screen.paint(renderer, 1)).toBe(GHOSTTY_ROWS);
    expect(screen.paint(renderer, 1)).toBe(GHOSTTY_ROWS);
    // The frame that stops painting the overlay still needs fresh pixels, or
    // the last thumb it drew would stay on the content it covered.
    expect(screen.paint(renderer, 0)).toBe(GHOSTTY_ROWS);
    expect(screen.paint(renderer, 0)).toBe(0);
  });

  test("fails open if the pinned build stops exposing the render hooks", () => {
    const render = vi.fn();
    const renderer = {
      canvas: document.createElement("canvas"),
      ctx: {},
      devicePixelRatio: 2,
      getMetrics: () => ({ width: 8, height: 19, baseline: 14 }),
      render,
      resize: vi.fn(),
    };

    expect(installGhosttyOverlayScrollbar(renderer as never)).toBe(false);
    expect(renderer.render).toBe(render);
  });

  test("fails open if the pinned build stops exposing a usable pixel ratio", () => {
    const render = vi.fn();
    const renderer = {
      canvas: document.createElement("canvas"),
      ctx: {},
      devicePixelRatio: 0,
      getMetrics: () => ({ width: 8, height: 19, baseline: 14 }),
      render,
      renderScrollbar: vi.fn(),
      resize: vi.fn(),
    };

    expect(installGhosttyOverlayScrollbar(renderer as never)).toBe(false);
    expect(renderer.render).toBe(render);
  });
});

describe("Ghostty overlay scrollbar clicks", () => {
  function ghosttyMouseSource() {
    const host = document.createElement("div");
    const claimStrip = vi.fn();
    // Mirrors the pinned build: handleMouseDown is an own bound field and
    // open() registers it on the host in the capture phase.
    const terminal = { handleMouseDown: claimStrip, scrollbarOpacity: 0 };
    host.addEventListener("mousedown", terminal.handleMouseDown, true);
    return { claimStrip, host, terminal };
  }

  test("the pinned build still exposes the state the gate binds to", async () => {
    // The terminal a ghostty tab constructs: the widget over chan's binding
    // on its own instance of the vendored core, as backend.ts's kit hands it.
    const module = await WebAssembly.compile(readFileSync(VENDORED));
    const terminal = new Terminal({
      ghostty: new GhosttyVt(await WebAssembly.instantiate(module, {})),
    }) as unknown as {
      handleMouseDown?: unknown;
    };

    expect(typeof terminal.handleMouseDown).toBe("function");
    expect(
      Object.prototype.hasOwnProperty.call(terminal, "scrollbarOpacity"),
    ).toBe(true);
  });

  test("an invisible overlay does not claim clicks on the content", () => {
    const { claimStrip, host, terminal } = ghosttyMouseSource();

    expect(gateGhosttyScrollbarClicks(terminal, host)).not.toBeNull();
    host.dispatchEvent(new MouseEvent("mousedown"));

    expect(claimStrip).not.toHaveBeenCalled();
  });

  test("a visible overlay claims them exactly once", () => {
    const { claimStrip, host, terminal } = ghosttyMouseSource();
    const dispose = gateGhosttyScrollbarClicks(terminal, host);

    terminal.scrollbarOpacity = 0.5;
    host.dispatchEvent(new MouseEvent("mousedown"));
    // Upstream's own listener has to be gone, not merely shadowed: a second
    // live claimant would scroll-jump the clicks this gate exists to release.
    expect(claimStrip).toHaveBeenCalledTimes(1);

    dispose?.();
    host.dispatchEvent(new MouseEvent("mousedown"));
    expect(claimStrip).toHaveBeenCalledTimes(1);
  });

  test("leaves upstream alone if the pinned build stops exposing its state", () => {
    const { claimStrip, host } = ghosttyMouseSource();
    const terminal = { handleMouseDown: claimStrip };

    expect(gateGhosttyScrollbarClicks(terminal, host)).toBeNull();
    host.dispatchEvent(new MouseEvent("mousedown"));
    expect(claimStrip).toHaveBeenCalledTimes(1);
  });
});

/// A settled ghostty screen: the real renderer sized the way chan sizes it,
/// over content the overlay is wide enough to cover, with history for the bar
/// to show and rows that go clean after their first paint. A screen whose
/// rows stayed dirty would repaint the covered columns every frame and hide
/// the defect entirely.
async function ghosttyScreen() {
  const pinned = await pinnedTerminal({
    cols: GHOSTTY_COLS,
    rows: GHOSTTY_ROWS,
    ratio: GHOSTTY_DPR,
  });
  // Every cell a space on the content colour, SCROLLBACK_LINES rows more
  // than the screen holds. The cursor is hidden: it would paint its block
  // on the last row.
  const line = `\x1b[48;2;${CONTENT.r};${CONTENT.g};${CONTENT.b}m${" ".repeat(GHOSTTY_COLS)}`;
  pinned.core.write(
    "\x1b[?25l" +
      Array.from({ length: GHOSTTY_ROWS + SCROLLBACK_LINES }, () => line).join("\r\n"),
  );
  expect(pinned.term.getScrollbackLength()).toBe(SCROLLBACK_LINES);
  const reads = vi.spyOn(pinned.core, "readRow");

  return {
    context: pinned.context,
    renderer: pinned.renderer,
    screen: {
      /// Render one frame at the given overlay opacity, viewport pinned to the
      /// bottom so nothing but the adapter can force a repaint. Returns how
      /// many rows the frame actually rendered.
      paint(target: CanvasRenderer, opacity: number): number {
        reads.mockClear();
        target.render(pinned.core, false, 0, opacity);
        return reads.mock.calls.length;
      },
    },
  };
}
