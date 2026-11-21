#!/usr/bin/env node
// Reads one run's trace against its stall windows and answers whether the
// server's sends were held back while the page did not run.
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const WANT_RUNS = 5;
const BLOCK_MS = 1000;
const FLOW_MS = 2000;
const MIN_DELIVERED_BYTES = 1024 * 1024;

const dir = process.argv[2];
if (!dir) throw new Error('analyze.mjs OUTPUT_DIR');
const stalls = JSON.parse(readFileSync(join(dir, 'stalls.json'), 'utf8'));
if (!Array.isArray(stalls) || !stalls.length) throw new Error('stalls.json holds no stalls');
const guard = existsSync(join(dir, 'guard.json')) ? JSON.parse(readFileSync(join(dir, 'guard.json'), 'utf8')) : null;

const overlap = (from, to, window) => Math.max(0, Math.min(to, window.endMs) - Math.max(from, window.startMs));
const sockets = new Map();
const sessions = new Map();
const instrument = { loggerStarts: 0, dropped: 0, lastFlushMs: null, unparsedLines: 0, lastLineUnparsed: false };

const sessionOf = (id) => {
  if (!sessions.has(id)) sessions.set(id, { bytes: 0, firstAfter: stalls.map(() => null), attaches: stalls.map(() => 0), lags: stalls.map(() => 0) });
  return sessions.get(id);
};
const socketOf = (event) => {
  const key = `${event.session}/${event.socket}`;
  if (!sockets.has(key)) sockets.set(key, { session: event.session, pending: null, windows: stalls.map(() => ({ longestMs: 0, bytes: 0, lastMs: null, beforeBytes: 0 })) });
  return sockets.get(key);
};
const settle = (socket, time) => {
  if (!socket.pending) return;
  stalls.forEach((window, index) => {
    socket.windows[index].longestMs = Math.max(socket.windows[index].longestMs, overlap(socket.pending.time, time, window));
  });
  socket.pending = null;
};

const lines = createInterface({ input: createReadStream(join(dir, 'server-events.jsonl')), crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim() || line.includes('"kind":"pty_read"')) continue;
  let event;
  try { event = JSON.parse(line); instrument.lastLineUnparsed = false; } catch { instrument.unparsedLines++; instrument.lastLineUnparsed = true; continue; }
  const time = Number(BigInt(event.t_ns ?? '0') / 1_000_000n);
  instrument.dropped = Math.max(instrument.dropped, Number(event.dropped ?? 0));
  if (event.kind === 'logger_start') { instrument.loggerStarts++; instrument.schema = event.schema; continue; }
  if (event.kind === 'logger_flush') { instrument.lastFlushMs = time; continue; }
  if (!event.session || !event.socket) continue;
  const session = sessionOf(event.session), socket = socketOf(event);
  if (event.kind === 'socket_attach') {
    stalls.forEach((window, index) => {
      const next = stalls[index + 1]?.startMs ?? Infinity;
      if (time >= window.startMs && time < next) session.attaches[index]++;
    });
  } else if (event.kind === 'lagged') {
    stalls.forEach((window, index) => {
      const next = stalls[index + 1]?.startMs ?? Infinity;
      if (time >= window.startMs && time < next) session.lags[index]++;
    });
  } else if (event.kind === 'send_start') {
    socket.pending = { time };
  } else if (event.kind === 'send_done' || event.kind === 'send_failed') {
    settle(socket, time);
    if (event.kind === 'send_done') {
      session.bytes += event.bytes;
      stalls.forEach((window, index) => {
        const stats = socket.windows[index];
        if (time >= window.startMs && time <= window.endMs) { stats.bytes += event.bytes; stats.lastMs = time; }
        if (time >= window.startMs - FLOW_MS && time < window.startMs) stats.beforeBytes += event.bytes;
        if (time > window.endMs && session.firstAfter[index] === null) session.firstAfter[index] = time;
      });
    }
  } else if (event.kind === 'socket_end') {
    settle(socket, time);
  }
}
for (const socket of sockets.values()) settle(socket, Infinity);

const problems = [];
if (instrument.loggerStarts !== 1) problems.push(`expected one logger start, read ${instrument.loggerStarts}`);
if (instrument.schema !== 1) problems.push('missing or unsupported trace schema');
if (instrument.dropped > 0) problems.push(`the trace dropped ${instrument.dropped} events`);
if (instrument.unparsedLines > (instrument.lastLineUnparsed ? 1 : 0)) problems.push(`${instrument.unparsedLines} unparsed trace lines`);
if (instrument.lastFlushMs === null || instrument.lastFlushMs < Math.max(...stalls.map((window) => window.endMs))) problems.push('no trace flush after the last stall');

const flood = [...sessions].sort((a, b) => b[1].bytes - a[1].bytes)[0];
if (!flood) problems.push('no terminal socket in the trace');
const samples = existsSync(join(dir, 'samples.jsonl'))
  ? readFileSync(join(dir, 'samples.jsonl'), 'utf8').split('\n').filter(Boolean).map((row) => JSON.parse(row)) : [];

function growthMiB(window) {
  const inWindow = samples.filter((row) => row.unixMs >= window.startMs && row.unixMs <= window.endMs);
  const before = samples.filter((row) => row.unixMs <= window.startMs).at(-1);
  const out = {};
  if (!before || !inWindow.length) return out;
  for (const proc of before.procs) {
    const peak = Math.max(...inWindow.map((row) => row.procs.find((other) => other.pid === proc.pid)?.rssKiB ?? 0));
    out[proc.kind] = Math.max(out[proc.kind] ?? 0, Math.round((peak - proc.rssKiB) / 1024));
  }
  return out;
}

const runs = stalls.map((window, index) => {
  const own = flood ? [...sockets.values()].filter((socket) => socket.session === flood[0]).map((socket) => socket.windows[index]) : [];
  const longestMs = own.length ? Math.max(...own.map((stats) => stats.longestMs)) : 0;
  const held = own.find((stats) => stats.longestMs === longestMs);
  const tailMs = window.endMs - (held?.lastMs ?? window.startMs);
  const bytes = own.reduce((sum, stats) => sum + stats.bytes, 0);
  const beforeBytes = own.reduce((sum, stats) => sum + stats.beforeBytes, 0);
  const spanMs = window.endMs - window.startMs;
  const faults = [];
  if (window.beatGapMs < 0.95 * spanMs) faults.push('the page was not shown stalled');
  if (window.visible === false) faults.push('the window was hidden');
  if (beforeBytes === 0) faults.push('no stream was flowing before the stall');
  if (guard && guard.atMs <= window.endMs) faults.push(`the guard stopped the flood: ${guard.reason}`);
  const reading = faults.length ? 'invalid' : longestMs >= BLOCK_MS ? 'blocked' : bytes >= MIN_DELIVERED_BYTES ? 'not-blocked' : 'inconclusive';
  const firstAfter = flood?.[1].firstAfter[index];
  return { run: window.run, reading, faults, stallMs: spanMs, longestPendingMs: longestMs,
    heldToStallEnd: tailMs >= BLOCK_MS && longestMs >= 0.9 * tailMs,
    deliveredInStallMiB: Math.round(bytes / 1048576 * 10) / 10,
    resumedAfterMs: firstAfter == null ? null : firstAfter - window.endMs,
    reattaches: flood?.[1].attaches[index] ?? 0, lagEvents: flood?.[1].lags[index] ?? 0, rssGrowthMiB: growthMiB(window) };
});

const count = (reading) => runs.filter((row) => row.reading === reading).length;
const verdict = problems.length || count('blocked') + count('not-blocked') < WANT_RUNS || count('inconclusive') + count('invalid') > 0 ? 'not established'
  : count('blocked') === runs.length ? 'blocks'
    : count('not-blocked') === runs.length ? 'never blocks' : 'mixed';
const host = existsSync(join(dir, 'host.txt')) ? readFileSync(join(dir, 'host.txt'), 'utf8').trim().split('\n') : [];
const summary = { verdict, problems, host, guard, runs };
writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 1) + '\n', { mode: 0o600 });

console.log(`VERDICT: ${verdict}`);
for (const problem of problems) console.log(`problem: ${problem}`);
for (const row of runs) {
  console.log(`run ${row.run}: ${row.reading}; longest pending ${row.longestPendingMs} ms of ${row.stallMs}; delivered ${row.deliveredInStallMiB} MiB in the stall; resumed after ${row.resumedAfterMs} ms; reattaches ${row.reattaches}; lag events ${row.lagEvents}; RSS growth MiB ${JSON.stringify(row.rssGrowthMiB)}${row.faults.length ? `; ${row.faults.join('; ')}` : ''}`);
}
