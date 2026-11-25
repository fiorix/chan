// Messages queued for a Muse terminal while it works reach it as one turn.
// The terminal runs a raw-PTY recorder stand-in named `muse`, so the server
// derives the Muse agent from its command, as it does for the real CLI. The
// stand-in prints a line every 200 ms while the check holds it busy, which
// keeps the server's queue from draining (the drainer waits for visible
// output to go quiet), and records every chunk the PTY hands it with the time
// it arrived. Deliveries are told apart by time: the drainer writes again
// only after the stand-in answered the last delivery and then stayed quiet
// for the queue's idle gate, so chunks closer together than DELIVERY_GAP_MS
// belong to one delivery.
//
// The batch leg queues five `cs terminal write --submit muse` messages while
// the stand-in is busy and reads, once it goes quiet, one delivery holding
// the framed five-message batch inside one bracketed paste, then the CR, with
// the queue depth going from 5 to 0 and never through 1..4. The boundaries
// leg queues submitted, raw, submitted: the raw write ends the run, so the
// three arrive one at a time, in order, and the depth passes 2 and 1.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "../lib/program-status.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";

const OPEN = "\x1b[200~";
const CLOSE = "\x1b[201~";
// Well below the queue's 800 ms idle gate, well above the spread of one
// write's read chunks.
const DELIVERY_GAP_MS = 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/// The server's chronological frame around submitted messages, built here
/// from its documented shape so the check does not read it from the server.
function framedBatch(messages) {
  const count = messages.length;
  let out = "# Queued terminal notifications\n\n";
  out += `${count} messages, oldest first. Read the entire batch before acting. Later\nmessages may update or supersede earlier messages.\n\n`;
  messages.forEach((message, index) => {
    const number = index + 1;
    out += `--- notification ${number}/${count} ---\n`;
    out += `${message.replace(/\n+$/, "")}\n`;
    out += `--- end notification ${number}/${count} ---\n`;
    if (number !== count) out += "\n";
  });
  return out;
}

const bracketed = (text) => `${OPEN}${text.replace(/\n+$/, "")}\n${CLOSE}\r`;

/// The complete lines of the stand-in's log; a line still being appended
/// has no newline yet and waits for the next read.
function logLinesOf(log) {
  if (!existsSync(log)) return [];
  const lines = readFileSync(log, "utf8").split("\n");
  lines.pop();
  return lines;
}

/// Every chunk the stand-in recorded past line `from` of its log.
function chunksSince(log, from) {
  return logLinesOf(log).slice(from)
    .map((line) => JSON.parse(line))
    .map(({ at, hex }) => ({ at, text: Buffer.from(hex, "hex").toString("utf8") }));
}

function deliveriesOf(chunks) {
  const deliveries = [];
  let last = -Infinity;
  for (const chunk of chunks) {
    if (chunk.at - last > DELIVERY_GAP_MS) deliveries.push("");
    deliveries[deliveries.length - 1] += chunk.text;
    last = chunk.at;
  }
  return deliveries;
}

function compactTrace(trace) {
  const runs = [];
  for (const depth of trace) {
    const tail = runs[runs.length - 1];
    if (tail && tail.depth === depth) tail.n += 1;
    else runs.push({ depth, n: 1 });
  }
  return runs.map(({ depth, n }) => `${depth}x${n}`).join(":");
}

export default {
  name: "muse-batch-delivery",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    if (process.env.CHAN_SUBMIT_MUSE !== undefined) {
      throw new Error("Unset CHAN_SUBMIT_MUSE: an override is never batched, and this check reads the built-in encoding");
    }
    const { page } = ctx;
    await page.bringToFront();
    const windowId = await page.evaluate(() => new URL(location.href).searchParams.get("w")?.trim()
      || sessionStorage.getItem("chan.session.window")?.trim() || "");
    assert.ok(windowId, "the check page has a window id");
    await ctx.waitWindowLive(windowId);
    const cs = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
      cwd: ctx.workspaceDir,
      env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
      timeout: 30_000,
    });
    // No agent's name is a whole word of this path but the stand-in's own.
    const dir = mkdtempSync(join(tmpdir(), "chan-batch-331-"));
    const log = join(dir, "input.jsonl");
    const ready = join(dir, "ready");
    const hold = join(dir, "hold");
    const ticks = join(dir, "ticks");
    const recorder = join(dir, "recorder.mjs");
    const stub = join(dir, "muse");
    const name = "MuseBatch331";
    const failures = [];
    const result = { backend: "ghostty", legs: [] };
    let opened = false;

    const queueDepth = async () => {
      const listed = await cs(["list", "--json"]);
      const rows = Object.values(JSON.parse(listed.stdout).groups ?? {}).flat();
      const row = rows.find((entry) => entry.name === name);
      if (!row) throw new Error(`${name} is not listed`);
      return row.queue_depth;
    };
    const tickCount = () => (existsSync(ticks) ? Number(readFileSync(ticks, "utf8")) || 0 : 0);
    const logLines = () => logLinesOf(log).length;

    // Hold the stand-in busy, and return only once it has printed, so the
    // writes below meet a queue whose target is not idle.
    const holdBusy = async (label) => {
      const before = tickCount();
      writeFileSync(hold, "");
      const deadline = Date.now() + 10_000;
      while (tickCount() < before + 2) {
        if (Date.now() > deadline) throw new Error(`${label}: the stand-in never printed while held busy`);
        await sleep(50);
      }
    };

    // Release the stand-in and sample the depth until the queue is empty.
    const releaseAndTrace = async (label) => {
      rmSync(hold, { force: true });
      const trace = [];
      const deadline = Date.now() + 30_000;
      for (;;) {
        const depth = await queueDepth();
        trace.push(depth);
        if (depth === 0) return trace;
        if (Date.now() > deadline) throw new Error(`${label}: the queue never drained (${compactTrace(trace)})`);
        await sleep(50);
      }
    };

    // The recorded chunks past `from`, once none has arrived for a second.
    const settledChunks = async (label, from) => {
      const deadline = Date.now() + 15_000;
      let count = -1;
      let steadySince = Date.now();
      for (;;) {
        const now = chunksSince(log, from).length;
        if (now !== count) {
          count = now;
          steadySince = Date.now();
        } else if (count > 0 && Date.now() - steadySince >= 1000) {
          return chunksSince(log, from);
        }
        if (Date.now() > deadline) throw new Error(`${label}: the stand-in read ${count} chunk(s) and never settled`);
        await sleep(100);
      }
    };

    const leg = async (label, writes, expectedDeliveries, judgeTrace) => {
      const record = { leg: label, passed: false };
      result.legs.push(record);
      try {
        await holdBusy(label);
        const from = logLines();
        for (const { text, submit } of writes) {
          await cs(["write", "--tab-name", name, ...(submit ? ["--submit", "muse"] : []), text]);
        }
        record.queuedDepth = await queueDepth();
        assert.equal(record.queuedDepth, writes.length, `${label}: every write waits while the stand-in is busy`);
        assert.equal(chunksSince(log, from).length, 0, `${label}: nothing reaches a busy stand-in`);
        const trace = await releaseAndTrace(label);
        record.depthTrace = compactTrace(trace);
        const deliveries = deliveriesOf(await settledChunks(label, from));
        record.deliveries = deliveries;
        console.log(`[smoke]   ${label}: depth ${record.depthTrace}; ${deliveries.length} deliveries ${JSON.stringify(deliveries)}`);
        const traceError = judgeTrace(trace);
        if (traceError) failures.push(`${label}: ${traceError} (depth ${record.depthTrace})`);
        if (JSON.stringify(deliveries) !== JSON.stringify(expectedDeliveries)) {
          failures.push(`${label}: expected ${expectedDeliveries.length} deliveries ${JSON.stringify(expectedDeliveries)}; got ${deliveries.length}: ${JSON.stringify(deliveries)}`);
        }
        record.passed = !traceError && JSON.stringify(deliveries) === JSON.stringify(expectedDeliveries);
      } catch (error) {
        record.failure = String(error.message ?? error);
        failures.push(`${label}: ${record.failure}`);
        rmSync(hold, { force: true });
      }
      writeFileSync(join(ctx.outDir, `331-${label}.json`), `${JSON.stringify(record, null, 2)}\n`);
    };

    try {
      // Node is the suite's runtime. A dot after each chunk lets the queue see
      // the stand-in answer before its next idle gate, as an agent would.
      writeFileSync(recorder, `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
if (!process.stdin.isTTY) throw new Error("stand-in stdin is not a PTY");
process.stdin.setRawMode(true);
writeFileSync(${JSON.stringify(log)}, "");
let ticks = 0;
let held = 0;
setInterval(() => {
  if (!existsSync(${JSON.stringify(hold)})) { held = 0; return; }
  if (++held > 300) return;
  ticks += 1;
  process.stdout.write("tick " + ticks + "\\r\\n");
  writeFileSync(${JSON.stringify(ticks)}, String(ticks));
}, 200);
process.stdout.write("\\x1b[?2004hREADY\\r\\n");
writeFileSync(${JSON.stringify(ready)}, "ready");
process.stdin.on("data", (bytes) => {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ at: Date.now(), hex: bytes.toString("hex") }) + "\\n");
  process.stdout.write(".");
});
`);
      writeFileSync(stub, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(recorder)}\n`);
      chmodSync(stub, 0o755);
      const row = await openAttachedTerminal(ctx, page, cs, windowId, name, ["--command", shellQuote(stub)]);
      opened = true;
      await ctx.pollFile(ready, 30_000);
      if (row.agent !== "muse") throw new Error(`${name}: derived ${JSON.stringify(row.agent)}, expected muse`);
      result.agent = row.agent;

      const batch = [1, 2, 3, 4, 5].map((index) => index === 3
        ? "MUSE331 batch message 3\nits second line"
        : `MUSE331 batch message ${index}`);
      await leg(
        "batch",
        batch.map((text) => ({ text, submit: true })),
        [`${OPEN}${framedBatch(batch)}${CLOSE}\r`],
        (trace) => trace.some((depth) => depth > 0 && depth < 5)
          ? "the depth stepped through 1..4, so the five drained apart" : null,
      );

      await leg(
        "boundaries",
        [
          { text: "MUSE331 boundary A", submit: true },
          { text: "MUSE331 boundary B raw", submit: false },
          { text: "MUSE331 boundary C", submit: true },
        ],
        [bracketed("MUSE331 boundary A"), "MUSE331 boundary B raw", bracketed("MUSE331 boundary C")],
        (trace) => [2, 1].every((level) => trace.includes(level))
          ? null : "the depth skipped a level, so a run crossed the raw write",
      );
    } finally {
      rmSync(hold, { force: true });
      if (opened) await cs(["close", "--tab-name", name]).catch((error) => failures.push(`close: ${error.message}`));
      rmSync(dir, { recursive: true, force: true });
    }
    if (failures.length) {
      const error = new Error(`${failures.length} failure(s):\n${failures.join("\n")}`);
      error.smokeDetails = result;
      throw error;
    }
    return result;
  },
};
