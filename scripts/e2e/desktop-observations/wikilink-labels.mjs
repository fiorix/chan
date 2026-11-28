#!/usr/bin/env node
// A wikilink's label in a table cell on chan-desktop's WebKitGTK page
// (wikilink-labels.sh starts the desktop and the window). It seeds a note
// and a table document whose link cell holds [[note]] and whose code cell
// holds the same link in backticks, opens the table with `cs open`, waits
// for the fixture's editor to mount in rendered mode and for the table
// widget to draw its grid, and reads the body row's two cells from the
// page: each cell's text, its links, wiki pills and code elements.
//
// The question is the link cell's: it must show the label, `note`, as
// text, with no link and no pill, while the code cell keeps `[[note]]` in
// its code element. Before the table widget rendered labels the link cell
// showed `[[note]]` as typed.
//
// Every reading is a page function evaluated through the engine's remote
// inspector (inspect.mjs) and called in its own expression, synchronous,
// since the inspector evaluates with no promise to wait on. The page whose
// listing holds "/workspace-" is the one read, and each reading carries
// that page's window id, which must be the window the fixture was opened
// in. The fixture's editor is found by the line above its table, so a
// reading is never taken from another tab.
//
// Exit 0 the label held; 10 a fault was observed (the wrapper turns it into
// 1); 2 the setup did not run (no fixture written, or the open refused), so
// nothing was read; 3 inconclusive. wikilink-labels.json in the output
// directory keeps the observation, its lines and the verdict.

import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { maskTokens } from "../browser-smoke/lib/token-mask.mjs";
import { MARKER, NOTE, NOTE_TEXT, TABLE, TABLE_TEXT, exitCode, judge } from "./wikilink-labels-verdict.mjs";

const exec = promisify(execFile);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const { values } = parseArgs({
  options: {
    inspector: { type: "string" },
    xid: { type: "string" },
    workspace: { type: "string" },
    output: { type: "string" },
  },
});
if (!values.inspector || !values.xid || !values.workspace || !values.output) {
  console.error("usage: wikilink-labels.mjs --inspector HOST:PORT --xid XID --workspace DIR --output DIR");
  process.exit(2);
}
const out = resolve(values.output);
const workspace = resolve(values.workspace);
const bin = process.env.CHAN_BIN;
const windowId = process.env.CHAN_WINDOW_ID;
if (!bin || !windowId || !process.env.CHAN_CONTROL_SOCKET) {
  console.error("CHAN_BIN, CHAN_WINDOW_ID and CHAN_CONTROL_SOCKET must be set");
  process.exit(2);
}

const record = {
  engine: "webkitgtk",
  sha: process.env.OBS_SHA ?? null,
  setup: "pending",
  observation: { window: windowId },
  verdict: null,
};
const save = () => writeFileSync(join(out, "wikilink-labels.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
// An inspector error lists the pages it saw, URLs and their tokens with them.
const describe = (error) => maskTokens(String(error?.stderr || error?.message || error).trim()).slice(0, 600);

/// The workspace page through inspect.mjs, one process per reading. A page
/// function is passed whole and called with its arguments as JSON.
const page = {
  async evaluate(fn, ...args) {
    const expression = `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(",")})`;
    const inspect = new URL("inspect.mjs", import.meta.url).pathname;
    const { stdout } = await exec(process.execPath, [inspect, values.inspector, "eval", "/workspace-", expression],
      { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  },
};

/// The value once `ok` accepts it, as { ok, value }, or the last value read
/// with ok false once the bound has passed. A reading that throws counts as
/// no value until the bound; its last error is kept beside the value.
async function waitFor(read, ok, bound) {
  const deadline = Date.now() + bound;
  let value;
  let error = null;
  for (;;) {
    try {
      value = await read();
      error = null;
      if (ok(value)) return { ok: true, value };
    } catch (caught) {
      error = describe(caught);
    }
    if (Date.now() > deadline) return { ok: false, value, error };
    await delay(300);
  }
}

/// The fixture's editor and, when it is drawn, its table widget's grid. The
/// editor is the one editor tab whose document text holds the marker line;
/// the grid is read only from inside it.
function readDocument(marker) {
  const w = new URLSearchParams(location.search).get("w");
  const editors = [...document.querySelectorAll(".editor-tab")].filter((tab) =>
    (tab.querySelector(".cm-content")?.textContent ?? "").includes(marker));
  if (editors.length !== 1) return { w, editors: editors.length };
  const tab = editors[0];
  const mode = tab.querySelector(".md-wysiwyg-cm6") ? "rendered" : tab.querySelector(".md-source") ? "source" : null;
  const wraps = [...tab.querySelectorAll(".cm-md-table-wrap")];
  const cellOf = (cell) => ({
    text: cell.textContent,
    html: cell.innerHTML.slice(0, 400),
    links: cell.querySelectorAll("a").length,
    pills: cell.querySelectorAll(".cm-md-wiki-pill").length,
    code: [...cell.querySelectorAll("code")].map((code) => code.textContent),
  });
  const grid = wraps[0];
  return {
    w,
    editors: 1,
    active: tab.classList.contains("active"),
    mode,
    wraps: wraps.length,
    headers: grid ? [...grid.querySelectorAll("thead th")].map((th) => th.textContent) : null,
    rows: grid ? [...grid.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map(cellOf)) : null,
  };
}

async function main() {
  try {
    writeFileSync(join(workspace, NOTE), NOTE_TEXT);
    writeFileSync(join(workspace, TABLE), TABLE_TEXT);
    const env = { ...process.env };
    delete env.CHAN_DESKTOP_BIN;
    const { stdout } = await exec(bin, ["shell", "open", TABLE], { cwd: workspace, env, timeout: 60_000 });
    record.setup = "done";
    record.open = maskTokens(stdout.trim());
  } catch (error) {
    record.setup = `not run: ${describe(error)}`;
    save();
    console.error(`wikilink-labels: SETUP NOT RUN: ${record.setup}`);
    return 2;
  }
  save();

  const obs = record.observation;
  const read = () => page.evaluate(readDocument, MARKER);
  // Hang guard: the open is queued, and the tab mounts its editor after it.
  const opened = await waitFor(read, (doc) => doc?.editors === 1 && doc.mode !== null, 60_000);
  obs.opened = opened.value;
  if (opened.error) obs.openedError = opened.error;
  if (opened.ok && opened.value.mode === "rendered") {
    // Hang guard: the widget draws once the document is parsed past the table.
    const drawn = await waitFor(read, (doc) => doc?.editors === 1 && doc.wraps >= 1 && (doc.rows?.length ?? 0) >= 1, 30_000);
    obs.grid = drawn.value;
    if (drawn.error) obs.gridError = drawn.error;
  }
  try {
    await exec("import", ["-window", values.xid, join(out, "grid.png")], { timeout: 30_000 });
    record.shot = "grid.png";
  } catch (error) {
    record.shot = `failed: ${describe(error)}`;
  }

  const judged = judge(obs);
  record.verdict = judged;
  save();
  for (const line of judged.lines) console.log(JSON.stringify(line));
  const cells = JSON.stringify(obs.grid?.rows?.[0]?.map((cell) => cell.text) ?? null);
  if (judged.status === "pass") console.log(`wikilink-labels: PASS: cells ${cells} (WebKitGTK)`);
  else if (judged.status === "fail") console.error(`wikilink-labels: FAULT: the link cell reads ${judged.reading}: cells ${cells} (WebKitGTK)`);
  else console.error(`wikilink-labels: INCONCLUSIVE: a precondition failed or went unread: cells ${cells} (WebKitGTK)`);
  return exitCode(judged);
}

let code;
try {
  code = await main();
} catch (error) {
  record.error = describe(error);
  save();
  console.error(`wikilink-labels: INCONCLUSIVE: the driver itself failed: ${record.error}`);
  code = 3;
}
process.exit(code);
