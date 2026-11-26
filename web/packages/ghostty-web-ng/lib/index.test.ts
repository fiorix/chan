import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GhosttyVt } from '../vt/ghosttyVt';
import { Terminal } from './terminal';

// The package's public surface, listed whole: the entries' runtime exports,
// a terminal's members, and those of the facades and buffer readers it hands
// out. The workspace app's boundary check reads only the app, so a back
// channel the package itself adds (a getter for the raw core, a friend
// module's reader exported from an entry) fails here and lands as a
// reviewed change to these lists.

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => new Proxy({}, {
    get: (_, key) => key === 'measureText'
      ? () => ({ width: 8, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 4 })
      : () => undefined,
    set: () => true,
  })) as never);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const sorted = (keys: ArrayLike<string | symbol>) => Array.from(keys, String).sort();
const own = (value: object) => sorted(Reflect.ownKeys(value));

async function opened() {
  const module = await WebAssembly.compile(readFileSync('vendor/ghostty-vt/ghostty-vt.wasm'));
  const ghostty = new GhosttyVt(await WebAssembly.instantiate(module, {}));
  const term = new Terminal({ ghostty, cols: 10, rows: 3 });
  const host = document.createElement('div');
  document.body.append(host);
  term.open(host);
  return term;
}

describe('the public surface', () => {
  test('the entries export exactly these names', async () => {
    expect(sorted(Object.keys(await import('./index')))).toEqual([
      'InputHandler',
      'Key',
      'KeyEncoderOption',
      'Terminal',
      'TerminalCoreDisposedError',
    ]);
    expect(sorted(Object.keys(await import('../vt')))).toEqual([
      'ABI',
      'CELL_BITS',
      'GhosttyVt',
      'GhosttyVtRefusal',
      'KEY_ENCODER_OPTIONS',
      'KEY_SHIFT_FROM',
      'LAYOUT',
      'SCRATCH',
      'STYLE_FLAG_BITS',
      'VtCells',
      'VtFlag',
      'VtKeyEncoder',
      'VtSearch',
      'VtTerminal',
      'VtTrackedCell',
      'copiedText',
      'upstreamKey',
      'upstreamKeyEncoderOption',
    ]);
  });

  test('a terminal has exactly these members', async () => {
    expect(sorted(Reflect.ownKeys(Terminal))).toEqual(['length', 'name', 'prototype']);
    expect(sorted(Reflect.ownKeys(Terminal.prototype))).toEqual([
      'addPaintLayer',
      'attachCustomKeyEventHandler',
      'attachCustomWheelEventHandler',
      'blur',
      'cellAt',
      'clearSelection',
      'constructor',
      'copySelection',
      'core',
      'dispose',
      'focus',
      'getCursor',
      'getMetrics',
      'getMode',
      'getRangeText',
      'getScrollbackLength',
      'getScrollbackText',
      'getSelection',
      'getSelectionRange',
      'getViewportY',
      'hasBracketedPaste',
      'hasFocusEvents',
      'hasMouseTracking',
      'hasSelection',
      'input',
      'open',
      'paste',
      'refresh',
      'resize',
      'scrollLines',
      'scrollToBottom',
      'select',
      'selectAll',
      'selectLines',
      'setSelection',
      'setTheme',
      'write',
      'writeln',
    ]);
    const term = await opened();
    try {
      expect(own(term)).toEqual([
        'buffer',
        'cols',
        'element',
        'highlights',
        'onChange',
        'onData',
        'onLinkActivate',
        'onResize',
        'options',
        'rows',
        'search',
        'viewport',
      ]);
    } finally {
      term.dispose();
    }
  });

  test("a terminal's facades have exactly these members", async () => {
    const term = await opened();
    try {
      // Plain objects, so their own keys are all their members.
      for (const facade of [term.search, term.viewport, term.highlights]) {
        expect(Object.getPrototypeOf(facade)).toBe(Object.prototype);
      }
      expect(own(term.search)).toEqual(['close', 'find', 'onChange', 'state', 'step']);
      expect(own(term.viewport)).toEqual(['followOutput', 'offset', 'reveal', 'scrollBy', 'scrollTo', 'scrollToBottom']);
      expect(own(term.highlights)).toEqual(['clear', 'get', 'set']);
      // The buffer and what it hands out are classes, with their members on
      // their prototypes.
      term.write('hi');
      const line = term.buffer.active.getLine(0)!;
      const readers = { buffer: term.buffer, active: term.buffer.active, line, cell: line.getCell(0)! };
      expect(Object.fromEntries(Object.entries(readers).map(([name, value]) =>
        [name, { own: own(value), prototype: own(Object.getPrototypeOf(value)) }]))).toEqual({
        buffer: { own: [], prototype: ['active', 'alternate', 'constructor', 'normal'] },
        active: { own: [], prototype: ['constructor', 'getLine', 'length', 'type'] },
        line: { own: [], prototype: ['constructor', 'getCell', 'isWrapped', 'length', 'translateToString'] },
        cell: { own: [], prototype: ['constructor', 'getChars', 'getCodepoint', 'getHyperlinkId', 'getWidth'] },
      });
    } finally {
      term.dispose();
    }
  });
});
