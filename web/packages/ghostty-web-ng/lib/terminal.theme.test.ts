import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { GhosttyVt, VtCells } from '../vt/ghosttyVt';
import { terminalInternals } from '../vt/internal';
import type { ITheme } from './interfaces';
import { widgetInternals } from './internal';
import type { PaintFrame } from './renderer';
import { Terminal } from './terminal';

// Structural typing lets this file run unchanged against the pre-API widget.
type Theme = ITheme & {
  minimumContrastRatio?: number;
  searchMatchBackground?: string; searchMatchForeground?: string;
  searchActiveMatchBackground?: string; searchActiveMatchForeground?: string;
};
function setTheme(term: Terminal, theme: Theme): void {
  (term as Terminal & { setTheme(theme: Theme): void }).setTheme(theme);
}
const LIGHT: Theme = { background: '#ffffff', foreground: '#222222', cursor: '#123456', red: '#aa1122' };
const DARK: Theme = { background: '#112233', foreground: '#dddddd', cursor: '#abcdef', red: '#ee3344' };
const keys = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;
const COLOR_ROW = Array.from({ length: 16 }, (_, i) => `\x1b[${i < 8 ? 30 + i : 90 + i - 8}mX`).join('') + '\x1b[0m';
let module: WebAssembly.Module;
let terminalData: Record<string, number>;
let contexts: WeakMap<HTMLCanvasElement, PixelContext>;
const terminals: Terminal[] = [];
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;

beforeAll(async () => {
  module = await WebAssembly.compile(readFileSync('vendor/ghostty-vt/ghostty-vt.wasm'));
  const { exports } = await WebAssembly.instantiate(module, {});
  const ptr = (exports.ghostty_type_json as () => number)();
  const bytes = new Uint8Array((exports.memory as WebAssembly.Memory).buffer);
  let end = ptr;
  while (bytes[end] !== 0) end++;
  terminalData = JSON.parse(new TextDecoder().decode(bytes.subarray(ptr, end))).types.GhosttyTerminalData.values;
});
beforeEach(() => {
  contexts = new WeakMap();
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    let context = contexts.get(this);
    if (!context) { context = new PixelContext(this); contexts.set(this, context); }
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
  const due = [...frames.values()];
  frames.clear();
  due.forEach(callback => callback(performance.now()));
}
async function unopened(theme: Theme = DARK) {
  const ghostty = new GhosttyVt(await WebAssembly.instantiate(module, {}));
  const term = new Terminal({ ghostty, theme, cols: 24, rows: 4, boxGlyphs: true,
    scrollbar: 'overlay', cursorBlink: false, smoothScrollDuration: 0, testHooks: { scrollbarOpacity: 0 } });
  terminals.push(term);
  const host = document.createElement('div');
  document.body.append(host);
  return { term, host };
}
async function open(theme: Theme = DARK, output = '\x1b[?25l') {
  const rig = await unopened(theme);
  rig.term.open(rig.host);
  rig.term.write(output);
  rig.term.refresh();
  const canvas = rig.host.querySelector('canvas')!;
  return { ...rig, canvas, ctx: contexts.get(canvas)! };
}
function cells(term: Terminal) {
  const core = term.core!;
  const view = new VtCells();
  return Array.from({ length: core.getScrollbackLength() + term.rows }, (_, row) => {
    if (row < core.getScrollbackLength()) core.readHistoryRow(row, view);
    else core.readRow(row - core.getScrollbackLength(), view);
    return Array.from({ length: view.length }, (_, col) => ({ ...view.at(col)! }));
  });
}
// Package-local C API snapshots pin effective colors as well as defaults,
// including cursor and palette slots that a cell read cannot expose.
function coreColors(term: Terminal): Record<string, number[] | null> {
  const raw = terminalInternals(widgetInternals(term).wasmTerm!);
  const out: Record<string, number[] | null> = {};
  const ptr = raw.wasm.alloc(768);
  try {
    for (const name of ['FOREGROUND', 'BACKGROUND', 'CURSOR', 'PALETTE']) {
      for (const data of [`COLOR_${name}`, `COLOR_${name}_DEFAULT`]) {
        expect(terminalData[data], data).toBeTypeOf('number');
        const result = raw.wasm.fn.ghostty_terminal_get(raw.handle, terminalData[data], ptr);
        expect([0, -4], data).toContain(result);
        out[data] = result === 0 ? [...raw.wasm.bytes().slice(ptr, ptr + (name === 'PALETTE' ? 768 : 3))] : null;
      }
    }
  } finally { raw.wasm.free(ptr, 768); }
  return out;
}
function cellPixel(ctx: PixelContext, col: number, row = 0) { return ctx.pixel(col * 8 + 4, row * 19 + 8); }
function contrast(a: number[], b: number[]): number {
  const luminance = (color: number[]) => color.slice(0, 3).map(c => c / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// jsdom has no rasterizer. Solid block glyphs take the real widget's fillRect
// path; this context reads their composited pixels. Text and strokes are
// recorded separately, never treated as rasterized browser glyphs.
class PixelContext {
  fillStyle = '#000000'; strokeStyle = '#000000'; globalAlpha = 1;
  texts: { text: string; x: number; y: number; color: string }[] = [];
  strokes: string[] = [];
  private pixels = new Map<number, number[]>();
  private saved: { fillStyle: string; strokeStyle: string; globalAlpha: number }[] = [];
  constructor(private canvas: HTMLCanvasElement) {}
  pixel(x: number, y: number): number[] { return this.pixels.get(y * this.canvas.width + x) ?? [0, 0, 0, 0]; }
  clearRect(x: number, y: number, w: number, h: number) { this.rectPixels(x, y, w, h, () => [0, 0, 0, 0]); }
  fillRect(x: number, y: number, w: number, h: number) {
    const from = this.fillStyle.startsWith('#')
      ? this.fillStyle.slice(1).match(/../g)!.map(c => Number.parseInt(c, 16))
      : this.fillStyle.match(/[\d.]+/g)!.map(Number);
    const alpha = (from[3] ?? 1) * this.globalAlpha;
    this.rectPixels(x, y, w, h, to => {
      const a = alpha + to[3] * (1 - alpha);
      return [...from.slice(0, 3).map((v, i) => a ? (v * alpha + to[i] * to[3] * (1 - alpha)) / a : 0), a];
    });
  }
  private rectPixels(x: number, y: number, w: number, h: number, blend: (to: number[]) => number[]) {
    for (let row = Math.max(0, Math.round(y)); row < Math.min(this.canvas.height, Math.round(y + h)); row++) {
      for (let col = Math.max(0, Math.round(x)); col < Math.min(this.canvas.width, Math.round(x + w)); col++) {
        this.pixels.set(row * this.canvas.width + col, blend(this.pixel(col, row)));
      }
    }
  }
  measureText() { return { width: 8, actualBoundingBoxAscent: 13, actualBoundingBoxDescent: 4 }; }
  fillText(text: string, x: number, y: number) { this.texts.push({ text, x, y, color: this.fillStyle }); }
  stroke() { this.strokes.push(this.strokeStyle); }
  save() { this.saved.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, globalAlpha: this.globalAlpha }); }
  restore() { Object.assign(this, this.saved.pop()); }
  setTransform() {} beginPath() {} rect() {} clip() {} moveTo() {} lineTo() {}
  setLineDash() {} quadraticCurveTo() {} bezierCurveTo() {}
}

describe('widget themes', () => {
  test('fixture paints a real core block and keeps explicit black beside a clear default', async () => {
    const { term, ctx } = await open({ background: 'rgba(0, 0, 0, 0)' }, '\x1b[?25l\x1b[38;2;153;153;153m\u2588\x1b[48;2;0;0;0m \x1b[49m ');
    expect(term.core!.plainText()).toBe('\u2588');
    expect(cellPixel(ctx, 0)).toEqual([153, 153, 153, 1]);
    expect(cellPixel(ctx, 1)).toEqual([0, 0, 0, 1]);
    expect(cellPixel(ctx, 2)).toEqual([0, 0, 0, 0]);
  });

  test('copies a pre-open theme and takes it into the sole core at open', async () => {
    const { term, host } = await unopened();
    const theme = { ...LIGHT };
    setTheme(term, theme);
    expect(term.options.theme).toEqual(LIGHT);
    expect(term.options.theme).not.toBe(theme);
    expect(term.core).toBeUndefined();
    theme.foreground = '#abcdef'; theme.background = '#654321';
    term.open(host);
    expect(cells(term)[0][0]).toMatchObject({ fg: 0x222222, bg: 0xffffff });
  });

  test('updates options without warning, ignores caller mutation, and does nothing after disposal', async () => {
    const { term, ctx } = await open();
    const warn = vi.spyOn(console, 'warn');
    const theme = { ...LIGHT };
    setTheme(term, theme);
    expect(term.options.theme).toEqual(LIGHT);
    expect(term.options.theme).not.toBe(theme);
    theme.background = '#ff00ff'; delete theme.red;
    term.refresh();
    expect(cellPixel(ctx, 0)).toEqual([255, 255, 255, 1]);
    expect(term.options.theme).toEqual(LIGHT);
    expect(warn).not.toHaveBeenCalled();
    const held = term.options.theme;
    term.dispose();
    expect(() => setTheme(term, DARK)).not.toThrow();
    expect(term.options.theme).toBe(held);
  });

  test('recolors every palette entry on screen and in history as a fresh terminal does', async () => {
    const theme = { ...LIGHT, ...Object.fromEntries(keys.map((key, i) => [key, `#${(0x123400 + i * 32).toString(16)}`])) };
    const output = '\x1b[?25l' + (COLOR_ROW + '\r\n').repeat(6) + '\x1b[38;2;7;8;9mT\x1b[0m\x1b[7mI';
    const { term } = await open(DARK, output);
    const before = cells(term), beforeColors = coreColors(term);
    setTheme(term, theme);
    const fresh = await open(theme, output);
    expect(cells(term)).toEqual(cells(fresh.term));
    expect(coreColors(term)).toEqual(coreColors(fresh.term));
    expect(cells(term)[0].slice(0, 16).map(cell => cell.fg)).toEqual(keys.map((_, i) => 0x123400 + i * 32));
    setTheme(term, DARK);
    expect(cells(term)).toEqual(before);
    expect(coreColors(term)).toEqual(beforeColors);
  });

  test('omitted and undefined colors reset to fresh defaults, including selection foreground', async () => {
    const { term, ctx } = await open({ ...DARK, selectionForeground: '#010203' }, '\x1b[?25l\u2588\x1b[31mR');
    term.setSelection({ start: { absoluteRow: 0, col: 0 }, end: { absoluteRow: 0, col: 0 } });
    setTheme(term, { cursor: undefined, red: undefined, selectionForeground: undefined });
    const fresh = await open({}, '\x1b[?25l\u2588\x1b[31mR');
    expect(cells(term)).toEqual(cells(fresh.term));
    expect(coreColors(term)).toEqual(coreColors(fresh.term));
    expect(cellPixel(ctx, 0)).toEqual([204, 204, 204, 1]);
    expect(cellPixel(ctx, 3)).toEqual([30, 30, 30, 1]);
  });

  test('theme black is a color for the core foreground, cursor and palette', async () => {
    const theme = { ...LIGHT, foreground: '#000000', cursor: '#000000', red: '#000000' };
    const { term, ctx } = await open(DARK, '\x1b[?25l\u2588\x1b[31m\u2588');
    setTheme(term, theme);
    expect(cells(term)[0].slice(0, 2).map(cell => cell.fg)).toEqual([0, 0]);
    expect(coreColors(term).COLOR_CURSOR_DEFAULT).toEqual([0, 0, 0]);
    expect(cellPixel(ctx, 0)).toEqual([0, 0, 0, 1]);
    expect(cellPixel(ctx, 1)).toEqual([0, 0, 0, 1]);
    term.write('\x1b[?25h'); term.refresh();
    expect(cellPixel(ctx, 2)).toEqual([0, 0, 0, 1]);
    const fresh = await open(theme, '\x1b[?25l\u2588\x1b[31m\u2588');
    expect(cells(term)).toEqual(cells(fresh.term));
    expect(coreColors(term)).toEqual(coreColors(fresh.term));
  });

  test('program color overrides remain over replacement defaults', async () => {
    const output = '\x1b[?25l\x1b]4;1;rgb:12/34/56\x07\x1b]10;rgb:aa/bb/cc\x07\x1b]11;rgb:20/30/40\x07\x1b]12;rgb:01/02/03\x07' + COLOR_ROW;
    const { term } = await open(DARK, output);
    setTheme(term, LIGHT);
    const fresh = await open(LIGHT, output);
    expect(cells(term)).toEqual(cells(fresh.term));
    expect(coreColors(term)).toEqual(coreColors(fresh.term));
    expect(cells(term)[0][1].fg).toBe(0x123456);
    expect(cells(term)[1][0]).toMatchObject({ fg: 0xaabbcc, bg: 0x203040 });
    expect(coreColors(term).COLOR_CURSOR).toEqual([1, 2, 3]);
  });

  test('preserves content, core identity, focus, viewport, selection and dimensions without resize or data', async () => {
    const { term, canvas } = await open(DARK, Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\r\n'));
    term.focus(); term.viewport.scrollTo(2);
    term.setSelection({ start: { absoluteRow: 3, col: 0 }, end: { absoluteRow: 3, col: 4 } });
    const state = () => ({ text: term.core!.plainText(), core: term.core, focus: document.activeElement,
      viewport: term.viewport.offset, selection: term.getSelectionRange(), copied: term.getSelection(),
      dimensions: term.core!.getDimensions(), width: canvas.width, height: canvas.height, metrics: term.getMetrics() });
    const before = state(), resize = vi.fn(), data = vi.fn();
    term.onResize(resize); term.onData(data);
    setTheme(term, LIGHT); tick();
    expect(state()).toEqual(before);
    expect(resize).not.toHaveBeenCalled(); expect(data).not.toHaveBeenCalled();
    term.input('typed', true); expect(data).toHaveBeenCalledExactlyOnceWith('typed');
  });

  test('one full frame repaints cursor, selection, fallback highlights, scrollbar and mask last', async () => {
    const { term, ctx } = await open(DARK, 'history\r\nhistory\r\n\r\n\r\n\r\n\x1b[1;1H\x1b[?25h');
    term.setSelection({ start: { absoluteRow: 2, col: 0 }, end: { absoluteRow: 2, col: 0 } });
    term.highlights.set('match', [{ start: { absoluteRow: 2, col: 1 }, end: { absoluteRow: 2, col: 1 } }], {});
    term.options.testHooks.scrollbarOpacity = 1;
    const order: string[] = [], paints: PaintFrame[] = [];
    term.addPaintLayer({ order: 'mask', paint: frame => {
      order.push('mask'); frame.ctx.fillStyle = '#123456'; frame.ctx.fillRect(16, 0, 8, 19);
    } });
    term.addPaintLayer({ order: 0, paint: frame => { order.push('ordinary'); paints.push(frame); } });
    term.write('\x1b[1;4H'); term.refresh(); order.length = paints.length = 0;
    setTheme(term, { ...LIGHT, selectionBackground: '#fedcba' });
    expect(order).toEqual(['ordinary', 'mask']);
    expect(paints).toHaveLength(1);
    expect(paints[0].full).toBe(true);
    expect(paints[0].changedRows).toEqual([0, 1, 2, 3]);
    expect(cellPixel(ctx, 0)).toEqual([254, 220, 186, 1]);
    expect(cellPixel(ctx, 1)).toEqual([254, 220, 186, 1]);
    expect(cellPixel(ctx, 2)).toEqual([18, 52, 86, 1]);
    expect(cellPixel(ctx, 3)).toEqual([18, 52, 86, 1]);
    expect(ctx.pixel(182, 8)[0]).toBeCloseTo(255 * 0.9 + 128 * 0.1, 6);
  });

  test('pixels meet 4.5 against a light background and ratio one restores the exact foreground', async () => {
    const { term, ctx } = await open(LIGHT, '\x1b[?25l\x1b[38;2;153;153;153m\u2588 ');
    expect(cellPixel(ctx, 0)).toEqual([153, 153, 153, 1]);
    expect(contrast(cellPixel(ctx, 0), cellPixel(ctx, 1))).toBeLessThan(4.5);
    setTheme(term, { ...LIGHT, minimumContrastRatio: 4.5 });
    expect(contrast(cellPixel(ctx, 0), cellPixel(ctx, 1))).toBeGreaterThanOrEqual(4.5);
    expect(cells(term)[0][0].fg).toBe(0x999999);
    setTheme(term, { ...LIGHT, minimumContrastRatio: 1 });
    expect(cellPixel(ctx, 0)).toEqual([153, 153, 153, 1]);
  });

  test.each([undefined, NaN, Infinity, -Infinity, 0, 0.5])('invalid or omitted ratio %s is the identity', async ratio => {
    const { term, ctx } = await open(LIGHT, '\x1b[?25l\x1b[38;2;153;153;153m\u2588');
    setTheme(term, { ...LIGHT, minimumContrastRatio: ratio });
    expect(cellPixel(ctx, 0)).toEqual([153, 153, 153, 1]);
  });

  test('construction applies the floor, and already contrasting colors stay exact', async () => {
    const { ctx } = await open({ ...LIGHT, minimumContrastRatio: 4.5 }, '\x1b[?25l\x1b[38;2;153;153;153m\u2588\x1b[38;2;1;2;3m\u2588 ');
    expect(contrast(cellPixel(ctx, 0), cellPixel(ctx, 2))).toBeGreaterThanOrEqual(4.5);
    expect(cellPixel(ctx, 1)).toEqual([1, 2, 3, 1]);
  });

  test('uses explicit and inverse backgrounds without changing black or transparency', async () => {
    const { term, ctx } = await open(LIGHT, '\x1b[?25l\x1b[38;2;153;153;153m\u2588 \x1b[38;2;51;51;51;48;2;0;0;0m\u2588 \x1b[0;7;38;2;255;255;255;48;2;153;153;153m\u2588 ');
    setTheme(term, { background: 'rgba(0, 0, 0, 0)', minimumContrastRatio: 4.5 });
    expect(cellPixel(ctx, 0)).toEqual([153, 153, 153, 1]);
    expect(cellPixel(ctx, 1)).toEqual([0, 0, 0, 0]);
    expect(cellPixel(ctx, 3)).toEqual([0, 0, 0, 1]);
    expect(contrast(cellPixel(ctx, 2), cellPixel(ctx, 3))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(cellPixel(ctx, 4), cellPixel(ctx, 5))).toBeGreaterThanOrEqual(4.5);
  });

  test('a clear background over a known backdrop gets the floor against that backdrop', async () => {
    const { term, ctx } = await open(LIGHT, '\x1b[?25l\x1b[38;2;153;153;153m\u2588 ');
    const clear = { background: 'rgba(0, 0, 0, 0)', minimumContrastRatio: 4.5 };
    setTheme(term, { ...clear, contrastBackdrop: '#ffffff' } as Theme);
    expect(contrast(cellPixel(ctx, 0), [255, 255, 255, 1])).toBeGreaterThanOrEqual(4.5);
    expect(cellPixel(ctx, 1), 'the background stays clear').toEqual([0, 0, 0, 0]);
    setTheme(term, { ...clear, contrastBackdrop: '#101010' } as Theme);
    expect(contrast(cellPixel(ctx, 0), [16, 16, 16, 1]), 'a dark backdrop already contrasts').toBeGreaterThanOrEqual(4.5);
    expect(cellPixel(ctx, 0)).toEqual([153, 153, 153, 1]);
    setTheme(term, { ...clear, contrastBackdrop: 'rgba(255, 255, 255, 0.5)' } as Theme);
    expect(cellPixel(ctx, 0), 'a translucent backdrop is not a known color').toEqual([153, 153, 153, 1]);
    setTheme(term, { background: 'rgba(255, 255, 255, 0.5)', minimumContrastRatio: 4.5, contrastBackdrop: '#ffffff' } as Theme);
    expect(contrast(cellPixel(ctx, 0), [255, 255, 255, 1]), 'a translucent fill composites over it').toBeGreaterThanOrEqual(4.5);
  });

  test('selection and highlights adjust inherited ink against their composite background but keep explicit ink', async () => {
    const { term, ctx } = await open(DARK, '\x1b[?25l\x1b[38;2;153;153;153m\u2588 \u2588 ');
    term.setSelection({ start: { absoluteRow: 0, col: 0 }, end: { absoluteRow: 0, col: 1 } });
    term.highlights.set('match', [{ start: { absoluteRow: 0, col: 2 }, end: { absoluteRow: 0, col: 3 } }], { background: 'rgba(255, 255, 255, 0.8)' });
    setTheme(term, { ...DARK, minimumContrastRatio: 4.5, selectionBackground: '#eeeeee' });
    expect(contrast(cellPixel(ctx, 0), cellPixel(ctx, 1))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(cellPixel(ctx, 2), cellPixel(ctx, 3))).toBeGreaterThanOrEqual(4.5);
    setTheme(term, { ...LIGHT, minimumContrastRatio: 4.5, selectionForeground: '#999999' });
    term.highlights.set('match', [{ start: { absoluteRow: 0, col: 2 }, end: { absoluteRow: 0, col: 3 } }], { background: '#ffffff', foreground: '#aaaaaa' });
    term.refresh();
    expect(cellPixel(ctx, 0)).toEqual([153, 153, 153, 1]);
    expect(cellPixel(ctx, 2)).toEqual([170, 170, 170, 1]);
  });

  test('search colours are theme keys with defaults, and inherited ink on them meets the floor on dark and light themes', async () => {
    // Ink close to both themes' match backgrounds, so the floor must move it.
    const { term, ctx } = await open(DARK, '\x1b[?25l\x1b[38;2;150;130;80mneedle\x1b[0m needle');
    term.search.find('needle');
    for (let i = 0; i < 100 && (term.search.state.partial || !term.highlights.get('search-active')); i++) tick();
    expect(term.search.state).toEqual({ index: 1, total: 2, partial: false });
    // The last glyph painted at a column of row 0, whose baseline is y 14.
    const ink = (col: number) => {
      const color = ctx.texts.filter(t => t.x === col * 8 && t.y === 14).at(-1)?.color ?? '';
      return color.startsWith('#') ? color.slice(1).match(/../g)!.map(c => Number.parseInt(c, 16)) : color.match(/\d+/g)!.map(Number);
    };
    const hex = (color: string) => color.slice(1).match(/../g)!.map(c => Number.parseInt(c, 16));
    expect(term.highlights.get('search-all')?.style, 'default match colour').toEqual({ background: '#806d36' });
    expect(term.highlights.get('search-active')?.style, 'default active colours').toEqual({ background: '#ffb454', foreground: '#000000' });
    const themes: Theme[] = [
      { ...DARK, minimumContrastRatio: 4.5, searchMatchBackground: '#6a5a30', searchActiveMatchBackground: '#e0a040', searchActiveMatchForeground: '#101010' },
      { ...LIGHT, minimumContrastRatio: 4.5, searchMatchBackground: '#c8b070', searchActiveMatchBackground: '#ffd080', searchActiveMatchForeground: '#202020' },
    ];
    for (const theme of themes) {
      ctx.texts.length = 0;
      setTheme(term, theme);
      const match = hex(theme.searchMatchBackground!);
      expect(cellPixel(ctx, 0).slice(0, 3), 'the match background is the theme key').toEqual(match);
      expect(contrast(ink(0), match), 'inherited ink on a match meets the floor').toBeGreaterThanOrEqual(4.5);
      expect(contrast([150, 130, 80], match), 'the ink itself does not').toBeLessThan(4.5);
      expect(cellPixel(ctx, 7).slice(0, 3), 'the active background is the theme key').toEqual(hex(theme.searchActiveMatchBackground!));
      expect(ink(7), 'an explicit active foreground stays exact').toEqual(hex(theme.searchActiveMatchForeground!));
      expect(term.highlights.get('search-all')?.style).toEqual({ background: theme.searchMatchBackground });
    }
    setTheme(term, { ...LIGHT, searchMatchForeground: '#333333' });
    expect(term.highlights.get('search-all')?.style, 'omitted keys return to their defaults').toEqual({ background: '#806d36', foreground: '#333333' });
    expect(ink(0)).toEqual([51, 51, 51]);
  });

  test('search colours in the theme a terminal opens with apply to its first search', async () => {
    const { term, ctx } = await open({ ...DARK, searchMatchBackground: '#6a5a30', searchMatchForeground: '#fefefe', searchActiveMatchBackground: '#e0a040', searchActiveMatchForeground: '#101010' }, '\x1b[?25lneedle needle');
    term.search.find('needle');
    for (let i = 0; i < 100 && (term.search.state.partial || !term.highlights.get('search-active')); i++) tick();
    expect(term.highlights.get('search-all')?.style).toEqual({ background: '#6a5a30', foreground: '#fefefe' });
    expect(term.highlights.get('search-active')?.style).toEqual({ background: '#e0a040', foreground: '#101010' });
    expect(cellPixel(ctx, 0).slice(0, 3), 'the first match paints in the theme colour').toEqual([0x6a, 0x5a, 0x30]);
  });

  test('search colours set by a theme change hold through the next write', async () => {
    const { term } = await open(DARK, '\x1b[?25lneedle needle');
    term.search.find('needle');
    for (let i = 0; i < 100 && (term.search.state.partial || !term.highlights.get('search-active')); i++) tick();
    setTheme(term, { ...DARK, searchMatchBackground: '#6a5a30', searchActiveMatchBackground: '#e0a040', searchActiveMatchForeground: '#101010' });
    term.write(' more needle');
    for (let i = 0; i < 100 && (term.search.state.partial || term.search.state.total !== 3); i++) tick();
    expect(term.search.state.total).toBe(3);
    expect(term.highlights.get('search-all')?.style, 'the republished match layer').toEqual({ background: '#6a5a30' });
    expect(term.highlights.get('search-active')?.style, 'the republished active layer').toEqual({ background: '#e0a040', foreground: '#101010' });
  });

  test('wide clusters, boxes and decorations share adjusted ink; explicit underline and faint keep their rules', async () => {
    const { term, ctx } = await open(LIGHT, '\x1b[?25l\x1b[38;2;153;153;153;4;9;53m\u754ce\u0301\u2500\u2588\x1b[58;2;9;8;7mU\x1b[0;2;38;2;153;153;153m\u2588');
    ctx.texts.length = ctx.strokes.length = 0;
    setTheme(term, { ...LIGHT, minimumContrastRatio: 4.5 });
    const wide = ctx.texts.filter(t => t.text === '\u754c');
    expect(wide).toHaveLength(1); expect(wide[0].x).toBe(0);
    expect(ctx.texts.filter(t => t.text === 'e\u0301')).toEqual([{ text: 'e\u0301', x: 16, y: 14, color: wide[0].color }]);
    expect(wide[0].color).not.toBe('rgb(153, 153, 153)');
    expect(ctx.strokes).toContain(wide[0].color);
    expect(ctx.strokes).toContain('rgb(9, 8, 7)');
    const block = cellPixel(ctx, 4), faint = cellPixel(ctx, 6);
    expect(contrast(block, [255, 255, 255])).toBeGreaterThanOrEqual(4.5);
    expect(faint[0]).toBeCloseTo((block[0] + 255) / 2, 6);
  });
});
