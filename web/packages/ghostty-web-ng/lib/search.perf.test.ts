import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { GhosttyVt, VtSearch } from '../vt/ghosttyVt';
import { HighlightsManager } from './highlights';
import { CanvasRenderer } from './renderer';
import { SearchOwner } from './search';
import { Terminal } from './terminal';

declare const process: { env: Record<string, string | undefined>; version: string; platform: string; arch: string };

// Opt-in measurements allocate a maximum-size history and use the wall clock.
// Skipping them in ordinary unit runs is not a performance acceptance.
const output = process.env.GHOSTTY_SEARCH_PERF;
const BYTES = 50 * 1024 * 1024;
const LINE = 'needle ' + 'abcdefgh'.repeat(9) + 'a';
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let module: WebAssembly.Module;
let terminal: Terminal | undefined;
type Sample = {
  phase: string; owner: number; scan: number; read: number; dedup: number; publication: number;
  paint: number; total: number; completion: number; fetched: number; published: number; spans: number; lookups: number;
  matches: number; partial: boolean;
};
let sample: Sample | undefined;
const results: { query: string; rows: number; samples: Sample[]; summary: unknown }[] = [];
const coreLimits: { bytes: number; rows: number; matches: number; completion: number; feed: number; maxUnit: number }[] = [];
const restores: (() => void)[] = [];
let ownerDepth = 0;
let scanDepth = 0;

type Callable = (...args: any[]) => any;
function wrap(proto: object, name: string, around: (call: Callable, args: any[]) => any) {
  const target = proto as Record<string, Callable>;
  const original = target[name];
  if (typeof original !== 'function') throw new Error(`the measurement times ${name}, which its class does not have`);
  target[name] = function (...args) { return around(original.bind(this), args); };
  restores.push(() => { target[name] = original; });
}
function timed(key: 'scan' | 'read' | 'publication' | 'paint', call: Callable, args: any[]) {
  const start = performance.now();
  try { return call(...args); } finally { if (sample) sample[key] += performance.now() - start; }
}
function instrument() {
  for (const method of ['pump', 'step', 'changed', 'find', 'close']) {
    wrap(SearchOwner.prototype, method, (call, args) => {
      const outer = ownerDepth++ === 0;
      const start = performance.now();
      const paint = sample?.paint ?? 0;
      try { return call(...args); } finally {
        ownerDepth--;
        if (outer && sample) sample.owner += performance.now() - start - (sample.paint - paint);
      }
    });
  }
  for (const method of ['step', 'feed', 'restart']) {
    wrap(VtSearch.prototype, method, (call, args) => {
      const outer = scanDepth++ === 0;
      try { return outer ? timed('scan', call, args) : call(...args); } finally { scanDepth--; }
    });
  }
  const step = VtSearch.prototype.step;
  VtSearch.prototype.step = function (...args) {
    const scanning = !this.caughtUp();
    const result = step.apply(this, args);
    if (sample && scanning && result === 'complete') sample.completion += this.completingUnitMs ?? 0;
    return result;
  };
  restores.push(() => { VtSearch.prototype.step = step; });
  wrap(VtSearch.prototype, 'matchesBetween', (call, args) => {
    const ranges = timed('read', call, args);
    if (sample) sample.fetched += ranges.length;
    return ranges;
  });
  wrap(VtSearch.prototype, 'readMatches', (call, args) => {
    const batch = timed('read', call, args);
    if (sample) sample.fetched += batch.ranges.length;
    return batch;
  });
  wrap(SearchOwner.prototype, 'readResults', (call, args) => {
    const start = performance.now();
    const read = sample?.read ?? 0;
    const publication = sample?.publication ?? 0;
    try { return call(...args); } finally {
      if (sample) sample.dedup += performance.now() - start - (sample.read - read) - (sample.publication - publication);
    }
  });
  for (const method of ['set', 'clear', 'append']) {
    wrap(HighlightsManager.prototype, method, (call, args) => {
      if (sample && method !== 'clear') sample.published += args[1].length;
      return timed('publication', call, args);
    });
  }
  wrap(HighlightsManager.prototype, 'frame', (call, args) => {
    const frame = timed('paint', call, args);
    if (sample) sample.spans += frame.spans.length;
    return frame;
  });
  wrap(CanvasRenderer.prototype, 'highlightAt', (call, args) => {
    if (sample) sample.lookups++;
    return timed('paint', call, args);
  });
  wrap(CanvasRenderer.prototype, 'cacheHighlights', (call, args) => timed('paint', call, args));
}

function animationFrame() {
  for (const [id, callback] of [...frames]) if (frames.delete(id)) callback(performance.now());
}
function measure(phase: string, work: () => void) {
  sample = { phase, owner: 0, scan: 0, read: 0, dedup: 0, publication: 0,
    paint: 0, total: 0, completion: 0, fetched: 0, published: 0, spans: 0, lookups: 0, matches: 0, partial: true };
  work();
  // Include an actual widget repaint in every measured work slice, even if
  // invalidation would otherwise defer it to the following animation frame.
  terminal!.refresh();
  sample.total = sample.owner + sample.paint;
  sample.matches = terminal!.search.state.total;
  sample.partial = terminal!.search.state.partial;
  results.at(-1)!.samples.push(sample);
  sample = undefined;
}
async function settle(phase: string, stream: boolean) {
  for (let i = 0; i < 2000; i++) {
    measure(phase, () => {
      if (stream && i < 8 && i % 2 === 0) terminal!.write('xyz output\r\n'.repeat(8));
      animationFrame();
    });
    if (!terminal!.search.state.partial && (!stream || i >= 8)) return;
    // Real animation frames return to the event loop between work slices.
    // Keep the clock real and permit runtime housekeeping without forcing GC.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('Maximum-history search did not settle within 2000 measured frames');
}
function summarize(samples: Sample[]) {
  const phases = [...new Set(samples.map(s => s.phase))];
  return Object.fromEntries(phases.map(phase => {
    const group = samples.filter(s => s.phase === phase);
    return [phase, Object.fromEntries(['owner', 'scan', 'read', 'dedup', 'publication', 'paint', 'total', 'completion',
      'fetched', 'published', 'spans', 'lookups', 'matches'].map(key => {
      const values = group.map(s => s[key as keyof Sample] as number).sort((a, b) => a - b);
      return [key, { n: values.length, median: values[Math.floor(values.length / 2)],
        p95: values[Math.ceil(values.length * 0.95) - 1], max: values.at(-1) }];
    }))];
  }));
}
function save() {
  if (!output) return;
  for (const result of results) result.summary = summarize(result.samples);
  writeFileSync(output, JSON.stringify({
    environment: { node: process.version, platform: process.platform, arch: process.arch,
      cpu: readFileSync('/proc/cpuinfo', 'utf8').split('\n').find(line => line.startsWith('model name')),
      kernel: readFileSync('/proc/sys/kernel/osrelease', 'utf8').trim(),
      medium: 'jsdom; software rectangle canvas shim, fixed glyph metrics, no glyph rasterization; not a browser',
      budgetBytes: BYTES, cols: 80, rows: 24, line: LINE, timing: 'performance.now; manual animation frames with macrotask yields; instrumented wall time' },
    results, coreLimits,
  }, null, 2) + '\n');
}

// Runs in every unit run, so a renamed or sealed method fails here rather
// than leaving the opt-in measurement without that phase.
test('the measurement wraps only methods its classes have', () => {
  try {
    instrument();
  } finally {
    for (const restore of restores.splice(0).reverse()) restore();
  }
});

describe.skipIf(!output)('maximum-history search work', () => {
  beforeAll(async () => {
    module = await WebAssembly.compile(readFileSync('vendor/ghostty-vt/ghostty-vt.wasm'));
  });
  afterEach(() => {
    save();
    terminal?.dispose();
    terminal = undefined;
    frames.clear();
    for (const restore of restores.splice(0).reverse()) restore();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  afterAll(save);
  test.each(['a', 'needle'])('measures %s near both ends, streaming and reflow', async query => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      const canvas = this;
      let pixels = new Uint32Array(0);
      return new Proxy({ fillStyle: '' }, {
        get(target, key: string) {
          if (key === 'measureText') return () => ({ width: 8, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 4 });
          if (key === 'fillRect' || key === 'clearRect') return (x: number, y: number, w: number, h: number) => {
            if (pixels.length !== canvas.width * canvas.height) pixels = new Uint32Array(canvas.width * canvas.height);
            const color = key === 'clearRect' ? 0 : Number.parseInt(target.fillStyle.replace('#', ''), 16) || 1;
            const start = Math.max(0, Math.floor(x));
            const end = Math.min(canvas.width, Math.ceil(x + w));
            for (let row = Math.max(0, Math.floor(y)); row < Math.min(canvas.height, Math.ceil(y + h)); row++) {
              pixels.fill(color, row * canvas.width + start, row * canvas.width + end);
            }
          };
          return (target as Record<string, unknown>)[key] ?? (() => undefined);
        },
      }) as unknown as CanvasRenderingContext2D;
    } as never);
    const ghostty = new GhosttyVt(await WebAssembly.instantiate(module, {}));
    terminal = new Terminal({ ghostty, cols: 80, rows: 24, scrollbackBytes: BYTES,
      cursorBlink: false, smoothScrollDuration: 0, testHooks: { scrollbarOpacity: 0 } });
    const host = document.createElement('div');
    document.body.append(host);
    terminal.open(host);
    terminal.write('\x1b[?25l');
    let pruned = false;
    let previous = 0;
    // 100,352 rows exceed this shape's 50 MiB budget. Assert actual pruning,
    // rather than treating a configured maximum as populated history.
    for (let rows = 0; rows < 100_352; rows += 256) {
      terminal.write((LINE + '\r\n').repeat(256));
      const current = terminal.core!.getScrollbackLength();
      pruned ||= rows > 0 && current < previous + 256;
      previous = current;
    }
    expect(previous).toBeGreaterThan(50_000);
    expect(pruned).toBe(true);
    animationFrame();
    results.push({ query, rows: previous, samples: [], summary: {} });
    instrument();
    measure('newest-start', () => terminal!.search.find(query));
    await settle('newest-stream', true);
    expect(terminal.search.state.total).toBeGreaterThan(50_000);
    const exactCount = () => expect(terminal!.search.state.total).toBe(
      terminal!.core!.plainText()!.split(query).length - 1);
    exactCount();
    measure('newest-reveal', () => terminal!.viewport.reveal(
      terminal!.highlights.get('search-active')!.ranges[0].start.absoluteRow));
    for (let i = 0; i < 10; i++) measure('newest-paint', () => animationFrame());
    measure('oldest-step', () => terminal!.search.step(query, 'newer'));
    expect(terminal.search.state.index).toBe(terminal.search.state.total);
    for (let i = 0; i < 10; i++) measure('oldest-paint', () => animationFrame());
    await settle('oldest-stream', true);
    exactCount();
    measure('reflow', () => terminal!.resize(40, 24));
    await settle('reflow-scan', false);
    expect(terminal.search.state.total).toBeGreaterThan(50_000);
    exactCount();
    save();
    const samples = results.at(-1)!.samples;
    expect(samples.some(s => s.owner > 0 && s.fetched > 0), 'live owner/result instrumentation').toBe(true);
    expect(samples.some(s => s.paint > 0 && s.lookups > 0), 'live highlight paint instrumentation').toBe(true);
    expect(samples.filter(s => s.phase === 'newest-paint' || s.phase === 'oldest-paint')
      .every(s => s.spans > 0), 'both history-end paint phases contain visible highlights').toBe(true);
    expect(Math.max(...samples.map(s => s.total)), 'total owner plus highlight paint, milliseconds').toBeLessThanOrEqual(12);
  }, 600_000);

  test('records the core completion and feed crossing without changing the core', async () => {
    for (const mib of [10, 20, 30, 40, 50]) {
      const ghostty = new GhosttyVt(await WebAssembly.instantiate(module, {}));
      const core = ghostty.createTerminal(80, 24, { scrollbackMaxBytes: mib * 1024 * 1024 });
      try {
        for (let rows = 0; rows < 100_352; rows += 256) core.write((LINE + '\r\n').repeat(256));
        expect(core.getScrollbackLength()).toBeLessThan(100_000);
        for (let repeat = 0; repeat < 3; repeat++) {
          const search = core.createSearch();
          try {
            search.setNeedle('a');
            let maxUnit = 0;
            for (let i = 0; ; i++) {
              if (i > 10_000) throw new Error('core search did not settle');
              const start = performance.now();
              const status = search.step(0);
              maxUnit = Math.max(maxUnit, performance.now() - start);
              if (status === 'complete') break;
            }
            const matches = search.state().total;
            core.write('xyz output\r\n');
            const start = performance.now();
            search.feed();
            coreLimits.push({ bytes: mib * 1024 * 1024, rows: core.getScrollbackLength(), matches,
              completion: search.completingUnitMs!, feed: performance.now() - start, maxUnit });
          } finally { search.free(); }
        }
      } finally { core.free(); }
    }
  }, 120_000);
});
