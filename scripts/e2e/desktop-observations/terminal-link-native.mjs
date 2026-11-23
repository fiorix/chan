#!/usr/bin/env node
// The link menu on chan-desktop's WebKitGTK page (terminal-link-native.sh
// starts the desktop, the private xdg-open and the window). A new Ghostty
// terminal's shell writes its grid size to a
// file, clears the screen and prints a URL on the top row (the printf's
// argument holds the URL's tail, so the echoed command holds no link); a
// click by XTEST on the URL must open the link menu showing it, and a click
// by XTEST on "Open in browser" must put the URL in the private xdg-open's
// record.
//
// Exit 0 the Ghostty arm held; 10 a fault (the wrapper turns it into 1); 2
// the setup did not run (the page, the terminal or the printed URL never
// came, or X input cannot be placed on the page); 3 the driver failed in a
// way it does not expect.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { TERMINAL_SURFACES } from "../browser-smoke/lib/terminal-attach.mjs";

const exec = promisify(execFile);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const { values } = parseArgs({
  options: {
    inspector: { type: "string" },
    xid: { type: "string" },
    workspace: { type: "string" },
    output: { type: "string" },
    backends: { type: "string" },
  },
});
const backends = (values.backends ?? "ghostty").split(",").filter(Boolean);
if (!values.inspector || !values.xid || !values.workspace || !values.output || !backends.length || backends.some((b) => b !== "ghostty")) {
  console.error("usage: terminal-link-native.mjs --inspector HOST:PORT --xid XID --workspace DIR --output DIR [--backends ghostty]; retired backends are unsupported");
  process.exit(2);
}
const out = resolve(values.output);
const opened = process.env.TERMINAL_LINK_OPENED;
const bin = process.env.CHAN_BIN;
const windowId = process.env.CHAN_WINDOW_ID;
if (!opened || !bin || !windowId) {
  console.error("TERMINAL_LINK_OPENED, CHAN_BIN and CHAN_WINDOW_ID must be set");
  process.exit(2);
}
process.env.CHAN_NO_DEVSERVER_HANDOFF = "1";

const URL_TAIL = "s://example.com/native316";
const URL_316 = `http${URL_TAIL}`;
const MENU = '.terminal-tab-menu-bubble[aria-label="terminal link menu"]';
const verdict = { engine: "webkitgtk", sha: process.env.OBS_SHA ?? null, backends: {}, faults: [] };
const save = () => writeFileSync(join(out, "terminal-link.json"), `${JSON.stringify(verdict, null, 2)}\n`, { mode: 0o600 });

class SetupError extends Error {}

async function cs(...args) {
  const env = { ...process.env };
  delete env.CHAN_DESKTOP_BIN;
  const { stdout } = await exec(bin, ["shell", ...args], { env, timeout: 60_000 });
  return stdout;
}

async function until(label, read, ok, bound, Failure = Error) {
  const deadline = Date.now() + bound;
  for (;;) {
    const value = await read().catch((error) => ({ error: String(error) }));
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Failure(`timed out waiting for ${label}: ${JSON.stringify(value)?.slice(0, 400)}`);
    await delay(200);
  }
}

// One inspector session on the workspace page, the protocol inspect.mjs
// speaks, kept open for the run.
async function openPage() {
  const html = await (await fetch(`http://${values.inspector}/`, { signal: AbortSignal.timeout(5000) })).text();
  const path = [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)]
    .map(([, cells]) => ({ path: /\/socket\/\d+\/\d+\/\w+/.exec(cells)?.[0], text: cells.replace(/<[^>]+>/g, " ") }))
    .find((row) => row.path && row.text.includes("/workspace-"))?.path;
  if (!path) throw new SetupError("no workspace page in the WebKit inspector");
  const socket = new WebSocket(`ws://${values.inspector}${path}`);
  const pending = new Map();
  let target = null;
  let nextId = 1;
  const ready = new Promise((done, fail) => {
    socket.onerror = () => fail(new SetupError("the inspector socket failed"));
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data.toString());
      if (message.method === "Target.targetCreated" && message.params.targetInfo.type === "page" && !target) {
        target = message.params.targetInfo.targetId;
        done();
      } else if (message.method === "Target.dispatchMessageFromTarget") {
        const inner = JSON.parse(message.params.message);
        const call = pending.get(inner.id);
        if (!call) return;
        pending.delete(inner.id);
        if (inner.error || inner.result?.wasThrown) call.reject(new Error(JSON.stringify(inner).slice(0, 400)));
        else call.resolve(inner.result?.result?.value);
      }
    };
  });
  await Promise.race([ready, delay(8000).then(() => { throw new SetupError("the page target did not answer"); })]);
  return {
    evaluate(fn, ...args) {
      const id = nextId++;
      const expression = `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(",")})`;
      return new Promise((resolveCall, rejectCall) => {
        pending.set(id, { resolve: resolveCall, reject: rejectCall });
        setTimeout(() => pending.delete(id) && rejectCall(new Error("inspector evaluation timed out")), 8000);
        const inner = JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } });
        socket.send(JSON.stringify({ id, method: "Target.sendMessageToTarget", params: { targetId: target, message: inner } }));
      });
    },
    close: () => socket.close(),
  };
}

let page;

// Where X input lands on the page: the offset between a screen point and the
// client point the page's mousemove reports for it, read at two points that
// must agree. Each reading moves the pointer to a point 7 px off first, so
// the move onto the point is a real move, and the record is cleared only
// after that first move has landed: a reading taken from the first move
// would be 7 px off, which is how two readings once disagreed by exactly
// (7, 7). The reading waits for a trusted move and settles before it is
// taken, as keyboard-focus-native.mjs reads it.
async function calibrate() {
  const geometry = Object.fromEntries((await exec("xdotool", ["getwindowgeometry", "--shell", values.xid])).stdout.trim().split("\n").map((line) => line.split("=")));
  const [wx, wy, ww, wh] = ["X", "Y", "WIDTH", "HEIGHT"].map((key) => Number(geometry[key]));
  await page.evaluate(() => {
    window.__linkMove = null;
    addEventListener("mousemove", (event) => {
      window.__linkMove = { x: event.clientX, y: event.clientY, trusted: event.isTrusted };
    }, true);
  });
  const seen = [];
  for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.35]]) {
    const sx = Math.round(wx + ww * fx);
    const sy = Math.round(wy + wh * fy);
    await exec("xdotool", ["windowactivate", "--sync", values.xid, "mousemove", String(sx - 7), String(sy - 7)]);
    await delay(120);
    await page.evaluate(() => { window.__linkMove = null; });
    await exec("xdotool", ["mousemove", String(sx), String(sy)]);
    await until("the page to see the pointer", () => page.evaluate(() => window.__linkMove), (move) => move?.trusted === true, 3000, SetupError);
    await delay(120);
    const move = await page.evaluate(() => window.__linkMove);
    seen.push({ dx: sx - move.x, dy: sy - move.y });
  }
  if (seen.some((p) => p.dx !== seen[0].dx || p.dy !== seen[0].dy)) {
    throw new SetupError(`X input cannot be placed on the page: ${JSON.stringify(seen)}`);
  }
  return seen[0];
}

async function clickAt(offset, point) {
  const sx = String(Math.round(point.x + offset.dx));
  const sy = String(Math.round(point.y + offset.dy));
  await exec("xdotool", ["windowactivate", "--sync", values.xid, "mousemove", sx, sy]);
  await delay(150);
  await exec("xdotool", ["click", "1"]);
}

/// The page selector of the named terminal's surface, from the server's own
/// list of where that terminal shows (its pane and tab), or null while it is
/// not listed. Keyed on the terminal, not on whichever tab is active, so a
/// terminal another run left behind cannot stand in for it.
async function surfaceOf(name, backend) {
  const listed = JSON.parse(await cs("terminal", "list", "--json"));
  const row = Object.values(listed.groups ?? {}).flat().find((entry) => entry.name === name);
  if (!row?.pane || !row.tab) return null;
  return `.pane[data-pane-id="${row.pane}"] .terminal-tab[data-terminal-tab-id="${row.tab}"] ${TERMINAL_SURFACES[backend]}`;
}

async function runBackend(backend, offset) {
  const record = { ok: false, requestedBackend: backend, mounted: null };
  verdict.backends[backend] = record;
  const name = `LinkNative${backend}`;
  try {
    await driveBackend(backend, name, record, offset);
  } finally {
    // Close the named terminal even when setup or the gesture fails.
    await cs("terminal", "close", "--tab-name", name).catch(() => {});
  }
}

async function driveBackend(backend, name, record, offset) {
  record.offset = offset;
  const size = join(values.workspace, `size-${backend}`);
  rmSync(size, { force: true });
  await cs("terminal", "new", "--window", windowId, "--tab-name", name);
  let surface = null;
  await until(`the ${backend} terminal ${name}`, async () => {
    surface = await surfaceOf(name, backend);
    if (!surface) return { listed: false };
    const state = await page.evaluate((sel, tabSel, ghosttySurface) => {
      const box = document.querySelector(sel)?.getBoundingClientRect();
      const tab = document.querySelector(tabSel);
      const tabBox = tab?.getBoundingClientRect();
      return {
        listed: true,
        shown: Boolean(box && box.width > 0 && box.height > 0),
        // What the tab holds when it is not shown, for the setup's record.
        tab: tab ? { active: tab.classList.contains("active"), width: tabBox.width, height: tabBox.height } : null,
        mounted: tab ? (tab.querySelector(ghosttySurface) ? "ghostty" : tab.querySelector(".terminal.xterm") ? "xterm" : "none") : null,
      };
    }, surface, surface.slice(0, surface.indexOf("]", surface.indexOf("data-terminal-tab-id")) + 1), TERMINAL_SURFACES.ghostty);
    record.mounted = state.mounted;
    return state;
  }, (v) => v?.shown === true && v.mounted === backend, 60_000, SetupError);
  record.surface = surface;
  const format = String.raw`\033[H\033[2Jhttp%s\nN316_%s\n`;
  await cs("terminal", "write", "--tab-name", name, `stty size > '${size}' && printf '${format}' '${URL_TAIL}' READY\n`);
  await until("the printed URL", () => cs("terminal", "scrollback", "--tab-name", name), (text) => typeof text === "string" && text.includes("N316_READY"), 30_000, SetupError);
  if (!existsSync(size)) throw new SetupError(`the shell wrote no ${size}`);
  const [rows, cols] = readFileSync(size, "utf8").trim().split(/\s+/).map(Number);
  await delay(800);
  const box = await page.evaluate((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }, surface);
  const cell = { x: box.left + 2.5 * (box.width / cols), y: box.top + 0.5 * (box.height / rows) };
  record.click = cell;

  const before = existsSync(opened) ? readFileSync(opened, "utf8") : "";
  await clickAt(offset, cell);
  let menu;
  try {
    menu = await until("the link menu", () => page.evaluate((sel) => {
      const node = document.querySelector(sel);
      const button = node?.querySelector('[data-terminal-link-action="open-browser"]');
      if (!node || !button) return null;
      const r = button.getBoundingClientRect();
      return {
        // The whole target: the menu may show a long one cut in the middle.
        target: node.querySelector("[data-terminal-link-target]")?.getAttribute("data-terminal-link-target") ?? null,
        disabled: button.disabled,
        button: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
      };
    }, MENU), (m) => m && m.target === URL_316 && !m.disabled, 5000);
  } catch (error) {
    record.fault = `no link menu with an enabled "Open in browser" for ${URL_316}: ${error.message}`;
    return;
  }
  record.menu = menu;
  await clickAt(offset, menu.button);
  try {
    await until("the system opener", async () => (existsSync(opened) ? readFileSync(opened, "utf8") : "").slice(before.length), (text) => text.includes(URL_316), 10_000);
  } catch (error) {
    record.fault = `"Open in browser" did not reach xdg-open with ${URL_316}: ${error.message}`;
    return;
  }
  record.opened = readFileSync(opened, "utf8").slice(before.length).trim();
  record.ok = true;
}

let status = 0;
try {
  page = await openPage();
  const offset = await calibrate();
  for (const backend of backends) {
    await runBackend(backend, offset);
    const record = verdict.backends[backend];
    if (!record.ok) verdict.faults.push(backend);
    console.log(`${record.ok ? "PASS" : "FAIL"} terminal-link ${backend}${record.fault ? ` ${record.fault}` : ""}`);
    save();
  }
  status = verdict.faults.length ? 10 : 0;
} catch (error) {
  verdict.error = String(error);
  status = error instanceof SetupError ? 2 : 3;
  console.log(`${status === 2 ? "SETUP" : "INCONCLUSIVE"} terminal-link ${error.message}`);
} finally {
  save();
  page?.close();
}
process.exit(status);
