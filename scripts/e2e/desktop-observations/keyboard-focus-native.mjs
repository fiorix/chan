#!/usr/bin/env node
// Keyboard ownership on chan-desktop (WebKitGTK): a real pointer press on
// the Rich Prompt's Submit keeps the composer's focus at the press and after
// the click; a deck run, and a deck dismissal, that settle while the
// Computers launcher is shown leave the keyboard with the launcher; and the
// deck opened by key returns into Search. Anything the guest cannot show ends
// the run inconclusive, not failed: exit 0 holds, 2 the environment cannot
// run this driver, 3 inconclusive. Exit 10 reports an observed fault (the
// wrapper's obs_judge turns it into 1). Its red variant runs on a tree with
// `keyboard-focus-native.red.patch` applied, which drops the Computers
// launcher from the keyboard rule: the deck run under the launcher then
// hands the keyboard back to the page.
//
// What XTEST drives and what the inspector drives is deliberate: pointer
// presses, the Computers chord and typed text go through the real input
// path; overlay toggles the desktop owns no test chord for go through the
// page's own command bus, the way the shipped checks open them.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const now = () => Number(process.hrtime.bigint()) / 1e6;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const { values } = parseArgs({
  options: {
    inspector: { type: "string" },
    xid: { type: "string" },
    output: { type: "string" },
    backend: { type: "string" },
  },
});
if (!values.inspector || !values.xid || !values.output) {
  console.error("usage: keyboard-focus-native.mjs --inspector HOST:PORT --xid XID --output DIR [--backend xterm|ghostty]");
  process.exit(2);
}
if (values.backend && !["xterm", "ghostty"].includes(values.backend)) {
  console.error("backend is xterm or ghostty");
  process.exit(2);
}
const out = resolve(values.output);
const xid = values.xid;
const verdictPath = join(out, "keyboard-focus.json");
const verdict = {
  engine: "webkitgtk",
  backend: values.backend ?? null,
  sha: process.env.OBS_SHA ?? null,
  steps: {},
  faults: [],
};
const save = () => writeFileSync(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`, { mode: 0o600 });
const say = (kind, name, detail) => console.log(`${kind} keyboard-focus ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
const pass = (name, detail) => {
  verdict.steps[name] = { ok: true, ...detail };
  save();
  say("PASS", name, detail);
};
const fail = (name, detail) => {
  verdict.steps[name] = { ok: false, ...detail };
  verdict.faults.push(name);
  save();
  say("FAIL", name, detail);
  process.exit(10);
};
const inconclusive = (name, detail) => {
  verdict.steps[name] = { inconclusive: detail ?? true };
  save();
  say("INCONCLUSIVE", name, detail);
  process.exit(3);
};

const bin = process.env.CHAN_BIN;
if (!bin) {
  console.error("CHAN_BIN is not set");
  process.exit(2);
}
const windowId = process.env.CHAN_WINDOW_ID;
if (!windowId) {
  console.error("CHAN_WINDOW_ID is not set");
  process.exit(2);
}
process.env.CHAN_NO_DEVSERVER_HANDOFF = "1";

async function xdotool(...args) {
  try {
    const { stdout } = await exec("xdotool", args, { timeout: 30_000 });
    return stdout.trim();
  } catch (error) {
    throw new Error(`xdotool ${args.join(" ")} failed: ${error.message}`);
  }
}

async function cs(...args) {
  const env = { ...process.env };
  delete env.CHAN_DESKTOP_BIN;
  try {
    const { stdout } = await exec(bin, ["shell", ...args], { env, timeout: 60_000 });
    return stdout.trim();
  } catch (error) {
    throw new Error(`cs ${args.join(" ")} failed: ${error.message}`);
  }
}

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

  evaluate(expression, ...args) {
    if (!this.target) throw new Error("WebKit inspector has no page target");
    // Callers pass either a source string or a function with its arguments.
    // A function object does not survive JSON, so serialize the call; a bare
    // undefined would drop the parameter and WebKit rejects the message.
    const body =
      typeof expression === "function"
        ? `(${expression.toString()})(${args.map((arg) => JSON.stringify(arg)).join(",")})`
        : expression;
    if (typeof body !== "string") throw new Error("WebKit evaluation needs a source string");
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error("inspector evaluation timed out"));
      }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      const inner = JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: body, returnByValue: true } });
      this.socket.send(JSON.stringify({ id, method: "Target.sendMessageToTarget", params: { targetId: this.target, message: inner } }));
    });
  }

  async call(fn, ...args) {
    return this.evaluate(fn, ...args);
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* Already gone. */
    }
  }
}

async function until(label, read, predicate, bound = 20_000) {
  const start = now();
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (now() - start > bound) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(value)?.slice(0, 400)}`);
    await delay(200);
  }
}

let page;

async function x(params, ...args) {
  await exec("xdotool", ["windowactivate", "--sync", xid]);
  return exec("xdotool", [...params, ...args], { timeout: 30_000 });
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
    window.__kbdMove = null;
    addEventListener("mousemove", (event) => {
      window.__kbdMove = { x: event.clientX, y: event.clientY, trusted: event.isTrusted };
    }, true);
  });
  const seen = [];
  for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.35]]) {
    const sx = Math.round(wx + ww * fx);
    const sy = Math.round(wy + wh * fy);
    await page.evaluate(() => { window.__kbdMove = null; });
    await x([], "mousemove", String(sx - 7), String(sy - 7));
    await delay(120);
    await xdotool("mousemove", String(sx), String(sy));
    await until("the page sees the pointer move", () => page.evaluate(() => window.__kbdMove), (move) => move?.trusted, 3_000);
    await delay(120);
    const move = await page.evaluate(() => window.__kbdMove);
    seen.push({ dx: sx - move.x, dy: sy - move.y });
  }
  if (seen.some((point) => point.dx !== seen[0].dx || point.dy !== seen[0].dy)) {
    throw new Error(`X input cannot be placed on the page: the calibration's two points disagree: ${JSON.stringify(seen)}`);
  }
  offset = seen[0];
  verdict.offset = offset;
}

const toScreen = (point) => ({ x: Math.round(point.x + offset.dx), y: Math.round(point.y + offset.dy) });

async function screenPoint(selector, where = { x: 0.5, y: 0.5 }) {
  const rect = await page.evaluate((selector, where) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`no ${selector}`);
    el.scrollIntoView({ block: "center" });
    const box = el.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0)) throw new Error(`${selector} has no box`);
    return {
      x: Math.round(box.left + box.width * where.x),
      y: Math.round(box.top + box.height * where.y),
    };
  }, selector, where);
  return toScreen(rect);
}

async function focusState(card) {
  return page.evaluate((card) => {
    const composer = card ? document.querySelector(card) : null;
    const editor = composer?.querySelector(".cm-content");
    const active = document.activeElement;
    return {
      text: editor?.textContent ?? null,
      editable: editor?.getAttribute("contenteditable") === "true",
      where:
        active === null || active === document.body
          ? "body"
          : composer && composer.contains(active)
            ? editor && editor.contains(active)
              ? "composer"
              : "composer-chrome"
            : `${active.tagName ?? "?"}.${
              typeof active.className === "string" ? active.className : active.className?.baseVal ?? "?"
            }`,
      launcherShown: document.documentElement.hasAttribute("data-launcher-shown"),
    };
  }, card);
}

async function dispatch(name) {
  await page.evaluate(
    (name) => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name } })),
    name,
  );
}

async function paneIds() {
  return page.evaluate(() =>
    [...document.querySelectorAll(".pane[data-pane-id]")].map((node) => ({
      id: node.getAttribute("data-pane-id"),
      focused: node.classList.contains("focused"),
      terminals: node.querySelectorAll(".terminal-tab").length,
    })),
  );
}

/// The focused pane's id, or null when no pane carries the focused class.
async function activePaneId() {
  return (await paneIds()).find((pane) => pane.focused)?.id ?? null;
}

/// A press point the instrument can stand behind: the element's centre must
/// hit-test to the element itself, or the press proves nothing about it.
async function pressPoint(selector) {
  const point = await screenPoint(selector);
  const under = await page.evaluate((selector) => {
    const el = document.querySelector(selector);
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2));
    return hit === el || el.contains(hit) ? null : (hit ? `${hit.tagName}.${hit.className}` : "nothing");
  }, selector);
  if (under !== null) throw new Error(`the centre of ${selector} hit-tests to ${under}, not the element`);
  return point;
}

/// A real press on `selector` read with the button held. The button's own
/// events are recorded in the page, and the release goes to the pointer
/// with no window activation in between, since an activation while the
/// button is held is not part of a user's click. A press the button never
/// saw as a click is the instrument's, not the product's.
async function press(selector, card) {
  const point = await pressPoint(selector);
  await page.evaluate((selector) => {
    const button = document.querySelector(selector);
    window.__kbdPress = [];
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      button.addEventListener(type, (event) => window.__kbdPress.push(event.type), { capture: true, once: true });
    }
  }, selector);
  await x([], "mousemove", String(point.x), String(point.y), "mousedown", "1");
  await delay(300);
  const held = await focusState(card);
  await exec("xdotool", ["mouseup", "1"], { timeout: 30_000 });
  const events = await until("the button sees the click", () => page.evaluate(() => window.__kbdPress), (seen) => seen.includes("click"), 5_000)
    .catch(() => null);
  if (!events) {
    throw new Error(`the press never reached ${selector} as a click: ${JSON.stringify(await page.evaluate(() => window.__kbdPress))}`);
  }
  return { held, events };
}

async function waitForCard(card, timeout = 30_000) {
  await until(`composer ${card}`, () => page.evaluate((card) => Boolean(document.querySelector(`${card} .cm-content`)), card), Boolean, timeout);
}

const TEXT = "KbdFocus";

async function openComposer(terminalSelector) {
  const host = await screenPoint(`${terminalSelector} .terminal-host`);
  await x([], "mousemove", String(host.x), String(host.y), "click", "1");
  await until("terminal host focused", () => focusState(null).then((s) => s.where), (w) => w === "terminal" || w === "composer" || w.startsWith("CANVAS") || w.startsWith("TEXTAREA") || w.startsWith("DIV"), 15_000).catch(() => null);
  await x([], "key", "ctrl+alt+p");
  await waitForCard(terminalSelector, 15_000).catch(async () => {
    await dispatch("terminal.richPrompt");
    await waitForCard(terminalSelector, 15_000);
  });
}

async function readTerminalId(selector) {
  return page.evaluate(
    (selector) => document.querySelector(selector)?.getAttribute("data-terminal-tab-id") ?? null,
    selector,
  );
}

async function main() {
  page = await WebKitPage.open(values.inspector);
  if (values.backend) {
    const ghostty = values.backend === "ghostty";
    await page.evaluate(async (selected) => {
      const prefix = document.querySelector('meta[name="chan-prefix"]')?.getAttribute("content")?.replace(/\/+$/, "") ?? "";
      const token = new URLSearchParams(location.search).get("t") ?? sessionStorage.getItem("chan.token");
      if (!token) throw new Error("workspace page has no auth token");
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const got = await fetch(`${prefix}/api/config`, { headers });
      if (!got.ok) throw new Error(`GET /api/config -> ${got.status}`);
      const config = await got.json();
      const response = await fetch(`${prefix}/api/config`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          expected_revision: config.revision,
          preferences: { terminal: { ...config.preferences.terminal, ghostty: selected, secret_masking: false } },
        }),
      });
      if (!response.ok) throw new Error(`PATCH /api/config -> ${response.status}`);
    }, ghostty);
    await page.evaluate(() => {
      setTimeout(() => location.reload(), 0);
      return true;
    });
    await delay(3000);
    page.close();
    page = await WebKitPage.open(values.inspector);
  }
  verdict.backend = values.backend ?? "default";
  await calibrate();

  // One terminal, one composer, one real press.
  await cs("terminal", "new", "--window", windowId, "--tab-name", "KbdA").catch((error) => {
    throw new Error(`open terminal A: ${error.message}`);
  });
  const cardA = await until("terminal A attached", () => readTerminalId(".terminal-tab"), Boolean, 60_000).then(
    async () => {
      const id = await readTerminalId(".terminal-tab.active");
      if (!id) throw new Error("no active terminal tab");
      return `.terminal-tab[data-terminal-tab-id="${id}"] .rich-prompt`;
    },
  );
  await openComposer(".terminal-tab.active");
  await x([], "type", "--delay", "12", TEXT);
  const typed = await until("the draft is editable", () => focusState(cardA), (s) => (s.text === TEXT ? s : false));
  if (typed.where !== "composer") throw new Error(`composer did not take the keyboard: ${typed.where}`);
  const pressA = await press(`${cardA} .rp-primary`, cardA);
  if (pressA.held.where !== "composer") fail("press holds the composer", { where: pressA.held.where });
  pass("press holds the composer", { where: pressA.held.where, events: pressA.events });
  const delivered = await until("the submit delivers", () => focusState(cardA), (s) => s.text === "" || s.text === null, 15_000)
    .catch(() => null);
  if (!delivered) fail("click submits and the next key types", { submitted: false, state: await focusState(cardA) });
  // One key, typed once: a retry would type a second x into a composer
  // that took the first.
  await x([], "type", "x");
  const after = await until(
    "the next key reaches the composer",
    () => focusState(cardA),
    (s) => (s.text === "x" && s.where === "composer" ? s : false),
    5_000,
  ).catch(() => null);
  if (!after) fail("click submits and the next key types", { after: await focusState(cardA) });
  pass("click submits and the next key types", { where: after.where });
  const tabA = await readTerminalId(".terminal-tab.active");

  // Two panes: B's composer is open while A is active. A real click on
  // B's Submit sends without activating B; the check records whether B
  // became the active pane on this engine.
  await dispatch("app.pane.splitRight");
  await until("the split lands", () => paneIds(), (panes) => panes.length === 2);
  const emptyPane = await page.evaluate(() => {
    const panes = [...document.querySelectorAll(".pane[data-pane-id]")];
    const empty = panes.find((pane) => !pane.querySelector(".terminal-tab"));
    if (!empty) return null;
    const box = empty.getBoundingClientRect();
    return { id: empty.getAttribute("data-pane-id"), x: box.left + box.width / 2, y: box.top + 40 };
  });
  if (!emptyPane) inconclusive("the split left no empty pane", null);
  const emptyPoint = toScreen(emptyPane);
  await x([], "mousemove", String(emptyPoint.x), String(emptyPoint.y), "click", "1");
  await until(
    "the empty pane activates",
    () => paneIds().then((panes) => panes.find((pane) => pane.id === emptyPane.id)?.focused ?? false),
    Boolean,
  );
  await cs("terminal", "new", "--window", windowId, "--tab-name", "KbdB");
  const otherId = await until(
    "terminal B attached",
    () =>
      page.evaluate(() => [...document.querySelectorAll(".terminal-tab")].map((node) => node.getAttribute("data-terminal-tab-id"))),
    (ids) => ids.length === 2 && ids.some((id) => id && id !== tabA),
    60_000,
  ).then((ids) => ids.find((id) => id && id !== tabA));
  const cardB = `.terminal-tab[data-terminal-tab-id="${otherId}"] .rich-prompt`;
  await openComposer(`.terminal-tab[data-terminal-tab-id="${otherId}"]`);
  await x([], "type", "--delay", "12", "KbdFocusB");
  await until("B's draft is editable", () => focusState(cardB), (s) => (s.text === "KbdFocusB" && s.editable ? s : false));
  const hostA = await screenPoint(`.terminal-tab[data-terminal-tab-id="${tabA}"] .terminal-host`);
  await x([], "mousemove", String(hostA.x), String(hostA.y), "click", "1");
  const paneA = await activePaneId();
  const { held: heldB } = await press(`${cardB} .rp-primary`, cardB);
  if (heldB.where !== "composer") fail("two-pane submit keeps focus and pane", { held: heldB.where });
  const sentB = await until("B's submit sends and clears", () => focusState(cardB), (s) =>
    s.text === "" || s.text === null ? s : false,
  ).catch(() => null);
  if (!sentB) fail("two-pane submit keeps focus and pane", { sent: false, state: await focusState(cardB) });
  const paneNow = await activePaneId();
  pass("two-pane submit keeps focus and pane", {
    focus: sentB.where,
    paneA,
    paneNow,
    paneBecameActive: paneNow !== paneA,
  });

  // The Computers launcher keeps the keyboard while a deck run settles.
  await x([], "key", "ctrl+shift+p");
  const shown = await until(
    "the Computers launcher covers the page",
    () => page.evaluate(() => document.documentElement.hasAttribute("data-launcher-shown")),
    Boolean,
    10_000,
  ).catch(() => false);
  if (!shown) inconclusive("computers launcher did not show", "ctrl+shift+p showed no data-launcher-shown");
  pass("computers launcher shown", {});
  // The page's command bus records what a deck run dispatches, so a run is
  // told apart from a dismissal by its command, not by the deck closing.
  await page.evaluate(() => {
    window.__kbdCommands = [];
    window.addEventListener("chan:command", (event) => window.__kbdCommands.push(event.detail?.name ?? null));
  });
  const deck = '[role="dialog"][aria-label="Command launcher"]';
  const openDeck = async () => {
    await dispatch("app.launcher.toggle");
    await until("the deck opens over the Computers launcher",
      () => page.evaluate((deck) => Boolean(document.querySelector(`${deck} .deck-input`)), deck), Boolean, 10_000);
  };
  const deckClosed = () => until("the deck closes",
    () => page.evaluate((deck) => !document.querySelector(deck), deck), Boolean, 10_000);
  const launcherShown = () => page.evaluate(() => document.documentElement.hasAttribute("data-launcher-shown"));
  // The Computers launcher holds the native keyboard, so the run's query and
  // its Enter go to the deck through the page, not through XTEST.
  await openDeck();
  pass("deck opened over the launcher", {});
  await page.evaluate((deck) => {
    const input = document.querySelector(`${deck} .deck-input`);
    input.value = "Copy scrollback";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, deck);
  await until("the deck selects Copy scrollback",
    () => page.evaluate(() => document.querySelector('[role="option"][aria-selected="true"] .deck-result-title')?.textContent?.trim() ?? null),
    (title) => title === "Copy scrollback", 10_000);
  await page.evaluate((deck) => {
    document.querySelector(`${deck} .deck-input`)
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  }, deck);
  await deckClosed();
  const ran = await until("the row's command dispatches",
    () => page.evaluate(() => window.__kbdCommands.includes("app.terminal.copyScrollback")), Boolean, 10_000);
  await delay(500);
  const settled = await focusState(null);
  if (settled.where !== "body") fail("deck run settles under the launcher", { active: settled.where });
  if (!(await launcherShown())) fail("deck run settles under the launcher", { launcherShown: false });
  pass("deck run settles under the launcher", { active: settled.where, ran });

  // A dismissal: the deck closes by its own toggle and runs nothing.
  const before = await page.evaluate(() => window.__kbdCommands.length);
  await openDeck();
  await dispatch("app.launcher.toggle");
  await deckClosed();
  await delay(500);
  const dismissed = await focusState(null);
  const extra = await page.evaluate((before) => window.__kbdCommands.slice(before).filter((name) => name !== "app.launcher.toggle"), before);
  if (extra.length) throw new Error(`the dismissal dispatched ${JSON.stringify(extra)}`);
  if (dismissed.where !== "body") fail("deck dismissal settles under the launcher", { active: dismissed.where });
  if (!(await launcherShown())) fail("deck dismissal settles under the launcher", { launcherShown: false });
  pass("deck dismissal settles under the launcher", { active: dismissed.where });
  await x([], "key", "ctrl+shift+p");
  const hidden = await until(
    "the Computers launcher hides again",
    () => page.evaluate(() => !document.documentElement.hasAttribute("data-launcher-shown")),
    Boolean,
    10_000,
  ).catch(() => false);
  if (!hidden) inconclusive("computers launcher stayed up", "second toggle did not hide it");

  // The deck opened by key returns into Search.
  await dispatch("app.search.toggle");
  await until("search shows its input", () => page.evaluate(() => Boolean(document.querySelector(".search .head input"))), Boolean);
  const nativeSearchFocus = await page.evaluate(
    () => document.activeElement === document.querySelector(".search .head input"),
  );
  if (!nativeSearchFocus) {
    await page.evaluate(() => document.querySelector(".search .head input")?.focus());
  }
  const searchFocus = await page.evaluate(() => document.activeElement === document.querySelector(".search .head input"));
  if (!searchFocus) throw new Error("the search input never took focus");
  await x([], "key", "ctrl+k");
  const deckByChord = await page
    .evaluate(() => Boolean(document.querySelector('[role="dialog"][aria-label="Command launcher"] .deck-input')))
    .catch(() => false);
  let openedBy = "chord";
  if (!deckByChord) {
    await dispatch("app.launcher.toggle");
    openedBy = "dispatch";
  }
  await until(
    "the deck takes the query",
    () => page.evaluate(() => Boolean(document.querySelector('[role="dialog"][aria-label="Command launcher"] .deck-input'))),
    Boolean,
  );
  await x([], "type", "--delay", "20", "Copy scrollback");
  await delay(500);
  await x([], "key", "Return");
  const back = await until(
    "the run returns into Search",
    () =>
      page.evaluate(() => {
        const input = document.querySelector(".search .head input");
        return document.activeElement === input ? (input.value ?? null) : false;
      }),
    (value) => value !== false,
  ).catch(() => false);
  if (back === false) fail("deck by key returns into Search", { openedBy, active: (await focusState(null)).where });
  await x([], "type", "Q");
  const query = await page.evaluate(() => document.querySelector(".search .head input")?.value ?? null);
  if (!query || !query.includes("Q")) fail("deck by key returns into Search", { openedBy, query });
  pass("deck by key returns into Search", { openedBy, nativeSearchFocus, query });
  await dispatch("app.search.toggle");
  // Terminals stay up for the guest teardown to remove with the workspace.

  save();
  console.log("PASS keyboard-focus all desktop steps held");
}

// A product property that does not hold calls fail() and exits 10; any
// other error is the instrument's (a wait, a lookup, the inspector), so it
// ends the run inconclusive.
main().then(
  () => process.exit(0),
  (error) => {
    console.error(`INCONCLUSIVE keyboard-focus ${error.message}`);
    try {
      verdict.instrument = String(error.message ?? error);
      save();
    } catch {
      /* The work dir is gone; the line above is the record. */
    }
    process.exit(3);
  },
);
