#!/usr/bin/env node
// The check-296 reset on the real WebKitGTK desktop at GDK_SCALE=2: open
// one terminal, paint pages, read the samples off the background per
// quarter plus the transform, drop the canvas drawing state by a
// same-size reset, and refocus the window (the app's forced passes run on
// focus). At the tip the repaint lands at full scale; at the base it stays
// in the top-left quarter. Run once per tree: base first, then tip. Exit 0 held; the
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
// Per quarter, every sampled pixel (`total`), those with any alpha
// (`painted`) and those that differ from the background (`marks`, also
// `quarters`). The background is the most common sample of the canvas,
// clear counted as one value. chan-desktop builds every window
// transparent and the terminal then leaves default-background cells
// clear, so there the background is clear and the marks are the painted
// glyphs and cursor; on an opaque terminal the background is the row
// fill and the marks are the samples off its colour.
const COUNT = `(() => {
  const c = document.querySelector(".terminal-host > canvas");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  const w = c.width >> 1, h = c.height >> 1;
  const CLEAR = -1;
  const at = (x, y) => (y * c.width + x) * 4;
  const quarterOf = (x, y) => (y < h ? 0 : 2) + (x < w ? 0 : 1);
  const keyAt = (o) => d[o + 3] === 0 ? CLEAR : (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
  const total = [0, 0, 0, 0];
  const painted = [0, 0, 0, 0];
  const seen = new Map();
  for (let y = 0; y < c.height; y += 2)
    for (let x = 0; x < c.width; x += 4) {
      const q = quarterOf(x, y);
      const key = keyAt(at(x, y));
      total[q]++;
      if (key !== CLEAR) painted[q]++;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
  let bg = CLEAR;
  let bgCount = -1;
  for (const [key, n] of seen) {
    if (n > bgCount) {
      bg = key;
      bgCount = n;
    }
  }
  const br = (bg >> 16) & 255, bgg = (bg >> 8) & 255, bb = bg & 255;
  const marks = [0, 0, 0, 0];
  for (let y = 0; y < c.height; y += 2)
    for (let x = 0; x < c.width; x += 4) {
      const o = at(x, y);
      const marked = bg === CLEAR ? d[o + 3] !== 0
        : d[o + 3] === 0 || Math.abs(d[o] - br) + Math.abs(d[o + 1] - bgg) + Math.abs(d[o + 2] - bb) > 36;
      if (marked) marks[quarterOf(x, y)]++;
    }
  const t = c.getContext("2d").getTransform();
  return { total, painted, marks, quarters: marks,
    bg: bg === CLEAR ? "clear" : "rgb(" + br + "," + bgg + "," + bb + ")",
    width: c.width, height: c.height,
    scaleX: t.a, scaleY: t.d, ratio: window.devicePixelRatio,
    visibility: document.visibilityState, focused: document.hasFocus(),
    events: window.__scale2Events ?? null };
})()`;
const MEASURE = COUNT;
// The page's focus and visibility events from the reset on: the app's
// forced passes run on a window focus or a return to visible, and the
// minimize must reach the page as a blur or a hide first. The counter is
// installed and zeroed in the reset's own synchronous expression, so no
// event can land between the zero and the reset.
const ZERO_EVENTS = `if (!window.__scale2Events) {
    const counts = window.__scale2Events = {};
    addEventListener("focus", () => { counts.focus++; });
    addEventListener("blur", () => { counts.blur++; });
    document.addEventListener("visibilitychange", () => { counts[document.visibilityState === "visible" ? "visible" : "hidden"]++; });
  }
  Object.assign(window.__scale2Events, { focus: 0, blur: 0, visible: 0, hidden: 0 });`;
// Reset and measure in one synchronous expression: the frame loop paints
// the cursor between two round trips, which would read as leftover paint.
const RESET_AND_MEASURE = COUNT.replace(
  "const c = document.querySelector(\".terminal-host > canvas\");",
  `const c = document.querySelector(".terminal-host > canvas"); ${ZERO_EVENTS} c.width = c.width;`,
);

// The bound is judged on its last attempt. When that attempt failed the
// page may have changed since the last value read, so the outcome is
// inconclusive whatever the earlier reads showed, and the error carries no
// value for a caller to judge; otherwise the error carries that last,
// fresh read.
async function poll(read, accept, label, bound, timeoutKind) {
  const until = Date.now() + bound;
  let value;
  let failure = null;
  do {
    try {
      value = await read();
      failure = null;
    } catch (error) {
      failure = error;
      await sleep(300);
      continue;
    }
    if (accept(value)) return value;
    await sleep(300);
  } while (Date.now() < until);
  if (failure) {
    throw new Incomplete(`${label}: read failed: ${failure.message}; last value ${JSON.stringify(value)}`);
  }
  const detail = `last ${JSON.stringify(value)}`;
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
  // Counts are shares of a quarter's samples, so they hold at any window
  // size. The written page marks about a seventh of every quarter; one
  // cell, the cursor alone, about a fifth of a percent of one quarter. The
  // floor asks for text in every quarter, which a half-scale paint (three
  // quarters empty) and a partial or glyphless frame lack. The band holds
  // what may differ between the baseline and a full repaint of the same
  // screen (the cursor, a prompt line painted late) and stays half the
  // floor, so a read inside it keeps marks in every quarter, about ten
  // times what a cursor-only repaint leaves.
  const FLOOR = 0.04;
  const BAND = 0.02;
  const floorOf = (total) => Math.ceil(total * FLOOR);
  const bandOf = (total) => Math.floor(total * BAND);
  const near = (a, b) => a.bg === b.bg
    && a.marks.every((q, i) => Math.abs(q - b.marks[i]) <= bandOf(b.total[i]));
  // Settled: two reads in a row agree, as browser check 296 takes its
  // baseline, so a frame still landing is not the reference.
  let previous = null;
  const baseline = await poll(async () => evaluate(MEASURE),
    (m) => {
      const settled = previous !== null && near(m, previous);
      previous = m;
      return m.ratio === 2 && m.scaleX === 2 && m.scaleY === 2
        && m.marks.every((q, i) => q >= floorOf(m.total[i])) && settled;
    },
    "no stable full-scale paint", 30000, "incomplete").catch((error) => {
    if (typeof error.value?.ratio === "number" && error.value.ratio !== 2) {
      throw new Incomplete(`the guest does not run at that scale: devicePixelRatio is ${error.value.ratio}`);
    }
    throw new Incomplete(error.message);
  });
  save("baseline.json", baseline);
  // Printed lines leave most of every quarter background: a quarter
  // mostly marked means the reference is not the background.
  if (baseline.marks.some((q, i) => q * 2 >= baseline.total[i])) {
    throw new Incomplete(`the background is not most of every quarter: ${JSON.stringify(baseline)}`);
  }
  run("import", ["-window", args.xid, join(args.output, "baseline.png")], "screenshot baseline", 30000);
  const hidden = await evaluate(RESET_AND_MEASURE);
  save("hidden.json", hidden);
  if (hidden.painted.some((q) => q !== 0)) {
    throw new Incomplete(`the discard left paint behind: ${JSON.stringify(hidden.painted)}`);
  }
  if (hidden.scaleX !== 1 || hidden.scaleY !== 1) {
    throw new Incomplete(`the discard did not reset the transform: ${JSON.stringify(hidden)}`);
  }
  const zeroed = hidden.events;
  if (!zeroed || ["focus", "blur", "visible", "hidden"].some((name) => zeroed[name] !== 0)) {
    throw new Incomplete(`the page took no event counter at the reset: ${JSON.stringify(zeroed)}`);
  }
  xdo("windowminimize", args.xid);
  // Settle: let the minimize land before the refocus, so the focus event
  // fires on a hidden window and the app runs its forced passes.
  await sleep(1000);
  xdo("windowactivate", "--sync", args.xid);
  // A verdict either way needs the minimize to have reached the page under
  // test: with no blur and no hide since the reset another X window took
  // it, and a repaint or its absence says nothing about this page.
  const sawHide = (read, detail) => {
    if (!read) throw new Incomplete(`no read of the page after the refocus: ${detail}`);
    const events = read.events;
    if (!events) throw new Incomplete(`the page lost its event counter: ${detail}`);
    if (events.blur === 0 && events.hidden === 0) {
      throw new Incomplete(`the page under test saw neither a blur nor a hide after the reset: ${detail}`);
    }
    return events;
  };
  // Only this wait is a product fault: every earlier wait is an
  // instrument fault, thrown as Incomplete by the poll itself.
  const after = await poll(async () => evaluate(MEASURE),
    (m) => m.width === baseline.width && m.height === baseline.height
      && m.scaleX === 2 && m.scaleY === 2 && near(m, baseline),
    "the terminal did not repaint at full scale after the refocus", 10000, "fault").catch((error) => {
    if (!(error instanceof Fault)) throw error;
    // A fault also needs a refocus that reached the page; without a focus
    // or a return to visible the product was never asked to repaint.
    const events = sawHide(error.value, error.message);
    if (events.focus === 0 && events.visible === 0) {
      throw new Incomplete(`the refocus reached the page under test as neither a focus nor a return to visible: ${error.message}`);
    }
    throw error;
  });
  sawHide(after, `last ${JSON.stringify(after)}`);
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
