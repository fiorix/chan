#!/usr/bin/env node
// File-browser Paste lands in the right-clicked row's folder, on WebKitGTK.
// The desktop guest counterpart of browser-smoke check 232: seeds keep.txt
// at the workspace root, right-clicks the notes row of the root listing to
// copy it, right-clicks... no: copies keep.txt, then right-clicks the notes
// row and pastes through its menu. Asserts notes/keep.txt on disk, the root
// keep.txt kept, and the selected row's title ending in /notes/keep.txt (the
// tab follows its selection into notes). DOM events are dispatched in-page;
// the engine, dispatch, handlers and rendering are WebKitGTK's own.
// Usage: node fbpaste-native.mjs --inspector HOST:PORT --out DIR --xid XID
//   --window ID --workspace DIR --sha SHA --engine-version V
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

function inspectorEval(endpoint, titleSub, expression) {
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
// Exit codes follow the directory's convention: 10 a property failed, 3 a
// precondition or the instrument itself failed, 0 the contract held.
let failures = [];
const record = (name, ok, detail, kind) => {
  run.steps.push({ name, ok, detail: detail ?? "" });
  console.log(`fbpaste-native: ${ok ? "ok" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`);
  if (!ok) failures.push({ name, kind, detail });
};
const check = (name, ok, detail) => record(name, ok, detail, "property");
const need = (name, ok, detail) => record(name, ok, detail, "precondition");
const xdo = (args, opts = {}) => spawnSync("xdotool", args.map(String), { encoding: "utf8", timeout: 15_000, ...opts });

const page = (expr) => inspectorEval(a.inspector, "/workspace-", expr);
const rowTitle = (path) => page(`(() => {
  const rows = [...document.querySelectorAll('.browser [role="option"], .browser [role="treeitem"]')];
  const row = rows.find((r) => (r.getAttribute("title") || "").replace(/ \\(.*\\)$/, "").endsWith("/${path}"));
  return row ? row.getAttribute("title") : null;
})()`);
const openMenu = (path) => page(`(() => {
  const rows = [...document.querySelectorAll('.browser [role="option"], .browser [role="treeitem"]')];
  const row = rows.find((r) => (r.getAttribute("title") || "").replace(/ \\(.*\\)$/, "").endsWith("/${path}"));
  if (!row) return "missing";
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  return "opened";
})()`);
const clickMenu = (title) => page(`(() => {
  const button = [...document.querySelectorAll(".ctx button")].find(
    (b) => b.querySelector(".menu-row-label")?.textContent?.trim() === ${JSON.stringify(title)});
  if (!button) return "missing";
  button.click();
  return "clicked";
})()`);

try {
  xdo(["windowactivate", "--sync", a.xid]);
  const ws = a.workspace;
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "keep.txt"), "keep me\n");
  need("seed workspace", true);

  await page(`(() => { window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.files.toggle" } })); return "toggled"; })()`);
  const listed = await page(`(() => new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const tick = () => {
      const el = document.querySelector('.browser [role="listbox"], .browser [role="tree"]');
      if (el) resolve("files");
      else if (Date.now() > deadline) reject(new Error("no file listing appeared"));
      else setTimeout(tick, 250);
    };
    tick();
  })())`).catch((err) => `failed: ${err.message}`);
  need("open files", listed === "files", String(listed).slice(0, 120));

  const keep = await rowTitle("keep.txt").catch((err) => `failed: ${err.message}`);
  need("keep.txt row present", typeof keep === "string" && keep.endsWith("/keep.txt"), JSON.stringify(keep));
  const copyMenu = await openMenu("keep.txt").catch((err) => `failed: ${err.message}`);
  need("copy menu opened", copyMenu === "opened", String(copyMenu));
  const copied = await clickMenu("Copy").catch((err) => `failed: ${err.message}`);
  need("copy row clicked", copied === "clicked", String(copied));

  const sub = await rowTitle("notes").catch((err) => `failed: ${err.message}`);
  need("notes row present", typeof sub === "string" && sub.endsWith("/notes"), JSON.stringify(sub));
  const pasteMenu = await openMenu("notes").catch((err) => `failed: ${err.message}`);
  need("paste menu opened", pasteMenu === "opened", String(pasteMenu));
  const pasted = await clickMenu("Paste").catch((err) => `failed: ${err.message}`);
  need("paste row clicked", pasted === "clicked", String(pasted));

  let landed = null;
  for (let i = 0; i < 30; i++) {
    try { landed = readFileSync(join(ws, "notes", "keep.txt"), "utf8"); break; }
    catch { await sleep(500); }
  }
  check("landed on disk", landed === "keep me\n", JSON.stringify(landed)?.slice(0, 60) ?? "absent");
  let kept = null;
  try { kept = readFileSync(join(ws, "keep.txt"), "utf8"); } catch {}
  check("source kept", kept === "keep me\n", JSON.stringify(kept)?.slice(0, 60) ?? "absent");
  const selected = await page(`(() => {
    const rows = [...document.querySelectorAll('.browser [role="option"], .browser [role="treeitem"]')];
    const row = rows.find((r) => (r.getAttribute("title") || "").endsWith("/notes/keep.txt"));
    return row ? row.getAttribute("aria-selected") : "absent";
  })()`).catch((err) => `failed: ${err.message}`);
  check("landed entry selected", selected === "true", JSON.stringify(selected));

  run.finished = new Date().toISOString();
  const preFailed = failures.some((f) => f.kind === "precondition");
  const code = preFailed ? 3 : failures.length > 0 ? 10 : 0;
  run.ok = code === 0;
  run.exitCode = code;
  writeFileSync(join(a.out, "fbpaste-native.json"), `${JSON.stringify(run, null, 2)}\n`);
  console.log(code === 0 ? "fbpaste-native: PASS" : `fbpaste-native: ${failures.length} check(s) failed`);
  process.exitCode = code;
} catch (error) {
  run.finished = new Date().toISOString();
  run.ok = false;
  run.exitCode = 3;
  run.error = String(error && error.message ? error.message : error).slice(0, 300);
  try { writeFileSync(join(a.out, "fbpaste-native.json"), `${JSON.stringify(run, null, 2)}\n`); } catch {}
  console.error(`fbpaste-native: FAIL ${run.error}`);
  process.exitCode = 3;
}
