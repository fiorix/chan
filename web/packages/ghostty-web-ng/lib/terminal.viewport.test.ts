import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { GhosttyVt } from '../vt/ghosttyVt';
import { terminalInternals } from '../vt/internal';
import { widgetInternals } from './internal';
import { LinkDetector } from './link-detector';
import { UrlRegexProvider } from './providers/url-regex-provider';
import type { CanvasRenderer } from './renderer';
import { Terminal } from './terminal';
import type { ILink } from './types';

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

// Real parsing and history, with only the browser paint surface replaced.
// The app integration suites open the widget against a software canvas.
async function terminal(rows = 6) {
  const ghostty = new GhosttyVt(await WebAssembly.instantiate(module, {}));
  const term = new Terminal({ ghostty, cols: 40, rows, smoothScrollDuration: 0 });
  const renderer = {
    render: vi.fn(),
    resize: vi.fn(),
    getMetrics: () => ({ width: 8, height: 16, baseline: 12 }),
    dispose: vi.fn(),
  };
  const internals = widgetInternals(term);
  internals.wasmTerm = ghostty.createTerminal(40, rows, { scrollbackLimit: 1000 });
  internals.renderer = renderer as unknown as CanvasRenderer;
  internals.canvas = document.createElement('canvas');
  internals.isOpen = true;
  terminals.push(term);
  return { term, renderer };
}

async function history(rows = 6) {
  const fixture = await terminal(rows);
  fixture.term.write(Array.from({ length: 40 }, (_, n) => `line ${n}\r\n`).join(''));
  expect(fixture.term.getScrollbackLength()).toBeGreaterThan(20);
  expect(fixture.term.viewport, 'the widget owns an explicit viewport').toBeDefined();
  return fixture;
}

describe('cursor position', () => {
  test('reads synchronous live-screen coordinates across writes, moves and lifecycle changes', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => new Proxy({}, {
      get: (_, key) => key === 'measureText'
        ? () => ({ width: 8, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 4 })
        : () => undefined,
      set: () => true,
    })) as never);
    const ghostty = new GhosttyVt(await WebAssembly.instantiate(module, {}));
    const term = new Terminal({ ghostty, cols: 40, rows: 6, smoothScrollDuration: 0 });
    terminals.push(term);
    expect(term.getCursor()).toBeUndefined();
    term.open(document.createElement('div'));
    expect(term.getCursor()).toEqual({ x: 0, y: 0 });
    term.write('hello\r\nworld');
    const written = term.getCursor();
    expect(written).toEqual({ x: 5, y: 1 });
    term.write('\x1b[4;8H');
    expect(term.getCursor()).toEqual({ x: 7, y: 3 });
    expect(written).toEqual({ x: 5, y: 1 });
    term.write(Array.from({ length: 20 }, () => '\r\nline').join(''));
    term.viewport.scrollTo(5);
    expect(term.viewport.offset).toBe(5);
    expect(term.getCursor()).toEqual({ x: 4, y: 5 });
    term.write('\x1b[?1049h\x1b[2;10Halt');
    expect(term.getCursor()).toEqual({ x: 12, y: 1 });
    term.write('\x1b[?1049l');
    expect(term.getCursor()).toEqual({ x: 4, y: 5 });
    term.dispose();
    expect(term.getCursor()).toBeUndefined();
  });
});

describe('viewport positioning', () => {
  test('offset counts fractional rows back from the bottom and clamps to history', async () => {
    const { term } = await history();
    expect(term.viewport.followOutput).toBe('at-bottom');
    term.viewport.scrollTo(7.25);
    expect(term.viewport.offset).toBe(7.25);
    expect(term.getViewportY()).toBe(7.25);
    term.viewport.scrollBy(1.5);
    expect(term.viewport.offset).toBe(8.75);
    term.viewport.scrollBy(-2);
    expect(term.viewport.offset).toBe(6.75);
    term.viewport.scrollTo(-1);
    expect(term.viewport.offset).toBe(0);
    term.viewport.scrollTo(1e6);
    expect(term.viewport.offset).toBe(term.getScrollbackLength());
    term.viewport.scrollToBottom();
    expect(term.viewport.offset).toBe(0);
  });

  test.each([0, 0.3, 0.999])('output follows at offset %s without discarding its fraction', async (offset) => {
    const { term } = await history();
    term.viewport.scrollTo(offset);
    const before = term.getScrollbackLength();
    term.write('first\r\n');
    term.write(new TextEncoder().encode('second\r\n'));
    expect(term.getScrollbackLength()).toBe(before + 2);
    expect(term.viewport.offset).toBe(offset);
  });

  test.each([1, 1.5, 7])('output keeps offset %s anchored to its rows', async (offset) => {
    const { term } = await history();
    term.viewport.scrollTo(offset);
    const before = term.getScrollbackLength();
    const top = before - Math.floor(offset);
    const first = term.buffer.active.getLine(top)?.translateToString(true);
    term.write('first\r\nsecond\r\n');
    expect(term.viewport.offset).toBe(offset + 2);
    expect(term.getScrollbackLength() - Math.floor(term.viewport.offset)).toBe(top);
    expect(term.buffer.active.getLine(top)?.translateToString(true)).toBe(first);
  });

  test('a slow gesture can leave the bottom while output streams', async () => {
    const { term } = await history();
    for (let n = 1; n <= 5; n++) {
      term.viewport.scrollBy(0.2);
      term.write('next\r\n');
      if (n < 5) expect(Math.floor(term.viewport.offset)).toBe(0);
    }
    expect(term.viewport.offset).toBe(2);
    term.write('last\r\n');
    expect(term.viewport.offset).toBe(3);
  });

  test('an in-place redraw preserves an anchor and a history clear clamps it', async () => {
    const { term } = await history();
    term.viewport.scrollTo(7.5);
    term.write('\rredraw');
    expect(term.viewport.offset).toBe(7.5);
    term.write('\x1b[3J');
    expect(term.getScrollbackLength()).toBe(0);
    expect(term.viewport.offset).toBe(0);
  });

  test.each(['start', 'center', 'end'] as const)('reveal aligns an offscreen absolute row at %s', async (align) => {
    const { term } = await history(10);
    const row = 12;
    term.viewport.reveal(row, align);
    const displayedRow = row - term.getScrollbackLength() + Math.floor(term.viewport.offset);
    expect(displayedRow).toBe(align === 'start' ? 0 : align === 'center' ? 5 : 9);
    const offset = term.viewport.offset;
    term.viewport.reveal(row, align);
    expect(term.viewport.offset).toBe(offset);
  });

  test.each(['start', 'center', 'end'] as const)('reveal preserves a visible row away from requested %s alignment', async (align) => {
    const { term } = await history(10);
    term.viewport.scrollTo(7.5);
    const row = term.getScrollbackLength() - 7 + 2;
    expect(row - term.getScrollbackLength() + Math.floor(term.viewport.offset)).toBe(2);
    term.viewport.reveal(row, align);
    expect(term.viewport.offset).toBe(7.5);
  });

  test('reveal clamps at both ends and alternate-screen output has no history', async () => {
    const { term } = await history(10);
    term.viewport.reveal(0, 'center');
    expect(term.viewport.offset).toBe(term.getScrollbackLength());
    term.viewport.reveal(term.getScrollbackLength() + term.rows - 1, 'center');
    expect(term.viewport.offset).toBe(0);
    term.viewport.scrollTo(7);
    term.write('\x1b[?1049h');
    expect(term.getScrollbackLength()).toBe(0);
    expect(term.viewport.offset).toBe(0);
    term.viewport.reveal(2, 'center');
    expect(term.viewport.offset).toBe(0);
  });
});

describe('content changes', () => {
  test('each parsed write emits once, before a synchronous echo paint and the callback', async () => {
    const { term, renderer } = await terminal();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    expect(term.onChange, 'the widget emits content changes').toBeTypeOf('function');
    const seen: string[] = [];
    term.onChange(({ kind }) => {
      seen.push(`${kind}:${term.buffer.active.getLine(0)?.translateToString(true)}`);
    });
    renderer.render.mockImplementation(() => { seen.push('paint'); });
    term.input('x', true);
    term.write('x', () => seen.push('callback'));
    expect(seen).toEqual(['write:x', 'paint']);
    expect(frames).toHaveLength(1);
    frames.shift()!(0);
    expect(seen).toEqual(['write:x', 'paint', 'callback']);
    term.write(new TextEncoder().encode('y'));
    term.writeln('z');
    term.write('');
    expect(seen.filter((item) => item.startsWith('write:'))).toEqual([
      'write:x', 'write:xy', 'write:xyz',
    ]);
  });

  test.each(['string', 'bytes'] as const)('an empty %s write queues its callback without changing content or consuming the pending echo', async (kind) => {
    const { term, renderer } = await terminal();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    const changed = vi.fn();
    const callback = vi.fn();
    term.onChange(changed);
    term.input('x', true);
    renderer.render.mockClear();
    term.write(kind === 'string' ? '' : new Uint8Array(), callback);
    expect(changed, 'empty output changes no content').not.toHaveBeenCalled();
    expect(renderer.render, 'empty output is not the pending user echo').not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    frames.shift()!(0);
    expect(callback).toHaveBeenCalledOnce();
    term.write('x');
    expect(changed).toHaveBeenCalledOnce();
    expect(renderer.render, 'the next real echo still paints synchronously').toHaveBeenCalledOnce();
  });

  test("a paste scrolls to the bottom and its echo paints inside the write", async () => {
    const { term, renderer } = await history();
    renderer.render.mockClear();
    term.write('quiet');
    expect(renderer.render, 'output with no paste before it waits for a frame').not.toHaveBeenCalled();
    term.viewport.scrollTo(7);
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    term.paste('x');
    expect(sent).toEqual(['x']);
    expect(term.viewport.offset, 'the paste brought the prompt into view').toBe(0);
    renderer.render.mockClear();
    term.write('x');
    expect(renderer.render, "the paste's echo painted inside its write").toHaveBeenCalledOnce();
  });

  test('a throwing change listener cannot leave parsed terminal replies unsent', async () => {
    const { term } = await terminal();
    const replies: string[] = [];
    term.onData((data) => replies.push(data));
    term.onChange(() => { throw new Error('observer failed'); });
    // This operating-status query/reply is also recorded in the differential oracle.
    expect(() => term.write('\x1b[5n')).toThrow('observer failed');
    expect(replies, 'the PTY receives the parsed reply before change observers run').toEqual(['\x1b[0n']);
    expect(widgetInternals(term).wasmTerm!.readResponse(), 'no reply is stranded for a later write').toBeNull();
  });

  test('a throwing change listener cannot leave a resize unpublished or unpainted', async () => {
    const { term, renderer } = await terminal();
    const sizes: string[] = [];
    term.onResize(({ cols, rows }) => sizes.push(`${cols}x${rows}`));
    term.onChange(() => { throw new Error('observer failed'); });
    renderer.render.mockClear();
    let thrown: unknown;
    try { term.resize(30, 8); } catch (error) { thrown = error; }
    expect(sizes, 'the PTY hears the new size').toEqual(['30x8']);
    expect(renderer.render, 'the screen repaints whole at the new size')
      .toHaveBeenCalledWith(expect.anything(), true, 0, expect.any(Number));
    expect(thrown, "the listener's error reaches the caller").toEqual(new Error('observer failed'));
  });

  test('a resize runs every observer and its paint before it throws the first error', async () => {
    const { term, renderer } = await terminal();
    const reported: unknown[] = [];
    vi.stubGlobal('reportError', (failure: unknown) => reported.push(failure));
    const heard: string[] = [];
    term.onChange(() => { heard.push('change'); throw new Error('change listener failed'); });
    term.onResize(() => { heard.push('resize'); throw new Error('resize listener failed'); });
    renderer.render.mockImplementation((_core: unknown, forceAll: boolean) => {
      if (!forceAll) return;
      heard.push('paint');
      throw new Error('paint failed');
    });
    expect(() => term.resize(30, 8)).toThrow('change listener failed');
    expect(heard).toEqual(['change', 'resize', 'paint']);
    expect(reported, 'a failed paint is reported, as a write reports one').toEqual([new Error('paint failed')]);
  });

  test('a change listener queries links from the parsed content rather than the previous cache', async () => {
    const { term } = await terminal();
    const links = new LinkDetector(term);
    links.registerProvider(new UrlRegexProvider(term));
    widgetInternals(term).linkDetector = links;
    term.write('https://before.example');
    expect(await links.getLinkAt(0, 0), 'prime the real provider cache').toBeDefined();
    const observed: Array<Promise<ILink | undefined>> = [];
    term.onChange(() => { observed.push(links.getLinkAt(0, 0)); });
    term.write('\r\x1b[2Khttps://after.example');
    expect(observed).toHaveLength(1);
    const link = await observed[0];
    expect(link?.target, 'the listener sees the URL currently on the screen').toBe('https://after.example');
  });

  test('change listeners see the final anchored offset before any write paint', async () => {
    const { term, renderer } = await history();
    term.viewport.scrollTo(7.5);
    const seen: Array<[string, number]> = [];
    term.onChange(({ kind }) => { seen.push([kind, term.viewport.offset]); });
    renderer.render.mockImplementation(() => { seen.push(['paint', term.viewport.offset]); });
    term.write('more\r\n');
    expect(seen[0]).toEqual(['write', 8.5]);
    expect(seen.every(([, offset]) => offset === 8.5)).toBe(true);
  });

  test('resize emits once after reflow and before both resize listeners and paint', async () => {
    const { term, renderer } = await terminal();
    expect(term.onChange, 'the widget emits content changes').toBeTypeOf('function');
    const seen: string[] = [];
    term.onChange(({ kind }) => seen.push(`${kind}:${widgetInternals(term).wasmTerm!.cols}x${widgetInternals(term).wasmTerm!.rows}`));
    term.onResize(() => seen.push('resize listener'));
    renderer.render.mockImplementation(() => { seen.push('paint'); });
    term.resize(30, 8);
    expect(seen.slice(0, 3)).toEqual(['resize:30x8', 'resize listener', 'paint']);
    expect(seen.filter((item) => item.startsWith('resize:'))).toHaveLength(1);
    seen.length = 0;
    term.resize(30, 8);
    expect(seen).toEqual([]);
  });

  test('a resize that pulls history clamps both the view and its smooth-scroll target', async () => {
    const { term } = await history();
    term.viewport.scrollTo(7.5);
    term.resize(40, 100);
    expect(term.getScrollbackLength()).toBe(0);
    expect(term.viewport.offset).toBe(0);
    expect(widgetInternals(term).targetViewportY).toBe(0);
  });

  test('unsubscribed and disposed listeners receive no further changes', async () => {
    const { term } = await terminal();
    expect(term.onChange, 'the widget emits content changes').toBeTypeOf('function');
    const listener = vi.fn();
    const subscription = term.onChange(listener);
    term.write('one');
    subscription.dispose();
    subscription.dispose();
    term.write('two');
    expect(listener).toHaveBeenCalledTimes(1);
    term.onChange(listener);
    term.dispose();
    expect(() => term.write('three')).toThrow('disposed');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('disposing the widget releases retained change subscriptions', async () => {
    const { term } = await terminal();
    const changed = vi.fn();
    term.onChange(changed);
    const emitter = widgetInternals(term).changeEmitter;
    term.dispose();
    // write() refuses a disposed widget before reaching the emitter; drive
    // delivery here so that guard cannot hide retained subscriptions.
    emitter.fire({ kind: 'write' });
    expect(changed, 'disposed observers are no longer retained for dispatch').not.toHaveBeenCalled();
  });

  test('a change listener can dispose itself without skipping the next subscriber', async () => {
    const { term } = await terminal();
    const seen: string[] = [];
    const first = term.onChange(({ kind }) => {
      seen.push(`first:${kind}`);
      first.dispose();
    });
    term.onChange(({ kind }) => seen.push(`second:${kind}`));
    term.write('one');
    term.write('two');
    expect(seen, 'every subscribed observer receives the parsed write').toEqual([
      'first:write', 'second:write', 'second:write',
    ]);
  });

  test('reveal defaults to centering an offscreen absolute row', async () => {
    const { term } = await history(10);
    const row = 12;
    term.viewport.reveal(row);
    expect(row - term.getScrollbackLength() + Math.floor(term.viewport.offset)).toBe(5);
  });
});

async function historyPrune(offset: number | 'oldest' = 7.5, target?: number) {
  const { term } = await terminal();
  term.resize(80, 6);
  const core = widgetInternals(term).wasmTerm!;
  const scrolling = widgetInternals(term);
  for (let line = 0; line < 5000; line++) {
    const before = term.getScrollbackLength();
    if (before < 20) {
      term.write(`line ${line} ${'x'.repeat(40)}\r\n`);
      continue;
    }
    // Position immediately before each write so a near-bottom anchor is
    // retained when the core first discards a page of older history.
    const offsetBefore = offset === 'oldest' ? before : offset;
    term.viewport.scrollTo(offsetBefore);
    if (target !== undefined) {
      scrolling.targetViewportY = target;
      scrolling.scrollAnimationStartTime = Date.now();
      scrolling.scrollAnimationFrame = 999;
    }
    const rowBefore = before - Math.floor(offsetBefore);
    const textBefore = term.buffer.active.getLine(rowBefore)?.translateToString(true);
    const anchor = core.trackCell(rowBefore, 0)!;
    const targetAnchor = target === undefined ? null : core.trackCell(before - Math.floor(target), 0);
    expect(anchor, 'the source row exists before pruning').not.toBeNull();
    if (target !== undefined) expect(targetAnchor).not.toBeNull();
    try {
      term.write(`line ${line} ${'x'.repeat(40)}\r\n`);
      const after = term.getScrollbackLength();
      if (after < before) {
        const point = anchor.point();
        return {
          term, before, after, offsetBefore, textBefore, point, line,
          retainedText: point === null ? null : term.buffer.active.getLine(point.row)?.translateToString(true),
          shownText: term.buffer.active.getLine(after - Math.floor(term.viewport.offset))?.translateToString(true),
          targetPoint: targetAnchor?.point(), targetOffset: scrolling.targetViewportY,
        };
      }
    } finally {
      anchor.free();
      targetAnchor?.free();
    }
  }
  throw new Error('the bounded real-core fixture never pruned history');
}

describe('retained history at the scrollback cap', () => {
  test('a retained row keeps its screen position and fraction when history prunes', async () => {
    const state = await historyPrune();
    expect(state.after).toBeLessThan(state.before);
    expect(state.point, 'the row being read survives pruning').not.toBeNull();
    expect(state.retainedText).toBe(state.textBefore);
    expect(state.shownText, 'output pruning keeps the retained top row in view').toBe(state.textBefore);
    expect(state.term.viewport.offset).toBe(8.5);
    expect(state.point!.row - state.after + Math.floor(state.term.viewport.offset)).toBe(0);
  });

  test.each([0.3, 0.999])('a live view at %s retains its fraction while history prunes', async (offset) => {
    const { term, after, before } = await historyPrune(offset);
    expect(after).toBeLessThan(before);
    expect(term.viewport.offset).toBe(offset);
  });

  test('a pruned visible anchor clamps to the oldest retained row', async () => {
    const { term, point, after } = await historyPrune('oldest');
    expect(point, 'the old top row was pruned').toBeNull();
    expect(term.viewport.offset).toBe(after);
  });

  test('a retained smooth-scroll target moves with its row when history prunes', async () => {
    const { term, point, targetPoint, targetOffset, after } = await historyPrune(7.5, 12.25);
    expect(point).not.toBeNull();
    expect(targetPoint).not.toBeNull();
    expect(term.viewport.offset).toBe(8.5);
    expect(targetOffset, 'the gesture keeps its retained target row').toBe(13.25);
    expect(targetPoint!.row - after + Math.floor(targetOffset)).toBe(0);
  });

  test('a surviving smooth-scroll target is retained when the visible anchor is pruned', async () => {
    const { term, point, targetPoint, targetOffset, after } = await historyPrune('oldest', 12.25);
    expect(point).toBeNull();
    expect(targetPoint, 'the newer target row survived').not.toBeNull();
    expect(term.viewport.offset).toBe(after);
    expect(targetOffset, 'pruning the view does not discard the retained gesture target').toBe(13.25);
    expect(targetPoint!.row - after + Math.floor(targetOffset)).toBe(0);
  });

  test('write anchors are released after a write, a screen change and a parser failure', async () => {
    const { term } = await history();
    const core = widgetInternals(term).wasmTerm!;
    const tracked = terminalInternals(core).trackedCells;
    expect(tracked.size).toBe(0);
    term.viewport.scrollTo(7.5);
    term.write('more\r\n');
    expect(tracked.size).toBe(0);
    const write = vi.spyOn(core, 'write').mockImplementationOnce(() => { throw new Error('parser failed'); });
    expect(() => term.write('failed')).toThrow('parser failed');
    expect(tracked.size, 'a failed parse releases its temporary anchors').toBe(0);
    write.mockRestore();
    term.write('\x1b[?1049h');
    expect(term.viewport.offset).toBe(0);
    expect(tracked.size).toBe(0);
    term.write('\x1b[?1049l');
    expect(term.viewport.offset).toBe(0);
    expect(tracked.size).toBe(0);
  });
  test('a smooth-scroll target below one row keeps following live output across pruning', async () => {
    const { term, targetOffset } = await historyPrune(7.5, 0.3);
    expect(term.viewport.offset).toBe(8.5);
    expect(targetOffset).toBe(0.3);
  });

  test('the viewport anchor is released if acquiring the gesture anchor throws', async () => {
    const { term } = await history();
    term.viewport.scrollTo(7.5);
    const scrolling = widgetInternals(term);
    scrolling.targetViewportY = 12.25;
    scrolling.scrollAnimationStartTime = Date.now();
    const core = widgetInternals(term).wasmTerm!;
    const track = core.trackCell.bind(core);
    const tracked = terminalInternals(core).trackedCells;
    vi.spyOn(core, 'trackCell')
      .mockImplementationOnce(track)
      .mockImplementationOnce(() => { throw new Error('tracking failed'); });
    expect(() => term.write('failed')).toThrow('tracking failed');
    expect(tracked.size, 'failure to acquire the second anchor releases the first').toBe(0);
  });

});

async function beforeHistoryPrune() {
  const observed = await historyPrune();
  const { term } = await terminal();
  term.resize(80, 6);
  for (let line = 0; line < observed.line; line++) {
    term.write(`line ${line} ${'x'.repeat(40)}\r\n`);
  }
  expect(term.getScrollbackLength()).toBe(observed.before);
  // Each payload occupies one row. The observed history loss identifies
  // the first row that the next write retains, without assuming a page size.
  const retainedRow = observed.before + 1 - observed.after;
  return {
    term, retainedRow, after: observed.after,
    next: `line ${observed.line} ${'x'.repeat(40)}\r\n`,
  };
}

function gestureTarget(term: Terminal, target: number) {
  const scrolling = widgetInternals(term);
  scrolling.targetViewportY = target;
  scrolling.scrollAnimationStartTime = Date.now();
  scrolling.scrollAnimationFrame = 999;
  return scrolling;
}

describe('history-cap boundary guards', () => {
  test('a fractional visible anchor at the retained boundary clamps to the oldest row', async () => {
    const { term, retainedRow, after, next } = await beforeHistoryPrune();
    const offset = term.getScrollbackLength() - retainedRow + 0.75;
    term.viewport.scrollTo(offset);
    const anchor = widgetInternals(term).wasmTerm!.trackCell(retainedRow, 0)!;
    expect(anchor).not.toBeNull();
    try {
      term.write(next);
      expect(term.getScrollbackLength()).toBe(after);
      expect(anchor.point()?.row, 'the fractional anchor survived as the oldest row').toBe(0);
      expect(term.viewport.offset, 'the oldest visible row cannot retain an extra fraction').toBe(after);
    } finally {
      anchor.free();
    }
  });

  test('a fractional gesture target at the retained boundary clamps to the oldest row', async () => {
    const { term, retainedRow, after, next } = await beforeHistoryPrune();
    term.viewport.scrollTo(7.5);
    const scrolling = gestureTarget(term, term.getScrollbackLength() - retainedRow + 0.25);
    const anchor = widgetInternals(term).wasmTerm!.trackCell(retainedRow, 0)!;
    expect(anchor).not.toBeNull();
    try {
      term.write(next);
      expect(term.getScrollbackLength()).toBe(after);
      expect(anchor.point()?.row, 'the fractional target survived as the oldest row').toBe(0);
      expect(term.viewport.offset).toBe(8.5);
      expect(scrolling.targetViewportY, 'the oldest target row cannot retain an extra fraction').toBe(after);
    } finally {
      anchor.free();
    }
  });

  test('a pruned gesture target falls back to the oldest retained row independently of the view', async () => {
    const { term, after, next } = await beforeHistoryPrune();
    term.viewport.scrollTo(7.5);
    const scrolling = gestureTarget(term, term.getScrollbackLength());
    const anchor = widgetInternals(term).wasmTerm!.trackCell(0, 0)!;
    expect(anchor).not.toBeNull();
    try {
      term.write(next);
      expect(anchor.point(), 'the previous oldest target was discarded').toBeNull();
      expect(term.viewport.offset).toBe(8.5);
      expect(scrolling.targetViewportY, 'a discarded target falls back to retained history').toBe(after);
    } finally {
      anchor.free();
    }
  });

  test.each([false, true])('both active gesture anchors are released when parser failure is %s', async (failure) => {
    const { term } = await history();
    term.viewport.scrollTo(7.5);
    gestureTarget(term, 12.25);
    const core = widgetInternals(term).wasmTerm!;
    const tracked = terminalInternals(core).trackedCells;
    const write = core.write.bind(core);
    const observed: number[] = [];
    vi.spyOn(core, 'write').mockImplementationOnce((data) => {
      observed.push(tracked.size);
      if (failure) throw new Error('parser failed with two anchors');
      write(data);
    });
    if (failure) expect(() => term.write('more\r\n')).toThrow('parser failed with two anchors');
    else term.write('more\r\n');
    expect(observed, 'both real anchors are owned during parsing').toEqual([2]);
    expect(tracked.size, 'both active gesture anchors are freed after parsing').toBe(0);
  });
});
