#!/usr/bin/env node
// Presses the row letters on a devserver's card in front of the real WebKitGTK
// Computers screen, with real input through XTEST (`xdotool` click and type,
// never `key --window`, which GTK ignores). The shell driver owns the desktop
// and the display; this owns a direct devserver.
//
// Legs, in order:
//   click       a click on an empty point of the card's body: the slot holds
//               focus and the card paints one ring.
//   connection  from a clicked card, o disconnects and o connects again, read
//               from the card's own connection button; focus stays on it.
//   nothing     with nothing focused, a key that reaches the page as a trusted
//               keydown on the body: o asks for nothing and the card stays
//               connected, and no card shows a ring.
//   row         a click on an empty point of a workspace row served on the
//               devserver: the row holds focus and paints one ring, and t
//               opens a window of that workspace, with no new terminal
//               window, which is what the header's t would open.
//   terminal    from a clicked card, t opens a terminal window on that
//               devserver, read from the devserver's own windows feed. A new
//               native X window is recorded beside it and decides nothing.
//
// What this cannot read: the ring is read as the card's computed outline, not
// from pixels (a shot of it stays in the work directory), and a run speaks for
// WebKitGTK alone, not for WKWebView or WebView2.
//
// Prints `PASS: <leg>` or `FAIL: <leg>: <detail>` per leg. Exit 0 when every
// leg held, 10 when one did not, 2 when a step the legs rest on did not happen
// (`SETUP NOT RUN`), 3 when the driver itself failed.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const [inspector, work, chan] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const LABEL = "letters-native";
const WORKSPACE = "letters-workspace";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secrets = [];
const mask = (text) => secrets.reduce((s, secret) => s.replaceAll(secret, "<token>"), String(text))
  .replace(/([?&]t=)[^&\s"']+/g, "$1<token>");
const results = [];
const logs = [];

class SetupNotRun extends Error {}

async function until(probe, ms) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last?.ok) return last;
    await sleep(200);
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

const xdo = async (...args) => (await run("xdotool", args.map(String), { timeout: 30_000 })).stdout.trim();

async function inspectAll(expression) {
  const { stdout } = await run(process.execPath, [path.join(here, "inspect.mjs"), inspector, "all", expression],
    { timeout: 30_000, maxBuffer: 1 << 24 });
  return stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/// The value from the launcher page the real pointer lands on.
async function inPage(expression) {
  const pages = await inspectAll(`(() => window.__cardLettersHere ? (${expression}) : { skip: true })()`);
  return pages.map((page) => page.value).find((value) => value != null && !value.skip) ?? null;
}

const SLOT = `[...document.querySelectorAll('.slot')].find((s) => [...s.querySelectorAll('.ds-name-row .row-name')].some((n) => n.textContent.trim() === ${JSON.stringify(LABEL)}))`;

/// Runs in every launcher page: records the requests the launcher sends, the
/// keys that reach the page and the pointer's last move.
function pageInstall() {
  if (!document.querySelector(".slot")) return { skip: true };
  if (window.__cardLetters) return { ok: true };
  const record = { asked: [], keys: [], move: null };
  window.__cardLetters = record;
  const native = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      record.asked.push(`${method} ${decodeURIComponent(url.pathname)}`);
    }
    return native(input, init);
  };
  addEventListener("keydown", (event) => {
    const target = event.target;
    record.keys.push({
      key: event.key,
      trusted: event.isTrusted,
      target: target === document.body ? "page" : target?.classList?.contains("slot") ? "card" : String(target?.tagName ?? "none").toLowerCase(),
    });
  }, true);
  addEventListener("mousemove", (event) => {
    record.move = { x: event.clientX, y: event.clientY, trusted: event.isTrusted };
  }, true);
  return { ok: true };
}

/// Runs in the page: the card as the selection and its connection read.
function pageCard(findSlot, label) {
  const slot = findSlot();
  if (!slot) return { skip: true };
  const card = slot.querySelector("section.card");
  const style = card ? getComputedStyle(card) : null;
  const active = document.activeElement;
  const enabled = (name) => Boolean(slot.querySelector(`button[aria-label="${name} ${label}"]:not([disabled])`));
  return {
    key: slot.getAttribute("data-key"),
    front: slot.getAttribute("aria-current") === "true",
    disconnect: enabled("Disconnect"),
    connect: enabled("Connect"),
    focus: active === slot ? "card" : active === document.body ? "page" : `${active?.tagName.toLowerCase()} ${active?.getAttribute("aria-label") ?? ""}`.trim(),
    outlineStyle: style?.outlineStyle ?? null,
    outlineWidth: style?.outlineWidth ?? null,
    ring: Boolean(style) && style.outlineStyle !== "none" && style.outlineWidth === "2px",
    slotOutline: getComputedStyle(slot).outlineStyle,
    cardsWithRing: [...document.querySelectorAll(".slot section.card")].filter((el) => getComputedStyle(el).outlineStyle !== "none").length,
    asked: window.__cardLetters.asked.length,
  };
}

/// Runs in the page: a point on the card's body that is neither a row nor a
/// control.
function pageEmptyPoint(findSlot) {
  const slot = findSlot();
  if (!slot) return { skip: true };
  const box = slot.getBoundingClientRect();
  for (let y = box.bottom - 12; y > box.top; y -= 8) {
    for (const share of [0.5, 0.25, 0.75]) {
      const x = box.left + box.width * share;
      const element = document.elementFromPoint(x, y);
      if (element && slot.contains(element) && !element.closest("[data-deck-row], button, a, input, select, textarea, label")) {
        return { x, y, element: `${element.tagName.toLowerCase()}.${element.getAttribute("class") ?? ""}` };
      }
    }
  }
  return { none: true };
}

/// Runs in the page: the workspace row, whether its t is enabled, where a
/// click on it lands outside its controls, and the rings on the deck.
function pageRow(findSlot, name) {
  const slot = findSlot();
  if (!slot) return { skip: true };
  const terminal = slot.querySelector(`button[aria-label="New terminal window of ${name}"]`);
  const row = terminal?.closest("[data-deck-row]");
  if (!row) return { missing: true };
  const box = row.getBoundingClientRect();
  const y = box.top + box.height / 2;
  let point = null;
  for (let x = box.left + 3; x < box.right - 3 && !point; x += 4) {
    const element = document.elementFromPoint(x, y);
    if (element && row.contains(element) && !element.closest("button, a, input, select, textarea, label")) {
      point = { x, y, element: `${element.tagName.toLowerCase()}.${element.getAttribute("class") ?? ""}` };
    }
  }
  const style = getComputedStyle(row);
  return {
    enabled: !terminal.disabled && terminal.dataset.deckKey === "t",
    point,
    focused: document.activeElement === row,
    outlineStyle: style.outlineStyle,
    outlineWidth: style.outlineWidth,
    rowsWithRing: [...document.querySelectorAll(".slot [data-deck-row]")].filter((el) => getComputedStyle(el).outlineStyle !== "none").length,
    cardsWithRing: [...document.querySelectorAll(".slot section.card")].filter((el) => getComputedStyle(el).outlineStyle !== "none").length,
  };
}

const readRow = () => inPage(`(${pageRow.toString()})(() => ${SLOT}, ${JSON.stringify(WORKSPACE)})`);
const readCard = () => inPage(`(${pageCard.toString()})(() => ${SLOT}, ${JSON.stringify(LABEL)})`);
const blur = () => inPage("(document.activeElement instanceof HTMLElement && document.activeElement.blur(), true)");

async function readUntil(holds, ms) {
  return until(async () => {
    const card = await readCard();
    return { ok: Boolean(card && holds(card)), card };
  }, ms);
}

const devHome = path.join(work, "devserver-home");
fs.mkdirSync(devHome);
let server = null;
let host = null;
let offset = null;
let devBase = null;
let token = null;

const cli = (args) => run(chan, args, { timeout: 90_000 });

/// Where X input lands on the page: the offset between a screen point and the
/// client point the page's mousemove reports for it, read at two points that
/// must agree. The page's window.screenX/Y does not place the webview on
/// WebKitGTK. The page the pointer reaches is the one every later reading
/// comes from.
async function calibrate() {
  const geometry = Object.fromEntries((await xdo("getwindowgeometry", "--shell", host)).split("\n").map((line) => line.split("=")));
  const [wx, wy, ww, wh] = ["X", "Y", "WIDTH", "HEIGHT"].map((key) => Number(geometry[key]));
  const seen = [];
  for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.35]]) {
    const sx = Math.round(wx + ww * fx);
    const sy = Math.round(wy + wh * fy);
    await xdo("windowactivate", "--sync", host, "mousemove", sx - 7, sy - 7);
    await sleep(120);
    await inspectAll("(() => { if (window.__cardLetters) window.__cardLetters.move = null; return true; })()");
    await xdo("mousemove", sx, sy);
    const moved = await until(async () => {
      const pages = await inspectAll("(() => { const m = window.__cardLetters?.move; if (!m?.trusted) return null; window.__cardLettersHere = true; return m; })()");
      return { ok: pages.some((page) => page.value?.trusted) };
    }, 3_000);
    if (!moved?.ok) throw new SetupNotRun("the launcher page did not see the real pointer move");
    await sleep(120);
    const move = await inPage("window.__cardLetters.move");
    if (!move) throw new SetupNotRun("the launcher page lost the pointer's reading");
    seen.push({ dx: sx - move.x, dy: sy - move.y });
  }
  if (seen.some((point) => point.dx !== seen[0].dx || point.dy !== seen[0].dy)) {
    throw new SetupNotRun(`X input cannot be placed on the page: ${JSON.stringify(seen)}`);
  }
  offset = seen[0];
}

async function setup() {
  const devPort = await freePort();
  devBase = `http://127.0.0.1:${devPort}`;
  server = spawn(chan, ["devserver", "run", "--service=none", "--bind=127.0.0.1", `--port=${devPort}`], {
    env: { ...process.env, CHAN_HOME: devHome }, stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (data) => logs.push(data.toString()));
  server.stderr.on("data", (data) => logs.push(data.toString()));
  const ready = await until(async () => {
    if (server.exitCode !== null) return { ok: false };
    try { return { ok: (await fetch(`${devBase}/api/devserver/info`, { signal: AbortSignal.timeout(1000) })).ok }; }
    catch { return null; }
  }, 60_000);
  if (!ready?.ok) throw new SetupNotRun("the devserver did not start");
  token = JSON.parse(fs.readFileSync(path.join(devHome, "devserver/config.json"))).devserver_token;
  secrets.push(token);
  const pageUp = await until(async () => {
    try { return { ok: (await inspectAll("document.readyState === 'complete'")).some((page) => page.value === true) }; }
    catch { return null; }
  }, 60_000);
  if (!pageUp?.ok) throw new SetupNotRun("no desktop page answered the inspector");

  host = await xdo("getactivewindow");
  await cli(["devserver", "register", `${devBase}/?t=${token}`, "--name", LABEL]);
  await cli(["devserver", "connect", LABEL]);
  const connected = await until(async () => {
    const { stdout } = await cli(["devserver", "ls", "--json"]);
    return { ok: JSON.parse(stdout).devservers.some((d) => d.label === LABEL && d.status === "connected") };
  }, 60_000);
  if (!connected?.ok) throw new SetupNotRun("the desktop did not connect to the devserver");
  const workspace = path.join(work, WORKSPACE);
  fs.mkdirSync(workspace);
  try {
    await cli(["workspace", "serve", workspace, "--on", LABEL]);
  } catch (error) {
    throw new SetupNotRun(`the workspace was not served on the devserver: ${error.message}`);
  }

  const hasCard = `(() => { const s = ${SLOT}; return s ? true : null; })()`;
  let shown = null;
  for (let attempt = 0; attempt < 3 && !shown?.ok; attempt++) {
    await xdo("windowactivate", "--sync", host);
    await xdo("key", "--clearmodifiers", "ctrl+shift+p");
    shown = await until(async () => ({ ok: (await inspectAll(hasCard)).some((page) => page.value === true) }), 15_000);
  }
  if (!shown?.ok) throw new SetupNotRun("the Computers screen did not show the devserver's card");
  await inspectAll(`(() => { const s = ${SLOT}; s?.click(); return s ? true : null; })()`);
  const front = await until(async () => ({
    ok: (await inspectAll(`(() => { const s = ${SLOT}; return s?.getAttribute('aria-current') === 'true' ? true : null; })()`)).some((page) => page.value === true),
  }), 15_000);
  if (!front?.ok) throw new SetupNotRun("the devserver's card did not come to the front");
  await sleep(800); // the deck's turn
  const installed = await inspectAll(`(${pageInstall.toString()})()`);
  if (!installed.some((page) => page.value?.ok)) throw new SetupNotRun("the page recorder did not install");
  await calibrate();
  const card = await readUntil((c) => c.front && c.disconnect, 20_000);
  if (!card?.ok) throw new SetupNotRun(`the card in front is not connected: ${mask(JSON.stringify(card?.card ?? null))}`);
}

async function ensureConnected() {
  const now = await readUntil((c) => c.connect || c.disconnect, 30_000);
  if (!now?.ok) throw new SetupNotRun(`the card shows no connection control: ${mask(JSON.stringify(now?.card ?? null))}`);
  if (now.card.disconnect) return;
  await cli(["devserver", "connect", LABEL]);
  const back = await readUntil((c) => c.disconnect, 60_000);
  if (!back?.ok) throw new SetupNotRun("the devserver was not put back connected");
}

/// A real click on an empty point of the card's body, from nothing focused.
async function clickCard() {
  await blur();
  const point = await inPage(`(${pageEmptyPoint.toString()})(() => ${SLOT})`);
  if (!point || point.none) throw new SetupNotRun("the card has no point that is neither a row nor a control");
  const sx = Math.round(point.x + offset.dx);
  const sy = Math.round(point.y + offset.dy);
  await clickScreen(sx, sy);
  return point;
}

async function clickScreen(sx, sy) {
  await xdo("windowactivate", "--sync", host, "mousemove", sx, sy);
  await sleep(150);
  await xdo("click", "1");
  await sleep(250);
}

/// A real key, and the proof it reached the launcher's page.
async function press(letter) {
  const before = (await inPage("window.__cardLetters.keys.length")) ?? 0;
  await xdo("windowactivate", "--sync", host);
  await xdo("type", "--delay", "40", letter);
  const arrived = await until(async () => {
    const keys = await inPage(`window.__cardLetters.keys.slice(${before})`);
    const hit = Array.isArray(keys) ? keys.find((key) => key.key === letter && key.trusted) : null;
    return { ok: Boolean(hit), hit };
  }, 3_000);
  if (!arrived?.ok) throw new SetupNotRun(`the real key ${letter} did not reach the launcher's page`);
  return arrived.hit;
}

async function devserverWindows() {
  const response = await fetch(`${devBase}/api/library/windows`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new SetupNotRun(`the devserver's windows route answered ${response.status}`);
  return response.json();
}

const devserverTerminals = async () => (await devserverWindows()).filter((row) => row.kind === "terminal").map((row) => row.window_id);

async function nativeWindows() {
  try { return (await xdo("search", "--onlyvisible", "--name", ".")).split("\n").filter(Boolean); }
  catch { return []; }
}

const verdict = (pass, detail) => ({ pass, detail });

async function clickLeg() {
  await clickCard();
  const selected = await readUntil((c) => c.focus === "card", 2_000);
  const card = selected?.card ?? null;
  try { await run("import", ["-window", host, path.join(work, "shots", "ring.png")], { timeout: 15_000 }); }
  catch (error) { logs.push(`screenshot: ${error}`); }
  if (card?.focus !== "card") return verdict(false, { why: "the click did not put focus on the slot", card });
  if (!(card.ring && card.slotOutline === "none" && card.cardsWithRing === 1)) {
    return verdict(false, { why: "the selected card does not paint one ring", card });
  }
  return verdict(true, { card });
}

async function connectionLeg() {
  await ensureConnected();
  await clickCard();
  await press("o");
  const off = await readUntil((c) => c.connect, 20_000);
  if (!off?.ok) return verdict(false, { why: "o on the clicked card did not disconnect it", card: off?.card ?? null });
  if (off.card.focus !== "card") return verdict(false, { why: "focus left the card after the disconnect", card: off.card });
  await press("o");
  const on = await readUntil((c) => c.disconnect, 60_000);
  if (!on?.ok) return verdict(false, { why: "o on the clicked card did not connect it again", card: on?.card ?? null });
  if (on.card.focus !== "card") return verdict(false, { why: "focus left the card after the connect", card: on.card });
  return verdict(true, { off: off.card, on: on.card });
}

async function nothingLeg() {
  await ensureConnected();
  // The click puts GTK's focus in the launcher's webview, so the key reaches
  // this page; the blur then leaves nothing selected in it.
  await clickCard();
  await blur();
  const before = await readCard();
  if (before?.focus !== "page") throw new SetupNotRun(`focus is not on the page: ${mask(JSON.stringify(before))}`);
  const key = await press("o");
  if (key.target !== "page") throw new SetupNotRun(`the key landed on ${key.target}, not the page`);
  await sleep(1_500);
  const after = await readCard();
  const pass = Boolean(after?.disconnect) && after.asked === before.asked && before.cardsWithRing === 0;
  return verdict(pass, pass ? { after } : { why: "o with nothing selected acted, or a card showed a ring", before, after });
}

async function rowLeg() {
  await ensureConnected();
  const ready = await until(async () => {
    const row = await readRow();
    return { ok: Boolean(row?.enabled && row.point), row };
  }, 45_000);
  if (!ready?.ok) throw new SetupNotRun(`the workspace row is not ready: ${mask(JSON.stringify(ready?.row ?? null))}`);
  await blur();
  const { point } = await readRow();
  if (!point) throw new SetupNotRun("the workspace row has no point outside its controls");
  await clickScreen(Math.round(point.x + offset.dx), Math.round(point.y + offset.dy));
  const selected = await until(async () => {
    const row = await readRow();
    return { ok: Boolean(row?.focused), row };
  }, 2_000);
  const row = selected?.row ?? null;
  if (!row?.focused) return verdict(false, { why: "the click did not put focus on the row", row });
  if (!(row.outlineStyle !== "none" && row.outlineWidth === "1px" && row.rowsWithRing === 1 && row.cardsWithRing === 0)) {
    return verdict(false, { why: "the clicked row does not paint one ring", row });
  }
  const before = (await devserverWindows()).map((window) => window.window_id);
  const nativeBefore = await nativeWindows();
  await press("t");
  const opened = await until(async () => {
    const fresh = (await devserverWindows()).filter((window) => !before.includes(window.window_id));
    return { ok: fresh.length > 0, fresh };
  }, 20_000);
  if (!opened?.ok) return verdict(false, { why: "t on the clicked row opened no window on the devserver", row });
  await sleep(1_500);
  const settled = (await devserverWindows()).filter((window) => !before.includes(window.window_id));
  const summary = settled.map((window) => ({ id: window.window_id, kind: window.kind, workspace: window.workspace_path ? path.basename(window.workspace_path) : null }));
  const nativeNew = (await nativeWindows()).filter((id) => !nativeBefore.includes(id));
  const ofRow = summary.some((window) => window.kind === "workspace" && window.workspace === WORKSPACE);
  const terminal = summary.some((window) => window.kind === "terminal");
  if (!ofRow || terminal) return verdict(false, { why: "t did not open a window of the clicked row's workspace alone", opened: summary });
  return verdict(true, { row, opened: summary, nativeNew });
}

async function terminalLeg() {
  await ensureConnected();
  await clickCard();
  const before = await devserverTerminals();
  const nativeBefore = await nativeWindows();
  await press("t");
  const opened = await until(async () => {
    const fresh = (await devserverTerminals()).filter((id) => !before.includes(id));
    return { ok: fresh.length > 0, fresh };
  }, 20_000);
  if (!opened?.ok) return verdict(false, { why: "t on the clicked card opened no terminal on the devserver", before });
  await sleep(1_500);
  const nativeNew = (await nativeWindows()).filter((id) => !nativeBefore.includes(id));
  return verdict(true, { window: opened.fresh, nativeNew });
}

const LEGS = [["click", clickLeg], ["connection", connectionLeg], ["nothing", nothingLeg], ["row", rowLeg], ["terminal", terminalLeg]];
let status = 3;
try {
  await setup();
  for (const [name, leg] of LEGS) {
    const { pass, detail } = await leg();
    results.push({ leg: name, pass, detail });
    console.log(pass ? `PASS: ${name}` : `FAIL: ${name}: ${mask(JSON.stringify(detail))}`);
  }
  status = results.every((result) => result.pass) ? 0 : 10;
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
  fs.writeFileSync(path.join(work, "results.json"), mask(JSON.stringify({ status, results }, null, 2)) + "\n");
  fs.writeFileSync(path.join(work, "devserver.log"), mask(logs.join("")));
  server?.kill("SIGTERM");
}
process.exit(status);
