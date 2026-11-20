#!/usr/bin/env node
// Reads a devserver's connection face on the real WebKitGTK Computers screen
// through a relay that delays, silences, drops and restores its flows. The
// shell driver owns the desktop and the display; this owns the devserver and
// the relay.
//
// Direct: the relay sits between the desktop and the devserver, and counts
// the `{"type":"ping"}` frames the desktop sends on the devserver's window
// feed, told from a page's own by the request: a page's carries its origin.
// Gateway (a fixture from `gateway-zone.sh connface`): the devserver's tunnel
// to the gateway's proxy passes through the relay, so a delay there slows
// only replies that cross the tunnel, and a face that reads slow shows the
// reply came from the devserver, not from the gateway.
//
// Every bounded wait (`until`, `readUntil`, `showScreen`) is a hang guard:
// it bounds a step that never comes, and its failure names the step. The
// bounds that measure are `FOCUSED_CADENCE_MS - 400` (a screen's ping ahead
// of the cadence), the 2.1 s step between two stalled counts, and
// `CADENCE_SPAN_MS` (the span the feed's pings are counted over).
//
// Exit 0 when every reading held, 10 when one did not, 3 when a step the
// readings rest on did not happen.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { clientFrameReader, startRelay } from "../browser-smoke/lib/flow-relay.mjs";

const run = promisify(execFile);
const [inspector, work, chan, fixturePath] = process.argv.slice(2);
const fixture = fixturePath ? JSON.parse(fs.readFileSync(fixturePath)) : null;
const here = path.dirname(fileURLToPath(import.meta.url));
const LABEL = fixture ? "face-gateway" : "face-test";
const FEED_PATH = "/api/library/windows/watch";
const DELAY_EACH_WAY_MS = 650;
const FOCUSED_CADENCE_MS = 3_000;
const CADENCE_SPAN_MS = 15_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secrets = fixture ? [fixture.pat.secret, fixture.tunnelPat] : [];
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

/// Poll `probe` until it answers truthy or `ms` pass; the last answer either way.
async function until(probe, ms) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last?.ok) return last;
    await sleep(250);
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

// The card as the launcher shows it, read in whichever page holds the deck.
let cardKey = null;
const findSlot = () => cardKey
  ? `[...document.querySelectorAll('.slot')].find((s) => s.getAttribute('data-key') === ${JSON.stringify(cardKey)})`
  : `[...document.querySelectorAll('.slot')].find((s) => [...s.querySelectorAll('.ds-name-row .row-name')].some((n) => n.textContent.trim() === ${JSON.stringify(LABEL)}))`;
const READ = () => `(() => {
  if (!document.querySelector('.slot')) return { skip: true };
  const slot = ${findSlot()};
  const local = document.querySelector('.slot[data-key="local"]');
  const face = slot?.querySelector('.ds-name-row .connection-face');
  const detail = slot?.querySelector('.ds-health .connection-detail');
  const chart = detail?.querySelector('svg.sparkline');
  const edges = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right) };
  };
  return {
    key: slot?.getAttribute('data-key') ?? null,
    front: slot?.getAttribute('aria-current') === 'true',
    face: face ? { state: face.dataset.face, text: face.textContent.trim(), title: face.getAttribute('title') } : null,
    detail: detail ? {
      text: detail.innerText.replace(/\\s+/g, ' ').trim(),
      misses: detail.querySelectorAll('.miss').length,
      runs: detail.querySelectorAll('.reading').length,
      chart: chart ? { ...edges(chart), height: getComputedStyle(chart).height } : null,
      figures: edges(detail.querySelector('.figures')),
      name: edges(slot.querySelector('.ds-name-row .row-name')),
      header: (() => {
        const header = slot.querySelector('.machine-header');
        if (!header) return null;
        const r = header.getBoundingClientRect();
        return { left: Math.round(r.left + parseFloat(getComputedStyle(header).paddingLeft)) };
      })(),
      actions: edges(slot.querySelector('.machine-actions')),
    } : null,
    faces: slot ? slot.querySelectorAll('.connection-face').length : -1,
    localMarks: local ? local.querySelectorAll('.connection-face, .connection-detail').length : -1,
    allFaces: document.querySelectorAll('.connection-face').length,
  };
})()`;

async function inspectAll(expression) {
  const { stdout } = await run(process.execPath, [path.join(here, "inspect.mjs"), inspector, "all", expression],
    { timeout: 30_000, maxBuffer: 1 << 22 });
  return stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function readCard(step) {
  const pages = await inspectAll(READ());
  const card = pages.map((page) => page.value).find((value) => value && !value.skip) ?? null;
  readings.push({ at: Date.now(), step, card });
  return card;
}

/// Read the card until `holds(card)`, up to `ms`: the last reading, with `ok`.
async function readUntil(step, holds, ms) {
  return until(async () => {
    const card = await readCard(step);
    return { ok: Boolean(card && holds(card)), card };
  }, ms);
}

async function shot(windowId, name) {
  try {
    await run("import", ["-window", windowId, path.join(work, "shots", `${name}.png`)], { timeout: 15_000 });
  } catch (error) {
    logs.push(`screenshot ${name}: ${error}`);
  }
}

const devHome = path.join(work, "devserver-home");
fs.mkdirSync(devHome);
let server = null;
let relay = null;

function startDevserver(args, env = {}) {
  server = spawn(chan, ["devserver", "run", "--service=none", ...args], {
    env: { ...process.env, CHAN_HOME: devHome, ...env }, stdio: ["ignore", "pipe", "pipe"],
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

/// Show the Computers screen over `host` until `shown` holds, pressing the
/// chord up to three times; on failure keep what the screen showed.
async function showScreen(host, shown) {
  let screen = null;
  for (let attempt = 0; attempt < 3 && !screen?.ok; attempt++) {
    await run("xdotool", ["windowactivate", "--sync", host]);
    await run("xdotool", ["key", "--clearmodifiers", "ctrl+shift+p"]);
    screen = await until(async () => ({ ok: await shown() }), 15_000);
  }
  if (screen?.ok) return;
  try {
    const { stdout: pages } = await run(process.execPath, [path.join(here, "inspect.mjs"), inspector, "list"], { timeout: 15_000 });
    logs.push(`inspector pages:\n${pages}`);
    const { stdout: active } = await run("xdotool", ["getactivewindow", "getwindowname"]);
    logs.push(`active window: ${active}`);
    await run("import", ["-window", "root", path.join(work, "shots", "no-deck.png")], { timeout: 15_000 });
  } catch (error) {
    logs.push(`no-deck diagnostics: ${error}`);
  }
  throw new Inconclusive("the Computers screen did not show the devserver's card");
}

/// The desktop's own library: the launcher page's origin and bearer.
async function desktopLibrary() {
  const launcherHref = (await inspectAll("document.querySelector('.slot') ? location.href : null"))
    .map((page) => page.value).find((value) => typeof value === "string");
  if (!launcherHref) throw new Inconclusive("the launcher page gave no address");
  const launcherUrl = new URL(launcherHref);
  const launcherToken = launcherUrl.searchParams.get("t");
  if (!launcherToken) throw new Inconclusive("the launcher page has no bearer");
  secrets.push(launcherToken);
  return (method, route, body) => api(launcherUrl.origin, launcherToken, method, route, body);
}

/// Bring the devserver's card to the front of the deck.
async function cardToFront() {
  await inspectAll(`(() => { const s = ${findSlot()}; s?.click(); return Boolean(s); })()`);
  const front = await readUntil("front", (card) => card.front, 15_000);
  if (!front?.ok) throw new Inconclusive("the devserver's card did not come to the front");
  await sleep(600); // the deck's turn
}

/// The detail leaves the state and its count to the face: it opens on the
/// chart, whose text is nothing, so its words start at the figures.
const detailOpensOnFigures = (card) => /^Latest /.test(card?.detail?.text ?? "");

/// The chart spans the card at the header's inset: from the left edge of
/// the header's content to the right edge of its actions, at its fixed
/// height; the figures under it start under the name.
const chartSpansCard = (card) => {
  const { chart, figures, name, header, actions } = card?.detail ?? {};
  return Boolean(chart && figures && name && header && actions) && chart.height === "69px"
    && Math.abs(chart.left - header.left) <= 2 && Math.abs(chart.right - actions.right) <= 2
    && Math.abs(figures.left - name.left) <= 2;
};

async function healthyLeg(host) {
  const healthy = await readUntil("healthy",
    (card) => card.face?.state === "healthy" && card.face.title === "Connection healthy" && detailOpensOnFigures(card), 30_000);
  if (healthy?.ok) {
    pass("the card in front shows a healthy face beside the name and under the address a detail that opens on its chart", healthy.card);
    if (chartSpansCard(healthy.card)) pass("the detail's chart spans the card at the header's inset to the actions, 69 px high, its figures under the name", healthy.card.detail);
    else fault("the detail's chart does not span the card at the header's inset to the actions at 69 px with its figures under the name", healthy.card.detail);
  } else {
    fault("no healthy face beside the name with a detail under the address that opens on its chart", healthy?.card ?? null);
  }
  await shot(host, "healthy");
  const local = await readCard("local");
  if (local && local.localMarks === 0) pass("the local machine's card shows no face", { localMarks: local.localMarks });
  else fault("the local machine's card shows a face or detail", local);
}

/// The face's reply time at a delay of 650 ms each way: at least the
/// 1.3 s round trip, and no more than a slow link's few seconds.
const SLOW_TITLE = /^Connection slow, (\d+\.\d) s$/;
const slowReply = (card, max) => {
  const seconds = Number(SLOW_TITLE.exec(card.face?.title ?? "")?.[1] ?? NaN);
  return card.face?.state === "slow" && seconds >= 1.2 && seconds <= max;
};

/// The last contact as the figures line reads it: the clock time after
/// Since, the line's last figure and the detail's last words.
const lastContact = (card) => /Since (.+)$/.exec(card?.detail?.text ?? "")?.[1] ?? null;

// Every client frame of every flow, read past its request head; a flow
// from the desktop's own client carries no Origin header.
const flowStates = new Map();
const pings = [];
const tapFeed = (flow, index, chunk) => {
  if (index !== 0) return;
  let state = flowStates.get(flow);
  if (!state) {
    state = { id: flowStates.size, head: Buffer.alloc(0), reader: null, desktop: null };
    flowStates.set(flow, state);
  }
  let rest = chunk;
  if (!state.reader) {
    state.head = Buffer.concat([state.head, chunk]);
    const end = state.head.indexOf("\r\n\r\n");
    if (end < 0) return;
    const head = state.head.toString("latin1", 0, end);
    state.desktop = !/^origin:/im.test(head);
    state.reader = clientFrameReader();
    rest = state.head.subarray(end + 4);
  }
  if (flow.path !== FEED_PATH) return;
  for (const frame of state.reader.push(rest)) {
    if (frame.text === '{"type":"ping"}') pings.push({ at: Date.now(), flow: state.id, desktop: state.desktop });
  }
};
const feedPings = (from, to) => pings.filter((p) => p.desktop && p.at >= from && p.at < to);

let status = 3;
const windows = [];
let desktop = null;

async function direct() {
  const devPort = await freePort();
  const devBase = `http://127.0.0.1:${devPort}`;
  startDevserver(["--bind=127.0.0.1", `--port=${devPort}`]);
  relay = await startRelay(devPort);
  relay.tap(tapFeed);
  const relayBase = `http://127.0.0.1:${relay.port}`;
  await devserverReady(devBase);
  const token = JSON.parse(fs.readFileSync(path.join(devHome, "devserver/config.json"))).devserver_token;
  secrets.push(token);
  const remote = (method, route, body) => api(devBase, token, method, route, body);
  const cli = (args) => run(chan, args, { timeout: 90_000 });
  await desktopPageUp();

  // The window that holds the focus before the devserver connects, the
  // local one: the devserver's own windows open over it later.
  const { stdout: firstWindow } = await run("xdotool", ["getactivewindow"]);
  const host = firstWindow.trim();
  await cli(["devserver", "register", `${relayBase}/?t=${token}`, "--name", LABEL]);
  await cli(["devserver", "connect", LABEL]);
  const connected = await until(async () => {
    const { stdout } = await cli(["devserver", "ls", "--json"]);
    return { ok: JSON.parse(stdout).devservers.some((d) => d.label === LABEL && d.status === "connected") };
  }, 60_000);
  if (!connected?.ok) throw new Inconclusive("the desktop did not connect to the devserver through the relay");
  const feedFlow = await until(async () => ({
    ok: [...flowStates.values()].some((state) => state.desktop) && relay.flows.some((flow) => flow.path === FEED_PATH),
  }), 30_000);
  if (!feedFlow?.ok) throw new Inconclusive("no window feed of the desktop's passed through the relay");

  // The Computers screen shows over the window the chord reaches, and the
  // desktop's own library closes the devserver's windows.
  await showScreen(host, async () => (await readCard("open"))?.key != null);
  desktop = await desktopLibrary();
  await cardToFront();

  // Healthy, with the face beside the name and the detail under the address.
  await healthyLeg(host);

  // The Computers screen showing asks the feed for a ping between two of
  // the 3 s cadence's.
  await run("xdotool", ["windowactivate", "--sync", host]);
  await run("xdotool", ["key", "--clearmodifiers", "ctrl+shift+p"]);
  await sleep(1_500);
  const mark = Date.now();
  const before = await until(async () => {
    const ping = pings.find((p) => p.desktop && p.at > mark);
    return { ok: Boolean(ping), ping };
  }, 8_000);
  if (before?.ok) {
    await sleep(Math.max(0, before.ping.at + 800 - Date.now()));
    await run("xdotool", ["windowactivate", "--sync", host]);
    const shown = Date.now();
    await run("xdotool", ["key", "--clearmodifiers", "ctrl+shift+p"]);
    const next = await until(async () => {
      const ping = pings.find((p) => p.desktop && p.at > before.ping.at);
      return { ok: Boolean(ping), ping };
    }, 5_000);
    const gap = next?.ping ? next.ping.at - before.ping.at : null;
    const detail = { gapMs: gap, afterShowMs: next?.ping ? next.ping.at - shown : null };
    if (gap !== null && gap < FOCUSED_CADENCE_MS - 400 && detail.afterShowMs > 0) {
      pass("showing the Computers screen pings the feed ahead of the cadence", detail);
    } else {
      fault("showing the Computers screen sent no ping ahead of the cadence", detail);
    }
  } else {
    fault("the desktop sends its feed no ping on the focused cadence", { pings: pings.length });
  }
  await readUntil("shown again", (card) => card.front, 10_000);

  // At 650 ms each way the face reads the reply time.
  relay.setDelay(DELAY_EACH_WAY_MS);
  const slow = await readUntil("slow", (card) => slowReply(card, 1.6), 30_000);
  if (slow?.ok) pass("at 650 ms each way the face reads slow with the reply time", slow.card);
  else fault("at 650 ms each way the face did not read slow with the reply time", slow?.card ?? null);
  await shot(host, "slow");
  relay.setDelay(0);
  const recovered = await readUntil("recovered", (card) => card.face?.state === "healthy", 30_000);
  if (!recovered?.ok) fault("the face did not read healthy again with the delay gone", recovered?.card ?? null);

  // Silenced, the face reads stalled and counts the wait in whole seconds.
  relay.silence();
  const stalled = await readUntil("stalled", (card) => card.face?.state === "stalled", 20_000);
  if (stalled?.ok) {
    const count = (card) => Number(/^stalled (\d+) s$/.exec(card?.face?.text ?? "")?.[1] ?? NaN);
    const first = count(stalled.card);
    await sleep(2_100);
    const later = await readCard("stalled count");
    const second = count(later);
    const detail = { first, second, card: later };
    // A stall begins at a 4 s wait, so no count reads under 4.
    if (first >= 4 && Number.isFinite(second) && second - first >= 1 && second - first <= 4
      && later?.face?.title === `Connection stalled for ${second} s` && detailOpensOnFigures(later)) {
      pass("silenced, the face reads stalled and counts in whole seconds", detail);
    } else {
      fault("the stalled face did not count its wait", detail);
    }
  } else {
    fault("the face did not read stalled with the feed silenced", stalled?.card ?? null);
  }
  await shot(host, "stalled");

  // Dropped and refused, it reads reconnecting until the link returns.
  relay.refuse(true);
  relay.drop();
  relay.resume();
  const down = await readUntil("reconnecting", (card) => card.face?.state === "reconnecting", 20_000);
  // The face counts from the drop, and its name carries the same count.
  const downCount = /^reconnecting (\d+) s$/.exec(down?.card?.face?.text ?? "")?.[1];
  if (down?.ok && downCount !== undefined && down.card.face.title === `Connection lost, reconnecting for ${downCount} s`
    && detailOpensOnFigures(down.card)) {
    pass("dropped, the face reads reconnecting", down.card);
  } else {
    fault("the face did not read reconnecting with the feed dropped", down?.card ?? null);
  }
  await sleep(4_000);
  await shot(host, "reconnecting");
  relay.refuse(false);
  // The last contact the outage left, which a reply after the restore moves.
  const outageContact = lastContact(down?.card) ?? lastContact(stalled?.card);
  const restored = await readUntil("restored", (card) => card.face?.state === "healthy" && card.detail?.misses > 0
    && outageContact !== null && ![null, "-", outageContact].includes(lastContact(card)), 90_000);
  const contacts = { outage: outageContact, restored: lastContact(restored?.card) };
  if (restored?.ok) pass("restored, the face reads healthy with the misses in the chart and a later last contact", { contacts, card: restored.card });
  else fault("restored, the face did not read healthy with the misses in the chart and a later last contact", { contacts, card: restored?.card ?? null });
  await shot(host, "restored");

  // One face and one feed ping per cadence, with two of the devserver's
  // windows open and with none. The devserver's pages are counted against
  // those it showed before (its control terminal's).
  const devserverPages = async () =>
    (await inspectAll("location.port")).filter((page) => page.value === String(relay.port)).length;
  const pagesBefore = await devserverPages();
  for (let i = 0; i < 2; i++) {
    const window = await remote("POST", "/api/library/windows", { kind: "terminal" });
    secrets.push(window.token);
    windows.push(window);
  }
  const opened = await until(async () => ({ ok: (await devserverPages()) >= pagesBefore + 2 }), 60_000);
  if (!opened?.ok) throw new Inconclusive("the devserver's two windows did not open on the desktop");
  const cadence = async (step) => {
    await run("xdotool", ["windowactivate", "--sync", host]);
    await sleep(1_000);
    const from = Date.now();
    await sleep(CADENCE_SPAN_MS);
    const feed = feedPings(from, Date.now());
    const card = await readCard(step);
    return {
      pings: feed.length,
      flows: new Set(feed.map((p) => p.flow)).size,
      pagePings: pings.filter((p) => !p.desktop && p.at >= from).length,
      faces: card?.allFaces ?? null,
    };
  };
  const withWindows = await cadence("two windows");
  for (const window of windows.splice(0)) await desktop("POST", `/api/library/windows/${window.window_id}/close`, {});
  const closed = await until(async () => ({ ok: (await devserverPages()) <= pagesBefore }), 60_000);
  if (!closed?.ok) throw new Inconclusive("the devserver's windows did not close on the desktop");
  const withNone = await cadence("no windows");
  const expected = CADENCE_SPAN_MS / FOCUSED_CADENCE_MS;
  const steady = (m) => m.flows === 1 && Math.abs(m.pings - expected) <= 1 && m.faces === 1;
  if (steady(withWindows) && steady(withNone)) {
    pass("one face and one feed ping per cadence with two windows and with none", { withWindows, withNone });
  } else {
    fault("the feed's pings or the faces follow the windows", { withWindows, withNone });
  }
}

async function gateway() {
  // The devserver's tunnel to the gateway's proxy, through the relay; the
  // edge certificate names 127.0.0.1, so the relay's port verifies.
  const [upstreamHost, upstreamPort] = fixture.tunnelUpstream.split(":");
  relay = await startRelay(Number(upstreamPort), { host: upstreamHost });
  const devPort = await freePort();
  startDevserver([
    "--bind", "127.0.0.1", "--port", String(devPort),
    `--tunnel-url=https://127.0.0.1:${relay.port}/v1/tunnel`, `--tunnel-devserver-name=${LABEL}`,
  ], { CHAN_TUNNEL_TOKEN: fixture.tunnelPat, SSL_CERT_FILE: fixture.ca, CHAN_DEVSERVER_LISTEN: "1" });
  await devserverReady(`http://127.0.0.1:${devPort}`);
  await desktopPageUp();
  const { stdout: firstWindow } = await run("xdotool", ["getactivewindow"]);
  const host = firstWindow.trim();

  // The gateway joins through the desktop's own library, with the account
  // token the shell driver put in the keyring, and its devserver connects.
  await showScreen(host, async () => (await inspectAll("Boolean(document.querySelector('.slot'))")).some((page) => page.value === true));
  desktop = await desktopLibrary();
  const added = await desktop("POST", "/api/library/gateways", { url: fixture.origin, label: "face-gateway" });
  await desktop("POST", `/api/library/gateways/${added.id}/connect`, {});
  const row = await until(async () => {
    const rows = await desktop("GET", "/api/library/devservers");
    const found = rows.find((d) => d.gateway_id === added.id);
    return { ok: Boolean(found), found };
  }, 90_000);
  if (!row?.ok) throw new Inconclusive("the devserver did not appear in the gateway's roster");
  await desktop("POST", `/api/library/devservers/${encodeURIComponent(row.found.id)}/connect`, {});
  const connected = await until(async () => {
    const rows = await desktop("GET", "/api/library/devservers");
    return { ok: rows.some((d) => d.id === row.found.id && d.status === "connected") };
  }, 90_000);
  if (!connected?.ok) throw new Inconclusive("the desktop did not connect to the gateway's devserver");
  cardKey = row.found.id;
  await cardToFront();

  await healthyLeg(host);
  // The tunnel leg at 650 ms each way: the devserver's reply crosses it.
  relay.setDelay(DELAY_EACH_WAY_MS);
  const slow = await readUntil("slow", (card) => slowReply(card, 5), 45_000);
  if (slow?.ok) pass("at 650 ms each way on the tunnel leg the face reads slow with the reply time", slow.card);
  else fault("at 650 ms each way on the tunnel leg the face did not read slow with the reply time", slow?.card ?? null);
  await shot(host, "slow");
  relay.setDelay(0);
  const recovered = await readUntil("recovered", (card) => card.face?.state === "healthy", 45_000);
  if (recovered?.ok) pass("with the delay gone the face reads healthy again", recovered.card);
  else fault("the face did not read healthy again with the delay gone", recovered?.card ?? null);
}

try {
  if (fixture) await gateway();
  else await direct();
  status = faulted ? 10 : 0;
} catch (error) {
  if (!(error instanceof Inconclusive)) logs.push(String(error?.stack ?? error));
  console.log(`INCONCLUSIVE: ${mask(error?.message ?? error)}`);
  status = 3;
} finally {
  for (const window of windows) {
    try { await desktop?.("POST", `/api/library/windows/${window.window_id}/close`, {}); } catch { /* best effort */ }
  }
  const flows = [...flowStates.entries()].map(([flow, state]) => ({
    id: state.id, path: flow.path, desktop: state.desktop, pings: pings.filter((p) => p.flow === state.id).length,
  }));
  fs.writeFileSync(path.join(work, "results.json"), mask(JSON.stringify({
    mode: fixture ? "gateway" : "direct", status, checks, readings, flows, pings, relay: relay?.summary() ?? null,
  }, null, 2)) + "\n");
  fs.writeFileSync(path.join(work, "devserver.log"), mask(logs.join("")));
  await relay?.close();
  server?.kill("SIGTERM");
}
process.exit(status);
