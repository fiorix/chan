#!/usr/bin/env node
// Native tab actions, observed through independent DOM and cs snapshots.
// Exit 0 held, 10 observed fault, 2 unavailable, 3 incomplete. The lifecycle
// shell owns the private desktop/bus and maps 10 through obs_judge.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({ options: Object.fromEntries([
  ...["inspector", "page", "xid", "work", "ws", "engine"].map((key) => [key, { type: "string" }]),
  ["verbose", { type: "boolean", short: "v" }],
]) });
const here = dirname(fileURLToPath(import.meta.url));
const stripExpression = readFileSync(join(here, "axclose-strip-state.js"), "utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mask = (text) => String(text).replace(/([?&]t=)[^&\s"']+/g, "$1<token>")
  .replace(/([?&]h=)[^&#\s"']+/g, "$1<holder>").replace(/(#s=)[^\s"']+/g, "$1<state>");
class Incomplete extends Error {}
class Unavailable extends Error {}
class Fault extends Error {}
const result = { engine: args.engine, arms: [], errors: [], started: new Date().toISOString() };
let commandNumber = 0;
let deadline = Infinity;
let offset;
let asyncNumber = 0;
const ownedNames = new Set();

function save(name, value) {
  writeFileSync(join(args.work, name), mask(JSON.stringify(value, null, 2)) + "\n");
}
function command(executable, words, label, bound = 30000) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Incomplete("the arm exceeded its five-minute bound");
  const call = spawnSync(executable, words.map(String), {
    encoding: "utf8", timeout: Math.min(bound, remaining), killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024, cwd: args.ws,
  });
  const record = { n: ++commandNumber, label, executable, words, status: call.status,
    signal: call.signal, error: call.error?.message, stdout: call.stdout ?? "", stderr: call.stderr ?? "" };
  appendFileSync(join(args.work, "axclose-commands.jsonl"), mask(JSON.stringify(record)) + "\n");
  if (args.verbose) console.error(`axclose: ${label} status ${call.status}`);
  return record;
}
function checked(executable, words, label, bound) {
  const call = command(executable, words, label, bound);
  if (call.status !== 0) throw new Incomplete(`${label}: status ${call.status}, ${call.error ?? call.stderr}`);
  return call.stdout;
}
const cs = (words) => checked(process.env.CHAN_BIN, ["shell", ...words], `cs ${words.slice(0, 2).join(" ")}`);
const xdo = (...words) => checked("xdotool", words, `xdotool ${words[0]}`, 10000);
function evaluate(expression) {
  return JSON.parse(checked(process.execPath, [join(here, "inspect.mjs"), args.inspector, "eval", args.page, expression], "inspect", 15000));
}
async function poll(read, accept, bound = 5000) {
  const until = Date.now() + bound;
  let value;
  do {
    value = await read();
    if (accept(value)) return value;
    await sleep(100);
  } while (Date.now() < until);
  throw new Incomplete(`observation did not settle within ${bound} ms`);
}

// The inspector returns a Promise as an object. A test-owned box observes
// completion without importing or changing chan's private application state.
async function asyncEvaluate(expression) {
  const key = `read${++asyncNumber}`;
  evaluate(`(() => { const box = window.__axcloseAsync ||= {}; box[${JSON.stringify(key)}] = { done: false };
    Promise.resolve().then(() => (${expression})).then(value => { box[${JSON.stringify(key)}] = { done: true, value }; },
    error => { box[${JSON.stringify(key)}] = { done: true, error: String(error) }; }); return true; })()`);
  const value = await poll(() => evaluate(`window.__axcloseAsync[${JSON.stringify(key)}]`), (v) => v?.done, 15000);
  evaluate(`delete window.__axcloseAsync[${JSON.stringify(key)}]`);
  if (value.error) throw new Incomplete(value.error);
  return value.value;
}
const apiExpression = `(async (path, init = {}) => {
  const advertised = document.querySelector('meta[name="chan-prefix"]')?.content?.trim() ?? '';
  const prefix = advertised.startsWith('/') ? advertised.replace(/\\/+$/, '') : '';
  const token = new URLSearchParams(location.search).get('t') ?? sessionStorage.getItem('chan.token');
  if (!token) throw new Error('the page has no auth token');
  const response = await fetch(prefix + path, { ...init, headers: { authorization: 'Bearer ' + token,
    ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  if (!response.ok) throw new Error(path + ': ' + response.status);
  return response.json();
})`;
async function stripPreference(on) {
  return asyncEvaluate(`(async () => { const api = ${apiExpression}; const config = await api('/api/config');
    const before = config.preferences.pane_strip_auto_hide === true;
    if (${JSON.stringify(on)} !== null) await api('/api/config', { method: 'PATCH', body: JSON.stringify({
      expected_revision: config.revision, preferences: { pane_strip_auto_hide: ${JSON.stringify(on)} } }) });
    return before; })()`);
}
function snapshot() {
  const dom = evaluate(stripExpression);
  const layout = JSON.parse(cs(["pane", "list", "--window", process.env.CHAN_WINDOW_ID, "--json"]));
  const roster = JSON.parse(cs(["terminal", "list", "--json"]));
  if (!Array.isArray(layout.panes) || !roster.groups || typeof roster.groups !== "object") {
    throw new Incomplete("the pane or terminal snapshot has an unknown shape");
  }
  const tabs = layout.panes.flatMap((pane) => ["a", "b"].flatMap((side) => {
    if (!Array.isArray(pane.sides?.[side]?.tabs)) throw new Incomplete("the pane has no side tabs");
    return pane.sides[side].tabs.map((tab) => ({ ...tab, pane: pane.id, side }));
  }));
  const groups = Object.values(roster.groups);
  if (tabs.some((tab) => typeof tab.id !== "string" || typeof tab.title !== "string" || typeof tab.active !== "boolean") ||
      groups.some((group) => !Array.isArray(group)) || groups.flat().some((row) =>
        typeof row.session_id !== "string" || typeof row.name !== "string" || !("window" in row))) {
    throw new Incomplete("the pane tabs or terminal rows have an unknown shape");
  }
  const allSessions = groups.flat();
  const sessions = allSessions.filter((session) => session.window === process.env.CHAN_WINDOW_ID);
  return { dom, layout, tabs, sessions, allSessions, at: Date.now() };
}
const ids = (values, key) => values.map((value) => value[key]).sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tabBy = (state, marker) => state.tabs.find((tab) => tab.title.includes(marker));
const domBy = (state, marker) => state.dom.tabs.find((tab) => tab.label?.includes(marker));
function unchanged(state, before) {
  return same(ids(state.tabs, "id"), ids(before.tabs, "id")) &&
    same(ids(state.dom.tabs, "label"), ids(before.dom.tabs, "label")) &&
    same(ids(state.sessions, "session_id"), ids(before.sessions, "session_id")) &&
    same(ids(state.allSessions, "session_id"), ids(before.allSessions, "session_id"));
}
function selected(state, marker) {
  const tab = tabBy(state, marker);
  const dom = domBy(state, marker);
  return Boolean(tab?.active && state.layout.activePaneId === tab.pane && dom?.activeClass && dom.selected === "true");
}
function screenshot(name) {
  checked("import", ["-window", "root", join(args.work, "shots", `${name}.png`)], `screenshot ${name}`, 15000);
}
async function calibrate() {
  evaluate(`(() => { window.__axclosePointer = null; window.__axcloseClick = null;
    addEventListener('mousemove', e => { window.__axclosePointer = { x:e.clientX, y:e.clientY, trusted:e.isTrusted }; });
    addEventListener('click', e => { window.__axcloseClick = { trusted:e.isTrusted, x:e.clientX, y:e.clientY }; }, true);
    return true; })()`);
  const geometry = Object.fromEntries(xdo("getwindowgeometry", "--shell", args.xid).trim().split("\n").map((line) => line.split("=")));
  const points = [];
  xdo("windowactivate", "--sync", args.xid);
  for (const fraction of [0.35, 0.6]) {
    const x = Math.round(Number(geometry.X) + Number(geometry.WIDTH) * fraction);
    const y = Math.round(Number(geometry.Y) + Number(geometry.HEIGHT) * fraction);
    evaluate("window.__axclosePointer = null");
    xdo("mousemove", x - 9, y - 9);
    xdo("mousemove", "--sync", x, y);
    const seen = await poll(() => evaluate("window.__axclosePointer"), (v) => v?.trusted);
    points.push({ x, y, seen, dx: x - seen.x, dy: y - seen.y });
  }
  save("axclose-calibration.json", { geometry, points });
  if (points[0].dx !== points[1].dx || points[0].dy !== points[1].dy) throw new Incomplete("pointer calibration disagrees");
  offset = points[0];
}
function installExitObserver() {
  const probe = window.__axcloseFrames = [];
  const NativeSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeSocket, {
    construct(target, args) {
      const socket = Reflect.construct(target, args);
      if (new URL(String(args[0]), location.href).pathname.endsWith("/api/terminal/ws")) {
        let session = null;
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          let frame;
          try { frame = JSON.parse(event.data); } catch { return; }
          if (frame.type === "session") session = frame.id;
          if (frame.type === "session" || frame.type === "exit") probe.push({ type: frame.type, session, code: frame.code });
        });
      }
      return socket;
    },
  });
  return true;
}
async function selectControl(marker) {
  const state = snapshot();
  const box = domBy(state, marker)?.labelRect;
  if (!box?.width || !box.height) throw new Incomplete("the control tab has no visible label");
  evaluate("window.__axcloseClick = null");
  xdo("mousemove", "--sync", Math.round(box.left + box.width / 2 + offset.dx), Math.round(box.top + box.height / 2 + offset.dy));
  xdo("click", "1");
  await poll(() => snapshot(), (value) => selected(value, marker));
  if (!evaluate("window.__axcloseClick?.trusted === true")) throw new Incomplete("the control tab saw no trusted click");
}
function probe(role, name, label, options = {}) {
  const words = [join(here, "axclose-atspi.py"), "--role", role, "--name", name];
  if (options.exact) words.push("--exact");
  if (options.observe) words.push("--observe");
  if (options.dialog) words.push("--dialog-name", options.dialog);
  if (args.verbose) words.push("--verbose");
  const call = command("python3", words, label);
  let value;
  try { value = JSON.parse(call.stdout); } catch { throw new Incomplete(`${label}: no probe JSON (status ${call.status})`); }
  save(`${label}.json`, { exit: call.status, ...value });
  if (call.status === 2) throw new Unavailable(`${label}: ${value.reason}`);
  if (call.status !== 0 || (!options.observe && value.invoked !== true)) throw new Incomplete(`${label}: action was not invoked`);
  return value;
}
async function cleanup() {
  xdo("key", "Escape");
  const before = snapshot();
  if (before.sessions.some((row) => !ownedNames.has(row.name))) {
    throw new Incomplete("cleanup refuses an unrelated session in the fixture window");
  }
  for (const name of new Set(before.allSessions.filter((row) => ownedNames.has(row.name)).map((row) => row.name))) {
    cs(["terminal", "close", "--tab-name", name]);
  }
  cs(["pane", "close-all", "--window", process.env.CHAN_WINDOW_ID, "--force"]);
  return poll(() => snapshot(), (state) => state.tabs.length === 0 && state.sessions.length === 0 &&
    !state.allSessions.some((row) => ownedNames.has(row.name)) && state.dom.dialogs.length === 0, 15000);
}
async function fixture(label) {
  await cleanup();
  const suffix = `${Date.now().toString(36)}-${label}`;
  const names = Object.fromEntries(["control", "file", "live", "ended"].map((kind) => [kind, `axc-${kind}-${suffix}`]));
  for (const kind of ["control", "file"]) {
    const file = `${names[kind]}.md`;
    writeFileSync(join(args.ws, file), `# ${names[kind]}\n\nSaved fixture.\n`);
    cs(["open", file]);
  }
  let endedSession;
  for (const kind of ["live", "ended"]) {
    if (snapshot().allSessions.some((row) => row.name === names[kind])) throw new Incomplete("fixture name already belongs to a session");
    ownedNames.add(names[kind]);
    cs(["terminal", "new", "--tab-name", names[kind]]);
    const attached = await poll(() => snapshot(), (s) => tabBy(s, names[kind])?.live === true && s.sessions.some((row) =>
      row.name === names[kind] && s.dom.frames.some((frame) => frame.type === "session" && frame.session === row.session_id)), 20000);
    if (kind === "ended") endedSession = attached.sessions.find((row) => row.name === names.ended).session_id;
  }
  cs(["terminal", "write", "--tab-name", names.ended, "exit 0\n"]);
  const exited = await poll(() => snapshot(), (s) => {
    const tab = tabBy(s, names.ended);
    return tab?.kind === "terminal" && tab.live === false &&
      !s.allSessions.some((row) => row.session_id === endedSession || row.name === names.ended) &&
      s.dom.frames.some((frame) => frame.type === "exit" && frame.session === endedSession && frame.code === 0);
  }, 20000);
  save(`${label}-exited-fixture.json`, exited);
  await selectControl(names.control);
  const before = snapshot();
  const kinds = ["control", "file", "live", "ended"];
  if (before.layout.panes.length !== 1 || before.tabs.length !== 4 || before.dom.tabs.length !== 4 || before.dom.dialogs.length ||
      before.sessions.length !== 1 || before.sessions[0].name !== names.live ||
      kinds.some((kind) => !domBy(before, names[kind])?.visible || !tabBy(before, names[kind])) ||
      tabBy(before, names.file).kind !== "file" || tabBy(before, names.file).dirty ||
      tabBy(before, names.live).live !== true || tabBy(before, names.ended).live !== false) {
    save(`${label}-bad-fixture.json`, before);
    throw new Incomplete("the exact four-tab/live-session fixture did not settle");
  }
  return { names, before };
}
async function observe(label, accept, invalid) {
  const until = Date.now() + 5000;
  let state;
  do {
    state = snapshot();
    save(`${label}-after.json`, state);
    if (invalid(state)) throw new Fault(`${label}: action changed the wrong tabs, sessions or dialog`);
    if (accept(state)) {
      const samples = [state];
      const heldUntil = Date.now() + 500;
      do {
        await sleep(100);
        state = snapshot();
        samples.push(state);
        save(`${label}-held.json`, samples);
        if (invalid(state) || !accept(state)) throw new Fault(`${label}: postcondition did not remain held`);
      } while (Date.now() < heldUntil);
      return state;
    }
    await sleep(100);
  } while (Date.now() < until);
  throw new Fault(`${label}: invoked action did not reach its postcondition`);
}
async function selection(kind, arm, fixture) {
  const { names, before } = fixture;
  const marker = names[kind];
  if (selected(before, marker) || domBy(before, marker)?.selected !== "false") throw new Incomplete("subject was not inactive");
  const nativeBefore = probe("tab", marker, `${arm}-native-before`, { observe: true });
  if (nativeBefore.target.selected) throw new Incomplete("the accessible subject was already selected");
  probe("tab", marker, `${arm}-action`);
  await observe(arm, (s) => selected(s, marker), (s) => !unchanged(s, before) || s.dom.dialogs.length > 0);
  const nativeAfter = probe("tab", marker, `${arm}-native-after`, { observe: true });
  if (!nativeAfter.target.selected) throw new Fault("the selected tab has no native SELECTED state");
}
async function closeControl(kind, arm, fixture) {
  const { names, before } = fixture;
  const marker = names[kind];
  const subject = tabBy(before, marker);
  const label = domBy(before, marker).label;
  const closeName = domBy(before, marker).closeName;
  if (!closeName) throw new Incomplete("the subject has no named close button");
  const tabIDs = ids(before.tabs.filter((tab) => tab.id !== subject.id), "id");
  const labels = ids(before.dom.tabs.filter((tab) => tab.label !== label), "label");
  const targetSession = kind === "live" ? before.sessions.find((row) => row.name === marker)?.session_id : null;
  if (kind === "live" && !targetSession) throw new Incomplete("live close subject has no known session id");
  const sessions = ids(before.sessions.filter((row) => row.session_id !== targetSession), "session_id");
  const survivors = ids(before.allSessions.filter((row) => row.session_id !== targetSession), "session_id");
  const original = ids(before.allSessions, "session_id");
  const removed = (s) => same(ids(s.tabs, "id"), tabIDs) && same(ids(s.dom.tabs, "label"), labels) &&
    same(ids(s.sessions, "session_id"), sessions) && same(ids(s.allSessions, "session_id"), survivors) && s.dom.dialogs.length === 0;
  const wrongRemoval = (s) => s.tabs.some((tab) => !before.tabs.some((old) => old.id === tab.id)) ||
    before.tabs.some((tab) => tab.id !== subject.id && !s.tabs.some((next) => next.id === tab.id)) ||
    s.allSessions.some((row) => !original.includes(row.session_id)) ||
    survivors.some((id) => !s.allSessions.some((row) => row.session_id === id));
  const prompt = (s) => s.dom.dialogs.length === 1 && s.dom.dialogs[0].name === "Close tab?";
  const close = (tag) => probe("button", closeName, `${arm}-${tag}`, { exact: true });
  close("action");
  if (kind === "live") {
    await observe(`${arm}-prompt`, prompt, (s) => !unchanged(s, before) || (s.dom.dialogs.length > 0 && !prompt(s)));
    screenshot(`${arm}-prompt`);
    probe("button", "Cancel", `${arm}-cancel-action`, { exact: true, dialog: "Close tab?" });
    await observe(`${arm}-cancel`, (s) => !s.dom.dialogs.length, (s) => !unchanged(s, before));
    close("second-action");
    await observe(`${arm}-second-prompt`, prompt, (s) => !unchanged(s, before) || (s.dom.dialogs.length > 0 && !prompt(s)));
    probe("button", "Close", `${arm}-confirm-action`, { exact: true, dialog: "Close tab?" });
  }
  await observe(`${arm}-closed`, removed, (s) => wrongRemoval(s) || (kind !== "live" && s.dom.dialogs.length > 0));
}
async function main() {
  if (["inspector", "page", "xid", "work", "ws", "engine"].some((key) => !args[key]) ||
      ["CHAN_BIN", "CHAN_CONTROL_SOCKET", "CHAN_WINDOW_ID", "DISPLAY", "DBUS_SESSION_BUS_ADDRESS"].some((key) => !process.env[key]) ||
      process.env.AXCLOSE_PRIVATE_BUS !== "1") {
    console.error("axclose: private lifecycle arguments/environment are required");
    return 2;
  }
  mkdirSync(join(args.work, "shots"), { recursive: true });
  let oldPreference;
  try {
    const initial = snapshot();
    save("axclose-initial.json", initial);
    if (!initial.dom.desktop) throw new Unavailable("the inspected page is not chan-desktop");
    oldPreference = await stripPreference(null);
    await stripPreference(false);
    evaluate(`(${installExitObserver.toString()})()`);
    await calibrate();
    for (const operation of ["select", "close"]) for (const kind of ["live", "file", "ended"]) {
      const arm = `${operation}-${kind}`;
      const row = { arm, kind, operation, status: "incomplete" };
      deadline = Date.now() + 300000;
      try {
        const prepared = await fixture(arm);
        save(`${arm}-before.json`, prepared.before);
        screenshot(`${arm}-before`);
        if (operation === "select") await selection(kind, arm, prepared);
        else await closeControl(kind, arm, prepared);
        row.status = "held";
      } catch (error) {
        row.status = error instanceof Fault ? "fault" : error instanceof Unavailable ? "unavailable" : "incomplete";
        row.error = mask(error.message);
      } finally {
        deadline = Date.now() + 60000;
        try { save(`${arm}-final.json`, snapshot()); screenshot(`${arm}-after`); }
        catch (error) { row.evidenceError = mask(error.message); row.status = "incomplete"; }
        try { save(`${arm}-cleanup.json`, await cleanup()); }
        catch (error) { row.cleanupError = mask(error.message); row.status = "incomplete"; }
      }
      result.arms.push(row);
      save("axclose-results.json", result);
      console.log(`${row.status.toUpperCase()} ${arm}${row.error ? `: ${row.error}` : ""}`);
    }
  } catch (error) {
    result.errors.push({ status: error instanceof Unavailable ? "unavailable" : "incomplete", message: mask(error.message) });
  } finally {
    deadline = Date.now() + 60000;
    if (oldPreference !== undefined) {
      try { await stripPreference(oldPreference); }
      catch (error) { result.errors.push({ status: "incomplete", message: `preference restore: ${mask(error.message)}` }); }
    }
  }
  const states = [...result.arms, ...result.errors].map((row) => row.status);
  const code = states.includes("incomplete") ? 3 : states.includes("unavailable") ? 2 :
    result.arms.length !== 6 ? 3 : states.includes("fault") ? 10 : 0;
  result.finished = new Date().toISOString();
  result.exit = code;
  save("axclose-results.json", result);
  return code;
}
process.exitCode = await main();
