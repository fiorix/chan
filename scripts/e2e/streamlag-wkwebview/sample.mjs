#!/usr/bin/env node
// Samples the RSS of the desktop and the WebKit processes every 250 ms, and
// stops the flood before an engine that buffers without bound can exhaust the
// Mac's memory or the trace can fill its disk.
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const [out, pidFile] = process.argv.slice(2);
if (!out || !pidFile) throw new Error('sample.mjs OUTPUT_DIR FLOOD_PID_FILE');

const GROWTH_LIMIT_KIB = 6 * 1024 * 1024;
const MIN_FREE_KIB = 15 * 1024 * 1024;
const TRACE_LIMIT_BYTES = 25 * 1024 ** 3;
const GONE_SAMPLES = 12;

const kindOf = (command) => {
  if (/com\.apple\.WebKit\.WebContent/.test(command)) return 'web';
  if (/com\.apple\.WebKit\.Networking/.test(command)) return 'network';
  if (/(^|\/)chan-desktop$/.test(command)) return 'desktop';
  return null;
};

async function processes() {
  // BSD ps reads everything after `=` as header text, commas included.
  const { stdout } = await run('ps', ['-ax', '-o', 'pid=', '-o', 'rss=', '-o', 'comm='], { maxBuffer: 16 * 1024 * 1024 });
  const rows = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    const kind = match && kindOf(match[3].trim());
    if (kind) rows.push({ pid: Number(match[1]), kind, rssKiB: Number(match[2]) });
  }
  return rows;
}

async function freeKiB() {
  const { stdout } = await run('df', ['-k', out]);
  return Number(stdout.trim().split('\n')[1].trim().split(/\s+/)[3]);
}

async function stopFlood(reason, value) {
  const record = { atMs: Date.now(), reason, value, stopped: false };
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    try {
      const { stdout } = await run('ps', ['-o', 'command=', '-p', String(pid)]);
      if (stdout.includes('flood.pl')) { process.kill(pid, 'SIGTERM'); record.stopped = true; }
    } catch { /* the flood already ended */ }
  }
  writeFileSync(join(out, 'guard.json'), JSON.stringify(record) + '\n', { mode: 0o600 });
  console.log(`guard: ${reason} (${value}); flood stopped: ${record.stopped}`);
}

const base = new Map();
const trace = join(out, 'server-events.jsonl');
let guarded = false, gone = 0;
try {
  for (;;) {
    const started = Date.now();
    const procs = await processes();
    appendFileSync(join(out, 'samples.jsonl'), JSON.stringify({ unixMs: started, procs }) + '\n', { mode: 0o600 });
    gone = procs.some((proc) => proc.kind === 'desktop') ? 0 : gone + 1;
    if (gone >= GONE_SAMPLES) break;
    if (!guarded) {
      let growth = 0;
      for (const proc of procs) {
        if (!base.has(proc.pid)) base.set(proc.pid, proc.rssKiB);
        growth += Math.max(0, proc.rssKiB - base.get(proc.pid));
      }
      const traceBytes = existsSync(trace) ? statSync(trace).size : 0;
      const free = await freeKiB();
      const trip = growth > GROWTH_LIMIT_KIB ? ['memory growth KiB', growth]
        : free < MIN_FREE_KIB ? ['free disk KiB', free]
          : traceBytes > TRACE_LIMIT_BYTES ? ['trace bytes', traceBytes] : null;
      if (trip) { guarded = true; await stopFlood(...trip); }
    }
    await new Promise((done) => setTimeout(done, Math.max(0, 250 - (Date.now() - started))));
  }
} catch (error) {
  // A flood with nothing watching it could exhaust the Mac.
  if (!guarded) await stopFlood('sampler failed', String(error.message ?? error).slice(0, 200));
  throw error;
}
