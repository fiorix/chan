#!/usr/bin/env node
// A Tab walk on chan-desktop's WebKitGTK page never lands in the terminal
// of a pane that is not the active one, and keys typed after the walk never
// reach that terminal's program: browser check 353's legs, walked by real
// key presses through XTEST in the desktop's own engine, whose sequential
// navigation may differ from Chrome's.
//
// Pane A's terminal sits before pane B in the page, pane B is the active
// pane, and a raw PTY recorder behind each terminal establishes where typed
// keys went. Each walk starts on a tab label placed by script, since a press
// on a label hands the keyboard to its terminal, and records every element
// it lands on with that element's pane and the active pane. It ends back at
// its start, in a terminal, where Tab and Shift+Tab are the program's keys,
// on a step after which the page no longer holds the focus (WebKitGTK can
// hand it to the window past the page's last stop), or at a step limit.
// Then `zq` is typed and both recorders are read.
//
// - forward, backward: Tab and Shift+Tab from B's tab label. Tab meets B's
//   terminal before A's place; Shift+Tab crosses A's place.
// - forward-from-a: Tab from A's tab label, placed by script with B still
//   the active pane, across A's place and on to B's terminal.
// - survey-*: the same three walks with a survey up over A's terminal.
// - program-tab: with B's terminal holding the keyboard, Tab and Shift+Tab
//   reach its program (09, then ESC [ Z) and move neither the keyboard nor
//   the active pane.
// - control: a press on A's terminal with B active makes A the active pane
//   with the keyboard in its terminal; then Tab from A's tab label lands in
//   A's terminal and the typed keys reach A's PTY. Without it a pass could
//   not tell a terminal out of the Tab order from a walk that never lands
//   in any terminal on this engine.
//
// Every leg starts by a press on B's terminal with no survey up. A survey
// leg's cleanup presses the card's dismiss in pane A, which makes A the
// active pane, so the next leg's start is itself a press on a terminal
// outside the active pane, read as the control's press is.
//
// What XTEST drives and what the inspector drives is deliberate: every
// press, Tab and typed key goes through the real input path; the walk's
// start is placed by script focus, as assistive technology can place it,
// and the split goes through the page's own command bus. A trusted Tab
// keydown the page records is the proof each press arrived.
//
// tab-order-verdict.mjs judges the readings. Exit 0 held, 10 a fault (the
// wrapper's obs_judge turns it into 1), 3 inconclusive, 2 refused. The
// readings are in OUTPUT/tab-order.json, a shot per leg in OUTPUT/shots.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { recordedSince } from "../browser-smoke/lib/pty-recorder.mjs";
import { TERMINAL_SURFACE } from "../browser-smoke/lib/terminal-attach.mjs";
import { maskTokens } from "../browser-smoke/lib/token-mask.mjs";
import { BACKTAB_BYTES, LEGS, TAB_BYTES, judge } from "./tab-order-verdict.mjs";

const exec = promisify(execFile);
const now = () => Number(process.hrtime.bigint()) / 1e6;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const describe = (error) => maskTokens(error?.message ?? String(error));
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

const { values } = parseArgs({
  options: {
    inspector: { type: "string" },
    xid: { type: "string" },
    output: { type: "string" },
  },
});
for (const key of ["inspector", "xid", "output"]) {
  if (!values[key]) {
    console.error(`tab-order: --${key} is required`);
    process.exit(3);
  }
}
const bin = process.env.CHAN_BIN;
const windowId = process.env.CHAN_WINDOW_ID;
if (!bin || !windowId || !process.env.CHAN_CONTROL_SOCKET) {
  console.error("tab-order: CHAN_BIN, CHAN_WINDOW_ID and CHAN_CONTROL_SOCKET must be exported");
  process.exit(2);
}
process.env.CHAN_NO_DEVSERVER_HANDOFF = "1";
const out = resolve(values.output);
const xid = values.xid;
mkdirSync(join(out, "pty"), { recursive: true, mode: 0o700 });

const WALK_LIMIT = 24;
/// How long a press gets to reach the page as a trusted keydown.
const KEY_MS = 3_000;
/// After the page saw a press: its focus move is done, and this lets the
/// widget's own focus handlers run before the step is read.
const SETTLE_MS = 150;
/// How long typed keys get to reach a PTY that is not expected to read them.
const QUIET_MS = 1_500;
const PRESS_MS = 10_000;

const report = {
  engine: "webkitgtk",
  sha: process.env.OBS_SHA ?? null,
  run: { setup: "pending", setupErrors: [], cleanupErrors: [], legs: [] },
  cleanupErrors: [],
};
const run = report.run;
const save = () => writeFileSync(join(out, "tab-order.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
const say = (line) => console.log(maskTokens(line));

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
        const pending = this.pending.get(inner.id);
        if (!pending) return;
        this.pending.delete(inner.id);
        clearTimeout(pending.timer);
        if (inner.error || inner.result?.wasThrown) pending.reject(new Error(JSON.stringify(inner)));
        else pending.resolve(inner.result?.result?.value);
      }
    };
    socket.onerror = () => this.failPending(new Error("inspector socket failed"));
    socket.onclose = () => this.failPending(new Error("inspector socket closed"));
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  static async open(endpoint) {
    const response = await fetch(`http://${endpoint}/`, { signal: AbortSignal.timeout(5000) });
    const html = await response.text();
    const rows = [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)];
    const found = rows
      .map(([, cells]) => {
        const path = /\/socket\/\d+\/\d+\/\w+/.exec(cells)?.[0];
        return path ? { path, text: cells.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() } : null;
      })
      .filter(Boolean)
      .find((entry) => entry.text.includes("/workspace-"));
    if (!found) throw new Error("no native workspace page in the WebKit inspector");
    const socket = new WebSocket(`ws://${endpoint}${found.path}`);
    const page = new WebKitPage(socket);
    await Promise.race([
      new Promise((done) => {
        page.ready = done;
      }),
      delay(8000).then(() => {
        throw new Error("page target did not answer");
      }),
    ]);
    return page;
  }

  /// A function and its arguments, serialized as one call: the inspector
  /// takes a source string, and a function object does not survive JSON.
  /// WebKitGTK's inspector does not await a promise, so a page function
  /// here is synchronous.
  evaluate(fn, ...args) {
    if (!this.target) throw new Error("WebKit inspector has no page target");
    const body = `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(",")})`;
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error("inspector evaluation timed out"));
      }, 8000);
      this.pending.set(id, { resolve: done, reject, timer });
      const inner = JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: body, returnByValue: true } });
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

async function until(label, read, predicate, bound = 20_000) {
  const start = now();
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (now() - start > bound) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(value)?.slice(0, 400)}`);
    await delay(100);
  }
}

async function xdotool(...args) {
  try {
    const { stdout } = await exec("xdotool", args, { timeout: 30_000 });
    return stdout.trim();
  } catch (error) {
    throw new Error(`xdotool ${args.join(" ")} failed: ${error.message}`);
  }
}

/// The window raised and focused before a pointer press. Keys go to the
/// X focus without it, so a walk's presses never re-activate the window.
async function activate() {
  await xdotool("windowactivate", "--sync", xid);
}

async function cs(args, options = {}) {
  const env = { ...process.env };
  delete env.CHAN_DESKTOP_BIN;
  try {
    const { stdout } = await exec(bin, ["shell", ...args], { env, timeout: 75_000, ...options });
    return stdout.trim();
  } catch (error) {
    throw new Error(`cs ${args.slice(0, 2).join(" ")} failed: ${describe(error)}`);
  }
}

/// The page's own record of the trusted Tab keydowns it saw (by key, code or
/// keyCode, since GTK may name Shift+Tab ISO_Left_Tab) and of its errors.
/// Installed once; a page that reloads loses it, which reads as the
/// instrument failing.
async function installRecorder() {
  return page.evaluate(() => {
    if (!window.__tabOrderNative) {
      const record = { tabs: 0, last: null, errors: [] };
      window.__tabOrderNative = record;
      window.addEventListener("keydown", (event) => {
        if (!event.isTrusted) return;
        if (event.key === "Tab" || event.code === "Tab" || event.keyCode === 9) {
          record.tabs += 1;
          record.last = { key: event.key, code: event.code, shift: event.shiftKey };
        }
      }, true);
      window.addEventListener("error", (event) => record.errors.push(String(event.message).slice(0, 300)));
      window.addEventListener("unhandledrejection", (event) => record.errors.push(String(event.reason).slice(0, 300)));
    }
    return true;
  });
}

// Where X input lands on the page: the offset between a screen point and
// the client point the page's mousemove reports for it, read at two points,
// which must agree. The page's own window.screenX/Y does not place the
// webview on WebKitGTK.
let offset = null;

async function calibrate() {
  const geometry = Object.fromEntries((await xdotool("getwindowgeometry", "--shell", xid)).split("\n").map((line) => line.split("=")));
  const [wx, wy, ww, wh] = ["X", "Y", "WIDTH", "HEIGHT"].map((key) => Number(geometry[key]));
  await page.evaluate(() => {
    window.__tabOrderMove = null;
    addEventListener("mousemove", (event) => {
      window.__tabOrderMove = { x: event.clientX, y: event.clientY, trusted: event.isTrusted };
    }, true);
    return true;
  });
  const seen = [];
  for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.35]]) {
    const sx = Math.round(wx + ww * fx);
    const sy = Math.round(wy + wh * fy);
    await page.evaluate(() => {
      window.__tabOrderMove = null;
      return true;
    });
    await activate();
    await xdotool("mousemove", String(sx - 7), String(sy - 7));
    await delay(120);
    await xdotool("mousemove", String(sx), String(sy));
    await until("the page sees the pointer move", () => page.evaluate(() => window.__tabOrderMove), (move) => move?.trusted, 3_000);
    await delay(120);
    const move = await page.evaluate(() => window.__tabOrderMove);
    seen.push({ dx: sx - move.x, dy: sy - move.y });
  }
  if (seen.some((point) => point.dx !== seen[0].dx || point.dy !== seen[0].dy)) {
    throw new Error(`X input cannot be placed on the page: the calibration's two points disagree: ${JSON.stringify(seen)}`);
  }
  offset = seen[0];
  report.offset = offset;
}

/// A press point the instrument can stand behind: the element's centre must
/// hit-test to the element itself or inside it, or the press proves nothing
/// about it.
async function pressPoint(selector) {
  const point = await page.evaluate((query) => {
    const el = document.querySelector(query);
    if (!el) return { missing: true };
    const box = el.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0)) return { empty: true };
    const x = Math.round(box.left + box.width / 2);
    const y = Math.round(box.top + box.height / 2);
    const hit = document.elementFromPoint(x, y);
    return { x, y, under: hit === el || el.contains(hit) ? null : hit ? `${hit.tagName}.${hit.getAttribute("class") ?? ""}` : "nothing" };
  }, selector);
  if (point.missing) throw new Error(`no ${selector}`);
  if (point.empty) throw new Error(`${selector} has no box`);
  if (point.under !== null) throw new Error(`the centre of ${selector} hit-tests to ${point.under}, not the element`);
  return { x: Math.round(point.x + offset.dx), y: Math.round(point.y + offset.dy) };
}

/// A real pointer click on the element's centre.
async function click(selector) {
  const point = await pressPoint(selector);
  await activate();
  await xdotool("mousemove", String(point.x), String(point.y), "click", "1");
}

/// A key press through XTEST, read back from the page's keydown record:
/// whether a trusted Tab keydown arrived for it, and whether it came
/// shifted. The page's focus move is done by the time the record shows it.
async function pressKey(key) {
  const before = await page.evaluate(() => window.__tabOrderNative?.tabs ?? null);
  if (before === null) throw new Error("the page lost its key recorder");
  await xdotool("key", "--clearmodifiers", key === "Shift+Tab" ? "shift+Tab" : "Tab");
  const seen = await until(`the page sees ${key}`, () => page.evaluate(() => window.__tabOrderNative
    ? { tabs: window.__tabOrderNative.tabs, last: window.__tabOrderNative.last } : null),
  (value) => value === null || value.tabs > before, KEY_MS).catch(() => undefined);
  if (seen === null) throw new Error("the page lost its key recorder");
  await delay(SETTLE_MS);
  return seen === undefined ? { reached: false, shift: null } : { reached: true, shift: seen.last?.shift === true };
}

async function typeKeys(...keys) {
  await xdotool("key", "--clearmodifiers", ...keys);
}

/// A screenshot of the whole X screen. A failed capture is named and never
/// decides the run.
async function shot(name) {
  try {
    mkdirSync(join(out, "shots"), { recursive: true });
    await exec("import", ["-window", "root", join(out, "shots", `${name}.png`)], { timeout: 15_000 });
    return `${name}.png`;
  } catch (error) {
    say(`tab-order screenshot ${name} failed: ${error.message}`);
    return "unavailable";
  }
}

const terminalSelector = (tab) => `.terminal-tab[data-terminal-tab-id="${tab}"]`;
const labelSelector = (pane) => `.pane[data-pane-id="${pane}"] .tabs [role="tab"]`;
const bytes = (file, from = 0) => existsSync(file)
  ? [...readFileSync(file).subarray(from)].map((byte) => byte.toString(16).padStart(2, "0"))
  : [];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/// Where the keyboard is, read in one pass against A's and B's terminals and
/// the walk's start: the element, its pane, the active pane, where the
/// element lies against A's terminal host in document order, and whether
/// the page holds the focus at all.
function where(targetTab, awayTab, start = null) {
  return page.evaluate((args) => {
    const terminal = (tab) => document.querySelector(`.terminal-tab[data-terminal-tab-id="${tab}"]`);
    const target = terminal(args.targetTab);
    const away = terminal(args.awayTab);
    const targetHost = target?.querySelector(".terminal-host") ?? null;
    const awayHost = away?.querySelector(".terminal-host") ?? null;
    const active = document.activeElement;
    const onBody = !active || active === document.body;
    const name = onBody ? "" : (active.getAttribute("aria-label") || active.getAttribute("title") ||
      active.textContent?.trim() || "").slice(0, 32);
    const tabIndex = (element) => element?.getAttribute("tabindex") ?? null;
    let relation = "none";
    if (targetHost && !onBody) {
      relation = targetHost.contains(active) ? "inside"
        : targetHost.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_PRECEDING ? "before" : "after";
    }
    return {
      element: `${active?.tagName ?? "none"}.${active?.getAttribute?.("class") ?? ""}`,
      name,
      pane: onBody ? null : active.closest(".pane")?.getAttribute("data-pane-id") ?? null,
      focusedPane: document.querySelector(".pane.focused")?.getAttribute("data-pane-id") ?? null,
      targetPane: target?.closest(".pane")?.getAttribute("data-pane-id") ?? null,
      awayPane: away?.closest(".pane")?.getAttribute("data-pane-id") ?? null,
      inTargetHost: relation === "inside",
      inAwayHost: Boolean(awayHost && !onBody && awayHost.contains(active)),
      // A terminal is attached while its widget's input is in its host.
      targetAttached: Boolean(targetHost?.querySelector("textarea")),
      awayAttached: Boolean(awayHost?.querySelector("textarea")),
      inTargetTab: Boolean(target && !onBody && target.contains(active)),
      relation,
      atStart: Boolean(args.start) && !onBody && active === document.querySelector(args.start),
      surveyOpen: Boolean(target?.querySelector(".survey-card")),
      hasFocus: document.hasFocus(),
      tabIndexes: {
        targetHost: tabIndex(targetHost),
        targetInput: tabIndex(targetHost?.querySelector("textarea")),
        awayHost: tabIndex(awayHost),
        awayInput: tabIndex(awayHost?.querySelector("textarea")),
      },
    };
  }, { targetTab, awayTab, start });
}

async function main() {
  page = await WebKitPage.open(values.inspector);
  await installRecorder();
  await calibrate();
  const suffix = Date.now().toString(36);
  const names = { target: `TabOrderNativeA-${suffix}`, away: `TabOrderNativeB-${suffix}` };
  const files = { target: join(out, "pty", "a.bytes"), away: join(out, "pty", "b.bytes") };
  const surveys = [];
  let target;
  let away;
  const read = (start = null) => where(target.tab, away.tab, start);
  const paneIds = () => page.evaluate(() => [...document.querySelectorAll(".pane[data-pane-id]")].map((node) => ({
    id: node.getAttribute("data-pane-id"),
    terminals: node.querySelectorAll(".terminal-tab").length,
  })));

  /// A terminal named `name` in pane `pane` whose program records every
  /// byte its PTY receives to `file`, in raw mode with no echo.
  async function openTerminal(name, pane, file) {
    await cs(["terminal", "new", "--tab-name", name, "--pane", pane, "--command",
      `stty raw -echo && exec dd bs=1 status=none of=${shellQuote(file)}`]);
    const row = await until(`${name} attached`, async () => {
      const listed = JSON.parse(await cs(["terminal", "list", "--json"]));
      const found = Object.values(listed.groups ?? {}).flat().find((entry) => entry.name === name) ?? null;
      if (!found?.pane || !found.tab) return null;
      const shown = await page.evaluate((selector) => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        return Boolean(box && box.width > 0 && box.height > 0);
      }, `.pane[data-pane-id="${found.pane}"] .terminal-tab.active[data-terminal-tab-id="${found.tab}"] ${TERMINAL_SURFACE}`);
      return shown ? found : null;
    }, Boolean, 60_000);
    if (row.pane !== pane) throw new Error(`${name} opened in ${row.pane}, not ${pane}`);
    await until(`${name}'s recorder starts`, () => existsSync(file), Boolean, 30_000);
    return row;
  }

  /// A real press on a terminal's host: took is true once its pane is the
  /// active one and its host holds the keyboard within the wait.
  async function pressTerminal(tab) {
    await click(`${terminalSelector(tab)} .terminal-host`);
    const took = await until("the pressed terminal holds the keyboard in the active pane", () => page.evaluate((selector) => {
      const terminal = document.querySelector(selector);
      const pane = terminal?.closest(".pane");
      return Boolean(pane?.classList.contains("focused") && terminal.querySelector(".terminal-host")?.contains(document.activeElement));
    }, terminalSelector(tab)), Boolean, PRESS_MS).then(() => true, () => false);
    return { took, after: await read() };
  }

  /// Both terminals attached and recording, as a press across panes needs.
  const ready = (at) => at.targetAttached && at.awayAttached && existsSync(files.target) && existsSync(files.away);

  /// Every leg starts from B the active pane, made by a press on B's
  /// terminal, with no survey over A's terminal. With A active and both
  /// terminals attached and recording the press is a press across panes,
  /// and one that does not take is the leg's failure: false is returned
  /// and the leg goes no further. Any other start that cannot be made is
  /// the instrument's.
  async function startOnB(result) {
    result.beforeStart = await read();
    const across = result.beforeStart.focusedPane === run.panes.target && ready(result.beforeStart);
    const press = await pressTerminal(away.tab);
    result.startPress = { side: "away", across, took: press.took, after: press.after };
    if (!press.took) {
      if (across) {
        result.screenshot = await shot(`${result.kind}-start-press`);
        return false;
      }
      throw new Error(`a press did not give pane B's terminal the keyboard: ${JSON.stringify(press.after)}`);
    }
    if (press.after.surveyOpen) throw new Error(`a survey is up over pane A before the leg raised one: ${JSON.stringify(press.after)}`);
    return true;
  }

  /// Raise the survey over A's terminal; `slot` holds it from the moment it
  /// is asked for, so a leg whose card never shows still cleans it up.
  async function raiseSurvey(label, slot) {
    const handle = { result: null, child: null, promise: null };
    const env = { ...process.env };
    delete env.CHAN_DESKTOP_BIN;
    handle.promise = new Promise((done) => {
      handle.child = execFile(bin, [
        "shell", "terminal", "survey", "--tab-name", names.target, "--timeout", "180",
        "--title", `Tab order: ${label}`, "--option", "Alpha", "--option", "Beta",
        "Pane B is the active pane; no Tab walk from it lands in this terminal.",
      ], { env, timeout: 200_000 }, (error, stdout, stderr) => {
        handle.result = error
          ? { code: error.code ?? "unknown", stdout: maskTokens(String(stdout ?? "").trim()), stderr: maskTokens(String(stderr ?? error.message).trim()) }
          : { code: 0, stdout: maskTokens(stdout.trim()), stderr: maskTokens(stderr.trim()) };
        done();
      });
    });
    surveys.push(handle);
    slot.handle = handle;
    await until(`survey ${label} appears`, async () => {
      if (handle.result) throw new Error(`survey exited before it appeared: ${JSON.stringify(handle.result)}`);
      return page.evaluate((selector) => Boolean(document.querySelector(selector)), `${terminalSelector(target.tab)} .survey-card`);
    }, Boolean, 15_000);
    await delay(SETTLE_MS);
  }

  /// Script focus on the walk's start, as assistive technology can place
  /// it; retried while the strip repaints.
  async function placeFocus(selector) {
    await until(`script focus on ${selector}`, () => page.evaluate((query) => {
      const element = document.querySelector(query);
      element?.focus();
      return Boolean(element) && document.activeElement === element;
    }, selector), Boolean, 10_000);
    await delay(SETTLE_MS);
  }

  /// Walk from `pane`'s tab label with `key` while `activePane` is the
  /// active pane, recording every landing. The walk stops back at its
  /// start, in either terminal, once the page no longer holds the focus,
  /// on a press the page never saw, or at the limit.
  async function walk(result, pane, activePane, key) {
    const start = labelSelector(pane);
    await placeFocus(start);
    result.start = await read(start);
    if (!result.start.atStart || result.start.focusedPane !== activePane || !result.start.hasFocus) {
      throw new Error(`the walk's start is not the tab label of ${pane} with ${activePane} active and the page focused: ${JSON.stringify(result.start)}`);
    }
    result.walk = [];
    result.ended = "limit";
    for (let step = 1; step <= WALK_LIMIT; step += 1) {
      const { reached, shift } = await pressKey(key);
      if (!reached) {
        result.ended = "no key";
        break;
      }
      const at = await read(start);
      result.walk.push({
        step, keyReached: reached, shift, element: at.element, name: at.name, pane: at.pane,
        focusedPane: at.focusedPane, relation: at.relation, hasFocus: at.hasFocus, inTargetTab: at.inTargetTab,
      });
      if (at.inTargetHost) {
        result.ended = "A's terminal";
        break;
      }
      if (at.inAwayHost) {
        result.ended = "B's terminal";
        break;
      }
      if (at.atStart) {
        result.ended = "start";
        break;
      }
      if (!at.hasFocus) {
        result.ended = "left the page";
        break;
      }
    }
  }

  /// Type `zq` where the walk left the keyboard and read both recorders. A
  /// walk that ended in a terminal waits for its PTY first; then both wait
  /// out a quiet window, so a byte that reaches the other PTY late is read.
  async function typeAfterWalk(result, offsets) {
    await typeKeys("z", "q");
    const expected = { "A's terminal": ["target", files.target], "B's terminal": ["away", files.away] }[result.ended];
    if (expected) {
      const [side, file] = expected;
      await recordedSince(`"zq" in ${result.ended}`, file, offsets[side], "71")
        .catch((error) => (result.typedWait = describe(error)));
    }
    await delay(QUIET_MS);
    result.targetBytes = bytes(files.target, offsets.target);
    result.awayBytes = bytes(files.away, offsets.away);
  }

  const offsetsNow = () => ({ target: bytes(files.target).length, away: bytes(files.away).length });

  /// A walk from B's or A's tab label with B the active pane, with or
  /// without a survey over A's terminal, which `slot` holds for cleanup.
  async function hold(result, leg, slot) {
    if (!(await startOnB(result))) return;
    if (leg.survey) {
      await raiseSurvey(leg.kind, slot);
      result.appeared = await read();
      if (!result.appeared.surveyOpen || result.appeared.focusedPane !== result.appeared.awayPane) {
        throw new Error(`the survey over pane A is not up with pane B active: ${JSON.stringify(result.appeared)}`);
      }
    }
    const offsets = offsetsNow();
    await walk(result, run.panes[leg.from], run.panes.away, leg.key);
    if (leg.survey) result.afterWalk = await read();
    await typeAfterWalk(result, offsets);
    result.screenshot = await shot(leg.kind);
  }

  /// With B's terminal holding the keyboard, Tab and then Shift+Tab: each
  /// must reach B's program and leave the keyboard and the active pane.
  async function programTab(result) {
    if (!(await startOnB(result))) return;
    const at = await read();
    if (!at.inAwayHost || at.focusedPane !== run.panes.away || !at.hasFocus) {
      throw new Error(`pane B's terminal does not hold the keyboard in the active pane: ${JSON.stringify(at)}`);
    }
    for (const [name, key, want] of [["tab", "Tab", TAB_BYTES], ["backtab", "Shift+Tab", BACKTAB_BYTES]]) {
      const offsets = offsetsNow();
      const { reached, shift } = await pressKey(key);
      const reading = { keyReached: reached, shift };
      result[name] = reading;
      if (reached) {
        await recordedSince(`${key} in B's terminal`, files.away, offsets.away, want.at(-1))
          .catch((error) => (reading.typedWait = describe(error)));
      }
      await delay(QUIET_MS);
      reading.after = await read();
      reading.awayBytes = bytes(files.away, offsets.away);
      reading.targetBytes = bytes(files.target, offsets.target);
    }
    result.screenshot = await shot(result.kind);
  }

  /// A press on A's terminal with B the active pane makes A the active pane
  /// and gives A's terminal the keyboard; then Tab from A's tab label lands
  /// in A's terminal and the typed keys reach A's PTY.
  async function control(result) {
    if (!(await startOnB(result))) return;
    result.beforePress = await read();
    if (!ready(result.beforePress) || result.beforePress.focusedPane !== run.panes.away) {
      throw new Error(`the press on pane A's terminal is not set up (both terminals attached and recording, pane B active): ${JSON.stringify(result.beforePress)}`);
    }
    const press = await pressTerminal(target.tab);
    result.press = { side: "target", across: true, took: press.took, after: press.after };
    if (!press.took) {
      result.screenshot = await shot(`${result.kind}-press`);
      return;
    }
    const offsets = offsetsNow();
    await walk(result, run.panes.target, run.panes.target, "Tab");
    await typeAfterWalk(result, offsets);
    result.screenshot = await shot(result.kind);
  }

  async function runLeg(leg) {
    const result = { kind: leg.kind, key: leg.key, survey: leg.survey, from: leg.from, observed: false, errors: [], cleanupErrors: [] };
    run.legs.push(result);
    const slot = { handle: null };
    try {
      if (leg.kind === "control") await control(result);
      else if (leg.kind === "program-tab") await programTab(result);
      else await hold(result, leg, slot);
      result.observed = true;
    } catch (error) {
      result.errors.push(describe(error));
      result.screenshot = await shot(`${leg.kind}-error`);
    } finally {
      // A press on the card's dismiss, as a user ends it; it makes pane A
      // the active pane, so the next leg starts with a press across panes.
      try {
        const up = await page.evaluate((selector) => Boolean(document.querySelector(selector)), `${terminalSelector(target.tab)} .survey-dismiss`);
        if (up) await click(`${terminalSelector(target.tab)} .survey-dismiss`);
        const open = slot.handle;
        if (open) {
          await until(`${leg.kind}'s survey answers its dismissal`, () => open.result, Boolean, 15_000);
          result.surveyReply = open.result;
        }
        await until(`${leg.kind}'s survey card leaves`, () => page.evaluate((selector) => !document.querySelector(selector),
          `${terminalSelector(target.tab)} .survey-card`), Boolean, 10_000);
      } catch (error) {
        result.cleanupErrors.push(describe(error));
      }
      save();
    }
  }

  try {
    const first = await paneIds();
    if (first.length !== 1 || first[0].terminals !== 0) throw new Error(`the window does not start with one empty pane: ${JSON.stringify(first)}`);
    target = await openTerminal(names.target, first[0].id, files.target);
    // B is not open yet, so this press is read against A alone.
    await click(`${terminalSelector(target.tab)} .terminal-host`);
    await until("a press gives A's terminal the keyboard", () => page.evaluate((selector) =>
      Boolean(document.querySelector(selector)?.contains(document.activeElement)),
    `${terminalSelector(target.tab)} .terminal-host`), Boolean, PRESS_MS);
    await typeKeys("t");
    run.targetControl = await recordedSince("A control", files.target, 0, "74");
    if (!same(run.targetControl, ["74"])) throw new Error(`A control bytes ${JSON.stringify(run.targetControl)}`);
    // The split puts the new pane after A in the page, so a Shift+Tab walk
    // from B's strip passes A's terminal.
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.pane.splitDown" } }));
      return true;
    });
    const split = await until("the split lands", () => paneIds(), (panes) => panes.length === 2 && panes.some((pane) => pane.terminals === 0));
    away = await openTerminal(names.away, split.find((pane) => pane.terminals === 0).id, files.away);
    const awayPress = await pressTerminal(away.tab);
    if (!awayPress.took) throw new Error(`a press did not give B's terminal the keyboard: ${JSON.stringify(awayPress.after)}`);
    await typeKeys("a");
    run.awayControl = await recordedSince("B control", files.away, 0, "61");
    if (!same(run.awayControl, ["61"])) throw new Error(`B control bytes ${JSON.stringify(run.awayControl)}`);
    run.initial = await read();
    const { targetPane, awayPane } = run.initial;
    if (!targetPane || !awayPane || targetPane === awayPane) throw new Error(`terminals are not in two panes: ${JSON.stringify(run.initial)}`);
    run.panes = { target: targetPane, away: awayPane };
    run.layout = await page.evaluate((args) => {
      const host = document.querySelector(`.terminal-tab[data-terminal-tab-id="${args.targetTab}"] .terminal-host`);
      const labels = args.labels.map((query) => {
        const box = document.querySelector(query)?.getBoundingClientRect();
        return Boolean(box && box.width > 0 && box.height > 0);
      });
      const awayLabel = document.querySelector(args.labels[1]);
      return {
        labelsShown: labels,
        targetBeforeAwayLabel: Boolean(host && awayLabel && (host.compareDocumentPosition(awayLabel) & Node.DOCUMENT_POSITION_FOLLOWING)),
      };
    }, { targetTab: target.tab, labels: [labelSelector(targetPane), labelSelector(awayPane)] });
    if (!run.layout.labelsShown.every(Boolean)) throw new Error(`a pane strip shows no tab label: ${JSON.stringify(run.layout)}`);
    if (!run.layout.targetBeforeAwayLabel) throw new Error("pane A's terminal does not precede pane B's tab label in the page");
    run.setup = "observed";
    save();
    for (const leg of LEGS) await runLeg(leg);
  } catch (error) {
    run.setupErrors.push(describe(error));
    run.setup = "incomplete";
    await shot("setup-failure");
  } finally {
    for (const handle of surveys) {
      if (!handle.result) {
        try {
          handle.child?.kill();
        } catch (error) {
          run.cleanupErrors.push(`stop a survey: ${describe(error)}`);
        }
      }
    }
    run.finalBytes = { target: bytes(files.target), away: bytes(files.away) };
    run.pageErrors = await page.evaluate(() => window.__tabOrderNative?.errors ?? null).catch((error) => [`unread: ${describe(error)}`]);
    page.close();
    save();
  }
}

try {
  await main();
} catch (error) {
  // Before the run's own try: the inspector or the calibration.
  run.setupErrors.push(describe(error));
  run.setup = "incomplete";
}
const verdict = judge(report);
report.verdict = verdict;
save();
for (const leg of verdict.legs) {
  const reasons = leg.status === "held" ? "" : ` ${JSON.stringify(leg.status === "fault" ? leg.failures : leg.incomplete)}`;
  say(`${leg.status === "held" ? "PASS" : leg.status === "fault" ? "FAIL" : "INCONCLUSIVE"} tab-order ${leg.kind}${reasons}`);
}
for (const reason of report.run.setupErrors) say(`INCONCLUSIVE tab-order setup ${JSON.stringify(reason)}`);
if (verdict.status === "fault") say(`FAULT tab-order ${JSON.stringify(verdict.failures)}`);
else if (verdict.status === "inconclusive") say(`INCOMPLETE tab-order ${JSON.stringify(verdict.incomplete)}`);
else say("HELD tab-order every leg held");
process.exit(verdict.exit);
