#!/usr/bin/env node
// A survey's overlay press and its body links on chan-desktop's WebKitGTK
// page (survey-links-native.sh starts the desktop, the private xdg-open and
// the window), as the counterpart of browser checks 351 and 354. Two
// terminals in two panes run raw PTY recorders: A carries the survey, B is
// the other pane and holds the keyboard when each survey shows. One body,
// with a link to a URL and a link to a seeded note, serves every leg, and
// each leg raises its own survey:
//
// - press: a press beside the card, on the overlay over A's terminal,
//   makes A the focused pane and leaves the keyboard on the card, and a 2
//   then answers Beta.
// - click: a click on the URL link is cancelled, focuses pane A and shows
//   the drop-down under the link with its one row, OPEN and the URL, and
//   the copy button; nothing opens and the survey stays unanswered.
// - row-url: a press on that row opens the URL once through the system
//   opener and closes the drop-down; the survey stays unanswered.
// - tab-enter: with A focused by a press beside the card, Tab reaches the
//   URL link, Enter makes the engine's click, which is cancelled and shows
//   the drop-down, and a second Enter opens the URL once.
// - tab-mod-enter: Tab to the link and Ctrl+Enter make the engine's Ctrl
//   click, which is cancelled and opens the URL once with no drop-down.
// - footer: a press on the drop-down's footer leaves the keyboard where the
//   click on the link left it and the drop-down open, and 1 answers Alpha.
// - tab-answer: with the drop-down open, Tab to the first answer closes it,
//   and Enter answers Alpha and opens nothing.
// - row-path: a press on the note link's row opens the note as pane A's
//   active tab, hiding the survey's terminal tab with its survey pending,
//   while pane B keeps its terminal.
//
// Every input is real: pointer presses, Tab, Enter, Ctrl+Enter and typed
// keys go through XTEST. The inspector reads the page and plants one
// probe: a bubble-phase click listener on the window, after the app's own,
// records whether the app cancelled each click on a body link and cancels
// one the app left alone, only so that a red run stays on the page. The
// desktop opens a URL through tauri-plugin-opener, whose xdg-open is the
// private recorder first on PATH. A leg that cannot put its question is
// inconclusive and prints no PASS.
//
// Exit 0 every leg held; 10 a leg observed a fault (the wrapper turns it
// into 1); 2 the setup did not run (no page, no terminal, no recorder, or X
// input cannot be placed on the page); 3 inconclusive.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { TERMINAL_SURFACE } from "../browser-smoke/lib/terminal-attach.mjs";
import { recordedSince } from "../browser-smoke/lib/pty-recorder.mjs";
import { maskTokens } from "../browser-smoke/lib/token-mask.mjs";
import { BODY, LEGS, NOTE, NOTE_TEXT, URL_TARGET, judgeLeg, runVerdict } from "./survey-links-verdict.mjs";

const exec = promisify(execFile);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const { values } = parseArgs({
  options: {
    inspector: { type: "string" },
    xid: { type: "string" },
    workspace: { type: "string" },
    output: { type: "string" },
    legs: { type: "string" },
  },
});
if (!values.inspector || !values.xid || !values.workspace || !values.output) {
  console.error("usage: survey-links-native.mjs --inspector HOST:PORT --xid XID --workspace DIR --output DIR [--legs LEG,...]");
  process.exit(2);
}
const selected = values.legs ? values.legs.split(",").map((leg) => leg.trim()).filter(Boolean) : LEGS;
const unknown = selected.filter((leg) => !LEGS.includes(leg));
if (unknown.length || !selected.length) {
  console.error(`unknown legs ${JSON.stringify(unknown)}; the legs are ${LEGS.join(",")}`);
  process.exit(2);
}
const out = resolve(values.output);
const xid = values.xid;
const opened = process.env.SURVEY_LINKS_OPENED;
const bin = process.env.CHAN_BIN;
const windowId = process.env.CHAN_WINDOW_ID;
if (!opened || !bin || !windowId) {
  console.error("SURVEY_LINKS_OPENED, CHAN_BIN and CHAN_WINDOW_ID must be set");
  process.exit(2);
}
process.env.CHAN_NO_DEVSERVER_HANDOFF = "1";

const NAMES = { target: "SurveyLinksA", away: "SurveyLinksB" };
const recorders = join(out, "recorders");
const FILES = { target: join(recorders, "a.bytes"), away: join(recorders, "b.bytes") };
const verdict = {
  engine: "webkitgtk",
  sha: process.env.OBS_SHA ?? null,
  selected,
  setup: "pending",
  legs: {},
  faults: [],
  inconclusive: [],
};
const save = () => writeFileSync(join(out, "survey-links.json"), `${JSON.stringify(verdict, null, 2)}\n`, { mode: 0o600 });
const describe = (error) => maskTokens(error?.message ?? String(error)).slice(0, 600);

class SetupError extends Error {}

async function cs(...args) {
  const env = { ...process.env };
  delete env.CHAN_DESKTOP_BIN;
  try {
    const { stdout } = await exec(bin, ["shell", ...args], { env, timeout: 60_000 });
    return stdout.trim();
  } catch (error) {
    throw new Error(`cs ${args.slice(0, 3).join(" ")} failed: ${describe(error)}`);
  }
}

/// One inspector session on the workspace page, the protocol inspect.mjs
/// speaks, kept open for the run. Page functions are synchronous: the
/// engine's inspector evaluates with no promise to wait on.
class WebKitPage {
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.nextId = 1;
    this.target = null;
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data.toString());
      if (message.method === "Target.targetCreated" && message.params.targetInfo.type === "page" && !this.target) {
        this.target = message.params.targetInfo.targetId;
        this.ready?.();
      } else if (message.method === "Target.dispatchMessageFromTarget") {
        const inner = JSON.parse(message.params.message);
        const call = this.pending.get(inner.id);
        if (!call) return;
        this.pending.delete(inner.id);
        clearTimeout(call.timer);
        if (inner.error || inner.result?.wasThrown) call.reject(new Error(JSON.stringify(inner).slice(0, 400)));
        else call.resolve(inner.result?.result?.value);
      }
    };
    socket.onerror = () => this.failPending(new Error("inspector socket failed"));
    socket.onclose = () => this.failPending(new Error("inspector socket closed"));
  }

  failPending(error) {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }

  static async open(endpoint) {
    const html = await (await fetch(`http://${endpoint}/`, { signal: AbortSignal.timeout(5000) })).text();
    const path = [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)]
      .map(([, cells]) => ({ path: /\/socket\/\d+\/\d+\/\w+/.exec(cells)?.[0], text: cells.replace(/<[^>]+>/g, " ") }))
      .find((row) => row.path && row.text.includes("/workspace-"))?.path;
    if (!path) throw new SetupError("no workspace page in the WebKit inspector");
    const page = new WebKitPage(new WebSocket(`ws://${endpoint}${path}`));
    await Promise.race([
      new Promise((done) => { page.ready = done; }),
      delay(8000).then(() => { throw new SetupError("the page target did not answer"); }),
    ]);
    return page;
  }

  evaluate(fn, ...args) {
    if (!this.target) return Promise.reject(new Error("the inspector has no page target"));
    const id = this.nextId++;
    const expression = `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(",")})`;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) rejectCall(new Error("inspector evaluation timed out"));
      }, 8000);
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
      const inner = JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } });
      this.socket.send(JSON.stringify({ id, method: "Target.sendMessageToTarget", params: { targetId: this.target, message: inner } }));
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* Already gone. */
    }
  }
}

let page;
let offset = null;

/// The value once `ok` accepts it, as { ok, value }, or the last value read
/// with ok false once the bound has passed. A read that throws is the
/// instrument's and propagates.
async function waitFor(read, ok, bound) {
  const deadline = Date.now() + bound;
  for (;;) {
    const value = await read();
    if (ok(value)) return { ok: true, value };
    if (Date.now() > deadline) return { ok: false, value };
    await delay(100);
  }
}

async function xdo(...args) {
  await exec("xdotool", args.map(String), { timeout: 30_000 });
}

// XTEST input to the window, activated first: GTK ignores the synthetic
// events `xdotool --window` sends.
async function activate() {
  await xdo("windowactivate", "--sync", xid);
}

const toScreen = (point) => ({ x: Math.round(point.x + offset.dx), y: Math.round(point.y + offset.dy) });

// XTEST lands asynchronously: an input counts as delivered once the page's
// counter of trusted releases moved, and the reading after it waits that
// long and a short settle more. An input the page never saw is the
// instrument's failure, not the product's.
async function delivered(before, field, what) {
  const seen = await waitFor(counters, (now) => now[field] > before[field], 3000);
  if (!seen.ok) throw new Error(`the page saw no release of ${what}`);
  await delay(150);
}

async function clickClient(point) {
  const screen = toScreen(point);
  await activate();
  await xdo("mousemove", screen.x, screen.y);
  await delay(150);
  const before = await counters();
  await xdo("click", "1");
  await delivered(before, "ups", `the click at ${point.x},${point.y}`);
}

async function key(name) {
  await activate();
  const before = await counters();
  await xdo("key", name);
  await delivered(before, "keyups", name);
}

async function typeText(text) {
  await activate();
  const before = await counters();
  await xdo("type", "--delay", "40", text);
  await delivered(before, "keyups", JSON.stringify(text));
}

/// A screenshot of the X screen into the output's shots folder; a failed
/// capture is logged and decides nothing.
async function shot(name) {
  try {
    mkdirSync(join(out, "shots"), { recursive: true });
    await exec("import", ["-window", "root", join(out, "shots", `${name}.png`)], { timeout: 15_000 });
  } catch (error) {
    console.log(`survey-links screenshot ${name} failed: ${describe(error)}`);
  }
}

// Where X input lands on the page: the offset between a screen point and
// the client point the page's mousemove reports for it, read at two points
// that must agree. Each reading first moves 7 px off and clears the record
// only after that move landed, as terminal-link-native.mjs reads it.
async function calibrate() {
  const geometry = Object.fromEntries((await exec("xdotool", ["getwindowgeometry", "--shell", xid])).stdout.trim().split("\n").map((line) => line.split("=")));
  const [wx, wy, ww, wh] = ["X", "Y", "WIDTH", "HEIGHT"].map((name) => Number(geometry[name]));
  await page.evaluate(() => {
    window.__surveyMove = null;
    addEventListener("mousemove", (event) => {
      window.__surveyMove = { x: event.clientX, y: event.clientY, trusted: event.isTrusted };
    }, true);
  });
  const seen = [];
  for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.35]]) {
    const sx = Math.round(wx + ww * fx);
    const sy = Math.round(wy + wh * fy);
    await activate();
    await xdo("mousemove", sx - 7, sy - 7);
    await delay(120);
    await page.evaluate(() => { window.__surveyMove = null; });
    await xdo("mousemove", sx, sy);
    const move = await waitFor(() => page.evaluate(() => window.__surveyMove), (m) => m?.trusted === true, 3000);
    if (!move.ok) throw new SetupError("the page never saw an XTEST pointer move");
    await delay(120);
    const settled = await page.evaluate(() => window.__surveyMove);
    seen.push({ dx: sx - settled.x, dy: sy - settled.y });
  }
  if (seen.some((p) => p.dx !== seen[0].dx || p.dy !== seen[0].dy)) {
    throw new SetupError(`X input cannot be placed on the page: ${JSON.stringify(seen)}`);
  }
  offset = seen[0];
  verdict.offset = offset;
}

/// The probe: the window's bubble-phase click and auxclick on a body link,
/// read after the app's own listeners, and `window.open`, which the desktop
/// never calls for a link, recorded instead of opening. A default the app
/// left alone is cancelled here so a red run stays on the page. Two
/// capture-phase counters of trusted releases, a mouseup and a keyup, tell
/// the driver when an XTEST input has reached the page.
function plantProbe() {
  if (window.__surveyNative) return "present";
  const probe = { clicks: [], auxclicks: [], opened: [], errors: [], ups: 0, keyups: 0 };
  window.__surveyNative = probe;
  window.open = (url, target, features) => {
    probe.opened.push([String(url), String(target ?? ""), String(features ?? "")]);
    return null;
  };
  const record = (list) => (event) => {
    const link = event.target instanceof Element ? event.target.closest(".survey-body [href]") : null;
    if (!link) return;
    list.push({ prevented: event.defaultPrevented, ctrl: event.ctrlKey, meta: event.metaKey, button: event.button });
    if (!event.defaultPrevented) event.preventDefault();
  };
  addEventListener("click", record(probe.clicks));
  addEventListener("auxclick", record(probe.auxclicks));
  addEventListener("error", (event) => probe.errors.push(String(event.message).slice(0, 300)));
  addEventListener("mouseup", (event) => { if (event.isTrusted) probe.ups += 1; }, true);
  addEventListener("keyup", (event) => { if (event.isTrusted) probe.keyups += 1; }, true);
  return "planted";
}

function takeProbe() {
  const probe = window.__surveyNative;
  if (!probe) return null;
  return { clicks: probe.clicks.splice(0), auxclicks: probe.auxclicks.splice(0), opened: probe.opened.splice(0), errors: probe.errors.splice(0) };
}

function readCounters() {
  const probe = window.__surveyNative;
  return probe ? { ups: probe.ups, keyups: probe.keyups } : null;
}

// Everything the probe recorded, in order, for the run; a leg reads the
// part after a mark it took.
const ledger = { clicks: [], auxclicks: [], opened: [], errors: [] };

async function pull() {
  const taken = await page.evaluate(takeProbe);
  if (!taken) throw new Error("the page's probe is gone: the page was loaded again");
  for (const name of Object.keys(ledger)) ledger[name].push(...taken[name]);
}

async function counters() {
  const read = await page.evaluate(readCounters);
  if (!read) throw new Error("the page's probe is gone: the page was loaded again");
  return read;
}

const openerLines = () => (existsSync(opened) ? readFileSync(opened, "utf8").split("\n").filter(Boolean) : []);

async function mark() {
  await pull();
  return { clicks: ledger.clicks.length, auxclicks: ledger.auxclicks.length, opened: ledger.opened.length, errors: ledger.errors.length, xdg: openerLines().length };
}

/// What the page and the system opener recorded since `from`: the probe's
/// clicks, the webview's window.open calls (`window`) and xdg-open's lines
/// (`xdg`). With `expectOpen` it first waits up to 10 s for an open, then,
/// either way, 1 s more in which a late or second one would land.
async function since(from, expectOpen = false) {
  if (expectOpen) {
    await waitFor(async () => {
      await pull();
      return openerLines().length > from.xdg || ledger.opened.length > from.opened;
    }, Boolean, 10_000);
  }
  await delay(1000);
  await pull();
  return {
    clicks: ledger.clicks.slice(from.clicks),
    auxclicks: ledger.auxclicks.slice(from.auxclicks),
    errors: ledger.errors.slice(from.errors),
    opened: { xdg: openerLines().slice(from.xdg).map(maskTokens), window: ledger.opened.slice(from.opened) },
  };
}

/// Where the keyboard is and how A's survey and both panes stand, read in
/// one pass. `keyboard` names the URL or path link by its href, an answer
/// by its label, the card itself as "survey", and a terminal as "target"
/// or "away".
function readState(targetTab, awayTab) {
  const terminal = (tab) => document.querySelector(`.terminal-tab[data-terminal-tab-id="${tab}"]`);
  const target = terminal(targetTab);
  const away = terminal(awayTab);
  const card = target?.querySelector(".survey-card") ?? null;
  const active = document.activeElement;
  const answer = card && active?.closest ? active.closest(".survey-option") : null;
  let keyboard;
  if (card && active?.matches?.(".survey-body [href]") && card.contains(active)) keyboard = `link:${active.getAttribute("href")}`;
  else if (answer && card.contains(answer)) keyboard = `answer:${answer.querySelector(".survey-option-label")?.textContent?.trim() ?? "?"}`;
  else if (card?.contains(active)) keyboard = "survey";
  else if (away?.querySelector(".terminal-host")?.contains(active)) keyboard = "away";
  else if (target?.querySelector(".terminal-host")?.contains(active)) keyboard = "target";
  else keyboard = `${active?.tagName ?? "none"}.${active?.className?.toString?.() ?? ""}`;
  return {
    targetPane: target?.closest(".pane")?.getAttribute("data-pane-id") ?? null,
    awayPane: away?.closest(".pane")?.getAttribute("data-pane-id") ?? null,
    focusedPane: document.querySelector(".pane.focused")?.getAttribute("data-pane-id") ?? null,
    keyboard,
    surveyOpen: Boolean(card),
    targetTabActive: Boolean(target?.classList.contains("active")),
    awayTabActive: Boolean(away?.classList.contains("active")),
    dropDowns: document.querySelectorAll(".md-bubble").length,
  };
}

/// The drop-downs showing: each one's rows as text (the OPEN tag and the
/// target as written), its copy button, and whether it sits under the body
/// link `href`.
function readDropDowns(tab, href) {
  const link = [...document.querySelectorAll(`.terminal-tab[data-terminal-tab-id="${tab}"] .survey-body a[href]`)]
    .find((a) => a.getAttribute("href") === href) ?? null;
  const linkBox = link?.getBoundingClientRect() ?? null;
  return [...document.querySelectorAll(".md-bubble")].map((wrap) => {
    const box = wrap.getBoundingClientRect();
    return {
      rows: [...wrap.querySelectorAll(".md-bubble-row")].map((row) => [...row.querySelectorAll(":scope > span")].map((span) => span.textContent)),
      copy: Boolean(wrap.querySelector(".copy-btn")),
      underLink: Boolean(linkBox && box.top >= linkBox.bottom - 1),
      box: { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) },
    };
  });
}

/// The centre of the body link `href` with what the page hit-tests there.
function linkPoint(tab, href) {
  const link = [...document.querySelectorAll(`.terminal-tab[data-terminal-tab-id="${tab}"] .survey-body a[href]`)]
    .find((a) => a.getAttribute("href") === href);
  if (!link) return { ok: false, hit: `no body link ${href}` };
  const box = link.getBoundingClientRect();
  const x = Math.round(box.left + box.width / 2);
  const y = Math.round(box.top + box.height / 2);
  const hit = document.elementFromPoint(x, y);
  return { x, y, ok: Boolean(hit && (hit === link || link.contains(hit))), hit: `${hit?.tagName ?? "none"}.${hit?.className?.toString?.() ?? ""}` };
}

/// The centre of the first element `selector` names, with its hit-test.
function elementPoint(selector) {
  const el = document.querySelector(selector);
  if (!el) return { ok: false, hit: `no ${selector}` };
  const box = el.getBoundingClientRect();
  const x = Math.round(box.left + box.width / 2);
  const y = Math.round(box.top + box.height / 2);
  const hit = document.elementFromPoint(x, y);
  return { x, y, ok: Boolean(hit && (hit === el || el.contains(hit))), hit: `${hit?.tagName ?? "none"}.${hit?.className?.toString?.() ?? ""}` };
}

/// A point in A's terminal above its survey's card, halfway between the
/// top of the overlay and the top of the card, as check 351 presses it.
function besidePoint(tab) {
  const terminal = document.querySelector(`.terminal-tab[data-terminal-tab-id="${tab}"]`);
  const overlay = terminal?.querySelector(".survey-overlay");
  const card = overlay?.querySelector(".survey-card");
  const host = terminal?.querySelector(".terminal-host");
  if (!overlay || !card || !host) return { onOverlay: false, inTerminal: false, hit: "no survey overlay, card or terminal host" };
  const o = overlay.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  const h = host.getBoundingClientRect();
  const x = Math.round(c.left + c.width / 2);
  const y = Math.round(o.top + (c.top - o.top) / 2);
  const hit = document.elementFromPoint(x, y);
  return {
    x, y,
    hit: `${hit?.tagName ?? "none"}.${hit?.className?.toString?.() ?? ""}`,
    onOverlay: hit === overlay,
    inTerminal: x >= h.left && x <= h.right && y >= h.top && y <= h.bottom,
  };
}

/// The centre of a terminal's host, for a press that gives it the keyboard.
function hostPoint(tab) {
  const host = document.querySelector(`.terminal-tab[data-terminal-tab-id="${tab}"] .terminal-host`);
  if (!host) return null;
  const box = host.getBoundingClientRect();
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
}

function pageWhere() {
  return { at: location.origin + location.pathname, probed: Boolean(window.__surveyNative) };
}

function dispatchCommand(name) {
  window.dispatchEvent(new CustomEvent("chan:command", { detail: { name } }));
  return true;
}

let target;
let away;
const surveys = [];
const state = () => page.evaluate(readState, target.tab, away.tab);
const dropDowns = (href = URL_TARGET) => page.evaluate(readDropDowns, target.tab, href);
const bytes = (file, from = 0) => existsSync(file)
  ? [...readFileSync(file).subarray(from)].map((byte) => byte.toString(16).padStart(2, "0"))
  : [];

/// The terminal `name` from the server's own list, once its pane and tab
/// are listed and its canvas shows on the page.
async function listedTerminal(name) {
  const listed = JSON.parse(await cs("terminal", "list", "--json"));
  const row = Object.values(listed.groups ?? {}).flat().find((entry) => entry.name === name);
  if (!row?.pane || !row.tab) return { row: row ?? null, shown: false };
  const shown = await page.evaluate((tab, surface) => {
    const box = document.querySelector(`.terminal-tab[data-terminal-tab-id="${tab}"] ${surface}`)?.getBoundingClientRect();
    return Boolean(box && box.width > 0 && box.height > 0);
  }, row.tab, TERMINAL_SURFACE);
  return { row, shown };
}

async function openRecorder(name, file, pane) {
  if (file.includes("'")) throw new SetupError(`the recorder path ${file} holds a quote`);
  const args = ["terminal", "new", "--window", windowId, "--tab-name", name, "--command", `stty raw -echo && exec dd bs=1 status=none of='${file}'`];
  if (pane) args.push("--pane", pane);
  await cs(...args);
  const attached = await waitFor(() => listedTerminal(name), (v) => v.shown === true, 60_000);
  if (!attached.ok) throw new SetupError(`terminal ${name} did not attach: ${JSON.stringify(attached.value).slice(0, 300)}`);
  const started = await waitFor(async () => existsSync(file), Boolean, 30_000);
  if (!started.ok) throw new SetupError(`the recorder of ${name} wrote no ${file}`);
  return { tab: attached.value.row.tab, pane: attached.value.row.pane };
}

/// A press on a terminal's host gives it the keyboard and its pane focus.
async function focusTerminal(tab) {
  const point = await page.evaluate(hostPoint, tab);
  if (!point) throw new Error(`terminal ${tab} has no host`);
  await clickClient(point);
  const held = await waitFor(() => page.evaluate((tab) => {
    const terminal = document.querySelector(`.terminal-tab[data-terminal-tab-id="${tab}"]`);
    const pane = terminal?.closest(".pane");
    return Boolean(pane?.classList.contains("focused") && terminal.querySelector(".terminal-host")?.contains(document.activeElement));
  }, tab), Boolean, 10_000);
  return held.ok;
}

async function setup() {
  page = await WebKitPage.open(values.inspector);
  await calibrate();
  mkdirSync(join(values.workspace, NOTE.split("/")[0]), { recursive: true });
  writeFileSync(join(values.workspace, NOTE), `# Survey native\n\n${NOTE_TEXT}\n`);
  mkdirSync(recorders, { recursive: true, mode: 0o700 });
  verdict.probe = await page.evaluate(plantProbe);
  verdict.startAt = (await page.evaluate(pageWhere)).at;
  target = await openRecorder(NAMES.target, FILES.target, null);
  if (!(await focusTerminal(target.tab))) throw new SetupError("a press on A's terminal did not give it the keyboard");
  await typeText("t");
  verdict.targetControl = await recordedSince("A's control", FILES.target, 0, "74").catch((error) => {
    throw new SetupError(describe(error));
  });
  await page.evaluate(dispatchCommand, "app.pane.splitRight");
  const split = await waitFor(() => page.evaluate(() => [...document.querySelectorAll(".pane[data-pane-id]")]
    .map((pane) => ({ id: pane.getAttribute("data-pane-id"), terminals: pane.querySelectorAll(".terminal-tab").length }))),
  (panes) => panes.length === 2 && panes.some((pane) => pane.terminals === 0), 10_000);
  if (!split.ok) throw new SetupError(`the split left no empty second pane: ${JSON.stringify(split.value)}`);
  away = await openRecorder(NAMES.away, FILES.away, split.value.find((pane) => pane.terminals === 0).id);
  if (!(await focusTerminal(away.tab))) throw new SetupError("a press on B's terminal did not give it the keyboard");
  await typeText("a");
  verdict.awayControl = await recordedSince("B's control", FILES.away, 0, "61").catch((error) => {
    throw new SetupError(describe(error));
  });
  verdict.initial = await state();
  if (!verdict.initial.targetPane || verdict.initial.targetPane === verdict.initial.awayPane) {
    throw new SetupError(`the terminals are not in two panes: ${JSON.stringify(verdict.initial)}`);
  }
  verdict.setup = "observed";
  save();
}

/// Raise A's survey and wait for its card; the CLI's reply, once it exits,
/// lands in `handle.result`.
async function raiseSurvey(label) {
  const handle = { label, result: null };
  const env = { ...process.env };
  delete env.CHAN_DESKTOP_BIN;
  execFile(bin, ["shell", "terminal", "survey", "--tab-name", NAMES.target, "--timeout", "60",
    "--title", `Survey links: ${label}`, "--option", "Alpha", "--option", "Beta", BODY], { env, timeout: 90_000 },
  (error, stdout, stderr) => {
    handle.result = {
      code: error ? (error.code ?? "unknown") : 0,
      stdout: maskTokens(String(stdout ?? "").trim()),
      stderr: maskTokens(String(stderr ?? "").trim()).slice(0, 400),
    };
  });
  surveys.push(handle);
  // A survey that never shows, or whose CLI exits first, is read by the
  // leg's first precondition.
  await waitFor(async () => handle.result ?? (await page.evaluate((tab) =>
    Boolean(document.querySelector(`.terminal-tab[data-terminal-tab-id="${tab}"] .survey-card`)), target.tab)),
  (v) => v === true || typeof v === "object", 15_000);
  await delay(300);
  return handle;
}

const replyWithin = (handle, ms) => waitFor(async () => handle.result, Boolean, ms).then((r) => r.value ?? null);

/// Survey up and unanswered after a pause in which a reply would arrive.
async function afterWait(handle) {
  const reply = await replyWithin(handle, 1000);
  return { reply, surveyOpen: (await state()).surveyOpen };
}

/// A plain XTEST click on the body link `href` and what it shows; true
/// when a drop-down shows.
async function plainClick(obs, href) {
  obs.linkPoint = await page.evaluate(linkPoint, target.tab, href);
  if (!obs.linkPoint.ok) return false;
  const from = await mark();
  await clickClient(obs.linkPoint);
  obs.dropDowns = (await waitFor(() => dropDowns(href), (list) => list.length > 0, 3000)).value;
  obs.afterClick = await state();
  const after = await since(from);
  obs.clicks = after.clicks;
  obs.pageErrors = after.errors;
  obs.openedByClick = after.opened;
  return obs.dropDowns.length > 0;
}

/// A press beside the card, then Tab onto the URL link; true once the
/// keyboard is on it.
async function tabToLink(obs) {
  obs.point = await page.evaluate(besidePoint, target.tab);
  if (!obs.point.onOverlay || !obs.point.inTerminal) return false;
  await clickClient(obs.point);
  const onCard = await waitFor(state, (s) => s.focusedPane === s.targetPane && s.keyboard === "survey", 3000);
  obs.onCard = onCard.value;
  if (!onCard.ok) return false;
  await key("Tab");
  obs.onLink = (await waitFor(state, (s) => s.keyboard !== "survey", 2000)).value.keyboard;
  return obs.onLink === `link:${URL_TARGET}`;
}

const ROW_TARGET = ".md-bubble .md-bubble-row > span:nth-of-type(2)";

const LEG_STEPS = {
  async press(obs, handle) {
    obs.point = await page.evaluate(besidePoint, target.tab);
    if (!obs.point.onOverlay || !obs.point.inTerminal) return;
    await clickClient(obs.point);
    // The card takes the keyboard a microtask after the pane's own handler;
    // a press that drops it to the page leaves it there.
    obs.afterPress = (await waitFor(state, (s) => s.focusedPane === s.targetPane && s.keyboard === "survey", 2000)).value;
    await shot("press-after");
    await typeText("2");
    obs.reply = await replyWithin(handle, 5000);
  },

  async click(obs, handle) {
    await plainClick(obs, URL_TARGET);
    await shot("click-dropdown");
    obs.afterWait = await afterWait(handle);
  },

  async "row-url"(obs, handle) {
    if (!(await plainClick(obs, URL_TARGET))) return;
    obs.rowPoint = await page.evaluate(elementPoint, ROW_TARGET);
    if (!obs.rowPoint.ok) return;
    const from = await mark();
    await clickClient(obs.rowPoint);
    obs.openedByRow = (await since(from, true)).opened;
    obs.dropDownsAfter = (await state()).dropDowns;
    obs.afterWait = await afterWait(handle);
  },

  async "tab-enter"(obs, handle) {
    if (!(await tabToLink(obs))) return;
    const from = await mark();
    await key("Return");
    obs.dropDowns = (await waitFor(() => dropDowns(), (list) => list.length > 0, 3000)).value;
    const first = await since(from);
    obs.clicks = first.clicks;
    obs.openedByFirst = first.opened;
    await shot("tab-enter-dropdown");
    const again = await mark();
    await key("Return");
    obs.openedBySecond = (await since(again, true)).opened;
    obs.dropDownsAfter = (await state()).dropDowns;
    obs.afterWait = await afterWait(handle);
  },

  async "tab-mod-enter"(obs, handle) {
    if (!(await tabToLink(obs))) return;
    const from = await mark();
    await key("ctrl+Return");
    const after = await since(from, true);
    obs.clicks = after.clicks;
    obs.opened = after.opened;
    obs.dropDownsAfter = (await state()).dropDowns;
    obs.afterWait = await afterWait(handle);
  },

  async footer(obs, handle) {
    if (!(await plainClick(obs, URL_TARGET))) return;
    obs.beforePress = await state();
    if (!obs.beforePress.keyboard.startsWith("link:") && obs.beforePress.keyboard !== "survey") return;
    obs.footerPoint = await page.evaluate(elementPoint, ".md-bubble .md-bubble-status");
    if (!obs.footerPoint.ok) return;
    const from = await mark();
    await clickClient(obs.footerPoint);
    obs.afterPress = await state();
    obs.dropDownsAfterPress = await dropDowns();
    await shot("footer-after-press");
    await typeText("1");
    obs.reply = await replyWithin(handle, 3000);
    obs.openedAfterPress = (await since(from)).opened;
  },

  async "tab-answer"(obs, handle) {
    if (!(await plainClick(obs, URL_TARGET))) return;
    const from = await mark();
    // From the URL link the first Tab reaches the path link and the second
    // the first answer; from the card itself one more Tab comes first.
    obs.tabStops = [];
    for (let i = 0; i < 3; i++) {
      const before = (await state()).keyboard;
      await key("Tab");
      const moved = await waitFor(state, (s) => s.keyboard !== before, 2000);
      obs.tabStops.push(moved.value.keyboard);
      if (!moved.ok || moved.value.keyboard.startsWith("answer:")) break;
    }
    if (obs.tabStops.at(-1) !== "answer:Alpha") return;
    obs.dropDownsOnAnswer = (await state()).dropDowns;
    await shot("tab-answer-on-alpha");
    await key("Return");
    obs.reply = await replyWithin(handle, 3000);
    obs.openedAfterTab = (await since(from)).opened;
  },

  async "row-path"(obs, handle) {
    if (!(await plainClick(obs, NOTE))) return;
    obs.rowPoint = await page.evaluate(elementPoint, ROW_TARGET);
    if (!obs.rowPoint.ok) return;
    const from = await mark();
    await clickClient(obs.rowPoint);
    obs.note = (await waitFor(() => page.evaluate((pane, text) => {
      const root = document.querySelector(`.pane[data-pane-id="${pane}"]`);
      return [...(root?.querySelectorAll(".cm-content") ?? [])]
        .some((el) => el.textContent?.includes(text) && el.getBoundingClientRect().width > 0);
    }, target.pane, NOTE_TEXT), Boolean, 15_000)).ok;
    obs.afterOpen = await state();
    await shot("row-path-note");
    obs.openedByRow = (await since(from)).opened;
    obs.replyAfterOpen = await replyWithin(handle, 1000);
  },
};

/// Close what a leg left: the note tab in pane A, then the survey by its
/// Dismiss (a page-side click; cleanup is not an observation), then wait
/// for the survey and the drop-down to go. Each failure is recorded.
async function cleanupLeg(name, record, handle) {
  try {
    if (name === "row-path") {
      const s = await state();
      if (!s.targetTabActive && s.focusedPane === s.targetPane) {
        await page.evaluate(dispatchCommand, "app.tab.close");
        record.afterNoteClosed = (await waitFor(state, (v) => v.targetTabActive, 5000)).value;
      } else if (!s.targetTabActive) {
        record.cleanupErrors.push(`pane A shows another tab and is not focused: ${JSON.stringify(s)}`);
      }
    }
    if (handle && !handle.result) {
      await page.evaluate((tab) => {
        document.querySelector(`.terminal-tab[data-terminal-tab-id="${tab}"] .survey-dismiss`)?.click();
        return true;
      }, target.tab);
      if (!(await replyWithin(handle, 10_000))) record.cleanupErrors.push("the survey was not dismissed");
    }
    if (handle) record.finalReply = handle.result;
    const gone = await waitFor(state, (s) => s.dropDowns === 0 && !s.surveyOpen, 5000);
    if (!gone.ok) record.cleanupErrors.push(`a survey or a drop-down stays: ${JSON.stringify(gone.value)}`);
  } catch (error) {
    record.cleanupErrors.push(describe(error));
  }
}

async function runLeg(name) {
  const obs = { startAt: verdict.startAt };
  const record = { obs, cleanupErrors: [] };
  verdict.legs[name] = record;
  let handle = null;
  try {
    record.awayFocused = await focusTerminal(away.tab);
    const offsets = { target: bytes(FILES.target).length, away: bytes(FILES.away).length };
    handle = await raiseSurvey(name);
    obs.appeared = await state();
    const s = obs.appeared;
    if (s.surveyOpen && s.focusedPane === s.awayPane && s.keyboard === "away" && s.dropDowns === 0) {
      await LEG_STEPS[name](obs, handle);
      // A byte a key sent to a PTY lands well inside this wait.
      await delay(500);
      obs.ptyBytes = { target: bytes(FILES.target, offsets.target), away: bytes(FILES.away, offsets.away) };
      obs.where = await page.evaluate(pageWhere);
    }
  } catch (error) {
    obs.error = describe(error);
    await shot(`${name}-error`);
  } finally {
    await cleanupLeg(name, record, handle);
  }
  Object.assign(record, judgeLeg(name, obs));
  const failed = record.lines.filter((l) => l.pass === false).map((l) => l.name);
  const unread = record.lines.filter((l) => l.pass === null).map((l) => `unread: ${l.name}`);
  if (record.status === "pass") console.log(`PASS survey-links ${name}`);
  else if (record.status === "fail") console.log(`FAIL survey-links ${name}: ${failed.join("; ")}`);
  else console.log(`INCONCLUSIVE survey-links ${name}: ${[...failed, ...(obs.error ? [obs.error] : []), ...unread].join("; ")}`);
  save();
  return { name, status: record.status };
}

/// One key typed into each terminal reaches that terminal's own recorder,
/// so a recorder that stopped cannot read as a leg's silence.
async function controlAfterLegs() {
  const control = { observed: false };
  verdict.afterLegs = control;
  try {
    for (const [side, terminal, char, byte] of [["target", target, "u", "75"], ["away", away, "v", "76"]]) {
      const from = bytes(FILES[side]).length;
      if (!(await focusTerminal(terminal.tab))) throw new Error(`a press on the ${side} terminal did not give it the keyboard`);
      await typeText(char);
      control[side] = await recordedSince(`${side} control after the legs`, FILES[side], from, byte);
      if (control[side].length !== 1) throw new Error(`${side} control bytes after the legs ${JSON.stringify(control[side])}`);
    }
    control.observed = true;
  } catch (error) {
    control.error = describe(error);
  }
  save();
  return control.observed;
}

let status = 3;
try {
  try {
    await setup();
  } catch (error) {
    verdict.setup = "not run";
    verdict.setupError = describe(error);
    save();
    console.log(`SETUP survey-links ${verdict.setupError}`);
    status = error instanceof SetupError ? 2 : 3;
    throw error;
  }
  const results = [];
  for (const name of LEGS.filter((leg) => selected.includes(leg))) results.push(await runLeg(name));
  const afterLegs = await controlAfterLegs();
  const run = runVerdict(results, afterLegs);
  Object.assign(verdict, { faults: run.faults, inconclusive: run.inconclusive, reason: run.reason ?? null });
  save();
  if (run.code === 10) console.log(`FAULTS survey-links ${JSON.stringify(run.faults)}`);
  else if (run.code === 3) console.log(`INCONCLUSIVE survey-links ${run.reason}: ${JSON.stringify(run.inconclusive)}`);
  else console.log(`PASS survey-links all ${results.length} selected legs held`);
  status = run.code;
} catch (error) {
  if (verdict.setup !== "not run") {
    verdict.error = describe(error);
    console.log(`INCONCLUSIVE survey-links the driver failed: ${verdict.error}`);
    status = 3;
  }
} finally {
  for (const name of [NAMES.target, NAMES.away]) {
    await cs("terminal", "close", "--tab-name", name).catch(() => {});
  }
  for (const handle of surveys) {
    if (!handle.result) await waitFor(async () => handle.result, Boolean, 15_000).catch(() => null);
  }
  verdict.surveys = surveys.map((handle) => ({ label: handle.label, result: handle.result }));
  try {
    save();
  } catch {
    /* The output dir is gone; the lines above are the record. */
  }
  page?.close();
}
process.exit(status);
