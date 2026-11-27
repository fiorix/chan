#!/usr/bin/env node
// The check-296 reset on the real WebKitGTK desktop at GDK_SCALE=2: open
// one terminal, paint pages, read painted pixels per quarter plus
// the transform, drop the canvas drawing state by a same-size reset, and
// refocus the window (the app's forced passes run on focus). At the tip
// the repaint lands at full scale; at the base it stays in the top-left
// quarter. Run once per tree: base first, then tip. Exit 0 held; the
// wrapper exits 1 on an observed fault (this driver exits 10 through its
// judge), 3 when inconclusive, 2 when refused. Runs only in the desktop
// guest; syntax-checked here.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({ options: {
  inspector: { type: "string" },
  xid: { type: "string" },
  output: { type: "string" },
} });
for (const key of ["inspector", "xid", "output"]) {
  if (!args[key]) {
    console.error(`scale2-repaint: --${key} is required`);
    process.exit(3);
  }
}
if (!process.env.CHAN_BIN) {
  console.error("scale2-repaint: CHAN_BIN is not exported");
  process.exit(2);
}
mkdirSync(args.output, { recursive: true, mode: 0o700 });

class Incomplete extends Error {}
class Fault extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const save = (name, value) =>
  writeFileSync(join(args.output, name), JSON.stringify(value, null, 2) + "\n");
const CHAN = process.env.CHAN_BIN;
const WID = process.env.CHAN_WINDOW_ID ?? "";

function run(executable, words, label, bound = 30000) {
  const call = spawnSync(executable, words.map(String), {
    encoding: "utf8", timeout: bound, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
  });
  if (call.status !== 0) throw new Incomplete(`${label}: status ${call.status}: ${call.error?.message ?? call.stderr}`);
  return (call.stdout ?? "").trim();
}
const cs = (words) => run(CHAN, ["shell", ...words], `cs ${words.slice(0, 2).join(" ")}`, 90000);
const xdo = (...words) => run("xdotool", words, `xdotool ${words[0]}`, 15000);
const evaluate = (expression) =>
  JSON.parse(run(process.execPath, [new URL("inspect.mjs", import.meta.url).pathname,
    args.inspector, "eval", "/workspace-", expression], "inspect", 15000));

// One terminal canvas: more than one means the tab lookup is ambiguous.
const FIND = `(() => {
  const canvases = document.querySelectorAll(".terminal-host > canvas").length;
  if (canvases !== 1) return { canvases };
  return { ok: true };
})()`;
const COUNT = `(() => {
  const c = document.querySelector(".terminal-host > canvas");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  const w = c.width >> 1, h = c.height >> 1;
  const total = [0, 0, 0, 0];
  const seen = new Map();
  const at = (x, y) => (y * c.width + x) * 4;
  const quarterOf = (x, y) => (y < h ? 0 : 2) + (x < w ? 0 : 1);
  for (let y = 0; y < c.height; y += 2)
    for (let x = 0; x < c.width; x += 4) {
      const q = quarterOf(x, y);
      total[q]++;
      const o = at(x, y);
      if (d[o + 3] === 0) continue;
      const key = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
      seen.set(key, (seen.get(key) || 0) + 1);
    }
  let bg = 0;
  let bgCount = -1;
  for (const [key, n] of seen) {
    if (n > bgCount) {
      bg = key;
      bgCount = n;
    }
  }
  const br = (bg >> 16) & 255, bgg = (bg >> 8) & 255, bb = bg & 255;
  const opaque = [0, 0, 0, 0];
  const ink = [0, 0, 0, 0];
  for (let y = 0; y < c.height; y += 2)
    for (let x = 0; x < c.width; x += 4) {
      const q = quarterOf(x, y);
      const o = at(x, y);
      if (d[o + 3] === 0) continue;
      opaque[q]++;
      if (Math.abs(d[o] - br) + Math.abs(d[o + 1] - bgg) + Math.abs(d[o + 2] - bb) > 36) ink[q]++;
    }
  const t = c.getContext("2d").getTransform();
  return { total, opaque, ink, bg: [br, bgg, bb],
    quarters: opaque, width: c.width, height: c.height,
    scaleX: t.a, scaleY: t.d, ratio: window.devicePixelRatio,
    visibility: document.visibilityState, focused: document.hasFocus(),
    events: window.__scale2Events ?? null };
})()`;
const MEASURE = COUNT;
// Reset and measure in one synchronous expression: the frame loop paints
// the cursor between two round trips, which would read as leftover paint.
const RESET_AND_MEASURE = COUNT.replace(
  "const c = document.querySelector(\".terminal-host > canvas\");",
  "const c = document.querySelector(\".terminal-host > canvas\"); c.width = c.width;",
);
// The page's focus and visibility events from the reset on: the app's
// forced passes run on a window focus or a return to visible, so a
// refocus that delivered neither never asked the product to repaint.
const EVENTS = `(() => {
  const seen = window.__scale2Events = { focus: 0, blur: 0, visible: 0, hidden: 0 };
  addEventListener("focus", () => { seen.focus++; });
  addEventListener("blur", () => { seen.blur++; });
  document.addEventListener("visibilitychange", () => { seen[document.visibilityState === "visible" ? "visible" : "hidden"]++; });
  return true;
})()`;

async function poll(read, accept, label, bound, timeoutKind) {
  const until = Date.now() + bound;
  let value;
  let lastError = null;
  do {
    try {
      value = await read();
    } catch (error) {
      lastError = error;
      await sleep(300);
      continue;
    }
    if (accept(value)) return value;
    await sleep(300);
  } while (Date.now() < until);
  const detail = lastError ? `read failed: ${lastError.message}; last value ${JSON.stringify(value)}` : `last ${JSON.stringify(value)}`;
  const error = timeoutKind === "fault" ? new Fault(`${label}: ${detail}`) : new Incomplete(`${label}: ${detail}`);
  error.value = value;
  throw error;
}

async function main() {
  const panes = JSON.parse(cs(["pane", "list", "--window", WID, "--json"]));
  const pane = panes.activePaneId ?? panes.panes?.[0]?.id;
  if (!pane) throw new Incomplete("the workspace names no pane");
  const tab = "scale2-repaint";
  cs(["terminal", "new", "--window", WID, "--pane", pane, "--side", "a", "--tab-name", tab]);
  // Hang guard: the new terminal takes a moment to mount its canvas.
  await poll(async () => evaluate(FIND),
    (f) => f.ok === true, "no terminal canvas mounted", 15000, "incomplete").catch((error) => {
    throw new Incomplete(error.message);
  });
  // Hang guard: the shell takes a moment to answer on the fresh pty.
  await poll(async () => cs(["terminal", "scrollback", "--tab-name", tab]),
    (text) => text.length > 0, "the shell never answered", 15000, "incomplete").catch((error) => {
    throw new Incomplete(error.message);
  });
  cs(["terminal", "write", "--tab-name", tab,
`for i in $(seq -w 1 60); do printf 'HS2_LINE_%s the quick brown fox jumps over the lazy dog, packing my box with five dozen liquor jugs\\n' "$i"; done; printf '%0180d\\n' 0; printf 'HS2_%s\\n' DONE
`]);
  // The marker prints after every other line, and the echoed command
  // never spells it whole, so the page under the baseline is the
  // finished one, not a frame taken while the lines still scroll in.
  await poll(async () => cs(["terminal", "scrollback", "--tab-name", tab]),
    (text) => /^HS2_DONE\s*$/m.test(text), "the paint write never finished", 30000, "incomplete");
  // A cursor-only repaint leaves dozens of ink samples; the prose leaves
  // thousands in every quarter. The floor stays low: the desktop window
  // is smaller than the browser's, and a glyphless repaint reads near zero.
  const INK_FLOOR = 100;
  // Settled: two reads in a row agree, as browser check 296 takes its
  // baseline, so a frame still landing is not the reference.
  const quiet = (a, b) => a && b && a.opaque.every((q, i) => q === b.opaque[i])
    && a.ink.every((q, i) => Math.abs(q - b.ink[i]) <= Math.max(50, b.ink[i] * 0.05));
  let previous = null;
  const baseline = await poll(async () => evaluate(MEASURE),
    (m) => {
      const settled = quiet(previous, m);
      previous = m;
      return m.ratio === 2 && m.scaleX === 2 && m.opaque.every((q, i) => q === m.total[i])
        && m.ink.every((q) => q >= INK_FLOOR) && settled;
    },
    "no stable full-scale paint", 30000, "incomplete").catch((error) => {
    if (error.message.includes('"ratio":1')) {
      throw new Incomplete("the guest does not run at that scale: devicePixelRatio is 1");
    }
    throw new Incomplete(error.message);
  });
  save("baseline.json", baseline);
  // Printed lines on a background leave both ink and plain samples: ink
  // equal to the opaque count means the reference is not the background.
  if (baseline.ink.some((q, i) => q >= baseline.opaque[i])) {
    throw new Incomplete(`the baseline counts every opaque sample as ink: ${JSON.stringify(baseline)}`);
  }
  run("import", ["-window", args.xid, join(args.output, "baseline.png")], "screenshot baseline", 30000);
  if (evaluate(EVENTS) !== true) throw new Incomplete("the page took no event counter");
  const hidden = await evaluate(RESET_AND_MEASURE);
  save("hidden.json", hidden);
  if (hidden.quarters.some((q) => q !== 0)) {
    throw new Incomplete(`the discard left paint behind: ${JSON.stringify(hidden.quarters)}`);
  }
  if (hidden.scaleX !== 1 || hidden.scaleY !== 1) {
    throw new Incomplete(`the discard did not reset the transform: ${JSON.stringify(hidden)}`);
  }
  xdo("windowminimize", args.xid);
  // Settle: let the minimize land before the refocus, so the focus event
  // fires on a hidden window and the app runs its forced passes.
  await sleep(1000);
  xdo("windowactivate", "--sync", args.xid);
  const band = (b) => Math.max(200, Math.round(b * 0.1));
  // Only this wait is a product fault: every earlier wait is an
  // instrument fault, thrown as Incomplete by the poll itself.
  const after = await poll(async () => evaluate(MEASURE),
    (m) => m.width === baseline.width && m.height === baseline.height
      && m.scaleX === 2 && m.scaleY === 2
      && m.opaque.every((q, i) => q === m.total[i])
      && m.ink.every((q, i) => Math.abs(q - baseline.ink[i]) <= band(baseline.ink[i])),
    "the terminal did not repaint at full scale after the refocus", 10000, "fault").catch((error) => {
    // A fault needs a read of the page and a refocus that reached it;
    // without either the product was never asked to repaint.
    const events = error.value?.events;
    if (error instanceof Fault && !events) throw new Incomplete(`no read of the page after the refocus: ${error.message}`);
    if (error instanceof Fault && events.focus === 0 && events.visible === 0) {
      throw new Incomplete(`the refocus reached the page under test as neither a focus nor a return to visible: ${error.message}`);
    }
    throw error;
  });
  save("after.json", after);
  run("import", ["-window", args.xid, join(args.output, "after.png")], "screenshot after", 30000);
  let tree = null;
  try {
    tree = run("git", ["rev-parse", "HEAD"], "tree", 10000);
  } catch { /* the tree sha is the wrapper's record */ }
  save("verdict.json", { held: true, tree, baseline: baseline.quarters, after: after.quarters });
  console.log(`HELD: quarters ${after.quarters} at scale ${after.scaleX} on tree ${tree}`);
}

try {
  await main();
} catch (error) {
  if (error instanceof Fault) {
    console.error(`FAULT: ${error.message}`);
    process.exit(10);
  }
  console.error(`INCOMPLETE: ${error.message}`);
  process.exit(3);
}
