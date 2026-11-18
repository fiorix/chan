#!/usr/bin/env node
// Drives the reconnecting cover's Show in Computers on the real WebKitGTK
// desktop. A direct devserver sits behind a relay (../browser-smoke/lib/
// flow-relay.mjs) that closes and refuses its window's flows, told by their
// request: a page's carries the engine's User-Agent and the desktop's own
// client sends none. The devserver's window feed, the desktop's, keeps
// flowing, so the devserver stays connected while its window is cut off.
// The shell driver owns the desktop and the display; this owns the
// devserver, the relay and the readings.
//
// The devserver arm: another card is put in front of the window's Computers
// screen, the window's flows are closed, and the cover must show within
// about 1 s with Show in Computers on it. A click through XTEST on the action
// must show the screen over that window with the devserver's card in front
// and the keyboard on it; hiding the screen must leave the cover up with the
// focus on it; and the action must keep its place when Restart connection
// and Abandon appear. The local arm: a local window has no relay between it
// and the desktop's embedded server, so its outage is made in the page, by
// closing its sockets and dialling new ones to a freed port; its cover must
// offer no Show in Computers.
//
// Every bounded wait (`until`, `toggleScreen`) is a hang guard: it bounds a
// step that never comes, and its failure names the step. The bounds that
// measure are COVER_WITHIN_MS (the drop to the cover), RECOVERY_ACTIONS_MS
// (past which Restart connection and Abandon show), HELD_MS (how long the
// cover must stay after the screen hides) and BOX_TOLERANCE_PX (how far the
// action may move when the other two appear).
//
// Exit 0 when every reading held, 10 when one did not, 3 when a step the
// readings rest on did not happen and no reading had failed before it.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startRelay } from "../browser-smoke/lib/flow-relay.mjs";

const run = promisify(execFile);
const [inspector, work, chan] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const LABEL = "cover-link";
const ACTION = "Show in Computers";
// The cover shows 600 ms after the watcher's status last changed
// (STARTUP_GRACE_MS in DisconnectOverlay.svelte). The watcher's first redial,
// 500 ms after the drop (WS_RECONNECT_BACKOFF_MIN_MS in transport.ts), flips
// it to connecting and, refused at the relay, back to reconnecting, and each
// flip starts the grace again, so the cover shows at about 1.1 s; the rest of
// the bound is for the refused redial's close to reach the page. The witness
// stamps the time in the page, so no inspector read is in it.
const COVER_WITHIN_MS = 1_500;
// Restart connection and Abandon show 8 s after the drop.
const RECOVERY_ACTIONS_MS = 8_000;
// A measurement: the cover must stay, with the focus, this long after the
// screen hides, so a cover that leaves once the hide has landed is not read
// as kept.
const HELD_MS = 2_000;
// How far Show in Computers may move, in CSS px, when the other two appear:
// rounding, never a row's height.
const BOX_TOLERANCE_PX = 0.5;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secrets = [];
const mask = (text) => secrets.reduce((s, secret) => s.replaceAll(secret, "<token>"), String(text))
  .replace(/([?&]t=)[^&\s"']+/g, "$1<token>");
const checks = [];
const readings = [];
const logs = [];
let faulted = false;

class Inconclusive extends Error {}

function pass(name, detail) {
  checks.push({ name, pass: true, detail });
  console.log(`PASS: ${name}`);
}

function fault(name, detail) {
  faulted = true;
  checks.push({ name, pass: false, detail });
  console.log(`FAULT: ${name}: ${mask(JSON.stringify(detail))}`);
}

/// Poll `probe` until it answers `ok` or `ms` pass; the last answer either way.
async function until(probe, ms, every = 250) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last?.ok) return last;
    await sleep(every);
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

async function api(base, token, method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Inconclusive(`${method} ${route}: HTTP ${response.status} ${mask(await response.text())}`);
  return response.status === 204 ? null : response.json();
}

async function inspectAll(expression) {
  const { stdout } = await run(process.execPath, [path.join(here, "inspect.mjs"), inspector, "all", expression],
    { timeout: 30_000, maxBuffer: 1 << 22 });
  return stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/// The value of `expression` in the one page that answers it with something
/// other than `{ skip: true }`, or null.
async function inspectOne(step, expression) {
  const pages = await inspectAll(expression);
  const value = pages.map((page) => page.value).find((v) => v && !v.skip) ?? null;
  readings.push({ at: Date.now(), step, value });
  return value;
}

/// The value of `expression` in every page, each page's answer recorded as
/// it came: its value, whether it threw, or the inspector's error.
async function inspectPages(step, expression) {
  const pages = await inspectAll(expression);
  readings.push({
    at: Date.now(), step,
    pages: pages.map((page) => ({ page: page.page, value: page.value ?? null, thrown: page.thrown ?? false, error: page.error ?? null })),
  });
  return pages;
}

async function xdo(...args) {
  const { stdout } = await run("xdotool", args.map(String), { timeout: 15_000 });
  return stdout.trim();
}

async function shot(windowId, name) {
  try {
    await run("import", ["-window", windowId, path.join(work, "shots", `${name}.png`)], { timeout: 15_000 });
  } catch (error) {
    logs.push(`screenshot ${name}: ${error}`);
  }
}

async function visibleWindows() {
  try {
    return (await xdo("search", "--onlyvisible", "--name", ".")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// The cover's buttons the user can reach: a place the cover holds for
// Restart connection and Abandon before their 8 s is inert.
const OFFERED = `const offered = (cover) => [...cover.querySelectorAll('button')].filter((b) => {
    for (let n = b; n; n = n.parentElement) if (n.inert) return false;
    return true;
  });`;

// A workspace page of the window `windowId`, by the `w` its URL carries.
const pageOf = (windowId) => `new URL(location.href).searchParams.get('w') === ${JSON.stringify(windowId)}
  && document.querySelector('#app > *')`;

/// What the window's page shows of the cover, its focus and the launcher's
/// mark on its root, with the action's centre in client coordinates.
const COVER = (windowId) => `(() => {
  if (!(${pageOf(windowId)})) return { skip: true };
  ${OFFERED}
  const cover = document.querySelector('[data-cover="reconnect"]');
  const active = document.activeElement;
  const action = cover && offered(cover).find((b) => b.textContent.trim() === ${JSON.stringify(ACTION)});
  const box = action?.getBoundingClientRect();
  return {
    cover: Boolean(cover),
    actions: cover ? offered(cover).map((b) => b.textContent.trim()) : [],
    error: cover?.querySelector('.error')?.textContent.trim() ?? null,
    action: box ? {
      x: box.left + box.width / 2, y: box.top + box.height / 2,
      box: { left: box.left, top: box.top, width: box.width, height: box.height }, disabled: action.disabled,
    } : null,
    focusOnCover: active === cover,
    focusInCover: Boolean(cover && active && cover.contains(active)),
    focus: active ? active.tagName.toLowerCase() + (typeof active.className === 'string' && active.className.trim()
      ? '.' + active.className.trim().split(/\\s+/).join('.') : '') : null,
    hasFocus: document.hasFocus(),
    covered: document.documentElement.hasAttribute('data-launcher-shown'),
    witness: window.__coverLink ? { ...window.__coverLink, moves: undefined } : null,
    dpr: devicePixelRatio,
  };
})()`;

/// What the launcher webview inside the window `windowId` shows: its card in
/// front and where its keyboard is.
const LAUNCHER = (windowId) => `(() => {
  const host = window.__CHAN_LAUNCHER_WINDOW__;
  if (!host || host.windowId !== ${JSON.stringify(windowId)}) return { skip: true };
  const front = document.querySelector('.slot[aria-current="true"]');
  const active = document.activeElement;
  return {
    front: front?.getAttribute('data-key') ?? null,
    keyboard: active?.closest?.('.slot')?.getAttribute('data-key') ?? null,
    keyboardOnFront: Boolean(front && active && front.contains(active)),
    hasFocus: document.hasFocus(),
    visibility: document.visibilityState,
    slots: [...document.querySelectorAll('.slot')].map((s) => s.getAttribute('data-key')),
  };
})()`;

/// Plant the witness in the window's page: the moment a cover first shows,
/// with its actions then, and a trusted click on the action.
const WITNESS = (windowId) => `(() => {
  if (!(${pageOf(windowId)})) return { skip: true };
  ${OFFERED}
  const w = window.__coverLink = { cover: null, cleared: null, clicks: [], moves: null };
  const look = () => {
    const cover = document.querySelector('[data-cover="reconnect"]');
    if (cover && !w.cover) w.cover = { at: Date.now(), actions: offered(cover).map((b) => b.textContent.trim()) };
    if (!cover && w.cover && !w.cleared) w.cleared = Date.now();
  };
  new MutationObserver(look).observe(document.documentElement, { subtree: true, childList: true });
  addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('[data-cover="reconnect"] button')) {
      w.clicks.push({ at: Date.now(), trusted: e.isTrusted, text: e.target.closest('button').textContent.trim() });
    }
  }, true);
  addEventListener('mousemove', (e) => { w.moves = { x: e.clientX, y: e.clientY, trusted: e.isTrusted }; }, true);
  look();
  return { planted: true, cover: w.cover };
})()`;

const devHome = path.join(work, "devserver-home");
fs.mkdirSync(devHome);
let server = null;
let relay = null;

function startDevserver(args) {
  server = spawn(chan, ["devserver", "run", "--service=none", ...args], {
    env: { ...process.env, CHAN_HOME: devHome }, stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (data) => logs.push(data.toString()));
  server.stderr.on("data", (data) => logs.push(data.toString()));
}

async function devserverReady(base) {
  const ready = await until(async () => {
    if (server.exitCode !== null) throw new Inconclusive("the devserver exited during startup");
    try { return { ok: (await fetch(`${base}/api/devserver/info`, { signal: AbortSignal.timeout(1000) })).ok }; }
    catch { return null; }
  }, 60_000);
  if (!ready?.ok) throw new Inconclusive("the devserver did not start");
}

async function desktopPageUp() {
  const pageUp = await until(async () => {
    try { return { ok: (await inspectAll("document.readyState === 'complete'")).some((page) => page.value === true) }; }
    catch { return null; }
  }, 60_000);
  if (!pageUp?.ok) throw new Inconclusive("no desktop page answered the inspector");
}

/// Press the Computers chord in the window `host` (an X window id) until
/// `shown` answers as wanted, up to three times.
async function toggleScreen(host, step, wanted) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    await xdo("windowactivate", "--sync", host);
    await xdo("key", "--clearmodifiers", "ctrl+shift+p");
    last = await until(async () => ({ ok: await wanted() }), 10_000);
    if (last?.ok) return;
  }
  await shot("root", `no-${step}`);
  throw new Inconclusive(`the Computers chord did not ${step} the screen`);
}

/// The desktop's own library: the launcher page's origin and bearer.
async function desktopLibrary() {
  const launcherHref = (await inspectAll("window.__CHAN_LAUNCHER_WINDOW__ && document.querySelector('.slot') ? location.href : null"))
    .map((page) => page.value).find((value) => typeof value === "string");
  if (!launcherHref) throw new Inconclusive("the launcher page gave no address");
  const launcherUrl = new URL(launcherHref);
  const launcherToken = launcherUrl.searchParams.get("t");
  if (!launcherToken) throw new Inconclusive("the launcher page has no bearer");
  secrets.push(launcherToken);
  return (method, route, body) => api(launcherUrl.origin, launcherToken, method, route, body);
}

/// Where X input lands on the page: the offset between a screen point and
/// the client point the page's trusted mousemove reports for it, read at two
/// points, which must agree.
async function calibrate(host, windowId) {
  const geo = Object.fromEntries((await xdo("getwindowgeometry", "--shell", host)).split("\n").map((l) => l.split("=")));
  const [x, y, w, h] = ["X", "Y", "WIDTH", "HEIGHT"].map((k) => Number(geo[k]));
  const seen = [];
  for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.35]]) {
    const sx = Math.round(x + w * fx);
    const sy = Math.round(y + h * fy);
    await xdo("mousemove", sx - 7, sy - 7);
    await sleep(150);
    await xdo("mousemove", sx, sy);
    await sleep(250);
    const move = (await inspectOne("calibrate", `(() => {
      if (!(${pageOf(windowId)})) return { skip: true };
      return window.__coverLink?.moves ?? { none: true };
    })()`));
    seen.push({ sx, sy, move });
  }
  const offsets = seen.map((p) => p.move?.trusted ? [p.sx - p.move.x, p.sy - p.move.y] : null);
  const agree = offsets.every((o) => o && o[0] === offsets[0][0] && o[1] === offsets[0][1]);
  if (!agree) throw new Inconclusive(`X input cannot be placed on the page: ${JSON.stringify(seen)}`);
  return { dx: offsets[0][0], dy: offsets[0][1], window: { x, y, w, h } };
}

// The flows of a page of the engine's, told by their request: the desktop's
// own HTTP and WebSocket client sends no User-Agent.
const pageFlow = (flow) => /^user-agent:/im.test(flow.head ?? "");
const FEED_PATH = "/api/library/windows/watch";
const upgraded = new Set();

/// The page's path prefix, read as its transport reads it (`readPrefix` in
/// transport.ts): the `chan-prefix` meta its server injects, trimmed, kept
/// only when it starts with a slash, without trailing slashes, and empty for
/// a page served at the root. A devserver's terminal window is served under
/// `/api/terminal`, a workspace window under its tenant's prefix.
const PAGE_PREFIX = `(() => {
  const v = document.querySelector('meta[name="chan-prefix"]')?.getAttribute('content')?.trim() ?? '';
  return v && v.startsWith('/') ? v.replace(/\\/+$/, '') : '';
})()`;

/// The request target of `flow` (path and query), from its head.
const requestTarget = (flow) => flow.head?.split("\r\n", 1)[0]?.split(" ")[1] ?? null;

/// Whether `flow` is the watcher socket of the window `windowId`, whose page
/// has the path prefix `prefix`. openWatch (transport.ts) dials
/// `${prefix}/ws` with the window's `w`. The page's other sockets sit under
/// the same prefix (a terminal's `${prefix}/api/terminal/ws`, a document's
/// `${prefix}/api/doc/ws` and a drawing's `${prefix}/api/scene/ws`, the last
/// two with the same `w`) or at the root (the colour and theme watches), so
/// the path must be the watcher's exactly.
function watcherOf(flow, windowId, prefix) {
  const target = requestTarget(flow);
  if (!target) return false;
  const url = new URL(target, "http://relay");
  return url.pathname === `${prefix}/ws` && url.searchParams.get("w") === windowId;
}

let status = 3;
const windows = [];
// The desktop's own library, once a Computers screen has shown.
let desktopApi = null;
// The local window, which holds the focus before the devserver connects.
let localHost = null;

/// Click Show in Computers, read the screen over the window and hide it, and
/// read the cover after the hide. The action's box as the hide landed, or
/// null when a fault ended the steps before it.
async function screenSteps({ host, windowId, offset, dropAt, devserverCard }) {
  // The trusted click on the action shows the screen over this window with
  // the devserver's card in front and the keyboard on it.
  const target = await inspectOne("action", COVER(windowId));
  if (!target?.action || target.action.disabled) {
    fault("Show in Computers is offered but cannot be clicked", target);
    return null;
  }
  const sx = Math.round(target.action.x + offset.dx);
  const sy = Math.round(target.action.y + offset.dy);
  await xdo("windowactivate", "--sync", host);
  await xdo("mousemove", sx - 5, sy - 5);
  await sleep(120);
  await xdo("mousemove", sx, sy);
  await sleep(120);
  const clickAt = Date.now();
  await xdo("click", "1");
  const front = await until(async () => {
    const launcher = await inspectOne("shown", LAUNCHER(windowId));
    const seen = await inspectOne("shown page", COVER(windowId));
    return {
      ok: launcher?.front === devserverCard && launcher.keyboardOnFront && launcher.hasFocus && seen?.covered,
      launcher, seen,
    };
  }, 15_000);
  const clicks = front?.seen?.witness?.clicks ?? [];
  const screen = {
    clickAfterDropMs: clickAt - dropAt, afterClickMs: Date.now() - clickAt, devserverCard, clicks, launcher: front?.launcher ?? null,
    coverUnderneath: front?.seen?.cover ?? null, error: front?.seen?.error ?? null,
  };
  await shot(host, "shown");
  if (front?.ok && clicks.some((c) => c.trusted && c.text === ACTION) && front.seen.cover) {
    pass("a trusted click on Show in Computers shows the screen over the window on the devserver's card with the keyboard on it", screen);
  } else {
    fault("the click on Show in Computers did not show the devserver's card in front with the keyboard on it", screen);
    return null;
  }

  // Hiding the screen leaves the cover up with the focus on it, while the
  // outage lasts.
  await toggleScreen(host, "hide", async () => (await inspectOne("hidden", COVER(windowId)))?.covered === false);
  // The action's box as the hide lands, before the focus is waited for.
  const landed = await inspectOne("after hide", COVER(windowId));
  const afterHide = { atMs: Date.now() - dropAt, box: landed?.action?.box ?? null, actions: landed?.actions ?? [] };
  const back = await until(async () => {
    const seen = await inspectOne("focus back", COVER(windowId));
    return { ok: Boolean(seen?.cover && seen.focusInCover && seen.hasFocus), seen };
  }, 10_000);
  await sleep(HELD_MS);
  const later = await inspectOne("still covered", COVER(windowId));
  await shot(host, "hidden");
  const hidden = { back: back?.seen ?? null, later };
  if (back?.ok && later?.cover && later.focusInCover && later.hasFocus) {
    pass("hiding the screen leaves the cover up with the focus on it", hidden);
  } else {
    fault("hiding the screen did not leave the cover up with the focus on it", hidden);
  }
  return afterHide;
}

async function devserverArm() {
  const devPort = await freePort();
  const devBase = `http://127.0.0.1:${devPort}`;
  startDevserver(["--bind=127.0.0.1", `--port=${devPort}`]);
  relay = await startRelay(devPort);
  // A page's WebSocket that its server answered with a switch; the window's
  // watcher among them has been open, which the cover needs before it can
  // show.
  relay.tap((flow, index, chunk) => {
    if (index === 1 && pageFlow(flow) && chunk.toString("latin1", 0, 12) === "HTTP/1.1 101") {
      upgraded.add(flow);
    }
  });
  const relayBase = `http://127.0.0.1:${relay.port}`;
  await devserverReady(devBase);
  const token = JSON.parse(fs.readFileSync(path.join(devHome, "devserver/config.json"))).devserver_token;
  secrets.push(token);
  const remote = (method, route, body) => api(devBase, token, method, route, body);
  const cli = (args) => run(chan, args, { timeout: 90_000 });
  await desktopPageUp();

  localHost = await xdo("getactivewindow");
  await cli(["devserver", "register", `${relayBase}/?t=${token}`, "--name", LABEL]);
  await cli(["devserver", "connect", LABEL]);
  const connected = await until(async () => {
    const { stdout } = await cli(["devserver", "ls", "--json"]);
    return { ok: JSON.parse(stdout).devservers.some((d) => d.label === LABEL && d.status === "connected") };
  }, 60_000);
  if (!connected?.ok) throw new Inconclusive("the desktop did not connect to the devserver through the relay");
  const feedFlow = () => relay.flows.find((flow) => flow.path === FEED_PATH && !pageFlow(flow) && !flow.closed) ?? null;
  if (!(await until(async () => ({ ok: Boolean(feedFlow()) }), 30_000))?.ok) {
    throw new Inconclusive("no window feed of the desktop's passed through the relay");
  }

  // One window of the devserver's, opened on the desktop by its feed.
  const before = new Set(await visibleWindows());
  const window = await remote("POST", "/api/library/windows", { kind: "terminal" });
  secrets.push(window.token);
  windows.push(window);
  const windowId = window.window_id;
  const opened = await until(async () => {
    const page = await inspectOne("open", `(${pageOf(windowId)}) ? { up: true, prefix: ${PAGE_PREFIX}, location: location.pathname } : { skip: true }`);
    return { ok: Boolean(page?.up), page };
  }, 60_000);
  if (!opened?.ok) throw new Inconclusive("the devserver's window did not open on the desktop");
  // The desktop titles a direct devserver's windows with the host label the
  // devserver reports in its info, falling back to the host it dialled
  // (main.rs), not with the name it was registered under. Matching that
  // label, among the windows that appeared, is what ties the X window to the
  // devserver; a lone new window would take anything the desktop mapped
  // meanwhile.
  const info = await (await fetch(`${devBase}/api/devserver/info`, { signal: AbortSignal.timeout(10_000) })).json();
  const machine = info.host_label?.trim() || "127.0.0.1";
  const fresh = (await visibleWindows()).filter((id) => !before.has(id));
  const named = [];
  const seenNames = [];
  for (const id of fresh) {
    const name = await xdo("getwindowname", id).catch(() => "");
    seenNames.push(name);
    if (name.includes(` ${machine} `)) named.push({ id, name });
  }
  if (named.length !== 1) throw new Inconclusive(`no one new window is titled with ${JSON.stringify(machine)}: ${JSON.stringify(seenNames)}`);
  const host = named[0].id;
  const prefix = opened.page.prefix;
  if (!(await until(async () => ({ ok: [...upgraded].some((flow) => watcherOf(flow, windowId, prefix)) }), 30_000))?.ok) {
    throw new Inconclusive(`the devserver's window opened no watcher socket through the relay: no switched socket is ${prefix}/ws with w=${windowId}; the switched ones: ${JSON.stringify([...upgraded].map(requestTarget))}`);
  }
  await sleep(2_000);
  await xdo("windowactivate", "--sync", host);
  const planted = await inspectOne("witness", WITNESS(windowId));
  if (!planted?.planted || planted.cover) throw new Inconclusive(`the window's page took no witness, or shows a cover already: ${JSON.stringify(planted)}`);
  const offset = await calibrate(host, windowId);
  const page = await inspectOne("page", COVER(windowId));
  if (page?.dpr !== 1) throw new Inconclusive(`the page is at device pixel ratio ${page?.dpr}, which the X input placement does not scale`);

  // Another card in front of this window's Computers screen first: This
  // machine's, which is neither the devserver's nor the screen's first card.
  await toggleScreen(host, "show", async () => (await inspectOne("show", LAUNCHER(windowId)))?.slots?.includes("local")
    && (await inspectOne("show page", COVER(windowId)))?.covered === true);
  const desktop = await desktopLibrary();
  desktopApi = desktop;
  const row = (await desktop("GET", "/api/library/devservers")).find((d) => d.label === LABEL);
  if (!row) throw new Inconclusive("the desktop's library lists no devserver row for the devserver");
  const devserverCard = row.id;
  await inspectAll(`(() => {
    const host = window.__CHAN_LAUNCHER_WINDOW__;
    if (!host || host.windowId !== ${JSON.stringify(windowId)}) return null;
    document.querySelector('.slot[data-key="local"]')?.click();
    return true;
  })()`);
  const other = await until(async () => {
    const launcher = await inspectOne("other card", LAUNCHER(windowId));
    return { ok: launcher?.front === "local", launcher };
  }, 10_000);
  if (!other?.ok) throw new Inconclusive(`This machine's card did not come to the front: ${JSON.stringify(other?.launcher)}`);
  await sleep(600); // the deck's turn
  await toggleScreen(host, "hide", async () => (await inspectOne("hide", COVER(windowId)))?.covered === false);
  const held = await inspectOne("held", LAUNCHER(windowId));
  if (held?.front !== "local") throw new Inconclusive(`the hidden screen does not hold This machine's card: ${JSON.stringify(held)}`);

  // The window's flows closed and refused, the feed left flowing.
  await xdo("windowactivate", "--sync", host);
  const dropAt = Date.now();
  relay.drop(pageFlow);
  relay.refuse(true, pageFlow);
  const shown = await until(async () => {
    const seen = await inspectOne("cover", COVER(windowId));
    return { ok: Boolean(seen?.witness?.cover), seen };
  }, 10_000, 100);
  if (!shown?.ok) {
    fault("the cover did not show with the window's flows closed", shown?.seen ?? null);
    return;
  }
  const cover = shown.seen.witness.cover;
  const coverMs = cover.at - dropAt;
  await shot(host, "cover");
  const offered = cover.actions.includes(ACTION);
  const early = { coverMs, actionsAtShow: cover.actions, focusOnCover: shown.seen.focusOnCover };
  if (coverMs <= COVER_WITHIN_MS && offered && !cover.actions.includes("Restart connection")) {
    pass("the cover shows within about 1 s with Show in Computers, before Restart connection and Abandon", early);
  } else {
    fault("the cover did not show within about 1 s with Show in Computers alone", early);
  }
  if (shown.seen.focusOnCover) pass("focus parks on the cover itself", { focus: shown.seen.focus });
  else fault("focus did not park on the cover itself", { focus: shown.seen.focus });
  if (!offered) return;

  // The screen's steps end where a fault is seen; the place readings and the
  // restore below run whatever they found, and an instrument failure in them
  // is raised only after those readings.
  let failed = null;
  let afterHide = null;
  try {
    afterHide = await screenSteps({ host, windowId, offset, dropAt, devserverCard });
  } catch (error) {
    if (!(error instanceof Inconclusive)) throw error;
    failed = error;
  }
  if (!feedFlow()) fault("the devserver's feed did not keep flowing through the outage", relay.summary());

  // Show in Computers keeps its place: its box as the cover showed, as the
  // screen's hide landed, and once Restart connection and Abandon show. The
  // box at the hide, while those two are still held, tells a move across the
  // click, the show and the hide from one at 8 s; a hide that landed after
  // 8 s, or none, leaves the two causes together.
  await sleep(Math.max(0, dropAt + RECOVERY_ACTIONS_MS + 500 - Date.now()));
  const settled = await inspectOne("all actions", COVER(windowId));
  const shift = (from, to) => from && to
    ? Math.max(...["left", "top", "width", "height"].map((k) => Math.abs(to[k] - from[k])))
    : null;
  const boxAtShow = shown.seen.action?.box ?? null;
  const hideBefore8s = afterHide !== null && afterHide.box !== null && !afterHide.actions.includes("Restart connection");
  const boxAfterHide = hideBefore8s ? afterHide.box : null;
  const boxSettled = settled?.action?.box ?? null;
  const place = {
    boxAtShow, afterHide, boxAfterHide, boxSettled, actions: settled?.actions ?? null,
    acrossScreen: shift(boxAtShow, boxAfterHide), at8s: shift(boxAfterHide, boxSettled), overall: shift(boxAtShow, boxSettled),
  };
  readings.push({ at: Date.now(), step: "place", value: place });
  const moved = (by) => by !== null && by > BOX_TOLERANCE_PX;
  const untold = afterHide === null
    ? "no box was read at the hide, as a fault ended the screen's steps first"
    : "the hide landed after 8 s";
  if (!settled?.actions.includes("Restart connection") || !settled.actions.includes("Abandon") || place.overall === null) {
    fault("Restart connection and Abandon did not show beside Show in Computers at 8 s", place);
  } else if (boxAfterHide === null) {
    if (moved(place.overall)) fault(`Show in Computers moved between the cover's show and 8 s; ${untold}, so the cause is not told`, place);
    else pass(`Show in Computers keeps its place from the cover's show to Restart connection and Abandon showing (${untold})`, place);
  } else {
    if (moved(place.acrossScreen)) fault("Show in Computers moved across the screen's show and hide", place);
    if (moved(place.at8s)) fault("Show in Computers moved when Restart connection and Abandon appeared", place);
    if (!moved(place.acrossScreen) && !moved(place.at8s)) {
      pass("Show in Computers keeps its place across the screen and when Restart connection and Abandon appear", place);
    }
  }

  // The link restored, the cover clears.
  relay.refuse(false);
  const cleared = await until(async () => {
    const seen = await inspectOne("restored", COVER(windowId));
    return { ok: seen && !seen.cover, seen };
  }, 30_000);
  if (cleared?.ok) pass("with the window's flows let through again the cover clears", cleared.seen.witness);
  else fault("the cover stayed with the window's flows let through again", cleared?.seen ?? null);
  if (failed) throw failed;
}

/// The local window's outage, made in its page: its sockets are noted as they
/// send, and once cut they close and every new one dials `deadPort`, a
/// loopback port the driver bound and freed, until the outage ends. The
/// fetch standard blocks some low ports, and a blocked port throws where the
/// watcher's dial has no catch, which would end its redials. Installed in the
/// page of one of `windowIds`, the desktop's own shown local windows, by its
/// `w`; every page answers with what it read of itself, so a page that skips
/// says why. The cut and the restore go to one window, by its `w`.
const LOCAL_HOOK = (deadPort, windowIds) => `(() => {
  const url = new URL(location.href);
  const page = {
    w: url.searchParams.get('w'), lib: url.searchParams.get('lib'), kind: url.searchParams.get('kind'),
    app: Boolean(document.querySelector('#app > *')), location: location.pathname,
  };
  if (!${JSON.stringify(windowIds)}.includes(page.w) || !page.app) return { skip: true, page };
  if (!window.__coverLinkCut) {
    const sockets = new Set();
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) { sockets.add(this); return send.call(this, data); };
    let cut = false;
    window.WebSocket = new Proxy(window.WebSocket, {
      construct(target, args) { return Reflect.construct(target, cut ? ['ws://127.0.0.1:${deadPort}/'] : args); },
    });
    // The window's watcher, as watcherOf reads it: the page's prefix and
    // /ws exactly, dialled with the window's own w.
    const prefix = ${PAGE_PREFIX};
    const watcher = (s) => {
      const at = new URL(s.url);
      return at.pathname === prefix + '/ws' && at.searchParams.get('w') === url.searchParams.get('w');
    };
    window.__coverLinkCut = {
      seen: () => [...sockets].filter((s) => s.readyState === 1).map((s) => {
        const at = new URL(s.url);
        return { target: at.pathname + at.search, prefix, watcher: watcher(s) };
      }),
      cut() { cut = true; for (const s of sockets) s.close(); return true; },
      restore() { cut = false; return true; },
    };
  }
  return { page, window: page.w, seen: window.__coverLinkCut.seen() };
})()`;
const localCall = (windowId, call) => `(() => {
  if (!(${pageOf(windowId)}) || !window.__coverLinkCut) return { skip: true };
  return { [${JSON.stringify(call)}]: window.__coverLinkCut[${JSON.stringify(call)}]() };
})()`;

/// The X window titled as a local window (`↓ local Terminal Window 1`), when
/// exactly one is; else the window that held the focus at the start.
async function localXWindow() {
  const named = [];
  for (const id of await visibleWindows()) {
    const name = await xdo("getwindowname", id).catch(() => "");
    if (name.includes(" local ") && name.includes("Window")) named.push({ id, name });
  }
  readings.push({ at: Date.now(), step: "local X windows", value: named });
  return named.length === 1 ? named[0].id : localHost;
}

async function localArm() {
  if (!desktopApi) throw new Inconclusive("the desktop's own library was never reached, so no local window is known");
  // The local window by the desktop's own record of it, not by what its
  // page's address is read to say.
  const list = await desktopApi("GET", "/api/library/windows");
  const records = Array.isArray(list) ? list : list?.windows ?? [];
  const local = records.filter((r) => r.library_id === "local" && !r.control && !r.hidden && r.origin !== "browser");
  readings.push({
    at: Date.now(), step: "local records",
    value: records.map(({ window_id, library_id, kind, control, hidden, origin, connected, prefix }) =>
      ({ window_id, library_id, kind, control, hidden, origin, connected, prefix })),
  });
  if (local.length === 0) throw new Inconclusive("the desktop lists no shown local window; see the local records reading");
  const host = await localXWindow();
  if (!host) throw new Inconclusive("no local window's X window is known");
  await xdo("windowactivate", "--sync", host);
  const hook = LOCAL_HOOK(await freePort(), local.map((r) => r.window_id));
  const hooked = await until(async () => {
    const pages = await inspectPages("local sockets", hook);
    const seen = pages.map((page) => page.value).find((value) => value && !value.skip) ?? null;
    return { ok: Boolean(seen?.seen?.some((socket) => socket.watcher)), seen };
  }, 30_000);
  if (!hooked?.ok) {
    throw new Inconclusive(`the local window's watcher socket was not reached: ${JSON.stringify(hooked?.seen)}; each page's answer is in the local sockets readings`);
  }
  const windowId = hooked.seen.window;
  const planted = await inspectOne("local witness", WITNESS(windowId));
  if (!planted?.planted || planted.cover) throw new Inconclusive("the local window's page took no witness, or shows a cover already");
  const cutAt = Date.now();
  if (!(await inspectOne("local cut", localCall(windowId, "cut")))?.cut) throw new Inconclusive("the local window's sockets were not cut");
  const shown = await until(async () => {
    const seen = await inspectOne("local cover", COVER(windowId));
    return { ok: Boolean(seen?.witness?.cover), seen };
  }, 10_000, 100);
  if (!shown?.ok) throw new Inconclusive("the local window's cover did not show with its sockets closed");
  await sleep(Math.max(0, cutAt + RECOVERY_ACTIONS_MS + 1_000 - Date.now()));
  const later = await inspectOne("local later", COVER(windowId));
  await shot(host, "local-cover");
  const detail = { coverMs: shown.seen.witness.cover.at - cutAt, actionsAtShow: shown.seen.witness.cover.actions, actionsLater: later?.actions ?? null };
  if (!detail.actionsAtShow.includes(ACTION) && later?.cover && !later.actions.includes(ACTION)) {
    pass("a local window's cover offers no Show in Computers", detail);
  } else {
    fault("a local window's cover offers Show in Computers", detail);
  }
  await inspectOne("local restore", localCall(windowId, "restore"));
  const cleared = await until(async () => {
    const seen = await inspectOne("local restored", COVER(windowId));
    return { ok: seen && !seen.cover, seen };
  }, 30_000);
  if (!cleared?.ok) logs.push(`the local window's cover stayed after its sockets were let through: ${JSON.stringify(cleared?.seen)}`);
}

try {
  // A fault ends the devserver arm at the step it was seen at; the local
  // arm runs either way.
  await devserverArm();
  await localArm();
  status = faulted ? 10 : 0;
} catch (error) {
  if (!(error instanceof Inconclusive)) logs.push(String(error?.stack ?? error));
  console.log(`INCONCLUSIVE: ${mask(error?.message ?? error)}`);
  // A reading that failed before this step stands.
  status = faulted ? 10 : 3;
} finally {
  try {
    const desktop = await desktopLibrary();
    for (const window of windows) await desktop("POST", `/api/library/windows/${window.window_id}/close`, {});
  } catch { /* best effort */ }
  fs.writeFileSync(path.join(work, "results.json"), mask(JSON.stringify({
    status, checks, readings,
    flows: relay?.flows.map((flow) => ({
      path: flow.path, target: requestTarget(flow), page: pageFlow(flow), closed: flow.closed, refused: flow.refused,
    })) ?? [],
    relay: relay?.summary() ?? null,
  }, null, 2)) + "\n");
  fs.writeFileSync(path.join(work, "devserver.log"), mask(logs.join("")));
  await relay?.close();
  server?.kill("SIGTERM");
}
process.exit(status);
