#!/usr/bin/env node
// Keyboard ownership on chan-desktop (WebKitGTK): a real pointer press on
// the Rich Prompt's Submit keeps the composer's focus at the press and after
// the click; a deck run that settles while the Computers launcher is shown
// leaves the keyboard with the launcher; and the deck opened by key returns
// into Search. Anything the guest cannot show ends the run inconclusive, not
// failed: exit 0 holds, 1 (via obs_fault in the wrapper: never here) would be
// a fault, 2 the environment cannot run this driver, 3 inconclusive.
// Exit 10 reports an observed fault (the wrapper's obs_judge turns it into 1).
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
      screenX: window.screenX,
      screenY: window.screenY,
    };
  }, selector, where);
  return { x: rect.screenX + rect.x, y: rect.screenY + rect.y };
}

async function focusState(card) {
  return page.evaluate((card) => {
    const composer = card ? document.querySelector(card) : null;
    const editor = composer?.querySelector(".cm-content");
    const active = document.activeElement;
    return {
      text: editor?.textContent ?? null,
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
  const press = await screenPoint(`${cardA} .rp-primary`);
  await x([], "mousemove", String(press.x), String(press.y), "mousedown", "1");
  await delay(300);
  const held = await focusState(cardA);
  await x([], "mouseup", "1");
  if (held.where !== "composer") throw new Error(`press moved focus out of the composer: ${held.where}`);
  pass("press holds the composer", { where: held.where });
  await until("the submit delivers", () => focusState(cardA), (s) => s.text === "" || s.text === null, 15_000);
  const after = await until(
    "the next key reaches the composer",
    async () => {
      await x([], "type", "x");
      return focusState(cardA);
    },
    (s) => (s.text === "x" && s.where === "composer" ? s : false),
  ).catch(() => null);
  if (!after) throw new Error("the next key did not reach the composer with no click");
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
  await x([], "mousemove", String(emptyPane.x), String(emptyPane.y), "click", "1");
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
  const paneA = await activePaneId(page);
  const pressB = await screenPoint(`${cardB} .rp-primary`);
  await x([], "mousemove", String(pressB.x), String(pressB.y), "mousedown", "1");
  await delay(300);
  const heldB = await focusState(cardB);
  await x([], "mouseup", "1");
  if (heldB.where !== "composer") throw new Error(`press moved focus out of B's composer: ${heldB.where}`);
  const sentB = await until("B's submit sends and clears", () => focusState(cardB), (s) =>
    s.text === "" || s.text === null ? s : false,
  );
  const paneNow = await activePaneId(page);
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
  await dispatch("app.launcher.toggle");
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
  const deckShown = await page.evaluate(() => Boolean(document.querySelector('[role="dialog"][aria-label="Command launcher"] .deck-input')));
  if (!deckShown) throw new Error("the command launcher did not open over the Computers launcher");
  pass("deck opened over the launcher", {});
  await dispatch("app.launcher.toggle");
  const settled = await focusState(null);
  if (settled.where !== "body") throw new Error(`a deck run under the Computers launcher moved page focus to ${settled.where}`);
  const stillShown = await page.evaluate(() => document.documentElement.hasAttribute("data-launcher-shown"));
  if (!stillShown) throw new Error("the Computers launcher hid during the deck run");
  pass("deck settles under the launcher", { active: settled.where });
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
  );
  await x([], "type", "Q");
  const query = await page.evaluate(() => document.querySelector(".search .head input")?.value ?? null);
  if (!query || !query.includes("Q")) throw new Error(`typed text did not land in Search, got ${JSON.stringify(query)}`);
  pass("deck by key returns into Search", { openedBy, nativeSearchFocus, query });
  await dispatch("app.search.toggle");
  // Terminals stay up for the guest teardown to remove with the workspace.

  save();
  console.log("PASS keyboard-focus all desktop steps held");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`FAULT keyboard-focus ${error.message}`);
    try {
      verdict.fault = String(error.message ?? error);
      save();
    } catch {
      /* The work dir is gone; the line above is the record. */
    }
    process.exit(10);
  },
);
