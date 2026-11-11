// @vitest-environment jsdom
//
// A measurement, not a test of record; `vitest.findframes.config.ts` runs it
// and the ordinary web tests do not. What each GhosttyFind frame costs while
// `seq 1 200000` streams into a terminal with the find bar open: chan's
// binding of the vendored core, chan's viewport controller over a stand-in
// with ghostty-web's viewport semantics, ghostty-web's own SelectionManager,
// and frames run by hand. Each frame writes one chunk of the stream through
// the viewport controller, the terminal's only write path, then runs the
// frame find asked for, timed; once the stream ends, the frames run until
// find asks for none. Configurations: 80x24 and 200x50, the default and the
// largest scrollback, 16, 64 and 256 KiB a frame and 16 KiB for 30 frames
// then 256 KiB (a burst after moderate output), needles `9` (on about every
// other line) and `4999` (on a few), MEASURE_REPS repetitions (10).
//
// Per configuration it reports the longest, median and 95th percentile
// frame, the frames over 16 ms, the longest feed, the restarts of the search
// (`VtSearch.restart`) and other needle sets, the stream frames whose count
// was partial, and whether each run ended on the buffer's whole count. With
// MEASURE_HONESTY=1 the first repetition also checks every frame's count,
// untimed, against a fresh blocking scan of the buffer: a complete count
// must equal it and a partial one must not exceed it. MEASURE_SIZES,
// MEASURE_SCROLLBACKS, MEASURE_CHUNKS and MEASURE_NEEDLES narrow the run;
// MEASURE_OUT names a JSON file for every figure.

import { readFileSync, writeFileSync } from "node:fs";
import { env, hrtime, version } from "node:process";
import { SelectionManager, type Terminal } from "ghostty-web";
import { beforeAll, expect, test } from "vitest";
import { type FindCount, type FrameScheduler, GhosttyFind, FIND_SCAN_BUDGET_MS } from "./ghosttyFind";
import { GhosttyViewportController } from "./ghosttyViewport";
import { GhosttyVt, type VtSearch, VtTerminal } from "./ghosttyVt";
import { SCROLLBACK_MB_DEFAULT, SCROLLBACK_MB_MAX, scrollbackLinesFromMb } from "./scrollback";

const VENDORED = "vendor/ghostty-vt/ghostty-vt.wasm";
const OUT = env.MEASURE_OUT ?? "";
const REPS = Number(env.MEASURE_REPS ?? 10);
const LINES = Number(env.MEASURE_LINES ?? 200_000);
const HONESTY = env.MEASURE_HONESTY === "1";

let vendored: WebAssembly.Module;
beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

const ms = (a: bigint, b: bigint) => Number(b - a) / 1e6;
const now = () => hrtime.bigint();

function timedFrames() {
  const queue = new Map<number, () => void>();
  let next = 1;
  const frames: FrameScheduler & { pending(): number; frame(): number } = {
    request(run) {
      const id = next++;
      queue.set(id, run);
      return id;
    },
    cancel(id) {
      queue.delete(id);
    },
    pending: () => queue.size,
    frame() {
      const runs = [...queue.values()];
      queue.clear();
      const t0 = now();
      for (const run of runs) run();
      return ms(t0, now());
    },
  };
  return frames;
}

type Split = { feedMs: number; stepMs: number; feeds: number; steps: number; restarts: number; needles: number };

function instrument(search: VtSearch, split: Split) {
  const s = search as unknown as Record<string, (...args: unknown[]) => unknown>;
  const wrap = (name: string, after: (elapsed: number) => void) => {
    const original = s[name];
    if (typeof original !== "function") return;
    const bound = original.bind(search);
    s[name] = (...args: unknown[]) => {
      const t0 = now();
      const r = bound(...args);
      after(ms(t0, now()));
      return r;
    };
  };
  wrap("feed", (t) => {
    split.feedMs += t;
    split.feeds++;
  });
  wrap("step", (t) => {
    split.stepMs += t;
    split.steps++;
  });
  wrap("restart", () => {
    split.restarts++;
  });
  wrap("setNeedle", () => {
    split.needles++;
  });
}

async function fixture(cols: number, rows: number, scrollbackLimit: number) {
  const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const core = vt.createTerminal(cols, rows, { scrollbackLimit }) as unknown as VtTerminal;
  const clamp = (y: number) => Math.max(0, Math.min(core.getScrollbackLength(), y));
  const view = {
    cols,
    rows,
    viewportY: 0,
    getViewportY: () => view.viewportY,
    getScrollbackLength: () => core.getScrollbackLength(),
    scrollLines(amount: number) {
      view.viewportY = clamp(view.viewportY - amount);
    },
    scrollToLine(line: number) {
      view.viewportY = clamp(line);
    },
    write(data: string | Uint8Array) {
      core.write(data);
      view.viewportY = 0;
    },
    onResize() {
      return { dispose() {} };
    },
  };
  const viewport = new GhosttyViewportController(view, {
    os: () => "linux",
    hasMouseTracking: () => false,
    isAlternateScreen: () => core.isAlternateScreen(),
    cellHeight: () => 16,
  });
  const canvas = document.createElement("canvas");
  const renderer = { getCanvas: () => canvas, getMetrics: () => ({ width: 8, height: 16, baseline: 12 }) };
  const manager = new SelectionManager(
    view as unknown as Terminal,
    renderer as unknown as ConstructorParameters<typeof SelectionManager>[1],
    core as unknown as ConstructorParameters<typeof SelectionManager>[2],
    document.createElement("textarea"),
  );
  const frames = timedFrames();
  const counts: FindCount[] = [];
  const split: Split = { feedMs: 0, stepMs: 0, feeds: 0, steps: 0, restarts: 0, needles: 0 };
  const createSearch = core.createSearch.bind(core);
  (core as { createSearch: () => VtSearch }).createSearch = () => {
    const search = createSearch();
    instrument(search, split);
    return search;
  };
  const find = new GhosttyFind(core, {
    viewport,
    selection: manager as unknown as ConstructorParameters<typeof GhosttyFind>[1]["selection"],
    onCount: (count) => counts.push(count),
    frames,
  });
  /// The whole buffer's match count now, from a search of its own run to
  /// completion; not timed.
  const truth = (needle: string) => {
    const search = createSearch();
    search.setNeedle(needle);
    while (search.step(1e9) === "running");
    const total = search.state().total;
    search.free();
    return total;
  };
  return { core, viewport, frames, counts, split, find, truth };
}

function seqBytes(n: number): Uint8Array {
  const parts: string[] = [];
  for (let i = 1; i <= n; i++) parts.push(`${i}\r\n`);
  return new TextEncoder().encode(parts.join(""));
}

type Frame = {
  pumpMs: number;
  feedMs: number;
  stepMs: number;
  feeds: number;
  restarts: number;
  needles: number;
  phase: "stream" | "tail";
  total: number;
  index: number | null;
  partial: boolean;
};

type Honesty = { checked: number; completeWrong: number; partialOver: number; firstBad: string | null };

/// A frame's chunk of the stream: a fixed size, or 16 KiB for the first 30
/// frames and 256 KiB after (moderate output, then a burst).
type Chunking = number | "mixed";
const chunkAt = (chunking: Chunking, frame: number) => (chunking === "mixed" ? (frame < 30 ? 16 * 1024 : 256 * 1024) : chunking);

async function run(opts: { cols: number; rows: number; scrollback: number; chunk: Chunking; needle: string; stream: Uint8Array; honesty: boolean }) {
  const f = await fixture(opts.cols, opts.rows, opts.scrollback);
  f.core.write("$ seq 1 200000\r\n");
  f.find.find(opts.needle);
  let guard = 0;
  while (f.frames.pending()) {
    f.frames.frame();
    if (++guard > 1000) throw new Error("open never settled");
  }
  const restartsAtOpen = f.split.restarts;
  const needlesAtOpen = f.split.needles;
  const out: Frame[] = [];
  const honesty: Honesty = { checked: 0, completeWrong: 0, partialOver: 0, firstBad: null };
  const take = (phase: Frame["phase"]) => {
    const before = { ...f.split };
    const pumpMs = f.frames.frame();
    const last = f.counts.at(-1);
    const frame: Frame = {
      pumpMs,
      feedMs: f.split.feedMs - before.feedMs,
      stepMs: f.split.stepMs - before.stepMs,
      feeds: f.split.feeds - before.feeds,
      restarts: f.split.restarts - before.restarts,
      needles: f.split.needles - before.needles,
      phase,
      total: last?.total ?? -1,
      index: last?.index ?? null,
      partial: last?.partial ?? true,
    };
    out.push(frame);
    if (opts.honesty && last) {
      const total = f.truth(opts.needle);
      honesty.checked++;
      const bad = last.partial ? last.total > total : last.total !== total;
      if (bad) {
        if (last.partial) honesty.partialOver++;
        else honesty.completeWrong++;
        honesty.firstBad ??= `${phase} frame ${out.length}: shown ${last.total}${last.partial ? "+" : ""}, buffer ${total}`;
      }
    }
  };
  for (let at = 0, frame = 0; at < opts.stream.length; frame++) {
    const size = chunkAt(opts.chunk, frame);
    f.viewport.write(opts.stream.subarray(at, Math.min(at + size, opts.stream.length)));
    at += size;
    if (!f.frames.pending()) throw new Error("a write requested no frame");
    take("stream");
  }
  guard = 0;
  while (f.frames.pending()) {
    take("tail");
    if (++guard > 100_000) throw new Error("tail never settled");
  }
  const last = f.counts.at(-1);
  const truth = f.truth(opts.needle);
  const result = {
    frames: out,
    last,
    truth,
    finalHonest: last !== undefined && !last.partial && last.total === truth,
    restartsAtOpen,
    needlesAtOpen,
    honesty,
  };
  f.find.dispose();
  f.core.free();
  return result;
}

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? NaN;
  return { n: s.length, max: s.at(-1) ?? NaN, median: q(0.5), p95: q(0.95), over16: s.filter((x) => x > 16).length };
}

test("find frame cost while seq 1 200000 streams with the bar open", { timeout: 6 * 3_600_000 }, async () => {
  const stream = seqBytes(LINES);
  const scrollbacks: Record<string, number> = {
    default: scrollbackLinesFromMb(SCROLLBACK_MB_DEFAULT),
    max: scrollbackLinesFromMb(SCROLLBACK_MB_MAX),
  };
  const chunks: Record<string, Chunking> = { "16KiB": 16 * 1024, "64KiB": 64 * 1024, "256KiB": 256 * 1024, "16KiBx30+256KiB": "mixed" };
  const needles = (env.MEASURE_NEEDLES ?? "9,4999").split(",");
  const sizes = (env.MEASURE_SIZES ?? "80x24,200x50").split(",").map((s) => s.split("x").map(Number) as [number, number]);
  const only = (env.MEASURE_SCROLLBACKS ?? "default,max").split(",");
  const onlyChunks = (env.MEASURE_CHUNKS ?? "16KiB,64KiB,256KiB,16KiBx30+256KiB").split(",");
  await run({ cols: 80, rows: 24, scrollback: scrollbacks.default!, chunk: 64 * 1024, needle: "9", stream, honesty: false });
  const results: unknown[] = [];
  for (const [cols, rows] of sizes) {
    for (const sbName of only) {
      const scrollback = scrollbacks[sbName]!;
      for (const chunkName of onlyChunks) {
        const chunk = chunks[chunkName]!;
        for (const needle of needles) {
          const all: Frame[] = [];
          const finals: unknown[] = [];
          let honesty: Honesty | null = null;
          let honestFinals = 0;
          for (let r = 0; r < REPS; r++) {
            const res = await run({ cols, rows, scrollback, chunk, needle, stream, honesty: HONESTY && r === 0 });
            all.push(...res.frames);
            if (res.finalHonest) honestFinals++;
            if (r === 0 && HONESTY) honesty = res.honesty;
            finals.push({ last: res.last, truth: res.truth, frames: res.frames.length, restartsAtOpen: res.restartsAtOpen, needlesAtOpen: res.needlesAtOpen });
          }
          const stream_ = all.filter((x) => x.phase === "stream");
          const pump = stats(all.map((x) => x.pumpMs));
          const feed = stats(stream_.map((x) => x.feedMs));
          const restartFrames = all.filter((x) => x.restarts > 0 || x.needles > 0);
          const row = {
            size: `${cols}x${rows}`,
            scrollback: `${sbName} (${scrollback} lines)`,
            chunk: chunkName,
            needle,
            reps: REPS,
            budgetMs: FIND_SCAN_BUDGET_MS,
            pump,
            feed,
            restarts: all.reduce((n, x) => n + x.restarts, 0),
            needleSets: all.reduce((n, x) => n + x.needles, 0),
            restartFramePump: stats(restartFrames.map((x) => x.pumpMs)),
            partialStreamFrames: stream_.filter((x) => x.partial).length,
            streamFrames: stream_.length,
            tailFrames: all.length - stream_.length,
            honestFinals,
            honesty,
            finals,
          };
          results.push(row);
          const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
          console.log(
            `MEASURE ${row.size} sb=${sbName} chunk=${chunkName} needle=${needle} | pump n=${pump.n} max=${f2(pump.max)} med=${f2(pump.median)} p95=${f2(pump.p95)} >16=${pump.over16} | feed max=${f2(feed.max)} | restarts=${row.restarts} needleSets=${row.needleSets} restartFrameMax=${f2(row.restartFramePump.max)} | partial ${row.partialStreamFrames}/${row.streamFrames} stream, tail ${row.tailFrames} | honest finals ${honestFinals}/${REPS}${honesty ? ` | honesty checked=${honesty.checked} completeWrong=${honesty.completeWrong} partialOver=${honesty.partialOver}${honesty.firstBad ? ` first: ${honesty.firstBad}` : ""}` : ""}`,
          );
        }
      }
    }
  }
  if (OUT) writeFileSync(OUT, JSON.stringify({ node: version, lines: LINES, streamBytes: stream.length, reps: REPS, results }, null, 2));
  expect(results.length).toBeGreaterThan(0);
});
