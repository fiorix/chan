#!/usr/bin/env node
// Uses the real WebKitGTK launcher's buttons, a real desktop connection and a
// real tmux server. The shell driver owns the desktop and display; this owns
// only its disposable devserver and tmux socket. An optional fixture from
// gateway-zone.sh supplies a real gateway and its tunnelled devserver.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const [inspector, work, chan, fixturePath] = process.argv.slice(2);
const fixture = fixturePath ? JSON.parse(fs.readFileSync(fixturePath)) : null;
const here = path.dirname(fileURLToPath(import.meta.url));
const secrets = [];
if (fixture) secrets.push(fixture.token, fixture.pat.secret);
const checks = [];
const logs = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mask = (text) => secrets.reduce((s, token) => s.replaceAll(token, "<token>"), String(text))
  .replace(/([?&]t=)[^&\s"']+/g, "$1<token>")
  .replace(/CHAN_DEVSERVER_TOKEN=\S+/g, "CHAN_DEVSERVER_TOKEN=<token>");

async function until(label, probe, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`timed out: ${label}`);
}

function pass(name, detail) {
  checks.push({ name, pass: true, detail });
  console.log(`PASS: ${name}`);
}

async function inspect(expression) {
  const { stdout } = await run(process.execPath, [path.join(here, "inspect.mjs"), inspector,
    "eval", "/?t=", expression], { timeout: 15000 });
  return JSON.parse(stdout);
}

async function api(base, token, method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) assert.fail(`${method} ${route}: HTTP ${response.status} ${mask(await response.text())}`);
  return response.status === 204 ? null : response.json();
}

async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const result = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return result;
}

const devHome = path.join(work, "devserver-home");
const socket = path.join(work, "tmux.sock");
const base = fixture?.base ?? `http://127.0.0.1:${await port()}`;
fs.mkdirSync(devHome);
const server = fixture ? null : spawn(chan, ["devserver", "run", "--service=none", "--bind=127.0.0.1", `--port=${new URL(base).port}`], {
  env: { ...process.env, CHAN_HOME: devHome }, stdio: ["ignore", "pipe", "pipe"],
});
server?.stdout.on("data", (data) => logs.push(data.toString()));
server?.stderr.on("data", (data) => logs.push(data.toString()));
const serverExit = server && new Promise((resolve) => server.once("exit", (code, signal) => resolve({ code, signal })));
let status = 3;
let connected = false;
let gatewayId;
let local;
let token;
let disconnectMatrix = false;

try {
  await until("devserver ready", async () => {
    if (server) assert.equal(server.exitCode, null, "devserver exited during startup");
    try { return (await fetch(`${base}/api/devserver/info`, { signal: AbortSignal.timeout(1000) })).ok; }
    catch { return false; }
  }, 60000);
  token = fixture?.token ?? JSON.parse(fs.readFileSync(path.join(devHome, "devserver/config.json"))).devserver_token;
  secrets.push(token);
  const cli = (args) => run(chan, args, { timeout: 90000 });
  await until("workspace inspector", async () => {
    try {
      const { stdout } = await run(process.execPath, [path.join(here, "inspect.mjs"), inspector, "eval", "w=",
        "document.readyState === 'complete'"], { timeout: 15000 });
      return JSON.parse(stdout);
    } catch { return false; }
  });
  await run("xdotool", ["key", "--clearmodifiers", "ctrl+shift+p"]);
  const launcherUrl = new URL(await until("native launcher inspector", async () => {
    try { return await inspect("location.href"); } catch { return false; }
  }));
  const { stdout: launcherWindow } = await run("xdotool", ["getactivewindow"]);
  const launcherToken = launcherUrl.searchParams.get("t");
  assert.ok(launcherToken, "native launcher has its bearer");
  secrets.push(launcherToken);
  local = (method, route, body) => api(launcherUrl.origin, launcherToken, method, route, body);
  const remote = (method, route, body) => api(base, token, method, route, body);
  if (fixture) {
    const gateway = await local("POST", "/api/library/gateways", { url: fixture.origin, label: "tmux-feed-gateway" });
    gatewayId = gateway.id;
    await local("POST", `/api/library/gateways/${gatewayId}/connect`, {});
    const devserver = await until("devserver appears in gateway roster", async () =>
      (await local("GET", "/api/library/devservers")).find((d) => d.gateway_id === gatewayId));
    await local("POST", `/api/library/devservers/${encodeURIComponent(devserver.id)}/connect`, {});
    await until("gateway's devserver is connected", async () => {
      const rows = await local("GET", "/api/library/devservers");
      return rows.some((d) => d.gateway_id === gatewayId && d.status === "connected");
    }, 60000);
    pass("real desktop is connected through the gateway roster and tunnel");
  } else {
    await cli(["devserver", "register", `${base}/?t=${token}`, "--name", "tmux-feed-test"]);
    await cli(["devserver", "connect", "tmux-feed-test"]);
    connected = true;
    await until("desktop connected", async () => {
      const { stdout } = await cli(["devserver", "ls", "--json"]);
      return JSON.parse(stdout).devservers.some((d) => d.label === "tmux-feed-test" && d.status === "connected");
    });
    pass("real desktop is connected to the disposable devserver");
  }

  await run("tmux", ["-S", socket, "new-session", "-d", "-s", "fed-smoke", "sleep 600"]);
  async function attach() {
    const window = await remote("POST", "/api/library/windows", { kind: "terminal" });
    secrets.push(window.token);
    await api(base, window.token, "POST", `${window.prefix}/api/terminals`, {
      name: "tmux-feed", window_id: window.window_id,
      command: `exec bash -i -c "tmux -CC -S '${socket}' attach-session -t fed-smoke; exec bash"`,
    });
    return until("devserver's tmux record", async () => {
      const records = await remote("GET", "/api/library/tmux");
      return records.find((r) => r.session?.name === "fed-smoke" && r.windows.length > 0);
    });
  }
  let connection = await attach();
  await until("fed record in desktop API", async () => {
    const records = await local("GET", "/api/library/tmux");
    return records.some((r) => r.connection === connection.connection && r.library_id === connection.library_id);
  });
  pass("desktop GET /api/library/tmux includes the owning devserver's record");
  const card = "[...document.querySelectorAll('section.machine')].find(c => c.textContent.includes('session fed-smoke'))";
  const rendered = await until("native card actions", async () => inspect(`(() => {
    const c = ${card};
    if (!c) return null;
    const labels = [...c.querySelectorAll('button')].map(b => b.getAttribute('aria-label'));
    if (!labels.some(l => l?.startsWith('New tmux window')) || !labels.some(l => l?.startsWith('Detach '))) return null;
    return { text: c.textContent.trim(), labels };
  })()`));
  assert.ok(rendered.text.includes(`tmux ${connection.version}`));
  async function showCard() {
    await inspect(`(${card}).closest('.slot').click(); true`);
    await until("tmux card is active", async () => inspect(`(${card}).closest('.slot').getAttribute('aria-current') === 'true'`));
  }
  await showCard();
  pass("native card shows origin, session, version, new-window and detach", rendered);
  await run("xdotool", ["windowactivate", "--sync", launcherWindow.trim()]);
  await until("launcher focused for screenshot", async () => inspect("document.hasFocus()"));
  await sleep(600); // Let the carousel's turn finish before capturing its card.
  await run("import", ["-window", launcherWindow.trim(), path.join(work, "shots/card.png")]);
  const before = connection.windows.length;
  await inspect(`(() => { const c = ${card}; c.querySelector('button[aria-label^="New tmux window"]').click(); return true; })()`);
  await until("new window on owning devserver", async () => {
    const records = await remote("GET", "/api/library/tmux");
    return records.find((r) => r.connection === connection.connection)?.windows.length === before + 1;
  });
  const { stdout: windows } = await run("tmux", ["-S", socket, "list-windows", "-F", "#{window_id}"]);
  assert.equal(windows.trim().split("\n").length, before + 1);
  pass("card t creates a real tmux window on the devserver");

  await inspect(`(() => { const c = ${card}; c.querySelector('button[aria-label^="Detach "]').click(); return true; })()`);
  await until("detach removes aggregated record", async () => (await local("GET", "/api/library/tmux")).length === 0);
  await until("detach removes card", async () => inspect(`!(${card})`));
  await run("tmux", ["-S", socket, "has-session", "-t", "fed-smoke"]);
  await until("released control window", async () => {
    const control = (await remote("GET", "/api/library/windows")).find((r) => r.window_id === connection.control_window);
    return control && !control.control && !control.tmux && !control.hidden;
  });
  pass("card c detaches, removes the card and releases the control window while tmux survives");

  connection = await attach();
  await until("reattached card", async () => inspect(`Boolean(${card})`));
  await showCard();
  await inspect("document.querySelector('button[aria-label=\"Select\"]').click(); true");
  await until("selection checkbox", async () => inspect(`Boolean((${card})?.querySelector('input[type=checkbox]'))`));
  await inspect(`(${card}).querySelector('input[type=checkbox]').click(); true`);
  await inspect("[...document.querySelectorAll('[aria-label=\"Bulk actions\"] button')].find(b => b.textContent.trim() === 'Turn off').click(); true");
  await until("selection end removes remote connection", async () => (await remote("GET", "/api/library/tmux")).length === 0);
  await until("selection end removes aggregated card", async () => inspect(`!(${card})`));
  const alive = await run("tmux", ["-S", socket, "has-session", "-t", "fed-smoke"]).then(() => true, () => false);
  assert.equal(alive, false);
  pass("selection Turn off ends the owning tmux server and removes its card");
  if (process.env.TMUX_FEED_DISCONNECTS === "1") {
    disconnectMatrix = true;
    const { disconnectChecks } = await import("./tmux-disconnect.mjs");
    await disconnectChecks({ work, run, port, until, pass, inspect, api, local, remote,
      localOrigin: launcherUrl.origin, base, token, secrets, inspector, here, fixture, gatewayId, server });
  }
  status = 0;
} catch (error) {
  const message = mask(error.stack ?? error);
  checks.push({ name: "scenario completed", pass: false, error: message });
  console.error(message);
  if (local) {
    const state = await Promise.all(["devservers", "gateways"].map(async (kind) =>
      [kind, await local("GET", `/api/library/${kind}`).catch(() => null)]));
    fs.writeFileSync(path.join(work, "connection-state.json"), mask(JSON.stringify(Object.fromEntries(state), null, 2)));
  }
  const page = await inspect("JSON.stringify({title: document.title, body: document.body.innerText, html: document.documentElement.outerHTML.slice(0, 12000)})").catch(() => null);
  if (page) fs.writeFileSync(path.join(work, "launcher-page.json"), mask(page));
  await run("import", ["-window", "root", path.join(work, "shots/failure.png")]).catch(() => {});
  const targets = await run(process.execPath, [path.join(here, "inspect.mjs"), inspector, "list"], { timeout: 10000 }).catch(() => null);
  if (targets) fs.writeFileSync(path.join(work, "inspector-pages.jsonl"), mask(targets.stdout));
  status = error.e2eFault === true || (!disconnectMatrix && checks.some((check) => check.pass)
    && (error.code === "ERR_ASSERTION" || String(error.message).startsWith("timed out:"))) ? 10 : 3;
} finally {
  if (gatewayId) await local("POST", `/api/library/gateways/${gatewayId}/disconnect`, {}).catch(() => {});
  if (connected) await run(chan, ["devserver", "disconnect", "tmux-feed-test"], { timeout: 15000 }).catch(() => {});
  await run("tmux", ["-S", socket, "kill-server"]).catch(() => {});
  if (server) {
    server.kill("SIGTERM");
    if (!(await Promise.race([serverExit, sleep(10000).then(() => false)]))) {
      server.kill("SIGKILL");
      await serverExit;
    }
  }
  fs.writeFileSync(path.join(work, "devserver.log"), mask(logs.join("")));
  fs.writeFileSync(path.join(work, "results.json"), mask(JSON.stringify({
    engine: "WebKitGTK", transport: fixture ? "gateway tunnel" : "direct devserver", build: process.env.OBS_SHA,
    checks, status, limits: ["macOS WKWebView is not exercised by this driver",
      ...(fixture ? ["account PAT is pre-seeded; browser sign-in is not exercised",
        "test desktop enables native certificate trust for the fixture CA"]
        : ["the gateway is not exercised in direct mode"])],
  }, null, 2)) + "\n");
}
process.exit(status);
