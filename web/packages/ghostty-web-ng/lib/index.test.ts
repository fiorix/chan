import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GhosttyVt } from '../vt/ghosttyVt';
import { Terminal } from './terminal';

// The package's public surface, listed whole: the entries' runtime exports
// and a terminal's members. The workspace app's boundary check reads only
// the app, so a back channel the package itself adds (a getter for the raw
// core, a friend module's reader exported from an entry) fails here and
// lands as a reviewed change to these lists.

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
    const module = await WebAssembly.compile(readFileSync('vendor/ghostty-vt/ghostty-vt.wasm'));
    const ghostty = new GhosttyVt(await WebAssembly.instantiate(module, {}));
    const term = new Terminal({ ghostty, cols: 10, rows: 3 });
    const host = document.createElement('div');
    document.body.append(host);
    term.open(host);
    try {
      expect(sorted(Reflect.ownKeys(term))).toEqual([
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
});
