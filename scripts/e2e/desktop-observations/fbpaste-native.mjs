#!/usr/bin/env node
// File-browser Paste lands in the right-clicked row's folder, on WebKitGTK.
// The desktop guest counterpart of browser-smoke check 232: seeds a workspace
// with notes/keep.txt and notes/sub/, opens a Files tab showing notes in
// chan-desktop, copies keep.txt through its row menu, pastes through the sub
// folder row's menu, then asserts notes/sub/keep.txt on disk and the landed
// entry selected. DOM events are dispatched in-page (synthetic); the engine,
// dispatch, handlers and rendering are WebKitGTK's own.
// Usage: node fbpaste-native.mjs --inspector HOST:PORT --out DIR --xid XID
//   --window WINDOWID --workspace DIR --sha SHA --engine-version V
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function argsOf(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] ?? "";
  }
  return out;
}

const a = argsOf(process.argv.slice(2));
for (const k of ["inspector", "out", "xid", "window", "workspace", "sha", "engine-version"]) {
  if (!a[k]) throw new Error(`usage: fbpaste-native.mjs --inspector H:P --out DIR --xid XID --window ID --workspace DIR --sha SHA --engine-version V (missing --${k})`);
}
const { CHAN_BIN, CHAN_CONTROL_SOCKET } = process.env;
if (!CHAN_BIN || !CHAN_CONTROL_SOCKET) throw new Error("need CHAN_BIN and CHAN_CONTROL_SOCKET in the environment");
mkdirSync(a.out, { recursive: true });

async function targets() {
  const html = await (await fetch(`http://${a.inspector}/`, { signal: AbortSignal.timeout(5000) })).text();
  const found = [];
  for (const [, cells] of html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)) {
    const path = /\/socket\/\d+\/\d+\/\w+/.exec(cells)?.[0];
    if (!path) continue;
    found.push({ socket: `${a.inspector}${path}`, text: cells.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() });
  }
  return found;
}

function evaluate(endpoint, titleSub, expression) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn) => (...args) => { if (settled) return; settled = true; try { ws.close(); } catch {} fn(...args); };
    const ok = done(resolve), fail = done(reject);
    const timer = setTimeout(() => fail(new Error("inspector did not answer in 8s")), 8000);
    let ws;
    let page = null;
    targets().then((found) => {
      const target = found.find((e) => e.text.includes(titleSub));
      if (!target) { clearTimeout(timer); fail(new Error(`no inspectable page matches ${JSON.stringify(titleSub)}`)); return; }
      ws = new WebSocket(`ws://${target.socket}`);
      const send = (targetId) => {
        const inner = JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } });
        ws.send(JSON.stringify({ id: 1, method: "Target.sendMessageToTarget", params: { targetId, message: inner } }));
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.method === "Target.targetCreated" && message.params.targetInfo.type === "page" && !page) {
          page = message.params.targetInfo.targetId;
          send(page);
        } else if (message.method === "Target.dispatchMessageFromTarget" && page) {
          const inner = JSON.parse(message.params.message);
          if (inner.id !== 1) return;
          clearTimeout(timer);
          if (inner.error || inner.result?.wasThrown) fail(new Error(`page threw: ${JSON.stringify(inner).slice(0, 400)}`));
          else ok(inner.result.result.value);
        }
      };
      ws.onerror = () => { clearTimeout(timer); fail(new Error("inspector socket failed")); };
    }).catch((err) => { clearTimeout(timer); fail(err); });
  });
}

const run = { engine: "webkitgtk", engineVersion: a["engine-version"], worktreeSha: a.sha, started: new Date().toISOString(), steps: [] };
const step = (name, ok, detail = "") => { run.steps.push({ name, ok, detail }); console.log(`fbpaste-native: ${ok ? "ok" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); if (!ok) throw new Error(name); };
const xdo = (args) => spawnSync("xdotool", args.map(String), { encoding: "utf8", timeout: 15_000 });

try {
  const page = (expr) => evaluate(a.inspector, "/workspace-", expr);
  xdo(["windowactivate", "--sync", a.xid]);
  const ws = a.workspace;
  mkdirSync(join(ws, "notes", "sub"), { recursive: true });
  writeFileSync(join(ws, "notes", "keep.txt"), "keep me\n");
  step("seed workspace", true);

  await page(`(() => { window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.files.toggle" } })); return "toggled"; })()`);
  await page(`(() => new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const tick = () => {
      const el = document.querySelector('.browser [role="listbox"], .browser [role="tree"]');
      if (el) resolve("files");
      else if (Date.now() > deadline) reject(new Error("no file listing appeared"));
      else setTimeout(tick, 250);
    };
    tick();
  })())`);
  step("open files", true);

  const rowTitle = async (path) => page(`(() => {
    const rows = [...document.querySelectorAll('.browser [role="option"], .browser [role="treeitem"]')];
    const row = rows.find((r) => (r.getAttribute("title") || "").replace(/ \\(.*\\)$/, "").endsWith("/${path}"));
    if (!row) return null;
    return { title: row.getAttribute("title"), selected: row.getAttribute("aria-selected") };
  })()`);
  const openMenu = async (path) => page(`(() => {
    const rows = [...document.querySelectorAll('.browser [role="option"], .browser [role="treeitem"]')];
    const row = rows.find((r) => (r.getAttribute("title") || "").replace(/ \\(.*\\)$/, "").endsWith("/${path}"));
    if (!row) return "missing:" + ${JSON.stringify(path)};
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    return "opened";
  })()`);
  const clickMenu = async (title) => page(`(() => {
    const button = [...document.querySelectorAll(".ctx button")].find(
      (b) => b.querySelector(".menu-row-label")?.textContent?.trim() === ${JSON.stringify(title)});
    if (!button) return "missing";
    button.click();
    return "clicked";
  })()`);

  const keep = await rowTitle("notes/keep.txt");
  step("keep.txt row present", !!keep, JSON.stringify(keep));
  if ((await openMenu("notes/keep.txt")) !== "opened") throw new Error("copy menu did not open");
  if ((await clickMenu("Copy")) !== "clicked") throw new Error("Copy row did not click");
  step("copy through row menu", true);
  const sub = await rowTitle("notes/sub");
  step("sub row present", !!sub, JSON.stringify(sub));
  if ((await openMenu("notes/sub")) !== "opened") throw new Error("paste menu did not open");
  if ((await clickMenu("Paste")) !== "clicked") throw new Error("Paste row did not click");
  step("paste through row menu", true);

  const landed = join(ws, "notes", "sub", "keep.txt");
  let disk = null;
  for (let i = 0; i < 30; i++) {
    try { disk = readFileSync(landed, "utf8"); break; } catch { await sleep(500); }
  }
  step("landed on disk", disk === "keep me\n", JSON.stringify(disk)?.slice(0, 60) ?? "absent");
  step("source kept (copy, not cut)", readFileSync(join(ws, "notes", "keep.txt"), "utf8") === "keep me\n");
  const selected = await page(`(() => {
    const rows = [...document.querySelectorAll('.browser [role="option"], .browser [role="treeitem"]')];
    const row = rows.find((r) => (r.getAttribute("title") || "").endsWith("/notes/sub/keep.txt"));
    return row ? row.getAttribute("aria-selected") : "absent";
  })()`);
  step("landed entry selected", selected === "true", String(selected));
  run.finished = new Date().toISOString();
  run.ok = true;
  writeFileSync(join(a.out, "fbpaste-native.json"), `${JSON.stringify(run, null, 2)}\n`);
  console.log("fbpaste-native: PASS");
} catch (error) {
  run.finished = new Date().toISOString();
  run.ok = false;
  run.error = String(error && error.message ? error.message : error).slice(0, 500);
  writeFileSync(join(a.out, "fbpaste-native.json"), `${JSON.stringify(run, null, 2)}\n`);
  console.error(`fbpaste-native: FAIL ${run.error}`);
  process.exit(1);
}
