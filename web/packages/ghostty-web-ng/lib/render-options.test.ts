import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { GhosttyVt } from '../vt/ghosttyVt';
import type { ITerminalOptions } from './interfaces';
import type { PaintFrame } from './renderer';
import { Terminal } from './terminal';

// Spread options keep the counterfactual type-checkable on the base widget.
type GridOptions = Partial<ITerminalOptions> & { lineHeight?: number; boxGlyphs?: boolean; scrollbar?: 'overlay' };
let module: WebAssembly.Module;
let measured = { width: 8.43, height: 16 };
let ink = { width: 8.43, ascent: 13, descent: 4 };
let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
const terminals: Terminal[] = [];
let contexts: WeakMap<HTMLCanvasElement, RecordingCanvasContext>;

beforeAll(async () => {
  module = await WebAssembly.compile(readFileSync('vendor/ghostty-vt/ghostty-vt.wasm'));
});
beforeEach(() => {
  measured = { width: 8.43, height: 16 };
  ink = { width: 8.43, ascent: 13, descent: 4 };
  contexts = new WeakMap();
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('OffscreenCanvas', class {
    getContext() { return { font: '', measureText: () => ({ width: measured.width, fontBoundingBoxAscent: measured.height - 4, fontBoundingBoxDescent: 4 }) }; }
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    let context = contexts.get(this);
    if (!context) { context = new RecordingCanvasContext(this); contexts.set(this, context); }
    return context as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
});
afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
  frames.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function tick() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(performance.now());
}
async function open(options: GridOptions = {}) {
  const ghostty = new GhosttyVt(await WebAssembly.instantiate(module, {}));
  const hooks = { scrollbarOpacity: 0 };
  const term = new Terminal({ ghostty, cols: 10, rows: 4, scrollback: 100, cursorBlink: false, smoothScrollDuration: 0, testHooks: hooks, ...options });
  terminals.push(term);
  const host = document.createElement('div');
  document.body.append(host);
  term.open(host);
  const canvas = host.querySelector('canvas')!;
  const context = contexts.get(canvas)!;
  vi.spyOn(canvas, 'getBoundingClientRect').mockImplementation(() => {
    const width = Number.parseFloat(canvas.style.width);
    const height = Number.parseFloat(canvas.style.height);
    return { left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON() {} };
  });
  context.texts.length = context.paths.length = context.strokes.length = context.fills.length = 0;
  return { term, host, canvas, context, hooks };
}
const GLYPH_COLOR = '\x1b[38;2;170;187;204m';
const GLYPH_STYLE = 'rgb(170, 187, 204)';
const cup = (column: number, row: number) => `\x1b[${row + 1};${column + 1}H`;
async function glyphTerminal(options: GridOptions = {}) {
  const screen = await open({ lineHeight: 1.2, boxGlyphs: true, ...options });
  return {
    ...screen,
    paint(bytes: string) {
      screen.term.write('\x1b[?25l' + GLYPH_COLOR + bytes);
      screen.term.refresh();
    },
    glyphFills() {
      return screen.context.fills.filter(fill => fill.style === GLYPH_STYLE).map(({ alpha, rect }) => ({ alpha, rect }));
    },
    textsAt(column: number, row: number) {
      const { width, height, baseline } = screen.term.getMetrics()!;
      return screen.context.texts.filter(t => t.x === column * width && t.y === row * height + baseline).map(({ text, style }) => ({ text, style }));
    },
  };
}

// A software 2D context for tests that read pixels back from a canvas
// renderer, with the colour helpers that compare them. jsdom implements no
// canvas; rectangle fills and clears are modelled exactly, with the canvas
// transform applied and source-over compositing over straight alpha. Glyph
// and path rasterization are not modelled, so nothing built on this asserts
// anything about drawn text.


type Rgba = { r: number; g: number; b: number; a: number };

/// The element's own size accessor, which converts the assigned value the
/// way the product's size check reads it back.
function sizeAccessor(name: "width" | "height"): {
  get: (canvas: HTMLCanvasElement) => number;
  set: (canvas: HTMLCanvasElement, value: number) => void;
} {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, name);
  if (typeof descriptor?.get !== "function" || typeof descriptor?.set !== "function") {
    throw new Error(`software canvas needs the element's ${name} accessor`);
  }
  const get = descriptor.get as (this: HTMLCanvasElement) => number;
  const set = descriptor.set as (this: HTMLCanvasElement, value: number) => void;
  return {
    get: (canvas: HTMLCanvasElement) => get.call(canvas),
    set: (canvas: HTMLCanvasElement, value: number) => set.call(canvas, value),
  };
}

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
  lineDashOffset = 0;
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

  readonly #cellWidth: number;

  /// `cellWidth` is what measureText reports per character, so a renderer
  /// measuring its font lands on the cell the test expects. The double
  /// observes every size assignment, even one that changes nothing: a
  /// canvas element converts the assigned value as WebIDL unsigned long
  /// and resets its drawing state, so the double delegates to the
  /// element's own accessors and resets after each set. Reading back
  /// through the element keeps fractional products visible the way the
  /// product's size check sees them. Negative sizes are ignored here
  /// rather than converted to the element's default; nothing assigns one.
  constructor(canvas: HTMLCanvasElement, cellWidth = 8) {
    this.#canvas = canvas;
    this.#cellWidth = cellWidth;
    const widthAccess = sizeAccessor("width");
    const heightAccess = sizeAccessor("height");
    Object.defineProperties(canvas, {
      width: {
        configurable: true,
        get: () => widthAccess.get(canvas),
        set: (value: number) => {
          if (value < 0) return;
          widthAccess.set(canvas, value);
          this.reset();
        },
      },
      height: {
        configurable: true,
        get: () => heightAccess.get(canvas),
        set: (value: number) => {
          if (value < 0) return;
          heightAccess.set(canvas, value);
          this.reset();
        },
      },
    });
  }

  /// Reset the drawing state the way assigning the canvas size does: a
  /// transparent bitmap, the identity transform, an empty save stack and
  /// the double's default styles.
  reset(): void {
    this.#width = this.#canvas.width;
    this.#height = this.#canvas.height;
    this.#pixels = new Float64Array(this.#width * this.#height * 4);
    this.#scaleX = 1;
    this.#scaleY = 1;
    this.#saved = [];
    this.fillStyle = "#000000";
    this.strokeStyle = "#000000";
    this.font = "";
    this.globalAlpha = 1;
    this.lineCap = "butt";
    this.lineDashOffset = 0;
    this.lineJoin = "miter";
    this.lineWidth = 1;
    this.textAlign = "left";
    this.textBaseline = "alphabetic";
  }

  scale(x: number, y: number): void {
    this.#resync();
    this.#scaleX *= x;
    this.#scaleY *= y;
  }

  /// Set the transform absolutely. The double models scaling only: a shear
  /// or translation is outside what the terminal paths use, so it fails
  /// like an unsupported color instead of modelling the wrong picture.
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.#resync();
    if (b !== 0 || c !== 0 || e !== 0 || f !== 0) {
      throw new Error(`unsupported canvas transform: setTransform(${a}, ${b}, ${c}, ${d}, ${e}, ${f})`);
    }
    this.#scaleX = a;
    this.#scaleY = d;
  }

  getTransform(): { a: number; b: number; c: number; d: number; e: number; f: number } {
    this.#resync();
    return { a: this.#scaleX, b: 0, c: 0, d: this.#scaleY, e: 0, f: 0 };
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
      width: text.length * this.#cellWidth,
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

  /// Read a device pixel back without touching the transform: the space
  /// the backing store is measured in.
  pixelAtDevice(x: number, y: number): Rgba {
    this.#resync();
    const at = (Math.floor(y) * this.#width + Math.floor(x)) * 4;
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
  quadraticCurveTo(): void {}
  rect(): void {}
  setLineDash(): void {}
  stroke(): void {}
  strokeText(): void {}

  // Size assignments reset through the element accessors above; this only
  // syncs a store changed behind them.
  #resync(): void {
    if (
      this.#canvas.width === this.#width &&
      this.#canvas.height === this.#height
    ) {
      return;
    }
    this.reset();
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


class RecordingCanvasContext extends SoftwareCanvasContext {
  readonly texts: { text: string; x: number; y: number; style: string }[] = [];
  readonly paths: [string, ...number[]][] = [];
  readonly strokes: { style: string; alpha: number }[] = [];
  readonly fills: { rect: number[]; alpha: number; style: string }[] = [];

  override measureText(): TextMetrics {
    return { width: ink.width, actualBoundingBoxAscent: ink.ascent, actualBoundingBoxDescent: ink.descent } as TextMetrics;
  }
  override fillText(text = '', x = 0, y = 0): void { this.texts.push({ text, x, y, style: this.fillStyle }); }
  override fillRect(x: number, y: number, width: number, height: number): void {
    this.fills.push({ rect: [x, y, width, height], alpha: this.globalAlpha, style: this.fillStyle });
    super.fillRect(x, y, width, height);
  }
  override moveTo(x = 0, y = 0): void { this.paths.push(['moveTo', x, y]); }
  override lineTo(x = 0, y = 0): void { this.paths.push(['lineTo', x, y]); }
  bezierCurveTo(...points: number[]): void { this.paths.push(['bezierCurveTo', ...points]); }
  override stroke(): void { this.strokes.push({ style: this.strokeStyle, alpha: this.globalAlpha }); }
}

describe('widget grid options', () => {
  test('centers glyphs in the multiplied cell and sizes the canvas', async () => {
    ink = { width: 8.43, ascent: 10, descent: 3 };
    const { term, canvas, context } = await open({ lineHeight: 1.2, cols: 80, rows: 24 });
    term.write('\x1b[?25lA');
    term.refresh();
    expect(term.getMetrics()).toEqual({ width: 8, height: 19, baseline: 13 });
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(456);
    expect(context.texts.find(t => t.text === 'A')).toMatchObject({ x: 0, y: 13 });
  });

  test('defaults to unit line height and font glyphs, with overlay opt-in', async () => {
    const { term, context } = await open();
    term.write('\x1b[?25l\u2500\u2588');
    term.refresh();
    expect(term.getMetrics()?.height).toBe(16);
    expect(context.texts.map(t => t.text)).toEqual(expect.arrayContaining(['\u2500', '\u2588']));
    expect(context.strokes).toEqual([]);
  });

  test.each([0, 0.5, NaN, Infinity])('invalid line height %s retains the unit grid', async lineHeight => {
    const { term } = await open({ lineHeight });
    expect(term.getMetrics()).toEqual({ width: 8, height: 16, baseline: 12.5 });
  });

  test('unavailable font-box measurements still honor line height and center the baseline', async () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    const { term, canvas } = await open({ lineHeight: 1.2 });
    expect(term.getMetrics()).toEqual({ width: 9, height: 22.8, baseline: 15.9 });
    expect(canvas.height).toBe(91);
  });

  test('fractional backing dimensions round once and the grid settles', async () => {
    vi.stubGlobal('devicePixelRatio', 1.4);
    measured.width = 8.7;
    const { term, canvas } = await open({ lineHeight: 1.2, cols: 10, rows: 3 });
    term.write('\x1b[?25lX');
    const seen: PaintFrame[] = [];
    term.addPaintLayer({ order: 0, paint: frame => seen.push(frame) });
    tick();
    const metrics = term.getMetrics()!;
    expect(canvas.width).toBe(Math.round(metrics.width * 10 * 1.4));
    expect(canvas.height).toBe(Math.round(metrics.height * 3 * 1.4));
    expect(seen.at(-1)?.full).toBe(true);
    seen.length = 0;
    tick();
    tick();
    expect(seen, 'the backing store settled').toEqual([]);
  });

  test('DPR and font changes update public geometry without publishing a PTY resize', async () => {
    const { term, canvas, context } = await open({ lineHeight: 1.2 });
    const resize = vi.fn();
    const change = vi.fn();
    term.onResize(resize);
    term.onChange(change);
    const seen: PaintFrame[] = [];
    term.addPaintLayer({ order: 0, paint: frame => seen.push(frame) });
    term.refresh();
    vi.stubGlobal('devicePixelRatio', 2);
    measured = { width: 8.7, height: 16.3 };
    expect(term.getMetrics()).toEqual({ width: 8.5, height: 19.5, baseline: 14.25 });
    expect(term.cellAt(16.9, 39.1)).toMatchObject({ col: 1, row: 2 });
    tick();
    expect(seen.at(-1)).toMatchObject({ pixelRatio: 2, full: true });
    expect(canvas.width).toBe(170);
    expect(canvas.height).toBe(156);
    context.setTransform(1, 0, 0, 1, 0, 0);
    term.refresh();
    expect(context.getTransform().a).toBe(2);
    measured = { width: 10.4, height: 20.2 };
    term.options.fontSize = 20;
    expect(term.getMetrics()).toEqual({ width: 10, height: 24.5, baseline: 16.75 });
    measured = { width: 11.4, height: 21.2 };
    term.options.fontFamily = 'another-monospace';
    expect(term.getMetrics()).toEqual({ width: 11, height: 25.5, baseline: 17.25 });
    expect(canvas.width).toBe(220);
    expect(canvas.height).toBe(204);
    expect(resize).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
  });
});

describe('widget box glyphs', () => {
  test('replaces a font horizontal rule with a full-cell path', async () => {
    const screen = await glyphTerminal();
    screen.paint(cup(2, 3) + '\u2500');
    expect(screen.context.texts.filter(t => t.text === '\u2500')).toEqual([]);
    expect(screen.context.paths).toContainEqual(['moveTo', 16, 66.5]);
    expect(screen.context.paths).toContainEqual(['lineTo', 24, 66.5]);
    expect(screen.context.strokes).toEqual([{ style: GLYPH_STYLE, alpha: 1 }]);
  });

  test('draws rounded corners and leaves ordinary text on the font', async () => {
    const screen = await glyphTerminal();
    screen.paint(cup(0, 0) + '\u256dA');
    expect(screen.context.paths.some(([call]) => call === 'bezierCurveTo')).toBe(true);
    expect(screen.textsAt(1, 0)).toEqual([{ text: 'A', style: GLYPH_STYLE }]);
    expect(screen.context.strokes).toHaveLength(1);
  });
});

describe('widget block glyphs', () => {
  test('a full block fills its whole cell', async () => {
    const screen = await glyphTerminal();
    screen.paint(cup(2, 3) + '\u2588');
    expect(screen.glyphFills()).toEqual([{ alpha: 1, rect: [16, 57, 8, 19] }]);
  });

  test('neighbouring blocks meet on one edge at a fractional cell size', async () => {
    // Public grids round width to device pixels; a 2.5 scale yields 8.4 CSS px.
    vi.stubGlobal('devicePixelRatio', 2.5);
    measured = { width: 8.43, height: 20.5 };
    const screen = await glyphTerminal({ lineHeight: 1 });
    screen.paint(cup(0, 0) + '\u2588\u2588' + cup(0, 1) + '\u2588');
    const [first, second, below] = screen.glyphFills().map(fill => fill.rect);
    expect(screen.term.getMetrics()?.width).toBe(8.4);
    expect(first[0] + first[2]).toBe(second[0]);
    expect(first[1] + first[3]).toBe(below[1]);
    expect(Number.isInteger(second[0] * 2.5)).toBe(true);
  });

  test('a device pixel ratio snaps to half a CSS pixel', async () => {
    vi.stubGlobal('devicePixelRatio', 2);
    measured.width = 8.7;
    const screen = await glyphTerminal();
    screen.paint(cup(0, 0) + '\u2588\u2588');
    const [first, second] = screen.glyphFills().map(fill => fill.rect);
    expect(first[2]).toBe(8.5);
    expect(second[0]).toBe(8.5);
  });

  test('partial blocks fill only their own fraction of the cell', async () => {
    const screen = await glyphTerminal({ lineHeight: 1 });
    screen.paint(cup(0, 0) + '\u2581');
    screen.paint(cup(0, 0) + '\u258c');
    screen.paint(cup(0, 0) + '\u2580');
    expect(screen.glyphFills().map(fill => fill.rect)).toEqual([[0, 14, 8, 2], [0, 0, 4, 16], [0, 0, 8, 8]]);
  });

  test('quadrants fill their own corners', async () => {
    const screen = await glyphTerminal({ lineHeight: 1 });
    screen.paint(cup(0, 0) + '\u259a');
    expect(screen.glyphFills().map(fill => fill.rect)).toEqual([[0, 0, 4, 8], [4, 8, 4, 8]]);
  });

  test('shades cover the cell at reduced alpha, and faint halves it', async () => {
    const screen = await glyphTerminal({ lineHeight: 1 });
    screen.paint(cup(0, 0) + '\u2592');
    screen.paint(cup(0, 0) + '\x1b[2m\u2592');
    expect(screen.glyphFills()).toEqual([{ alpha: 0.5, rect: [0, 0, 8, 16] }, { alpha: 0.25, rect: [0, 0, 8, 16] }]);
  });

  test('an invisible block paints nothing but still clears its cell', async () => {
    const screen = await glyphTerminal();
    screen.paint(cup(1, 1) + '\x1b[8;48;2;40;80;160m\u2588');
    expect(screen.glyphFills()).toEqual([]);
    expect(screen.textsAt(1, 1)).toEqual([]);
    expectPixel(screen.context.pixelAt(12, 28), { r: 40, g: 80, b: 160, a: 1 });
  });

  test('ordinary text and box glyphs keep their own paths', async () => {
    const screen = await glyphTerminal();
    screen.paint(cup(0, 0) + '\u2500');
    expect(screen.glyphFills()).toEqual([]);
    expect(screen.context.strokes).toHaveLength(1);
    screen.paint(cup(0, 0) + 'A');
    expect(screen.glyphFills()).toEqual([]);
    expect(screen.context.strokes).toHaveLength(1);
  });

  test('selection and highlight foregrounds reach glyph paths and selection wins', async () => {
    const screen = await glyphTerminal({ theme: { selectionForeground: '#123456', selectionBackground: '#abcdef' } });
    screen.term.write('\x1b[?25l\u2588\u2500');
    const range = { start: { col: 0, absoluteRow: 0 }, end: { col: 1, absoluteRow: 0 } };
    screen.term.highlights.set('match', [range], { foreground: '#654321', background: '#fedcba' });
    screen.term.refresh();
    expect(screen.context.fills).toContainEqual({ rect: [0, 0, 8, 19], alpha: 1, style: '#654321' });
    expect(screen.context.strokes.at(-1)?.style).toBe('#654321');
    screen.term.setSelection(range);
    screen.term.refresh();
    expect(screen.context.fills).toContainEqual({ rect: [0, 0, 8, 19], alpha: 1, style: '#123456' });
    expect(screen.context.strokes.at(-1)?.style).toBe('#123456');
  });

  test('inverse and faint glyphs keep decorations and ordinary wide text', async () => {
    const screen = await glyphTerminal();
    screen.paint('\x1b[7;2;4;9;53;48;2;1;2;3;58;2;9;8;7m\u2588\x1b[0m\u754c');
    expect(screen.context.fills).toContainEqual({ rect: [0, 0, 8, 19], alpha: 0.5, style: 'rgb(1, 2, 3)' });
    expect(screen.context.strokes.map(stroke => stroke.style)).toEqual(['rgb(9, 8, 7)', 'rgb(1, 2, 3)', 'rgb(1, 2, 3)']);
    expect(screen.context.texts.filter(t => t.text === '\u754c')).toHaveLength(1);
    expect(screen.context.texts.find(t => t.text === '\u754c')?.x).toBe(8);
  });

  test('transparent default cells remain clear beside explicit black backgrounds', async () => {
    const screen = await glyphTerminal({ theme: { background: 'rgba(0, 0, 0, 0)' } });
    screen.paint('A\x1b[48;2;0;0;0m \x1b[49m\u2588');
    expectPixel(screen.context.pixelAt(4, 2), { r: 0, g: 0, b: 0, a: 0 });
    expectPixel(screen.context.pixelAt(12, 2), { r: 0, g: 0, b: 0, a: 1 });
    expectPixel(screen.context.pixelAt(20, 2), { r: 170, g: 187, b: 204, a: 1 });
  });
});

const CONTENT = { r: 40, g: 80, b: 160, a: 1 };
const TRACK = sourceOver({ r: 128, g: 128, b: 128, a: 0.1 }, CONTENT);
const THUMB = sourceOver({ r: 128, g: 128, b: 128, a: 0.3 }, TRACK);
async function overlayScreen() {
  vi.stubGlobal('devicePixelRatio', 2);
  const screen = await open({ cols: 24, rows: 8, lineHeight: 1.2, scrollbar: 'overlay' });
  const line = '\x1b[48;2;40;80;160m' + ' '.repeat(24);
  screen.term.write('\x1b[?25l' + Array(12).fill(line).join('\r\n'));
  expect(screen.term.getScrollbackLength()).toBe(4);
  const seen: PaintFrame[] = [];
  screen.term.addPaintLayer({ order: 0, paint: frame => seen.push(frame) });
  tick();
  return { ...screen, frame(opacity: number) {
    seen.length = 0;
    screen.hooks.scrollbarOpacity = opacity;
    tick();
    return seen.at(-1)?.changedRows.length ?? 0;
  } };
}

describe('widget overlay scrollbar', () => {
  test('paints the bar onto the content it covers and restores the first hidden frame', async () => {
    const { frame, context } = await overlayScreen();
    expectPixel(context.pixelAt(182, 100), CONTENT);
    frame(1);
    expectPixel(context.pixelAt(182, 100), THUMB);
    expectPixel(context.pixelAt(182, 20), TRACK);
    expectPixel(context.pixelAt(190, 100), CONTENT);
    frame(0);
    expectPixel(context.pixelAt(182, 100), CONTENT);
  });

  test('repeated frames composite to one pass, not to an opaque bar', async () => {
    const { frame, context } = await overlayScreen();
    frame(1);
    const first = context.pixelAt(182, 100);
    for (let i = 0; i < 30; i++) frame(1);
    expectPixel(first, THUMB);
    expectPixel(context.pixelAt(182, 100), THUMB);
    expectPixel(context.pixelAt(182, 20), TRACK);
    expect(sourceOver({ r: 128, g: 128, b: 128, a: 0.3 }, THUMB).r).not.toBeCloseTo(THUMB.r, 6);
  });

  test('every overlay frame re-reads rows including the first hidden frame, then settles', async () => {
    const { frame } = await overlayScreen();
    expect(frame(0)).toBe(0);
    expect(frame(1)).toBe(8);
    expect(frame(1)).toBe(8);
    expect(frame(0)).toBe(8);
    expect(frame(0)).toBe(0);
  });
});
