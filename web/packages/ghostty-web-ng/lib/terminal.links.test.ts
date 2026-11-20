import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { GhosttyVt } from '../vt/ghosttyVt';
import type { TerminalLinkActivation } from './interfaces';
import { LinkDetector } from './link-detector';
import { OSC8LinkProvider } from './providers/osc8-link-provider';
import { UrlRegexProvider } from './providers/url-regex-provider';
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
});

afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const CELL = { width: 8, height: 16 };

// The real core and both providers; the canvas sits at the page's origin
// (jsdom lays out nothing), so a cell's pixels are its column and row times
// the cell size.
async function terminal() {
  const ghostty = new GhosttyVt(await WebAssembly.instantiate(module, {}));
  const term = new Terminal({ ghostty, cols: 40, rows: 6, smoothScrollDuration: 0 });
  const renderer = {
    render: vi.fn(),
    resize: vi.fn(),
    getMetrics: () => ({ ...CELL, baseline: 12 }),
    charWidth: CELL.width,
    charHeight: CELL.height,
    dispose: vi.fn(),
  };
  Object.assign(term, {
    wasmTerm: ghostty.createTerminal(40, 6, { scrollbackLimit: 1000 }),
    renderer,
    canvas: document.createElement('canvas'),
    isOpen: true,
  });
  const links = new LinkDetector(term);
  links.registerProvider(new OSC8LinkProvider(term));
  links.registerProvider(new UrlRegexProvider(term));
  Object.assign(term, { linkDetector: links });
  terminals.push(term);
  const seen: TerminalLinkActivation[] = [];
  term.onLinkActivate((link) => seen.push(link));
  return { term, seen };
}

type Pointer = { x: number; y: number; shiftKey?: boolean; ctrlKey?: boolean; detail?: number };

// A press at one point and the click its release makes at another, through
// the widget's own press and click listeners.
async function click(term: Terminal, press: Pointer, release: Pointer = press) {
  const at = (p: Pointer) => ({
    clientX: p.x,
    clientY: p.y,
    button: 0,
    shiftKey: p.shiftKey ?? false,
    ctrlKey: p.ctrlKey ?? false,
  });
  const widget = term as unknown as {
    handleLinkPress(e: MouseEvent): void;
    handleClick(e: MouseEvent): Promise<void>;
  };
  widget.handleLinkPress(new MouseEvent('mousedown', at(press)));
  await widget.handleClick(new MouseEvent('click', { ...at(release), detail: release.detail ?? 1 }));
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
    // A press that moved less than the selection's drag threshold is a click.
    await click(term, cell(3, 0), { x: cell(3, 0).x + 2, y: cell(3, 0).y });
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
