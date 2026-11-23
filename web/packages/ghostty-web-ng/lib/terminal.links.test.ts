import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { GhosttyVt } from '../vt/ghosttyVt';
import type { TerminalLinkActivation } from './interfaces';
import { DRAG_THRESHOLD_CELLS } from './selection-manager';
import { Terminal } from './terminal';

let module: WebAssembly.Module;
const terminals: Terminal[] = [];

beforeAll(async () => {
  module = await WebAssembly.compile(readFileSync('vendor/ghostty-vt/ghostty-vt.wasm'));
});

beforeEach(() => {
  let next = 1;
  vi.stubGlobal('requestAnimationFrame', () => next++);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => new Proxy({}, {
    get: (_, key) => key === 'measureText'
      ? () => ({ width: 8, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 4 })
      : () => undefined,
    set: () => true,
  })) as never);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } });
});

afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
  document.body.replaceChildren();
  delete (navigator as { clipboard?: unknown }).clipboard;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const CELL = { width: 8, height: 16 };

// Canvas pixels are modelled; capture delivery is explicitly targeted at the canvas.
async function terminal() {
  const ghostty = new GhosttyVt(await WebAssembly.instantiate(module, {}));
  const term = new Terminal({ ghostty, cols: 40, rows: 6, smoothScrollDuration: 0 });
  const host = document.createElement('div');
  document.body.append(host);
  terminals.push(term);
  term.open(host);
  const canvas = host.querySelector('canvas')!;
  const captured = new Set<number>();
  Object.assign(canvas, {
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
  });
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 40 * CELL.width, 6 * CELL.height));
  const seen: TerminalLinkActivation[] = [];
  term.onLinkActivate((link) => seen.push(link));
  return { term, seen, host, canvas, captured };
}

type Pointer = { x: number; y: number; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; detail?: number };

function pointer(term: Terminal, type: string, p: Pointer, extra: PointerEventInit = {}) {
  term.element!.querySelector('canvas')!.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true,
    button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1,
    clientX: p.x, clientY: p.y, shiftKey: p.shiftKey, ctrlKey: p.ctrlKey, ...extra,
  }));
}

async function dispatchClick(term: Terminal, p: Pointer, target: Element = term.element!.querySelector('canvas')!) {
  target.dispatchEvent(new MouseEvent('click', {
    bubbles: true, cancelable: true, button: 0, detail: p.detail ?? 1,
    clientX: p.x, clientY: p.y, shiftKey: p.shiftKey, ctrlKey: p.ctrlKey,
    metaKey: p.metaKey, altKey: p.altKey,
  }));
  // The providers resolve asynchronously, even for a click which must be suppressed.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function click(term: Terminal, press: Pointer, release: Pointer = press) {
  pointer(term, 'pointerdown', press);
  pointer(term, 'pointermove', release);
  pointer(term, 'pointerup', release);
  // Native implicit capture loss follows up, before click, and must preserve it.
  pointer(term, 'lostpointercapture', release);
  await dispatchClick(term, release);
}

const cell = (col: number, row: number) => ({ x: col * CELL.width + 2, y: row * CELL.height + 2 });

describe('link activation', () => {
  test('a click on a link reports its real target, kind and cells', async () => {
    const { term, seen } = await terminal();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    // The OSC 8 text names one place and the target another.
    term.write('see \x1b]8;;./dev/notes.md\x07README\x1b]8;;\x07 and https://example.com/a\r\n');
    await click(term, cell(5, 0));
    // Ctrl or Cmd with the click is the listener's to read; the widget opens nothing.
    await click(term, { ...cell(20, 0), ctrlKey: true });
    expect(seen.map(({ target, kind, range }) => ({ target, kind, range }))).toEqual([
      { target: './dev/notes.md', kind: 'osc8', range: { start: { x: 4, y: 0 }, end: { x: 9, y: 0 } } },
      { target: 'https://example.com/a', kind: 'url', range: { start: { x: 15, y: 0 }, end: { x: 35, y: 0 } } },
    ]);
    expect(seen[1].event.ctrlKey).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  test('a press that ends a drag or a double click is not a link click', async () => {
    const { term, seen } = await terminal();
    term.write('https://example.com/drag\r\n');
    // From one end of the link to the other: a selection.
    await click(term, cell(1, 0), cell(20, 0));
    // The second click of a double click on the link: a word selection.
    await click(term, cell(3, 0), { ...cell(3, 0), detail: 2 });
    expect(seen).toEqual([]);
    // The selection's drag threshold, half a cell: a press moved that far
    // selected, one moved a pixel less is a click.
    const half = CELL.width * DRAG_THRESHOLD_CELLS;
    await click(term, cell(3, 0), { x: cell(3, 0).x + half, y: cell(3, 0).y });
    expect(seen).toEqual([]);
    await click(term, cell(3, 0), { x: cell(3, 0).x + half - 1, y: cell(3, 0).y });
    expect(seen.map((link) => link.target)).toEqual(['https://example.com/drag']);
  });

  test('a press reported to a program tracking the mouse is the program\'s unless Shift held it back', async () => {
    const { term, seen } = await terminal();
    term.write('\x1b[?1000hhttps://example.com/tracked\r\n');
    expect(term.hasMouseTracking()).toBe(true);
    await click(term, cell(2, 0));
    expect(seen).toEqual([]);
    await click(term, { ...cell(2, 0), shiftKey: true });
    expect(seen.map((link) => link.target)).toEqual(['https://example.com/tracked']);
  });
});

describe('link gesture completion through registered listeners', () => {
  test.each(['pointercancel', 'lostpointercapture', 'uncaptured', 'detached', 'prevented'])('%s abandons a pending link press', async (end) => {
    const { term, seen, host, canvas, captured } = await terminal();
    term.write('https://example.com');
    const at = cell(3, 0);
    pointer(term, 'pointerdown', at);
    if (end === 'uncaptured') {
      captured.clear();
      pointer(term, 'pointermove', at);
    } else if (end === 'detached') {
      host.remove();
      pointer(term, 'pointerup', at);
      document.body.append(host);
    } else if (end === 'prevented') {
      pointer(term, 'pointerup', at);
      host.addEventListener('pointerdown', (e) => e.preventDefault(), { capture: true });
      pointer(term, 'pointerdown', at);
      pointer(term, 'pointerup', at);
    } else {
      pointer(term, end, at);
    }
    await dispatchClick(term, at);
    expect(seen).toEqual([]);
    expect(canvas.hasPointerCapture(7)).toBe(false);
  });

  test('a drag returning to its start cannot become a link click', async () => {
    const { term, seen } = await terminal();
    term.write('https://example.com');
    const at = cell(3, 0);
    pointer(term, 'pointerdown', at);
    pointer(term, 'pointermove', cell(10, 0));
    pointer(term, 'pointermove', at);
    pointer(term, 'pointerup', at);
    await dispatchClick(term, at);
    expect(seen).toEqual([]);
  });

  test.each(['thumb', 'track'])('%s press consumes a stale link click while bubbling', async (where) => {
    const { term, seen, host } = await terminal();
    const url = 'https://example.com';
    term.write(Array.from({ length: 40 }, () => url).join('\r\n'));
    term.viewport.scrollTo(1);
    term.viewport.scrollTo(10);
    const at = cell(3, 0);
    pointer(term, 'pointerdown', at);
    pointer(term, 'pointerup', at);
    const pagePress = vi.fn();
    host.addEventListener('pointerdown', pagePress);
    const track = 6 * CELL.height - 8;
    const thumb = Math.max(20, 6 / (term.getScrollbackLength() + 6) * track);
    const y = where === 'track' ? 5 : 4 + (track - thumb) * (1 - 10 / term.getScrollbackLength()) + thumb / 2;
    pointer(term, 'pointerdown', { x: 312, y });
    pointer(term, 'pointerup', { x: 312, y });
    await dispatchClick(term, at);
    expect(pagePress).toHaveBeenCalledOnce();
    expect(seen).toEqual([]);
  });

  test('a program-owned press releases outside and never activates a link', async () => {
    const { term, seen } = await terminal();
    term.write('\x1b[?1002h\x1b[?1006hhttps://example.com');
    const reports: string[] = [];
    term.onData((data) => reports.push(data));
    pointer(term, 'pointerdown', cell(3, 0));
    pointer(term, 'pointerup', { x: 500, y: 500 });
    term.write('\x1b[?1002l');
    await dispatchClick(term, cell(3, 0));
    expect(reports).toEqual(['\x1b[<0;4;1M', '\x1b[<0;40;6m']);
    expect(seen).toEqual([]);
  });

  test('a release just above the grid cannot activate a link in hidden history', async () => {
    const { term, seen, host } = await terminal();
    term.write(Array.from({ length: 12 }, (_, i) => `https://example.com/${i}`).join('\r\n'));
    expect(term.getScrollbackLength()).toBeGreaterThan(0);
    pointer(term, 'pointerdown', { x: cell(3, 0).x, y: 1 });
    pointer(term, 'pointerup', { x: cell(3, 0).x, y: -1 });
    await dispatchClick(term, { x: cell(3, 0).x, y: -1 }, host);
    expect(seen).toEqual([]);
  });

  test('modifiers survive a first click and the second click selects a word', async () => {
    const { term, seen } = await terminal();
    term.write('\x1b]8;;../raw%20target#part\x07word\x1b]8;;\x07');
    const at = cell(1, 0);
    await click(term, at, { ...at, ctrlKey: true, metaKey: true, altKey: true });
    expect(seen.map((link) => link.target)).toEqual(['../raw%20target#part']);
    expect(seen[0].event).toMatchObject({ ctrlKey: true, metaKey: true, altKey: true });
    await click(term, at, { ...at, detail: 2 });
    expect(term.getSelection()).toBe('word');
    expect(seen).toHaveLength(1);
  });

  test('dispose removes every registered pointer and click listener by identity and phase', async () => {
    const add = vi.spyOn(EventTarget.prototype, 'addEventListener');
    const remove = vi.spyOn(EventTarget.prototype, 'removeEventListener');
    const { term, host, canvas } = await terminal();
    term.write('https://example.com');
    pointer(term, 'pointerdown', cell(3, 0));
    pointer(term, 'pointerup', cell(3, 0));
    const registrations = add.mock.calls.map((args, i) => ({ args, target: add.mock.contexts[i] }))
      .filter(({ args: [type], target }) => (target === host || target === canvas) && /^(pointer|lostpointer|click|mouse)/.test(type));
    expect(registrations.length).toBeGreaterThan(5);
    term.dispose();
    for (const { args: [name, handler, options], target } of registrations) {
      const capture = typeof options === 'boolean' ? options : options?.capture ?? false;
      expect(remove.mock.calls.some(([type, listener, opts], i) => remove.mock.contexts[i] === target &&
        type === name && listener === handler && (typeof opts === 'boolean' ? opts : opts?.capture ?? false) === capture), name).toBe(true);
    }
  });
});
