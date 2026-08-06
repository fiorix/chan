import { CanvasRenderer, Ghostty, Terminal } from "ghostty-web";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  alignGhosttyRendererToXterm,
  gateGhosttyScrollbarClicks,
  installGhosttyCustomGlyphs,
  installGhosttyOverlayScrollbar,
  xtermCellDimensionsFromMeasurement,
} from "./ghosttyCompat";

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

describe("Ghostty custom box glyphs", () => {
  function boxRenderer() {
    const context = {
      beginPath: vi.fn(),
      bezierCurveTo: vi.fn(),
      fillStyle: "#aabbcc",
      globalAlpha: 1,
      lineCap: "butt",
      lineJoin: "miter",
      lineTo: vi.fn(),
      lineWidth: 1,
      moveTo: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      stroke: vi.fn(),
      strokeStyle: "#000000",
    };
    const original = vi.fn();
    const renderer = {
      ctx: context,
      getMetrics: () => ({ width: 8, height: 19, baseline: 13 }),
      renderCellText: original,
      resize: vi.fn(),
    };
    return { context, original, renderer };
  }

  function cell(codepoint: number) {
    return {
      bg_b: 0,
      bg_g: 0,
      bg_r: 0,
      codepoint,
      fg_b: 255,
      fg_g: 255,
      fg_r: 255,
      flags: 0,
      grapheme_len: 0,
      hyperlink_id: 0,
      width: 1,
    };
  }

  test("replaces a font horizontal rule with a full-cell path", () => {
    const { context, original, renderer } = boxRenderer();
    expect(installGhosttyCustomGlyphs(renderer as never)).toBe(true);

    renderer.renderCellText(cell(0x2500), 2, 3);

    expect(original.mock.calls[0][0].codepoint).toBe(32);
    expect(context.moveTo).toHaveBeenCalledWith(16, 66.5);
    expect(context.lineTo).toHaveBeenCalledWith(24, 66.5);
    expect(context.strokeStyle).toBe("#aabbcc");
    expect(context.stroke).toHaveBeenCalledOnce();
  });

  test("draws rounded corners and leaves ordinary text on Ghostty", () => {
    const { context, original, renderer } = boxRenderer();
    expect(installGhosttyCustomGlyphs(renderer as never)).toBe(true);

    renderer.renderCellText(cell(0x256d), 0, 0);
    expect(context.bezierCurveTo).toHaveBeenCalled();

    const ordinary = cell("A".codePointAt(0)!);
    renderer.renderCellText(ordinary, 1, 0);
    expect(original).toHaveBeenLastCalledWith(ordinary, 1, 0, undefined);
  });

  test("fails open if ghostty-web changes its private text hook", () => {
    const renderer = {
      getMetrics: () => ({ width: 8, height: 19, baseline: 13 }),
      resize: vi.fn(),
    };
    expect(installGhosttyCustomGlyphs(renderer as never)).toBe(false);
  });
});

// The overlay-scrollbar suites below drive the real CanvasRenderer and the
// real Terminal from the pinned ghostty-web build. The defect is upstream's
// own paint order, so a hand-rolled double would go green while the owner
// still saw the strip, and only the real build can tell us the adapter still
// binds to something that exists.

type Rgba = { r: number; g: number; b: number; a: number };

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("upstream erases the columns it covers and leaves them erased", () => {
    const { renderer, context, screen } = ghosttyScreen();

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

  test("the adapter paints the bar onto the content it covers", () => {
    const { renderer, context, screen } = ghosttyScreen();
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

  test("repeated frames composite to one pass, not to an opaque bar", () => {
    const { renderer, context, screen } = ghosttyScreen();
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

  test("every overlay frame re-reads the rows the bar composites over", () => {
    const { renderer, screen } = ghosttyScreen();
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
    const terminal = new Terminal({
      ghostty: await Ghostty.load(),
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

/// The canvas source-over rule over straight alpha. The expected pixels come
/// from the rule rather than from the adapter, so a change to the adapter
/// cannot move the target it is measured against.
function sourceOver(source: Rgba, destination: Rgba): Rgba {
  const alpha = source.a + destination.a * (1 - source.a);
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const channel = (from: number, onto: number): number =>
    (from * source.a + onto * destination.a * (1 - source.a)) / alpha;
  return {
    r: channel(source.r, destination.r),
    g: channel(source.g, destination.g),
    b: channel(source.b, destination.b),
    a: alpha,
  };
}

function expectPixel(actual: Rgba, expected: Rgba): void {
  expect(actual.r).toBeCloseTo(expected.r, 6);
  expect(actual.g).toBeCloseTo(expected.g, 6);
  expect(actual.b).toBeCloseTo(expected.b, 6);
  expect(actual.a).toBeCloseTo(expected.a, 6);
}

/// A software 2D context. jsdom implements no canvas, and the question here is
/// a compositing one: the overlay bar is translucent, so what separates the
/// fix from the defect it replaces is the color left in the pixel, not the
/// sequence of calls that produced it. Rectangle fills and clears are modeled
/// exactly, with the canvas transform applied and source-over compositing over
/// straight alpha. Glyph and path rasterization are not modeled, so nothing
/// here asserts anything about drawn text.
class SoftwareCanvasContext {
  fillStyle = "#000000";
  strokeStyle = "#000000";
  font = "";
  globalAlpha = 1;
  lineCap = "butt";
  lineJoin = "miter";
  lineWidth = 1;
  textAlign = "left";
  textBaseline = "alphabetic";

  #canvas: HTMLCanvasElement;
  #pixels = new Float64Array(0);
  #width = -1;
  #height = -1;
  #scaleX = 1;
  #scaleY = 1;
  #saved: {
    fillStyle: string;
    globalAlpha: number;
    scaleX: number;
    scaleY: number;
  }[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
  }

  scale(x: number, y: number): void {
    this.#resync();
    this.#scaleX *= x;
    this.#scaleY *= y;
  }

  save(): void {
    this.#resync();
    this.#saved.push({
      fillStyle: this.fillStyle,
      globalAlpha: this.globalAlpha,
      scaleX: this.#scaleX,
      scaleY: this.#scaleY,
    });
  }

  restore(): void {
    const state = this.#saved.pop();
    if (!state) return;
    this.fillStyle = state.fillStyle;
    this.globalAlpha = state.globalAlpha;
    this.#scaleX = state.scaleX;
    this.#scaleY = state.scaleY;
  }

  clearRect(x: number, y: number, width: number, height: number): void {
    this.#composite(x, y, width, height, null);
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    const source = parseCanvasColor(this.fillStyle);
    this.#composite(x, y, width, height, {
      ...source,
      a: source.a * this.globalAlpha,
    });
  }

  measureText(text: string): TextMetrics {
    return {
      width: text.length * GHOSTTY_CELL.width,
      actualBoundingBoxAscent: 13,
      actualBoundingBoxDescent: 4,
    } as TextMetrics;
  }

  /// Read a pixel back in CSS coordinates, the space the renderer draws in.
  pixelAt(x: number, y: number): Rgba {
    this.#resync();
    const at =
      (Math.floor(y * this.#scaleY) * this.#width +
        Math.floor(x * this.#scaleX)) *
      4;
    return {
      r: this.#pixels[at],
      g: this.#pixels[at + 1],
      b: this.#pixels[at + 2],
      a: this.#pixels[at + 3],
    };
  }

  beginPath(): void {}
  clip(): void {}
  fillText(): void {}
  lineTo(): void {}
  moveTo(): void {}
  rect(): void {}
  stroke(): void {}
  strokeText(): void {}

  // Assigning canvas.width or canvas.height reallocates the backing store and
  // resets the context state, which is why the renderer can call ctx.scale
  // after every resize without compounding its transform.
  #resync(): void {
    if (
      this.#canvas.width === this.#width &&
      this.#canvas.height === this.#height
    ) {
      return;
    }
    this.#width = this.#canvas.width;
    this.#height = this.#canvas.height;
    this.#pixels = new Float64Array(this.#width * this.#height * 4);
    this.#scaleX = 1;
    this.#scaleY = 1;
    this.#saved = [];
  }

  #composite(
    x: number,
    y: number,
    width: number,
    height: number,
    source: Rgba | null,
  ): void {
    this.#resync();
    const left = Math.max(0, Math.round(x * this.#scaleX));
    const top = Math.max(0, Math.round(y * this.#scaleY));
    const right = Math.min(
      this.#width,
      Math.round((x + width) * this.#scaleX),
    );
    const bottom = Math.min(
      this.#height,
      Math.round((y + height) * this.#scaleY),
    );
    for (let row = top; row < bottom; row++) {
      for (let column = left; column < right; column++) {
        const at = (row * this.#width + column) * 4;
        const blended = source
          ? sourceOver(source, {
              r: this.#pixels[at],
              g: this.#pixels[at + 1],
              b: this.#pixels[at + 2],
              a: this.#pixels[at + 3],
            })
          : { r: 0, g: 0, b: 0, a: 0 };
        this.#pixels[at] = blended.r;
        this.#pixels[at + 1] = blended.g;
        this.#pixels[at + 2] = blended.b;
        this.#pixels[at + 3] = blended.a;
      }
    }
  }
}

function parseCanvasColor(style: string): Rgba {
  const functional = style.match(/^rgba?\(([^)]+)\)$/);
  if (functional) {
    const parts = functional[1].split(",").map((part) => Number(part.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
  }
  const hex = style.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const value = Number.parseInt(hex[1], 16);
    return {
      r: (value >> 16) & 255,
      g: (value >> 8) & 255,
      b: value & 255,
      a: 1,
    };
  }
  // Any other notation would silently model the wrong color, which is worse
  // here than a failure: these tests exist to compare colors.
  throw new Error(`unsupported canvas color: ${style}`);
}

/// A settled ghostty screen: the real renderer sized the way chan sizes it,
/// over content the overlay is wide enough to cover, with rows that go clean
/// after their first paint. A screen whose rows stayed dirty would repaint the
/// covered columns every frame and hide the defect entirely.
function ghosttyScreen() {
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

  const canvas = document.createElement("canvas");
  const renderer = new CanvasRenderer(canvas, {
    devicePixelRatio: GHOSTTY_DPR,
    theme: { background: "#101010", foreground: "#e0e0e0" },
  });
  renderer.resize(GHOSTTY_COLS, GHOSTTY_ROWS);

  const line = Array.from({ length: GHOSTTY_COLS }, () => ({
    bg_b: CONTENT.b,
    bg_g: CONTENT.g,
    bg_r: CONTENT.r,
    codepoint: 32,
    fg_b: 255,
    fg_g: 255,
    fg_r: 255,
    flags: 0,
    grapheme_len: 0,
    hyperlink_id: 0,
    width: 1,
  }));
  let dirty = true;
  let reads = 0;
  const buffer = {
    clearDirty: () => {
      dirty = false;
    },
    getCursor: () => ({ x: 0, y: 0, visible: false }),
    getDimensions: () => ({ cols: GHOSTTY_COLS, rows: GHOSTTY_ROWS }),
    getLine: () => {
      reads += 1;
      return line;
    },
    isRowDirty: () => dirty,
  };
  const scrollback = {
    getScrollbackLength: () => SCROLLBACK_LINES,
    getScrollbackLine: () => line,
  };

  return {
    context: contexts.get(canvas)!,
    renderer,
    screen: {
      /// Render one frame at the given overlay opacity, viewport pinned to the
      /// bottom so nothing but the adapter can force a repaint. Returns how
      /// many rows the frame actually rendered.
      paint(target: CanvasRenderer, opacity: number): number {
        reads = 0;
        target.render(buffer as never, false, 0, scrollback as never, opacity);
        return reads;
      },
    },
  };
}
