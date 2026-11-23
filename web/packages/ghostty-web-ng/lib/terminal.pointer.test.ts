// The real widget/core with no-pixel canvas and explicitly modelled capture.
// Dispatching on the captured canvas checks lifecycle logic, not native retargeting.
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { GhosttyVt } from '../vt/ghosttyVt';
import { Terminal } from './terminal';

let module: WebAssembly.Module;
const opened: Terminal[] = [];
const COLS = 40;
const ROWS = 6;

beforeAll(async () => {
  module = await WebAssembly.compile(readFileSync('vendor/ghostty-vt/ghostty-vt.wasm'));
});
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
  for (const term of opened.splice(0)) term.dispose();
  vi.useRealTimers();
  document.body.replaceChildren();
  delete (navigator as { clipboard?: unknown }).clipboard;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function pointer(target: Element, type: string, x = 1, y = 1, extra: PointerEventInit = {}) {
  const init: PointerEventInit = {
    bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true,
    button: type === 'pointermove' ? -1 : 0,
    buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
    clientX: x, clientY: y, ...extra,
  };
  target.dispatchEvent(new PointerEvent(type, init));
  // Browsers emit compatibility mouse events after the pointer event.
  const compat = { pointerdown: 'mousedown', pointermove: 'mousemove', pointerup: 'mouseup' }[type];
  if (compat) target.dispatchEvent(new MouseEvent(compat, init));
}

async function open(input = 'hello world\r\nsecond row') {
  const ghostty = new GhosttyVt(await WebAssembly.instantiate(module, {}));
  const term = new Terminal({ ghostty, cols: COLS, rows: ROWS, cursorBlink: false, smoothScrollDuration: 0 });
  const host = document.createElement('div');
  document.body.append(host);
  term.open(host);
  opened.push(term);
  const canvas = host.querySelector('canvas')!;
  const textarea = host.querySelector('textarea')!;
  const captured = new Set<number>();
  const capture = vi.fn((id: number) => captured.add(id));
  const release = vi.fn((id: number) => captured.delete(id));
  Object.assign(canvas, {
    setPointerCapture: capture,
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: release,
  });
  const { width, height } = term.renderer!.getMetrics();
  vi.spyOn(canvas, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, term.cols * width, term.rows * height));
  const write = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } });
  const reports: string[] = [];
  term.onData((data) => reports.push(data));
  term.write(input);
  return { term, host, canvas, textarea, captured, capture, release, width, height, write, reports };
}

function drag(canvas: Element, extra: PointerEventInit = {}) {
  pointer(canvas, 'pointerdown', 1, 1, extra);
  pointer(canvas, 'pointermove', 33, 1, extra);
}

function history() { return Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\r\n'); }

describe('captured selection lifecycle', () => {
  test('captures the active id and releases it exactly once after copying', async () => {
    const { term, canvas, capture, release, write } = await open();
    drag(canvas);
    expect(capture).toHaveBeenCalledExactlyOnceWith(7);
    expect(term.getSelection()).toBe('hello');
    pointer(canvas, 'pointerup', 33, 1);
    pointer(canvas, 'lostpointercapture');
    pointer(canvas, 'pointerup', 33, 1);
    expect(write).toHaveBeenCalledExactlyOnceWith('hello');
    expect(release).toHaveBeenCalledExactlyOnceWith(7);
  });

  test('outside captured moves select complete edge rows', async () => {
    const { term, canvas, height, write } = await open(['hello world', '', '', '', '', 'last row here'].join('\r\n'));
    pointer(canvas, 'pointerdown', 161, 1);
    pointer(canvas, 'pointermove', 161, -50);
    pointer(canvas, 'pointerup', 161, -50);
    expect(term.getSelection()).toBe('hello world');
    pointer(canvas, 'pointerdown', 17, 1);
    pointer(canvas, 'pointermove', 17, ROWS * height + 50);
    pointer(canvas, 'pointerup', 17, ROWS * height + 50);
    expect(term.getSelection()).toMatch(/^llo world\n(\n*)last row here$/);
    expect(write).toHaveBeenCalledTimes(2);
  });

  test('an outside page click leaves the selection in place', async () => {
    const { term, canvas } = await open();
    drag(canvas);
    pointer(canvas, 'pointerup', 33, 1);
    const sibling = document.createElement('button');
    document.body.append(sibling);
    pointer(sibling, 'pointerdown');
    pointer(sibling, 'pointerup');
    sibling.click();
    expect(term.getSelection()).toBe('hello');
  });

  test.each([3, 4, 5])('the drag threshold at %i pixels is half a cell', async (distance) => {
    const { term, canvas, write } = await open();
    pointer(canvas, 'pointerdown');
    pointer(canvas, 'pointermove', 1 + distance, 1);
    pointer(canvas, 'pointerup', 1 + distance, 1);
    expect(term.hasSelection()).toBe(distance >= 4);
    expect(write).toHaveBeenCalledTimes(distance >= 4 ? 1 : 0);
  });

  test.each([
    { pointerId: 8 }, { pointerType: 'pen' }, { pointerType: 'touch' }, { isPrimary: false },
  ])('unrelated events cannot move, replace or end a gesture: %j', async (other) => {
    const { term, canvas, release, write } = await open();
    drag(canvas);
    pointer(canvas, 'pointerdown', 65, 17, other);
    for (const type of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      pointer(canvas, type, 100, 17, other);
    }
    expect(term.getSelection()).toBe('hello');
    expect(release).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    pointer(canvas, 'pointermove', 81, 1);
    pointer(canvas, 'pointerup', 81, 1);
    expect(write).toHaveBeenCalledExactlyOnceWith('hello world');
  });

  test.each([
    { pointerType: 'touch' }, { isPrimary: false }, { button: 1, buttons: 4 }, { button: 2, buttons: 2 },
  ])('non-selection presses preserve the prior selection: %j', async (extra) => {
    const { term, canvas, write } = await open();
    drag(canvas);
    pointer(canvas, 'pointerup', 33, 1);
    write.mockClear();
    pointer(canvas, 'pointerdown', 65, 17, extra);
    pointer(canvas, 'pointermove', 100, 17, { ...extra, button: -1 });
    pointer(canvas, 'pointerup', 100, 17, { ...extra, buttons: 0 });
    expect(term.getSelection()).toBe('hello');
    expect(write).not.toHaveBeenCalled();
  });

  test('a primary pen selects and copies', async () => {
    const { canvas, write } = await open();
    drag(canvas, { pointerType: 'pen' });
    pointer(canvas, 'pointerup', 33, 1, { pointerType: 'pen' });
    expect(write).toHaveBeenCalledExactlyOnceWith('hello');
  });

  test('a prevented press preserves selection and acquires no capture', async () => {
    const { term, host, canvas, capture } = await open();
    drag(canvas);
    pointer(canvas, 'pointerup', 33, 1);
    capture.mockClear();
    host.addEventListener('pointerdown', (e) => e.preventDefault(), { capture: true });
    drag(canvas);
    pointer(canvas, 'pointerup', 33, 1);
    expect(capture).not.toHaveBeenCalled();
    expect(term.getSelection()).toBe('hello');
  });

  test.each(['throw', 'false'])('capture acquisition failure (%s) leaves prior selection and no gesture', async (failure) => {
    const { term, canvas, capture, captured, release, write, reports } = await open();
    drag(canvas);
    pointer(canvas, 'pointerup', 33, 1);
    write.mockClear(); release.mockClear();
    capture.mockImplementation(() => { if (failure === 'throw') throw new Error('capture unavailable'); return captured; });
    term.write('\x1b[?1002h\x1b[?1006h');
    pointer(canvas, 'pointerdown', 65, 17, { shiftKey: true });
    pointer(canvas, 'pointermove', 100, -40);
    pointer(canvas, 'pointerup', 100, -40);
    expect(term.getSelection()).toBe('hello');
    expect(write).not.toHaveBeenCalled();
    expect(reports).toEqual([]);
    expect(release).not.toHaveBeenCalled();
    capture.mockImplementation((id) => captured.add(id));
    pointer(canvas, 'pointerdown'); pointer(canvas, 'pointerup');
    expect(reports).toEqual(['\x1b[<0;1;1M', '\x1b[<0;1;1m']);
  });

  test.each(['pointercancel', 'dispose'])('%s stops scrolling, releases capture and never copies', async (end) => {
    const { term, canvas, height, release, write } = await open(history());
    term.viewport.scrollTo(8);
    vi.useFakeTimers();
    pointer(canvas, 'pointerdown'); pointer(canvas, 'pointermove', 1, ROWS * height + 50);
    vi.advanceTimersByTime(50);
    expect(term.viewport.offset).toBe(5);
    if (end === 'dispose') term.dispose(); else pointer(canvas, end);
    pointer(canvas, 'lostpointercapture'); pointer(canvas, 'pointerup');
    vi.advanceTimersByTime(150);
    expect(term.viewport.offset).toBe(5);
    expect(write).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledExactlyOnceWith(7);
  });

  test('a cancelled selection keeps its text without copying on a late loss or release', async () => {
    const { term, canvas, write, release } = await open();
    drag(canvas);
    expect(term.getSelection()).toBe('hello');
    pointer(canvas, 'pointercancel'); pointer(canvas, 'lostpointercapture'); pointer(canvas, 'pointerup', 33, 1);
    expect(term.getSelection()).toBe('hello');
    expect(write).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledExactlyOnceWith(7);
  });

  test('unexpected connected loss copies once even if tracking changes after the press', async () => {
    const { canvas, term, captured, write } = await open();
    drag(canvas);
    term.write('\x1b[?1000h');
    captured.clear();
    pointer(canvas, 'lostpointercapture'); pointer(canvas, 'pointerup', 33, 1);
    expect(write).toHaveBeenCalledExactlyOnceWith('hello');
  });

  test.each(['detached', 'reattached', 'uncaptured'])('%s auto-scroll stops silently and ignores late release', async (state) => {
    const { term, host, canvas, height, captured, write } = await open(history());
    term.viewport.scrollTo(8);
    vi.useFakeTimers();
    pointer(canvas, 'pointerdown'); pointer(canvas, 'pointermove', 1, ROWS * height + 50);
    vi.advanceTimersByTime(50);
    expect(term.viewport.offset).toBe(5);
    if (state !== 'uncaptured') host.remove();
    if (state === 'reattached') document.body.append(host);
    if (state !== 'detached') captured.clear();
    vi.advanceTimersByTime(150);
    pointer(canvas, 'pointerup'); pointer(canvas, 'lostpointercapture');
    expect(term.viewport.offset).toBe(5);
    expect(write).not.toHaveBeenCalled();
  });

  test('buttonless moves retain a captured selection, silent loss stops it without copy', async () => {
    const { term, canvas, captured, write } = await open();
    drag(canvas);
    pointer(canvas, 'pointermove', 81, 1, { buttons: 0 });
    expect(term.getSelection()).toBe('hello world');
    captured.clear();
    pointer(canvas, 'pointermove', 33, 17, { buttons: 0 });
    pointer(canvas, 'pointerup');
    expect(term.getSelection()).toBe('hello world');
    expect(write).not.toHaveBeenCalled();
  });
});

describe('report and bypass completion', () => {
  test.each([0, 1, 2])('a reported button %i releases outside once, with no held-button motion left', async (button) => {
    const { term, canvas, reports, write } = await open();
    term.write('\x1b[?1002h\x1b[?1006h');
    pointer(canvas, 'pointerdown', 1, 1, { button, buttons: [1, 4, 2][button] });
    pointer(canvas, 'pointermove', 999, 999, { buttons: [1, 4, 2][button] });
    pointer(canvas, 'pointerup', 999, 999, { button, shiftKey: true });
    pointer(canvas, 'pointermove', 1, 1, { buttons: 0 });
    expect(reports).toEqual([`\x1b[<${button};1;1M`, `\x1b[<${32 + button};40;6M`, `\x1b[<${4 + button};40;6m`]);
    expect(write).not.toHaveBeenCalled();
  });

  test.each([0, 1, 2])('a Shift bypass for button %i ends outside after Shift is released', async (button) => {
    const { term, canvas, reports, write } = await open();
    term.write('\x1b[?1003h\x1b[?1006h');
    pointer(canvas, 'pointerdown', 1, 1, { button, buttons: [1, 4, 2][button], shiftKey: true });
    pointer(canvas, 'pointermove', 33, 1, { buttons: [1, 4, 2][button] });
    pointer(canvas, 'pointerup', 33, 1, { button });
    expect(reports).toEqual([]);
    expect(write).toHaveBeenCalledTimes(button === 0 ? 1 : 0);
    pointer(canvas, 'pointermove', 1, 1, { buttons: 0 });
    expect(reports).toEqual(['\x1b[<32;1;1M']);
  });

  test.each(['pointercancel', 'lostpointercapture'])('a report-only %s leaves no held button or copy', async (end) => {
    const { term, canvas, reports, write } = await open();
    term.write('\x1b[?1002h\x1b[?1006h');
    drag(canvas);
    pointer(canvas, end);
    reports.length = 0;
    pointer(canvas, 'pointermove', 1, 1, { buttons: 0 }); pointer(canvas, 'pointerup');
    expect(reports).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });

  test('a terminal-owned press stays bypassed if tracking starts during its drag', async () => {
    const { term, canvas, reports, write } = await open();
    pointer(canvas, 'pointerdown');
    term.write('\x1b[?1003h\x1b[?1006h');
    pointer(canvas, 'pointermove', 33, 1);
    pointer(canvas, 'pointerup', 33, 1);
    expect(reports).toEqual([]);
    expect(write).toHaveBeenCalledExactlyOnceWith('hello');
  });

  test('a reported press stays reported if tracking stops during its drag', async () => {
    const { term, canvas, reports, write } = await open();
    term.write('\x1b[?1000h\x1b[?1006h');
    pointer(canvas, 'pointerdown');
    term.write('\x1b[?1000l');
    pointer(canvas, 'pointermove', 33, 1);
    pointer(canvas, 'pointerup', 33, 1);
    expect(reports).toEqual(['\x1b[<0;1;1M', '\x1b[<0;5;1m']);
    expect(write).not.toHaveBeenCalled();
  });

  test('a Shift selection copies once on connected capture loss', async () => {
    const { term, canvas, captured, reports, write } = await open();
    term.write('\x1b[?1000h\x1b[?1006h');
    pointer(canvas, 'pointerdown', 1, 1, { shiftKey: true });
    pointer(canvas, 'pointermove', 33, 1);
    captured.clear();
    pointer(canvas, 'lostpointercapture'); pointer(canvas, 'pointerup', 33, 1);
    expect(write).toHaveBeenCalledExactlyOnceWith('hello');
    expect(reports).toEqual([]);
  });

  test('chorded buttons retain each press disposition without duplicate motion or releases', async () => {
    const { term, canvas, reports } = await open();
    term.write('\x1b[?1002h\x1b[?1006h');
    pointer(canvas, 'pointerdown');
    pointer(canvas, 'pointermove', 1, 1, { button: 2, buttons: 3, shiftKey: true });
    pointer(canvas, 'pointermove', 1, 1, { buttons: 3 });
    pointer(canvas, 'pointermove', 1, 1, { button: 2, buttons: 1 });
    pointer(canvas, 'pointermove', 1, 1);
    pointer(canvas, 'pointerup');
    expect(reports).toEqual(['\x1b[<0;1;1M', '\x1b[<32;1;1M', '\x1b[<0;1;1m']);
    reports.length = 0;
    pointer(canvas, 'pointerdown');
    pointer(canvas, 'pointermove', 1, 1, { button: 2, buttons: 3 });
    pointer(canvas, 'pointermove', 1, 1, { button: 0, buttons: 2, shiftKey: true });
    pointer(canvas, 'pointerup', 1, 1, { button: 2 });
    expect(reports).toEqual(['\x1b[<0;1;1M', '\x1b[<2;1;1M', '\x1b[<4;1;1m', '\x1b[<2;1;1m']);
  });

  test('a fresh press replaces stale bypass and reads live grid dimensions', async () => {
    const { term, canvas, reports } = await open();
    term.write('\x1b[?1002h\x1b[?1006h');
    pointer(canvas, 'pointerdown', 1, 1, { shiftKey: true });
    pointer(canvas, 'pointerdown');
    term.resize(20, 4);
    pointer(canvas, 'pointermove', 999, 999);
    pointer(canvas, 'pointerup', 999, 999);
    expect(reports).toEqual(['\x1b[<0;1;1M', '\x1b[<32;20;4M', '\x1b[<0;20;4m']);
  });
});

describe('scoped context menu and click selection', () => {
  test('only the existing scrollbar mouseup listener remains global', async () => {
    // Warm jsdom selectors before recording widget listeners.
    document.querySelector('canvas');
    const doc = vi.spyOn(document, 'addEventListener');
    const win = vi.spyOn(window, 'addEventListener');
    const { canvas, textarea } = await open();
    const eventNames = () => doc.mock.calls.map(([name]) => name);
    expect(eventNames()).toEqual(['mouseup']);
    vi.useFakeTimers();
    canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 30 }));
    expect(textarea.style.pointerEvents).toBe('auto');
    vi.advanceTimersByTime(10);
    expect(eventNames()).toEqual(['mouseup']);
    expect(win).not.toHaveBeenCalled();
    textarea.blur();
    expect(textarea.style.pointerEvents).toBe('none');
    expect(textarea.style.width).toBe('0px');
    expect(textarea.value).toBe('');
  });

  test.each(['pointerdown', 'dispose'])('context menu reset on %s cancels pending cleanup', async (end) => {
    const { term, canvas, textarea } = await open();
    vi.useFakeTimers();
    canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    if (end === 'dispose') term.dispose(); else pointer(canvas, 'pointerdown');
    vi.advanceTimersByTime(20);
    expect(textarea.style.pointerEvents).toBe('none');
    expect(textarea.style.width).toBe('0px');
    expect(textarea.value).toBe('');
  });

  test.each([2, 3])('click count %i retains word and line selection', async (detail) => {
    const { term, canvas, write } = await open();
    pointer(canvas, 'pointerdown', 57, 1); pointer(canvas, 'pointerup', 57, 1);
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, detail, clientX: 57, clientY: 1 }));
    expect(term.getSelection()).toBe(detail === 2 ? 'world' : 'hello world');
    expect(write).toHaveBeenCalledTimes(1);
  });
  test('a reporting double click cannot copy after tracking is switched off', async () => {
    const { term, canvas, write } = await open();
    term.write('\x1b[?1000h\x1b[?1006h');
    pointer(canvas, 'pointerdown', 57, 1); pointer(canvas, 'pointerup', 57, 1);
    term.write('\x1b[?1000l');
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2, clientX: 57, clientY: 1 }));
    expect(write).not.toHaveBeenCalled();
  });

  test('real pointer and compatibility ordering keeps link activation and word selection', async () => {
    const { term, canvas, write } = await open('https://example.com');
    const activated: string[] = [];
    term.onLinkActivate((link) => activated.push(link.target));
    const click = (detail: number) => canvas.dispatchEvent(new MouseEvent('click', {
      bubbles: true, detail, clientX: 17, clientY: 1,
    }));
    pointer(canvas, 'pointerdown', 17, 1); pointer(canvas, 'pointerup', 17, 1); click(1);
    await vi.waitFor(() => expect(activated).toEqual(['https://example.com']));
    activated.length = 0;
    pointer(canvas, 'pointerdown', 17, 1); pointer(canvas, 'pointermove', 81, 1);
    pointer(canvas, 'pointerup', 81, 1);
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 81, clientY: 1 }));
    pointer(canvas, 'pointerdown', 17, 1); pointer(canvas, 'pointerup', 17, 1); click(2);
    expect(write).toHaveBeenCalledTimes(2);
    expect(activated).toEqual([]);
    term.write('\x1b[?1000h');
    pointer(canvas, 'pointerdown', 17, 1, { shiftKey: true });
    pointer(canvas, 'pointerup', 17, 1); click(1);
    await vi.waitFor(() => expect(activated).toEqual(['https://example.com']));
  });

  test('a link press retains its reporting disposition before synchronous input listeners run', async () => {
    const { term, canvas, reports } = await open('https://example.com');
    const activated: string[] = [];
    term.onLinkActivate((link) => activated.push(link.target));
    term.write('\x1b[?1000h\x1b[?1006h');
    term.onData(() => term.write('\x1b[?1000l'));
    pointer(canvas, 'pointerdown', 17, 1); pointer(canvas, 'pointerup', 17, 1);
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 17, clientY: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports).toEqual(['\x1b[<0;3;1M', '\x1b[<0;3;1m']);
    expect(activated).toEqual([]);
  });

});
