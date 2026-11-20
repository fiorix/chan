#!/usr/bin/env node
// Reads the connection chart on a devserver's card in front of the real
// WebKitGTK Computers screen: where the chart sits inside the card, and how
// its line moves between and across the samples the desktop's pings add.
// The shell driver owns the desktop and the display; this owns a direct
// devserver and a relay in front of it (`../browser-smoke/lib/flow-relay.mjs`).
//
// Legs (argv after the work paths, any of):
//   inset    the baseline's ends against the card's edges: equal insets.
//   figures  the detail's fourth figure: Missed 0 on a relay that drops
//            nothing, its title the count against the window's pings and
//            the last contact's clock time.
//   motion   a marked reading's on-screen x, read in the page every 50 ms
//            over 12 s: it moves left between arrivals, never right, and
//            does not jump at an arrival.
//   reduced  the same reading with prefers-reduced-motion in effect (the
//            shell driver sets it in the desktop's GTK settings): it holds
//            between arrivals and steps at each.
//
// The marked reading is one ping the relay holds 150 ms each way, so its
// reply time reads about 300 ms where the guest's loopback reads under one:
// the one high point on the line, whose leftmost point the page follows.
//
// Every bounded wait is a hang guard that names its step. One JSON line per
// assertion: {"name","expected","actual","pass"}, then one `leg <name>
// pass|fail` line per leg. Exit 0 when every leg held, 10 when one did not,
// 2 when a step the legs rest on did not happen (the setup did not run), 3
// when the driver itself failed.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { clientFrameReader, startRelay } from "../browser-smoke/lib/flow-relay.mjs";
import { judgeFigures, judgeInset, judgeMotion } from "./connection-chart-verdict.mjs";

const run = promisify(execFile);
const [inspector, work, chan, ...legs] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const LABEL = "chart-test";
const FEED_PATH = "/api/library/windows/watch";
const MARKER_DELAY_MS = 150;
// A point this high in the chart's units (48 tall, baseline at 44, 40 for
// the 400 ms ceiling) replied in 100 ms or more.
const MARKER_MAX_Y = 34;
const TRACE_MS = 12_000;
const TRACE_PERIOD_MS = 50;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secrets = [];
const mask = (text) => secrets.reduce((s, secret) => s.replaceAll(secret, "<token>"), String(text))
  .replace(/([?&]t=)[^&\s"']+/g, "$1<token>");
const results = [];
const logs = [];

class SetupNotRun extends Error {}

function report(leg, lines) {
  for (const l of lines) {
    results.push({ leg, ...l });
    console.log(mask(JSON.stringify({ name: l.name, expected: l.expected, actual: l.actual, pass: l.pass })));
  }
}

async function until(probe, ms) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last?.ok) return last;
    await sleep(250);
  }
  return last;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function inspectAll(expression) {
  const { stdout } = await run(process.execPath, [path.join(here, "inspect.mjs"), inspector, "all", expression],
    { timeout: 30_000, maxBuffer: 1 << 24 });
  return stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/// The first page's value that is neither null nor a skip.
async function inPage(expression) {
  return (await inspectAll(expression)).map((page) => page.value).find((value) => value != null && !value.skip) ?? null;
}

const SLOT = `[...document.querySelectorAll('.slot')].find((s) => [...s.querySelectorAll('.ds-name-row .row-name')].some((n) => n.textContent.trim() === ${JSON.stringify(LABEL)}))`;

/// Runs in the page: the card's state and the boxes the inset leg reads.
function pageCard(slotExpression, markerMaxY) {
  if (!document.querySelector(".slot")) return { skip: true };
  const slot = slotExpression();
  if (!slot) return { skip: true };
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  };
  const chart = slot.querySelector(".ds-health svg.sparkline");
  const points = [...(chart?.querySelectorAll(".reading") ?? [])]
    .reduce((count, p) => count + ((p.getAttribute("d") ?? "").match(/ L /g)?.length ?? 0) + 1, 0);
  const highs = [...(chart?.querySelectorAll(".reading") ?? [])]
    .flatMap((p) => [...(p.getAttribute("d") ?? "").matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[2])))
    .filter((y) => y <= markerMaxY).length;
  return {
    front: slot.getAttribute("aria-current") === "true",
    face: slot.querySelector(".ds-name-row .connection-face")?.dataset.face ?? null,
    points,
    highs,
    reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
    missed: (() => {
      const figure = slot.querySelector(".ds-health .figures > span:last-child");
      return { text: figure?.textContent.replace(/\s+/g, " ").trim() ?? null, title: figure?.getAttribute("title") ?? null };
    })(),
    boxes: {
      card: box(slot.querySelector("section.card")),
      health: box(slot.querySelector(".ds-health")),
      chart: box(chart),
      baseline: box(chart?.querySelector(".baseline")),
    },
  };
}

/// Runs in the page: records the chart every `periodMs` for `durationMs`
/// into `window.__chartTrace`, and answers at once.
function pageSampler(slotExpression, markerMaxY, durationMs, periodMs) {
  if (!document.querySelector(".slot")) return { skip: true };
  const svg = slotExpression()?.querySelector(".ds-health svg.sparkline");
  if (!svg) return { ok: false, why: "no chart on the card" };
  const hash = (text) => {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return h;
  };
  const trace = [];
  window.__chartTrace = trace;
  const start = performance.now();
  const read = () => {
    const paths = [...svg.querySelectorAll(".reading")];
    const drawn = paths.concat([...svg.querySelectorAll(".miss")]).map((p) => p.getAttribute("d")).join("|");
    let marker = null;
    for (const p of paths) {
      const m = p.getScreenCTM();
      for (const [, x, y] of (p.getAttribute("d") ?? "").matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)) {
        if (Number(y) > markerMaxY) continue;
        const at = m.a * Number(x) + m.c * Number(y) + m.e;
        marker = marker === null ? at : Math.min(marker, at);
      }
    }
    trace.push({ t: Math.round(performance.now() - start), sig: hash(drawn), marker });
  };
  read();
  const timer = setInterval(() => {
    read();
    if (performance.now() - start >= durationMs) clearInterval(timer);
  }, periodMs);
  return { ok: true };
}

const call = (fn, ...args) => `(${fn.toString()})(() => ${SLOT}, ${args.map((a) => JSON.stringify(a)).join(", ")})`;
const readCard = async () => inPage(call(pageCard, MARKER_MAX_Y));

async function readUntil(holds, ms, step) {
  const last = await until(async () => {
    const card = await readCard();
    return { ok: Boolean(card && holds(card)), card };
  }, ms);
  if (!last?.ok) throw new SetupNotRun(`${step}: ${mask(JSON.stringify(last?.card ?? null))}`);
  return last.card;
}

const devHome = path.join(work, "devserver-home");
fs.mkdirSync(devHome);
let server = null;
let relay = null;
let marking = false;

// The desktop's own feed pings, told from a page's by the request's Origin
// header; the marker holds the first one asked for.
const flowStates = new Map();
const tapFeed = (flow, index, chunk) => {
  if (index !== 0) return;
  let state = flowStates.get(flow);
  if (!state) {
    state = { head: Buffer.alloc(0), reader: null, desktop: null };
    flowStates.set(flow, state);
  }
  let rest = chunk;
  if (!state.reader) {
    state.head = Buffer.concat([state.head, chunk]);
    const end = state.head.indexOf("\r\n\r\n");
    if (end < 0) return;
    state.desktop = !/^origin:/im.test(state.head.toString("latin1", 0, end));
    state.reader = clientFrameReader();
    rest = state.head.subarray(end + 4);
  }
  if (flow.path !== FEED_PATH) return;
  for (const frame of state.reader.push(rest)) {
    if (frame.text === '{"type":"ping"}' && state.desktop && marking) {
      // Set before the relay queues this chunk, so the ping and its pong
      // each wait the delay.
      marking = false;
      relay.setDelay(MARKER_DELAY_MS);
      setTimeout(() => relay.setDelay(0), 1_500);
    }
  }
};

async function setup() {
  const devPort = await freePort();
  const devBase = `http://127.0.0.1:${devPort}`;
  server = spawn(chan, ["devserver", "run", "--service=none", "--bind=127.0.0.1", `--port=${devPort}`], {
    env: { ...process.env, CHAN_HOME: devHome }, stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (data) => logs.push(data.toString()));
  server.stderr.on("data", (data) => logs.push(data.toString()));
  relay = await startRelay(devPort);
  relay.tap(tapFeed);
  const ready = await until(async () => {
    if (server.exitCode !== null) return { ok: false };
    try { return { ok: (await fetch(`${devBase}/api/devserver/info`, { signal: AbortSignal.timeout(1000) })).ok }; }
    catch { return null; }
  }, 60_000);
  if (!ready?.ok) throw new SetupNotRun("the devserver did not start");
  const token = JSON.parse(fs.readFileSync(path.join(devHome, "devserver/config.json"))).devserver_token;
  secrets.push(token);
  const pageUp = await until(async () => {
    try { return { ok: (await inspectAll("document.readyState === 'complete'")).some((page) => page.value === true) }; }
    catch { return null; }
  }, 60_000);
  if (!pageUp?.ok) throw new SetupNotRun("no desktop page answered the inspector");

  const { stdout: firstWindow } = await run("xdotool", ["getactivewindow"]);
  const host = firstWindow.trim();
  const cli = (args) => run(chan, args, { timeout: 90_000 });
  await cli(["devserver", "register", `http://127.0.0.1:${relay.port}/?t=${token}`, "--name", LABEL]);
  await cli(["devserver", "connect", LABEL]);
  const connected = await until(async () => {
    const { stdout } = await cli(["devserver", "ls", "--json"]);
    return { ok: JSON.parse(stdout).devservers.some((d) => d.label === LABEL && d.status === "connected") };
  }, 60_000);
  if (!connected?.ok) throw new SetupNotRun("the desktop did not connect to the devserver through the relay");

  // The Computers screen over the window the chord reaches, with the card
  // in front; the window keeps the focus, so the desktop pings every 3 s.
  let shown = null;
  for (let attempt = 0; attempt < 3 && !shown?.ok; attempt++) {
    await run("xdotool", ["windowactivate", "--sync", host]);
    await run("xdotool", ["key", "--clearmodifiers", "ctrl+shift+p"]);
    shown = await until(async () => ({ ok: Boolean(await readCard()) }), 15_000);
  }
  if (!shown?.ok) throw new SetupNotRun("the Computers screen did not show the devserver's card");
  await inPage(`(() => { const s = ${SLOT}; s?.click(); return s ? true : null; })()`);
  await readUntil((card) => card.front, 15_000, "the devserver's card did not come to the front");
  await sleep(600); // the deck's turn
  await run("xdotool", ["windowactivate", "--sync", host]);
  const card = await readUntil((c) => c.face === "healthy" && c.points >= 4, 60_000,
    "the card in front did not read healthy with four points on its chart");
  try {
    await run("import", ["-window", host, path.join(work, "shots", "chart.png")], { timeout: 15_000 });
  } catch (error) {
    logs.push(`screenshot: ${error}`);
  }
  return card;
}

async function insetLeg(card) {
  const { boxes } = card;
  if (!boxes.card || !boxes.baseline) throw new SetupNotRun(`the card's boxes did not read: ${JSON.stringify(boxes)}`);
  const lines = judgeInset(boxes);
  report("inset", lines);
  return lines.every((l) => l.pass);
}

function figuresLeg(card) {
  const lines = judgeFigures(card.missed);
  report("figures", lines);
  return lines.every((l) => l.pass);
}

async function motionLeg(card, reduced) {
  const leg = reduced ? "reduced" : "motion";
  if (card.reduced !== reduced) {
    throw new SetupNotRun(`prefers-reduced-motion reads ${card.reduced} in the page, and the ${leg} leg needs ${reduced}`);
  }
  marking = true;
  const marked = await until(async () => {
    const now = await readCard();
    return { ok: (now?.highs ?? 0) > 0, now };
  }, 20_000);
  if (!marked?.ok) throw new SetupNotRun(`no marked reading reached the chart: ${JSON.stringify(marked?.now ?? null)}`);
  const started = await inPage(call(pageSampler, MARKER_MAX_Y, TRACE_MS, TRACE_PERIOD_MS));
  if (!started?.ok) throw new SetupNotRun(`the page sampler did not start: ${JSON.stringify(started)}`);
  await sleep(TRACE_MS + 1_000);
  const trace = await inPage("window.__chartTrace ?? null");
  if (!Array.isArray(trace)) throw new SetupNotRun("the page sampler left no trace");
  fs.writeFileSync(path.join(work, `trace-${leg}.json`), JSON.stringify(trace) + "\n");
  const verdict = judgeMotion(trace, reduced);
  report(leg, verdict.lines);
  if (!verdict.setup) throw new SetupNotRun(`the ${leg} trace cannot carry a verdict; see ${leg} lines above`);
  return verdict.lines.every((l) => l.pass);
}

let status = 3;
const legStates = [];
try {
  const card = await setup();
  for (const leg of legs) {
    const held = leg === "inset" ? await insetLeg(card)
      : leg === "figures" ? figuresLeg(await readCard())
        : await motionLeg(await readCard(), leg === "reduced");
    legStates.push({ leg, pass: held });
    console.log(`leg ${leg} ${held ? "pass" : "fail"}`);
  }
  status = legStates.every((l) => l.pass) ? 0 : 10;
} catch (error) {
  if (error instanceof SetupNotRun) {
    console.log(`SETUP NOT RUN: ${mask(error.message)}`);
    status = 2;
  } else {
    logs.push(String(error?.stack ?? error));
    console.log(`DRIVER FAILED: ${mask(error?.message ?? error)}`);
    status = 3;
  }
} finally {
  fs.writeFileSync(path.join(work, "results.json"), mask(JSON.stringify({ status, legs: legStates, results }, null, 2)) + "\n");
  fs.writeFileSync(path.join(work, "devserver.log"), mask(logs.join("")));
  await relay?.close();
  server?.kill("SIGTERM");
}
process.exit(status);
