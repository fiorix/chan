#!/usr/bin/env node
// Wakescale acceptance 5: the check-296 reset on the real WebKitGTK desktop
// at GDK_SCALE=2. Opens one ghostty terminal, paints pages, reads painted
// pixels per quarter plus the transform, drops the canvas drawing state by
// a same-size reset, and refocuses the window (the app's forced passes run
// on focus). At the tip the repaint lands at full scale; at the base it
// stays in the top-left quarter. Run once per tree: base first, then tip.
// Exit 0 held, 10 observed fault, 3 incomplete. Unrunnable here: it needs
// the desktop guest, so this file is syntax-checked only until Ops runs it.
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
    console.error(`wakescale-gdk2: --${key} is required`);
    process.exit(3);
  }
}
mkdirSync(args.output, { recursive: true, mode: 0o700 });

class Incomplete extends Error {}
class Fault extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const save = (name, value) =>
  writeFileSync(join(args.output, name), JSON.stringify(value, null, 2) + "\n");
const CHAN = process.env.CHAN_BIN ?? "cs";
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

const FIND = `(() => {
  const all = [...document.querySelectorAll(".terminal-host canvas")];
  if (all.length !== 1) return JSON.stringify({ canvases: all.length });
  return JSON.stringify({ ok: true });
})()`;
const MEASURE = `(() => {
  const c = document.querySelector(".terminal-host canvas");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  const w = c.width >> 1, h = c.height >> 1;
  const quarters = [0, 0, 0, 0];
  for (let y = 0; y < c.height; y += 2)
    for (let x = 0; x < c.width; x += 4) {
      const at = (y * c.width + x) * 4;
      if (d[at] + d[at + 1] + d[at + 2] > 30) quarters[(y < h ? 0 : 2) + (x < w ? 0 : 1)] += 1;
    }
  const t = c.getContext("2d").getTransform();
  return JSON.stringify({ quarters, width: c.width, height: c.height,
    scaleX: t.a, scaleY: t.d, ratio: window.devicePixelRatio });
})()`;
const RESET = `(() => {
  const c = document.querySelector(".terminal-host canvas");
  c.width = c.width;
  return "reset";
})()`;

async function poll(read, accept, label, bound = 10000) {
  const until = Date.now() + bound;
  let value;
  do {
    value = await read();
    if (accept(value)) return value;
    await sleep(300);
  } while (Date.now() < until);
  throw new Fault(`${label}: last ${JSON.stringify(value)}`);
}

async function main() {
  const panes = JSON.parse(cs(["pane", "list", "--window", WID, "--json"]));
  const pane = panes.activePaneId ?? panes.panes?.[0]?.id;
  if (!pane) throw new Incomplete("the workspace names no pane");
  const tab = "wakescale-gdk2";
  cs(["terminal", "new", "--window", WID, "--pane", pane, "--side", "a", "--tab-name", tab]);
  const found = JSON.parse(await evaluate(FIND));
  if (!found.ok) throw new Incomplete(`the fresh workspace holds ${found.canvases} terminal canvases`);
  cs(["terminal", "write", "--tab-name", tab,
    `for i in $(seq -w 1 60); do printf 'HS2_LINE_%s the quick brown fox jumps over the lazy dog, packing my box with five dozen liquor jugs\\\\n' "$i"; done; printf '%0180d\\\\n' 0; printf 'HS2_DONE\\\\n'\\n`]);
  const baseline = await poll(async () => JSON.parse(await evaluate(MEASURE)),
    (m) => m.ratio === 2 && m.scaleX === 2 && m.quarters.every((q) => q > 2000),
    "no stable full-scale paint", 30000).catch((error) => {
    if (error instanceof Fault) {
      const last = JSON.parse(error.message.slice(error.message.indexOf("last ") + 5));
      if (last.ratio !== 2) throw new Incomplete(`the guest does not run at that scale: devicePixelRatio is ${last.ratio}`);
    }
    throw error;
  });
  save("baseline.json", baseline);
  await evaluate(RESET);
  const hidden = JSON.parse(await evaluate(MEASURE));
  save("hidden.json", hidden);
  if (hidden.quarters.some((q) => q !== 0)) {
    throw new Fault(`the discard left paint behind: ${JSON.stringify(hidden.quarters)}`);
  }
  if (hidden.scaleX !== 1 || hidden.scaleY !== 1) {
    throw new Incomplete(`the discard did not reset the transform: ${JSON.stringify(hidden)}`);
  }
  xdo("windowminimize", args.xid);
  await sleep(1000);
  xdo("windowactivate", "--sync", args.xid);
  const band = (b) => Math.max(200, Math.round(b * 0.02));
  const after = await poll(async () => JSON.parse(await evaluate(MEASURE)),
    (m) => m.width === baseline.width && m.height === baseline.height
      && m.scaleX === 2 && m.scaleY === 2
      && m.quarters.every((q, i) => Math.abs(q - baseline.quarters[i]) <= band(baseline.quarters[i])),
    "the terminal did not repaint at full scale after the refocus", 10000);
  save("after.json", after);
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
