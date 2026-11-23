// The real widget/core with no-pixel canvas and explicitly modelled capture.
// Dispatching on the captured canvas checks lifecycle logic, not native retargeting.
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { GhosttyVt, VtTerminal } from '../vt/ghosttyVt';
import { Terminal } from './terminal';
import { CanvasRenderer } from './renderer';

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
  opened.push(term);
  term.open(host);
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
  test('open, context-menu delay and dispose leave no document or window listeners', async () => {
    // Warm jsdom selectors before recording widget listeners.
    document.querySelector('canvas');
    const doc = vi.spyOn(document, 'addEventListener');
    const win = vi.spyOn(window, 'addEventListener');
    const docRemove = vi.spyOn(document, 'removeEventListener');
    const winRemove = vi.spyOn(window, 'removeEventListener');
    const { term, canvas, textarea } = await open();
    const eventNames = () => doc.mock.calls.map(([name]) => name);
    expect(eventNames()).toEqual([]);
    vi.useFakeTimers();
    canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 30 }));
    expect(textarea.style.pointerEvents).toBe('auto');
    vi.advanceTimersByTime(10);
    expect(eventNames()).toEqual([]);
    expect(win).not.toHaveBeenCalled();
    textarea.blur();
    expect(textarea.style.pointerEvents).toBe('none');
    expect(textarea.style.width).toBe('0px');
    expect(textarea.value).toBe('');
    term.dispose();
    expect(doc.mock.calls.length - docRemove.mock.calls.length).toBe(0);
    expect(win.mock.calls.length - winRemove.mock.calls.length).toBe(0);
  });

  test('a failed open balances document/window listeners and releases its core and host', async () => {
    document.querySelector('canvas');
    const doc = vi.spyOn(document, 'addEventListener');
    const win = vi.spyOn(window, 'addEventListener');
    const docRemove = vi.spyOn(document, 'removeEventListener');
    const winRemove = vi.spyOn(window, 'removeEventListener');
    const ghostty = new GhosttyVt(await WebAssembly.instantiate(module, {}));
    const term = new Terminal({ ghostty });
    const host = document.createElement('div');
    document.body.append(host);
    const remove = vi.spyOn(host, 'removeEventListener');
    const add = vi.spyOn(host, 'addEventListener');
    const create = vi.spyOn(ghostty, 'createTerminal');
    const free = vi.spyOn(VtTerminal.prototype, 'free');
    vi.spyOn(CanvasRenderer.prototype, 'render').mockImplementation(() => { throw new Error('paint failed'); });
    expect(() => term.open(host)).toThrow('paint failed');
    expect(doc.mock.calls.length - docRemove.mock.calls.length).toBe(0);
    expect(win.mock.calls.length - winRemove.mock.calls.length).toBe(0);
    for (const [name, handler, options] of add.mock.calls) {
      const capture = typeof options === 'boolean' ? options : options?.capture ?? false;
      expect(remove.mock.calls.some(([type, listener, opts]) => type === name && listener === handler &&
        (typeof opts === 'boolean' ? opts : opts?.capture ?? false) === capture), name).toBe(true);
    }
    expect(create).toHaveBeenCalledOnce();
    expect(free).toHaveBeenCalledOnce();
    expect(term.wasmTerm).toBeUndefined();
    expect(term.element).toBeUndefined();
    expect(term.renderer).toBeUndefined();
    expect(host.childElementCount).toBe(0);
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

// No compatibility mouse events: canceling a pointerdown suppresses them.
function rawPointer(target: Element, type: string, x: number, y: number, extra: PointerEventInit = {}) {
  const event = new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true,
    button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1,
    clientX: x, clientY: y, ...extra,
  });
  target.dispatchEvent(event);
  return event;
}

async function scrollbar(offset = 12.25) {
  const fixture = await open(history());
  // A second position shows the overlay synchronously; no private animation hook.
  fixture.term.viewport.scrollTo(1);
  fixture.term.viewport.scrollTo(offset);
  const geometry = () => {
    const rect = fixture.canvas.getBoundingClientRect();
    const track = rect.height - 8;
    const thumb = Math.max(20, fixture.term.rows / (fixture.term.rows + fixture.term.getScrollbackLength()) * track);
    return {
      x: rect.right - 8,
      y: rect.top + 4 + (track - thumb) * (1 - fixture.term.viewport.offset / fixture.term.getScrollbackLength()) + thumb / 2,
      rowsPerPixel: fixture.term.getScrollbackLength() / (track - thumb),
    };
  };
  return { ...fixture, geometry };
}

describe('captured scrollbar lifecycle', () => {
  test('dispose cancels the pending scrollbar animation as well as the render loop', async () => {
    let id = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame));
    const { term } = await open(history());
    term.viewport.scrollTo(2);
    expect(frames.size).toBe(2);
    term.dispose();
    expect(frames.size).toBe(0);
  });

  test('a new pointer can start a thumb after the previous capture silently disappears', async () => {
    const { term, canvas, captured, geometry } = await scrollbar();
    const { x, y } = geometry();
    rawPointer(canvas, 'pointerdown', x, y);
    captured.clear();
    const before = term.viewport.offset;
    rawPointer(canvas, 'pointerdown', x, y, { pointerId: 8 });
    rawPointer(canvas, 'pointermove', x, y - 5, { pointerId: 8 });
    expect(term.viewport.offset).toBeGreaterThan(before);
    expect(canvas.hasPointerCapture(8)).toBe(true);
  });

  test.each(['mouse', 'pen'])('%s thumb uses pointer moves, keeps fractional offsets and restores styles', async (pointerType) => {
    const { term, canvas, capture, release, write, geometry } = await scrollbar();
    canvas.style.userSelect = 'text';
    canvas.style.webkitUserSelect = 'text';
    const { x, y, rowsPerPixel } = geometry();
    const before = term.viewport.offset;
    const press = rawPointer(canvas, 'pointerdown', x, y, { pointerType });
    expect(press.defaultPrevented).toBe(true);
    expect(capture).toHaveBeenCalledExactlyOnceWith(7);
    expect(canvas.style.userSelect).toBe('none');
    rawPointer(canvas, 'pointermove', x, y - 2.5, { pointerType });
    expect(term.viewport.offset).toBeCloseTo(before + 2.5 * rowsPerPixel);
    rawPointer(canvas, 'pointerup', x, y - 2.5, { pointerType });
    expect(release).toHaveBeenCalledExactlyOnceWith(7);
    expect(canvas.style.userSelect).toBe('text');
    expect(canvas.style.webkitUserSelect).toBe('text');
    expect(write).not.toHaveBeenCalled();
  });

  test.each(['pointerup', 'pointercancel', 'lostpointercapture', 'dispose'])('%s ends the thumb once and ignores later movement', async (end) => {
    const { term, canvas, release, geometry } = await scrollbar();
    const { x, y } = geometry();
    rawPointer(canvas, 'pointerdown', x, y);
    rawPointer(canvas, 'pointermove', x, y - 5);
    expect(canvas.style.userSelect).toBe('none');
    if (end === 'dispose') term.dispose(); else rawPointer(canvas, end, x, y - 5);
    const offset = term.viewport.offset;
    rawPointer(canvas, 'lostpointercapture', x, y - 5);
    rawPointer(canvas, 'pointermove', x, y - 10);
    rawPointer(canvas, 'pointerup', x, y - 10);
    expect(term.viewport.offset).toBe(offset);
    expect(release).toHaveBeenCalledExactlyOnceWith(7);
    expect(canvas.style.userSelect).toBe('');
    expect(canvas.style.webkitUserSelect).toBe('');
  });

  test.each(['detached', 'reattached', 'uncaptured'])('%s host cannot continue a stale thumb', async (state) => {
    const { term, host, canvas, captured, geometry } = await scrollbar();
    const { x, y } = geometry();
    rawPointer(canvas, 'pointerdown', x, y);
    expect(canvas.style.userSelect).toBe('none');
    if (state !== 'uncaptured') host.remove();
    if (state === 'reattached') document.body.append(host);
    if (state !== 'detached') captured.clear();
    const before = term.viewport.offset;
    rawPointer(canvas, 'pointermove', x, y - 10);
    expect(term.viewport.offset).toBe(before);
    expect(canvas.style.userSelect).toBe('');
    document.body.append(host);
    rawPointer(canvas, 'pointerup', x, y);
    const fresh = geometry();
    rawPointer(canvas, 'pointerdown', fresh.x, fresh.y);
    rawPointer(canvas, 'pointermove', fresh.x, fresh.y - 3);
    expect(term.viewport.offset).toBeGreaterThan(before);
  });

  test.each([{ pointerId: 8 }, { pointerType: 'pen' }, { pointerType: 'touch' }, { isPrimary: false }])('unrelated %j cannot replace, move or end a thumb', async (extra) => {
    const { term, canvas, release, geometry } = await scrollbar();
    const { x, y } = geometry();
    rawPointer(canvas, 'pointerdown', x, y);
    expect(canvas.style.userSelect).toBe('none');
    const before = term.viewport.offset;
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      rawPointer(canvas, type, x, y - 10, extra);
    }
    expect(term.viewport.offset).toBe(before);
    expect(release).not.toHaveBeenCalled();
    rawPointer(canvas, 'pointermove', x, y - 5, { buttons: 0 });
    expect(term.viewport.offset).toBeGreaterThan(before);
    rawPointer(canvas, 'pointerup', x, y - 5);
    expect(release).toHaveBeenCalledExactlyOnceWith(7);
  });

  test.each([{ pointerType: 'touch' }, { isPrimary: false }, { button: 1, buttons: 4 }, { button: 2, buttons: 2 }])('non-thumb press %j leaves the strip unclaimed', async (extra) => {
    const { term, canvas, geometry } = await scrollbar();
    const { x, y } = geometry();
    const before = term.viewport.offset;
    const event = rawPointer(canvas, 'pointerdown', x, y, extra);
    rawPointer(canvas, 'pointermove', x, y - 10, { ...extra, button: -1 });
    expect(event.defaultPrevented).toBe(false);
    expect(canvas.style.userSelect).not.toBe('none');
    expect(term.viewport.offset).toBe(before);
  });

  test.each(['throw', 'false'])('capture failure (%s) abandons the thumb without losing selection', async (failure) => {
    const { term, canvas, captured, capture, release, geometry, write } = await scrollbar();
    term.select(0, 0, 4);
    const selected = term.getSelection();
    const { x, y } = geometry();
    const before = term.viewport.offset;
    capture.mockImplementation(() => { if (failure === 'throw') throw new Error('unavailable'); return captured; });
    rawPointer(canvas, 'pointerdown', x, y);
    expect(capture).toHaveBeenCalledExactlyOnceWith(7);
    rawPointer(canvas, 'pointermove', x, y - 10);
    rawPointer(canvas, 'pointerup', x, y - 10);
    expect(term.viewport.offset).toBe(before);
    expect(term.getSelection()).toBe(selected);
    expect(canvas.style.userSelect).not.toBe('none');
    expect(release).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  test.each(['hidden', 'no history'])('%s strip remains selectable content', async (state) => {
    const line = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    const { term, canvas, width, height, write } = await open(state === 'hidden' ? `${history()}\r\n${line}` : line);
    if (state === 'hidden') expect(term.getScrollbackLength()).toBeGreaterThan(0);
    const y = state === 'hidden' ? (ROWS - 1) * height + 1 : 1;
    const x = COLS * width - 8;
    expect(rawPointer(canvas, 'pointerdown', x, y).defaultPrevented).toBe(false);
    rawPointer(canvas, 'pointermove', x - 24, y);
    rawPointer(canvas, 'pointerup', x - 24, y);
    expect(term.getSelection()).toBe('ABCD');
    expect(write).toHaveBeenCalledExactlyOnceWith('ABCD');
  });

  test('a visible track press prevents selection and bubbles to page closers', async () => {
    const { term, host, canvas, capture, write, geometry } = await scrollbar();
    const pagePress = vi.fn();
    host.addEventListener('pointerdown', pagePress);
    const { x } = geometry();
    const press = rawPointer(canvas, 'pointerdown', x, 5);
    rawPointer(canvas, 'pointerup', x, 5);
    expect(press.defaultPrevented).toBe(true);
    expect(pagePress).toHaveBeenCalledOnce();
    expect(term.viewport.offset).toBeGreaterThan(30);
    expect(term.hasSelection()).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  test.each(['top', 'bottom'])('the %s clamp rebases overshoot and reverses immediately', async (end) => {
    const { term, canvas, geometry } = await scrollbar();
    const { x, y, rowsPerPixel } = geometry();
    rawPointer(canvas, 'pointerdown', x, y);
    const overshoot = end === 'top' ? -500 : 500;
    rawPointer(canvas, 'pointermove', x, overshoot);
    const bound = end === 'top' ? term.getScrollbackLength() : 0;
    expect(term.viewport.offset).toBe(bound);
    rawPointer(canvas, 'pointermove', x, overshoot + (end === 'top' ? 2 : -2));
    expect(term.viewport.offset).toBeCloseTo(bound + (end === 'top' ? -2 : 2) * rowsPerPixel);
  });

  test.each(['top', 'bottom'])('output after %s overshoot rebases before a zero-delta move and reversal', async (end) => {
    const { term, canvas, geometry } = await scrollbar();
    const { x, y } = geometry();
    rawPointer(canvas, 'pointerdown', x, y);
    const overshoot = end === 'top' ? -500 : 500;
    rawPointer(canvas, 'pointermove', x, overshoot);
    const before = term.viewport.offset;
    term.write('\r\nstreamed row');
    const anchored = end === 'top' ? before + 1 : 0;
    expect(term.viewport.offset).toBe(anchored);
    rawPointer(canvas, 'pointermove', x, overshoot);
    expect(term.viewport.offset).toBe(anchored);
    rawPointer(canvas, 'pointermove', x, overshoot + (end === 'top' ? 2 : -2));
    expect(term.viewport.offset).toBeCloseTo(anchored + (end === 'top' ? -2 : 2) * geometry().rowsPerPixel);
  });

  test.each([0, 12.25, 34])('output at offset %s stays anchored on a zero-delta thumb move', async (offset) => {
    const { term, canvas, geometry } = await scrollbar(offset);
    const { x, y } = geometry();
    rawPointer(canvas, 'pointerdown', x, y);
    expect(canvas.style.userSelect).toBe('none');
    term.write('\r\nstreamed row');
    const anchored = term.viewport.offset;
    expect(anchored).toBe(offset < 1 ? offset : offset + 1);
    rawPointer(canvas, 'pointermove', x, y);
    expect(term.viewport.offset).toBe(anchored);
    const { rowsPerPixel } = geometry();
    rawPointer(canvas, 'pointermove', x, y + 1);
    expect(term.viewport.offset).toBeCloseTo(Math.max(0, anchored - rowsPerPixel));
  });

  test('a track with no travel never produces an infinite or reversed offset', async () => {
    const { term, canvas, capture } = await scrollbar();
    term.resize(COLS, 1);
    term.viewport.scrollTo(8.25);
    const before = term.viewport.offset;
    rawPointer(canvas, 'pointerdown', COLS * 8 - 8, 8);
    expect(capture).toHaveBeenCalledExactlyOnceWith(7);
    rawPointer(canvas, 'pointermove', COLS * 8 - 8, 12);
    expect(term.viewport.offset).toBe(before);
  });

  test('a thumb owns buttonless captured moves even in all-motion reporting mode', async () => {
    const { term, canvas, reports, geometry } = await scrollbar();
    term.write('\x1b[?1003h\x1b[?1006h');
    const { x, y } = geometry();
    const before = term.viewport.offset;
    rawPointer(canvas, 'pointerdown', x, y);
    rawPointer(canvas, 'pointermove', x, y - 4, { buttons: 0 });
    rawPointer(canvas, 'pointerup', x, y - 4);
    expect(term.viewport.offset).toBeGreaterThan(before);
    expect(reports).toEqual([]);
  });
});
