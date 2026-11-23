import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { GhosttyVt } from '../vt/ghosttyVt';
import { Terminal } from './terminal';

// Structural signatures let the same tests compile against the previous widget.
type Metrics = { width: number; height: number; baseline: number };
type Frame = {
  readonly ctx: CanvasRenderingContext2D;
  readonly metrics: Readonly<Metrics>;
  readonly pixelRatio: number;
  readonly viewportOffset: number;
  readonly topRow: number;
  readonly full: boolean;
  readonly changedRows: readonly number[];
  readonly rows: number;
  readonly cols: number;
};
type Layer = { order: number | 'mask'; paint(frame: Frame): void };
type PaintAPI = { addPaintLayer(layer: Layer): () => void; refresh(): void; getMetrics(): Readonly<Metrics> | undefined };
type Fill = { color: string; x: number; y: number; width: number; height: number; alpha: number };
type State = { fillStyle: string; globalAlpha: number; transform: number[]; [key: string]: unknown };
let module: WebAssembly.Module;
let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
const terminals: Terminal[] = [];
const fills: Fill[] = [];
const texts: string[] = [];
const transforms: number[][] = [];
let state: State;
let stack: State[];

beforeAll(async () => {
  module = await WebAssembly.compile(readFileSync('vendor/ghostty-vt/ghostty-vt.wasm'));
});

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('OffscreenCanvas', undefined);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => {
    const local: State = { fillStyle: '', globalAlpha: 1, transform: [1, 0, 0, 1, 0, 0] };
    const saved: State[] = [];
    // The first context belongs to the display canvas, later ones measure fonts.
    if (!state) { state = local; stack = saved; }
    return new Proxy(local, {
      get: (target, key: string) => {
        if (key === 'measureText') return () => ({ width: 8, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 4 });
        if (key === 'save') return () => saved.push({ ...target, transform: [...target.transform] });
        if (key === 'restore') return () => Object.assign(target, saved.pop());
        if (key === 'setTransform') return (...args: number[]) => { target.transform = args; transforms.push(args); };
        if (key === 'fillRect') return (x: number, y: number, width: number, height: number) => {
          fills.push({ color: target.fillStyle, x, y, width, height, alpha: target.globalAlpha });
        };
        if (key === 'fillText') return (text: string) => texts.push(text);
        return target[key] ?? (() => undefined);
      },
    });
  }) as never);
});

afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
  frames.clear();
  clearPaint();
  state = undefined as unknown as State;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function clearPaint() { fills.length = texts.length = transforms.length = 0; }
function tick() {
  clearPaint();
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(performance.now());
}
async function create(hooks?: { scrollbarOpacity?: number }) {
  const ghostty = new GhosttyVt(await WebAssembly.instantiate(module, {}));
  const term = new Terminal({ ghostty, cols: 12, rows: 6, scrollback: 100, cursorBlink: false, smoothScrollDuration: 0, ...{ testHooks: hooks } }) as Terminal & PaintAPI;
  terminals.push(term);
  return term;
}
async function open(hooks?: { scrollbarOpacity?: number }, input = 'secret') {
  const term = await create(hooks);
  const host = document.createElement('div');
  document.body.append(host);
  term.open(host);
  term.write(`\x1b[?25l${input}`);
  tick();
  return term;
}
function observe(term: Terminal & PaintAPI) {
  const seen: Frame[] = [];
  term.addPaintLayer({ order: 0, paint: (frame) => seen.push(frame) });
  tick();
  seen.length = 0;
  return seen;
}
function coat(color: string, order: number | 'mask'): Layer {
  return { order, paint(frame) {
    frame.ctx.fillStyle = color;
    for (const row of frame.changedRows) frame.ctx.fillRect(0, row * frame.metrics.height, frame.cols * frame.metrics.width, frame.metrics.height);
  } };
}
function background(row = 0) {
  return fills.filter((fill) => fill.x === 0 && fill.y === row * 18).at(-1)?.color;
}

test('real core and canvas setup render the supplied text', async () => {
  const term = await open();
  expect(term.buffer.active.getLine(0)!.translateToString(true)).toBe('secret');
  expect(texts.join('')).toContain('secret');
});

describe('paint layer lifetime', () => {
  test('numeric order is stable and the sole mask stays last after later registrations', async () => {
    const term = await open();
    const calls: string[] = [];
    for (const [name, order] of [['mask', 'mask'], ['b', 2], ['a', -1], ['c', 2], ['z', Number.MAX_VALUE]] as const) {
      term.addPaintLayer({ order, paint(frame) { calls.push(name); coat(name, order).paint(frame); } });
    }
    tick();
    expect(calls).toEqual(['a', 'b', 'c', 'z', 'mask']);
    expect(background()).toBe('mask');
    expect(() => term.addPaintLayer(coat('second mask', 'mask'))).toThrow();
    for (const order of [NaN, Infinity, -Infinity]) expect(() => term.addPaintLayer(coat('bad', order))).toThrow(RangeError);
  });

  test('register and remove repaint old pixels, and repeated removal does nothing', async () => {
    const term = await open();
    const seen = observe(term);
    const remove = term.addPaintLayer(coat('overlay', 1));
    tick();
    expect(seen.at(-1)?.full).toBe(true);
    expect(background()).toBe('overlay');
    remove();
    tick();
    expect(background()).toBe('#1e1e1e');
    expect(seen.at(-1)?.full).toBe(true);
    seen.length = 0;
    remove();
    tick();
    expect(seen).toEqual([]);
  });

  test('registrations are copied and disposal during a frame takes effect next frame', async () => {
    const term = await open();
    const calls: string[] = [];
    let remove = () => {};
    term.addPaintLayer({ order: -1, paint() { calls.push('a'); remove(); } });
    const layer: Layer = { order: 1, paint: () => calls.push('b') };
    remove = term.addPaintLayer(layer);
    layer.order = -2;
    layer.paint = () => calls.push('mutated');
    tick();
    expect(calls).toEqual(['a', 'b']);
    calls.length = 0;
    tick();
    expect(calls).toEqual(['a']);
  });

  test('a registration inside paint starts on the next full frame', async () => {
    const term = await open();
    const calls: string[] = [];
    let added = false;
    term.addPaintLayer({ order: 0, paint() {
      calls.push('first');
      if (!added) { added = true; term.addPaintLayer({ order: 1, paint: () => calls.push('new') }); }
    } });
    tick();
    expect(calls).toEqual(['first']);
    tick();
    expect(calls).toEqual(['first', 'first', 'new']);
  });

  test('each callback restores context and immutable frame data, even when it throws', async () => {
    const term = await open();
    const error = new Error('paint failed');
    const remove = term.addPaintLayer({ order: 0, paint(frame) {
      frame.ctx.globalAlpha = 0.2;
      frame.ctx.setTransform(9, 0, 0, 9, 0, 0);
      expect(Object.isFrozen(frame)).toBe(true);
      expect(Object.isFrozen(frame.changedRows)).toBe(true);
      expect(Object.isFrozen(frame.metrics)).toBe(true);
      throw error;
    } });
    const mask = vi.fn((frame: Frame) => {
      expect(frame.ctx.globalAlpha).toBe(1);
      expect(state.transform).toEqual([1, 0, 0, 1, 0, 0]);
      coat('masked', 'mask').paint(frame);
    });
    term.addPaintLayer({ order: 'mask', paint: mask });
    expect(() => term.refresh()).toThrow(error);
    expect(mask).toHaveBeenCalledOnce();
    expect(background()).toBe('masked');
    expect(stack).toHaveLength(0);
    remove();
    term.refresh();
    expect(mask).toHaveBeenCalledTimes(2);
    tick();
    expect(mask).toHaveBeenCalledTimes(2);
  });

  test('a callback error in the animation loop leaves a future repaint scheduled', async () => {
    const term = await open();
    const remove = term.addPaintLayer({ order: 0, paint() { throw new Error('frame failed'); } });
    expect(() => tick()).toThrow('frame failed');
    remove();
    const paint = vi.fn();
    term.addPaintLayer({ order: 'mask', paint });
    tick();
    expect(paint).toHaveBeenCalledOnce();
  });

  test('clear invalidates the canvas and layers repaint on the next frame', async () => {
    const term = await open();
    const seen = observe(term);
    term.renderer!.clear();
    tick();
    expect(seen.at(-1)?.full).toBe(true);
    expect(texts.join('')).toContain('secret');
  });

  test('idle frames do not repaint translucent layers', async () => {
    const term = await open();
    const paint = vi.fn(coat('rgba(1, 2, 3, 0.2)', 1).paint);
    term.addPaintLayer({ order: 1, paint });
    tick();
    expect(paint).toHaveBeenCalledOnce();
    for (let i = 0; i < 3; i++) tick();
    expect(paint).toHaveBeenCalledOnce();
    expect(fills).toEqual([]);
  });
});

describe('frame coverage and refresh', () => {
  test('refresh is synchronous, full, and restores the absolute DPR without resizing the PTY', async () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const term = await open();
    const seen = observe(term);
    const resize = vi.fn();
    const change = vi.fn();
    term.onResize(resize);
    term.onChange(change);
    state.transform = [1, 0, 0, 1, 0, 0];
    clearPaint();
    term.refresh();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ full: true, changedRows: [0, 1, 2, 3, 4, 5], rows: 6, cols: 12, pixelRatio: 2, topRow: 0, viewportOffset: 0 });
    expect(transforms[0]).toEqual([2, 0, 0, 2, 0, 0]);
    expect(resize).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
  });

  test('a reentrant refresh defers exactly one full repaint without recursion', async () => {
    const term = await open();
    const seen: Frame[] = [];
    term.addPaintLayer({ order: 0, paint(frame) { seen.push(frame); if (seen.length === 1) term.refresh(); } });
    term.refresh();
    expect(seen).toHaveLength(1);
    tick();
    expect(seen).toHaveLength(2);
    expect(seen[1].full).toBe(true);
    tick();
    expect(seen).toHaveLength(2);
  });

  test('unopened and disposed calls are inert and never queue a registration', async () => {
    const term = await create();
    const paint = vi.fn();
    expect(() => term.refresh()).not.toThrow();
    expect(term.getMetrics()).toBeUndefined();
    const remove = term.addPaintLayer({ order: NaN, paint });
    const host = document.createElement('div');
    document.body.append(host);
    term.open(host);
    term.refresh();
    remove();
    expect(paint).not.toHaveBeenCalled();
    term.dispose();
    expect(() => term.refresh()).not.toThrow();
    expect(term.getMetrics()).toBeUndefined();
    expect(() => term.addPaintLayer({ order: NaN, paint })()).not.toThrow();
  });

  test('cursor visibility and movement report the actual repainted rows', async () => {
    const term = await open();
    const seen = observe(term);
    term.write('\x1b[?25h');
    tick();
    expect(seen.at(-1)?.changedRows).toEqual([0, 1]);
    seen.length = 0;
    term.write('\x1b[4;1H');
    tick();
    expect(seen.at(-1)?.changedRows).toEqual([0, 1, 2, 3, 4]);
    expect(seen.at(-1)?.full).toBe(false);
    term.write('\x1b[?25l');
    tick();
    expect(seen.at(-1)?.changedRows).toEqual([2, 3, 4]);
  });

  test('highlights, selection and hover changes list their repainted neighbors', async () => {
    const term = await open(undefined, '\x1b[3;1H\x1b]8;;https://example.test\x07secret\x1b]8;;\x07');
    const seen = observe(term);
    const range = { start: { col: 0, absoluteRow: 2 }, end: { col: 1, absoluteRow: 2 } };
    term.highlights.set('owned', [range]);
    tick();
    expect(seen.at(-1)?.changedRows).toEqual([1, 2, 3]);
    term.highlights.clear('owned');
    tick();
    expect(seen.at(-1)?.changedRows).toEqual([1, 2, 3]);
    term.setSelection(range);
    tick();
    expect(seen.at(-1)?.changedRows).toEqual([1, 2, 3]);
    term.clearSelection();
    tick();
    expect(seen.at(-1)?.changedRows).toEqual([1, 2, 3]);
    term.renderer!.setHoveredLinkRange({ startX: 0, endX: 5, startY: 2, endY: 2 });
    tick();
    expect(seen.at(-1)?.changedRows).toEqual([1, 2, 3]);
  });

  test('viewport metadata uses the floored history offset and the actual absolute top row', async () => {
    const term = await open({ scrollbarOpacity: 0 }, Array.from({ length: 15 }, (_, i) => `line${i}`).join('\r\n'));
    const seen = observe(term);
    term.viewport.scrollTo(2.5);
    term.refresh();
    expect(seen.at(-1)).toMatchObject({ viewportOffset: 2.5, topRow: term.getScrollbackLength() - 2, full: true, changedRows: [0, 1, 2, 3, 4, 5] });
  });

  test('the deterministic opacity paints over fresh rows and hiding restores content', async () => {
    const hooks = { scrollbarOpacity: 0.5 };
    const term = await open(hooks, 'a\r\n'.repeat(10));
    const seen = observe(term);
    clearPaint();
    term.refresh();
    expect(fills.some((fill) => fill.color === 'rgba(128, 128, 128, 0.05)')).toBe(true);
    expect(seen.at(-1)?.full).toBe(true);
    hooks.scrollbarOpacity = 0;
    tick();
    expect(seen.at(-1)?.full).toBe(true);
    expect(fills.some((fill) => fill.color.startsWith('rgba(128'))).toBe(false);
    seen.length = 0;
    tick();
    expect(seen).toEqual([]);
  });
});

describe('public cell metrics', () => {
  function offscreen(width = 8.7, height = 16.3) {
    vi.stubGlobal('OffscreenCanvas', class {
      getContext() { return { font: '', measureText: () => ({ width, fontBoundingBoxAscent: height - 4, fontBoundingBoxDescent: 4 }) }; }
    });
  }
  test('rounds W measurements to device pixels and centers the natural baseline', async () => {
    vi.stubGlobal('devicePixelRatio', 2);
    offscreen();
    const term = await open();
    // Use the old public renderer read in the counterfactual to isolate the algorithm.
    expect(term.renderer!.getMetrics()).toEqual({ width: 8.5, height: 16.5, baseline: 12.25 });
    const metrics = term.getMetrics()! as Metrics;
    metrics.width = 123;
    expect(term.getMetrics()).toEqual({ width: 8.5, height: 16.5, baseline: 12.25 });
  });

  test('DOM fallback measures 32 W glyphs without leaving a span', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.tagName === 'SPAN' && this.textContent === 'W'.repeat(32) ? 280 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.tagName === 'SPAN' ? 17 : 0;
    });
    const term = await open();
    expect(term.renderer!.getMetrics()).toEqual({ width: 8, height: 17, baseline: 12.5 });
    expect(document.querySelector('span')).toBeNull();
  });

  test('clamps baseline into short cells and updates metrics when font options change', async () => {
    offscreen(8.7, 1);
    const term = await open();
    expect(term.renderer!.getMetrics()).toEqual({ width: 8, height: 1, baseline: 1 });
    offscreen(10.4, 20.2);
    term.options.fontSize = 20;
    expect(term.getMetrics()).toEqual({ width: 10, height: 21, baseline: 14.5 });
    offscreen(11.4, 21.2);
    term.options.fontFamily = 'another-monospace';
    expect(term.getMetrics()).toEqual({ width: 11, height: 22, baseline: 15 });
  });
});
