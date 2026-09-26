#!/usr/bin/env node
// What a window's `/ws` event socket is told about `cs terminal survey`
// overlays when it drops and comes back, recorded frame by frame.
//
// It starts its own `chan devserver run` on a throwaway CHAN_HOME and loopback
// port, mints a terminal window with one terminal named @@E2E, and attaches a
// socket tagged with that window (`<prefix>/ws?t=<token>&w=<window>`), as the
// SPA's watcher does. Then two phases:
//
//   expiry  a survey raised with `--timeout 3`; the socket drops once its
//           `open_survey` arrives and stays down across the deadline, which
//           the CLI reports by exiting 124. The reattached socket must get a
//           `survey_sync` with an empty list and no `close_survey`, and a
//           reply to the expired survey must answer 404.
//   reraise a survey that stays open while the socket drops; the reattached
//           socket must get a `survey_sync` listing it in the `open_survey`
//           shape. A Dismiss posted from that window must print "survey
//           dismissed; no answer" on the CLI and exit 0, a second reply must
//           answer 404, and the answering window gets no `close_survey`.
//
// Every frame each socket received goes to <out>/survey-reattach.json with
// the CLI results, the HTTP statuses and each check; the devserver's output
// goes to <out>/devserver.log. Neither carries a token. The SPA's handling of
// the recorded frames is pinned by the workspace app's mounted tests, which
// replay them; this script sees only the wire.
//
// Usage: survey-reattach-ws.mjs --chan BIN --out DIR
// Exits 0 when every check holds, 1 when one fails, 2 when it cannot run.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const TAB = "@@E2E";
const READY_MS = 90_000;
const FRAME_MS = 10_000;
const QUIET_MS = 1_500;

function usage(message) {
  console.error(`survey-reattach-ws: ${message}`);
  console.error("usage: survey-reattach-ws.mjs --chan BIN --out DIR");
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) usage(`missing value for ${flag}`);
    if (flag === "--chan") opts.chan = path.resolve(value);
    else if (flag === "--out") opts.out = path.resolve(value);
    else usage(`unknown flag ${flag}`);
  }
  if (!opts.chan || !opts.out) usage("missing flags");
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (typeof WebSocket !== "function") usage("this check needs Node's WebSocket implementation");
if (!fs.existsSync(opts.chan)) usage(`no chan binary at ${opts.chan}`);
fs.mkdirSync(opts.out, { recursive: true });

const started = Date.now();
const since = () => Date.now() - started;
const secrets = [];
const record = { chan: opts.chan, checks: [], sockets: {}, cli: {}, http: {} };

function redact(text) {
  let out = String(text)
    .replace(/CHAN_DEVSERVER_TOKEN=\S+/g, "CHAN_DEVSERVER_TOKEN=<redacted>")
    .replace(/([?&]t=)[^&\s"']+/g, "$1<redacted>");
  for (const secret of secrets) out = out.split(secret).join("<redacted>");
  return out;
}

function log(message) {
  console.log(`[${String(since()).padStart(6)}ms] ${redact(message)}`);
}

function check(name, ok, detail) {
  record.checks.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, ms, probe) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await sleep(100);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// ---- the devserver under test ------------------------------------------

const work = fs.mkdtempSync(path.join(os.tmpdir(), "chan-survey-e2e-"));
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: path.join(work, "user"),
  XDG_CONFIG_HOME: path.join(work, "user", ".config"),
  XDG_DATA_HOME: path.join(work, "user", ".local", "share"),
  XDG_STATE_HOME: path.join(work, "user", ".local", "state"),
  XDG_RUNTIME_DIR: path.join(work, "run"),
  CHAN_HOME: path.join(work, "home"),
  TMPDIR: path.join(work, "tmp"),
  LANG: "C.UTF-8",
};
for (const dir of [env.HOME, env.XDG_RUNTIME_DIR, env.CHAN_HOME, env.TMPDIR]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
log(`work dir ${work}, port ${port}`);

const version = await runChan(["--version"], {}, 10_000);
record.version = version.stdout.trim();
log(`chan --version: ${record.version}`);

const devserverOutput = [];
const devserver = spawn(opts.chan, ["devserver", "run", "--bind=127.0.0.1", `--port=${port}`], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
devserver.stdout.on("data", (chunk) => devserverOutput.push(chunk.toString()));
devserver.stderr.on("data", (chunk) => devserverOutput.push(chunk.toString()));
let devserverGone = null;
const devserverExit = new Promise((resolve) =>
  devserver.once("exit", (code, signal) => resolve((devserverGone = { code, signal }))),
);
record.devserverPid = devserver.pid;
log(`devserver pid ${devserver.pid}`);

let exitCode = 1;
try {
  await until("the devserver to answer /api/devserver/info", READY_MS, async () => {
    if (devserverGone) throw new Error(`the devserver exited before it was ready: ${JSON.stringify(devserverGone)}`);
    try {
      const res = await fetch(`${base}/api/devserver/info`, { signal: AbortSignal.timeout(2_000) });
      return res.ok;
    } catch {
      return false;
    }
  });
  log("devserver ready");
  exitCode = (await scenario()) ? 0 : 1;
} catch (error) {
  check("the scenario ran to its end", false, error.message);
  exitCode = 1;
} finally {
  devserver.kill("SIGTERM");
  const stopped = await Promise.race([devserverExit, sleep(15_000).then(() => null)]);
  if (!stopped) {
    devserver.kill("SIGKILL");
    record.devserverStop = { ...(await devserverExit), forced: true };
  } else {
    record.devserverStop = stopped;
  }
  log(`devserver stopped: ${JSON.stringify(record.devserverStop)}`);
  try {
    secrets.push(JSON.parse(fs.readFileSync(path.join(env.CHAN_HOME, "devserver", "config.json"), "utf8")).devserver_token);
  } catch {
    // No config was written; the patterns in redact() still apply.
  }
  fs.writeFileSync(path.join(opts.out, "devserver.log"), redact(devserverOutput.join("")));
  record.elapsedMs = since();
  fs.writeFileSync(path.join(opts.out, "survey-reattach.json"), `${redact(JSON.stringify(record, null, 2))}\n`);
  const failed = record.checks.filter((c) => !c.ok).map((c) => c.name);
  log(`${record.checks.length - failed.length}/${record.checks.length} checks passed${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
  if (exitCode === 0) fs.rmSync(work, { recursive: true, force: true });
  else log(`work dir kept at ${work}`);
}
process.exit(exitCode);

// ---- helpers over the devserver ----------------------------------------

function runChan(args, extraEnv, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(opts.chan, args, { env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const startedAt = since();
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, startedAt, endedAt: since() });
    });
  });
}

async function json(method, url, token, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Keep the text.
  }
  return { status: res.status, text, data };
}

// A socket tagged with the window, recording every text frame it receives.
function attach(label, route) {
  const url = `${base.replace(/^http/, "ws")}${route.prefix}/ws?t=${encodeURIComponent(route.token)}&w=${encodeURIComponent(route.windowId)}`;
  const frames = [];
  record.sockets[label] = frames;
  const socket = new WebSocket(url);
  const closed = new Promise((resolve) => socket.addEventListener("close", () => resolve()));
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error(`${label} failed to open`)));
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      frame = { unparsed: event.data };
    }
    frames.push({ atMs: since(), frame });
  });
  return {
    frames,
    opened,
    async next(what, predicate, ms = FRAME_MS) {
      return until(`${label}: ${what}`, ms, () => frames.find((f) => predicate(f.frame))?.frame);
    },
    async close() {
      socket.close();
      await Promise.race([closed, sleep(5_000)]);
    },
  };
}

function isCommand(name) {
  return (frame) => frame?.type === "window_command" && frame.command === name;
}

function commandsOf(socket, name) {
  return socket.frames.map((f) => f.frame).filter(isCommand(name));
}

// ---- the scenario ------------------------------------------------------

async function scenario() {
  const config = JSON.parse(fs.readFileSync(path.join(env.CHAN_HOME, "devserver", "config.json"), "utf8"));
  const devserverToken = config.devserver_token;
  secrets.push(devserverToken);

  const window = await json("POST", `${base}/api/library/windows`, devserverToken, { kind: "terminal" });
  if (window.status !== 200 || !window.data?.window_id) throw new Error(`minting a window answered ${window.status}`);
  const route = { windowId: window.data.window_id, prefix: window.data.prefix, token: window.data.token };
  secrets.push(route.token);
  record.windowId = route.windowId;
  log(`window ${route.windowId}`);

  const socketFile = path.join(work, "control-socket");
  const terminal = await json("POST", `${base}${route.prefix}/api/terminals`, route.token, {
    name: TAB,
    window_id: route.windowId,
    command: `printf '%s\\n' "$CHAN_CONTROL_SOCKET" > '${socketFile}'; exec sleep 600`,
  });
  if (terminal.status < 200 || terminal.status > 299) throw new Error(`spawning ${TAB} answered ${terminal.status}: ${terminal.text}`);
  const controlSocket = await until("the terminal to report its control socket", FRAME_MS, () => {
    try {
      return fs.readFileSync(socketFile, "utf8").trim() || null;
    } catch {
      return null;
    }
  });
  const cs = { CHAN_CONTROL_SOCKET: controlSocket };
  const survey = (timeout, options, body) =>
    runChan(
      ["shell", "terminal", "survey", `--tab-name=${TAB}`, `--timeout=${timeout}`, ...options.map((o) => `--option=${o}`), body],
      cs,
      (timeout + 30) * 1_000,
    );
  const reply = (surveyId) =>
    json("POST", `${base}${route.prefix}/api/survey/reply`, route.token, {
      surveyId,
      kind: "dismissed",
      windowId: route.windowId,
    });

  // Phase expiry.
  log("phase expiry");
  const s1 = attach("s1-before-the-deadline", route);
  await s1.opened;
  await s1.next("the attach survey_sync", isCommand("survey_sync"));
  const expiring = survey(3, ["ok"], "expires while the window is away");
  const opened = await s1.next("open_survey", isCommand("open_survey"));
  const expiredId = opened.survey.surveyId;
  await s1.close();
  log(`s1 dropped with ${expiredId} open`);
  const expired = await expiring;
  record.cli.expiry = expired;
  check("the deadline exits 124 with nothing on stdout", expired.code === 124 && expired.stdout === "", {
    code: expired.code,
    stdout: expired.stdout,
  });
  check("the deadline names itself on stderr", /no reply within 3s/.test(expired.stderr), expired.stderr.trim());

  const s2 = attach("s2-after-the-deadline", route);
  await s2.opened;
  const sync = await s2.next("the reattach survey_sync", isCommand("survey_sync"));
  await sleep(QUIET_MS);
  check("the reattach sync lists nothing", Array.isArray(sync.surveys) && sync.surveys.length === 0, sync.surveys);
  check("the reattach sync names the window", sync.window_id === route.windowId, sync.window_id);
  check("the reattached socket gets no close_survey", commandsOf(s2, "close_survey").length === 0, commandsOf(s2, "close_survey"));
  check("the reattached socket gets no open_survey", commandsOf(s2, "open_survey").length === 0, commandsOf(s2, "open_survey"));
  const stale = await reply(expiredId);
  record.http.expiredReply = { status: stale.status, text: stale.text };
  check(
    "a reply to the expired survey answers 404",
    stale.status === 404 && /no survey parked with id/.test(stale.text),
    { status: stale.status, text: stale.text },
  );

  // Phase reraise.
  log("phase reraise");
  const staying = survey(60, ["yes", "no"], "still open when the window comes back");
  const raised = await s2.next("open_survey", isCommand("open_survey"));
  const openId = raised.survey.surveyId;
  await s2.close();
  log(`s2 dropped with ${openId} open`);
  const s3 = attach("s3-while-open", route);
  await s3.opened;
  const resync = await s3.next("the reattach survey_sync", isCommand("survey_sync"));
  check(
    "the reattach sync lists the open survey in the open_survey shape",
    resync.surveys?.length === 1 &&
      JSON.stringify(resync.surveys[0].survey) === JSON.stringify(raised.survey) &&
      resync.surveys[0].tabName === TAB,
    resync.surveys,
  );
  const answered = await reply(openId);
  record.http.dismiss = { status: answered.status, text: answered.text };
  check("the Dismiss reply is accepted", answered.status === 200, answered.status);
  const dismissed = await staying;
  record.cli.reraise = dismissed;
  check("the CLI prints the Dismiss line and exits 0", dismissed.code === 0 && dismissed.stdout.trim() === "survey dismissed; no answer", {
    code: dismissed.code,
    stdout: dismissed.stdout,
  });
  const again = await reply(openId);
  record.http.secondReply = { status: again.status, text: again.text };
  check("a second reply answers 404", again.status === 404, again.status);
  await sleep(QUIET_MS);
  check("the answering window gets no close_survey", commandsOf(s3, "close_survey").length === 0, commandsOf(s3, "close_survey"));
  await s3.close();

  return record.checks.every((c) => c.ok);
}
