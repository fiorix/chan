#!/usr/bin/env node
// File-browser Paste lands in the right-clicked row's folder, on WebKitGTK.
// The desktop guest counterpart of browser-smoke check 232: the shell seeds
// keep.txt at the workspace root beside notes; the driver right-clicks the
// keep.txt row to copy it, then right-clicks the notes row and pastes through
// its menu. Asserts notes/keep.txt on disk, the root keep.txt kept, and the
// selected row's title ending in /notes/keep.txt (the tab follows its
// selection into notes). A paste that lands a new entry at the root instead
// is the fault observed at once. DOM events are dispatched in-page; the engine,
// dispatch, handlers and rendering are WebKitGTK's own.
// Usage: node fbpaste-native.mjs --inspector HOST:PORT --out DIR --xid XID
//   --workspace DIR --sha SHA --engine-version V
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Hang guards, each named with the figure it rests on. The tip's whole
// driver run took 0.853 s at host load near 20, so a 15 s bound is about
// 17 times a healthy run and its expiry names the stuck arm. The inspector
// bounds rest on at least 11 evals inside that 0.853 s run.
const INSPECTOR_LIST_MS = 5000;
const EVAL_MS = 8000;
const ROW_GUARD_MS = 15000;
const MENU_GUARD_MS = 15000;
const DISK_GUARD_MS = 15000;
const SELECT_GUARD_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function argsOf(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] ?? "";
  }
  return out;
}

const a = argsOf(process.argv.slice(2));
for (const k of ["inspector", "out", "xid", "workspace", "sha", "engine-version"]) {
  if (!a[k]) throw new Error(`usage: fbpaste-native.mjs --inspector H:P --out DIR --xid XID --workspace DIR --sha SHA --engine-version V (missing --${k})`);
}
mkdirSync(a.out, { recursive: true });

async function targets() {
  const html = await (await fetch(`http://${a.inspector}/`, { signal: AbortSignal.timeout(INSPECTOR_LIST_MS) })).text();
  const found = [];
  for (const [, cells] of html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)) {
    const path = /\/socket\/\d+\/\d+\/\w+/.exec(cells)?.[0];
    if (!path) continue;
    found.push({ socket: `${a.inspector}${path}`, text: cells.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() });
  }
  return found;
}

function inspectorEval(endpoint, titleSub, expression, timeoutMs = EVAL_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn) => (...args) => { if (settled) return; settled = true; try { ws.close(); } catch {} fn(...args); };
    const ok = done(resolve), fail = done(reject);
    const timer = setTimeout(() => fail(new Error(`inspector did not answer in ${timeoutMs}ms`)), timeoutMs);
    let ws;
    let page = null;
    targets().then((found) => {
      const target = found.find((e) => e.text.includes(titleSub));
      if (!target) { clearTimeout(timer); fail(new Error(`no inspectable page matches ${JSON.stringify(titleSub)}`)); return; }
      ws = new WebSocket(`ws://${target.socket}`);
      const send = (targetId) => {
        const inner = JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } });
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
// A failed precondition ends the run here instead of walking every later
// step to its bound: the verdict is already inconclusive (exit 3).
const stopIfFailed = (phase) => {
  const failed = failures.filter((f) => f.kind === "precondition");
  if (failed.length > 0) throw new Error(`stopping after failed precondition in ${phase}: ${failed.map((f) => f.name).join(", ")}`);
};
const xdo = (args) => spawnSync("xdotool", args.map(String), { encoding: "utf8", timeout: 15_000 });

const page = (expr, timeoutMs) => inspectorEval(a.inspector, "/workspace-", expr, timeoutMs);
// Every page expression below is synchronous and returns a value; the
// deadline lives in node. WebKitGTK's Runtime.evaluate has no awaitPromise,
// so an in-page promise would answer at once as an object and every wait
// below would end at once. A rejected eval fails fast as "failed: ...".
async function until(read, accept, label, bound = ROW_GUARD_MS) {
  const deadline = Date.now() + bound;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
}
const rowTitleExpr = (path) => `(() => {
  const rows = [...document.querySelectorAll('.browser [role="option"], .browser [role="treeitem"]')];
  const row = rows.find((r) => (r.getAttribute("title") || "").replace(/ \\(.*\\)$/, "").endsWith("/${path}"));
  return row ? row.getAttribute("title") : null;
})()`;
const waitRow = async (path, timeoutMs = ROW_GUARD_MS) => {
  try {
    return await until(() => page(rowTitleExpr(path)).catch((err) => `failed: ${err.message}`),
      (t) => typeof t === "string", `row ${path} to appear`, timeoutMs);
  } catch (err) {
    return String((err && err.message) || err).startsWith("timeout waiting for") ? null : `failed: ${String((err && err.message) || err).slice(0, 120)}`;
  }
};
const openMenu = async (path) => {
  const found = await waitRow(path);
  if (found === null) return "missing";
  if (typeof found !== "string" || found.startsWith("failed:")) return found;
  const opened = await page(`(() => {
    const rows = [...document.querySelectorAll('.browser [role="option"], .browser [role="treeitem"]')];
    const row = rows.find((r) => (r.getAttribute("title") || "").replace(/ \\(.*\\)$/, "").endsWith("/${path}"));
    if (!row) return "missing";
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    return "opened";
  })()`);
  if (opened !== "opened") return opened;
  const menu = await waitMenu(path);
  if (menu === null) return "no menu appeared";
  return menu === true ? "opened" : menu;
};
const clickMenu = (title) => page(`(() => {
  const button = [...document.querySelectorAll(".ctx button")].find(
    (b) => b.querySelector(".menu-row-label")?.textContent?.trim() === ${JSON.stringify(title)});
  if (!button) return "missing";
  if (button.disabled) return "disabled";
  button.click();
  return "clicked";
})()`);
const selectedExpr = `(() => {
  const rows = [...document.querySelectorAll('.browser [role="option"], .browser [role="treeitem"]')];
  const row = rows.find((r) => (r.getAttribute("title") || "").endsWith("/notes/keep.txt"));
  if (!row) return "absent";
  return row.getAttribute("aria-selected") ?? "unselected";
})()`;
const waitMenu = async (path, timeoutMs = MENU_GUARD_MS) => {
  // The dispatch's return is the driver's own string, not an observation:
  // wait for the menu the row should have opened before saying so.
  try {
    return await until(() => page(`(() => !!document.querySelector(".ctx"))()`).catch((err) => `failed: ${err.message}`),
      (v) => v === true || (typeof v === "string" && v.startsWith("failed:")), `menu for ${path}`, timeoutMs);
  } catch (err) {
    return String((err && err.message) || err).startsWith("timeout waiting for") ? null : `failed: ${String((err && err.message) || err).slice(0, 120)}`;
  }
};
const waitSelected = async (timeoutMs = SELECT_GUARD_MS) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let state;
    try {
      state = await page(selectedExpr);
    } catch (err) {
      return `failed: ${err && err.message ? err.message : err}`.slice(0, 120);
    }
    if (state === "true") return "true";
    if (Date.now() > deadline) return state;
    await sleep(250);
  }
};

try {
  xdo(["windowactivate", "--sync", a.xid]);
  const ws = a.workspace;
  let seeded = null;
  try { seeded = readFileSync(join(ws, "keep.txt"), "utf8"); } catch {}
  need("shell seeded keep.txt", seeded === "keep me\n", seeded === null ? "absent" : JSON.stringify(seeded).slice(0, 60));
  let preLanded = true;
  try { readFileSync(join(ws, "notes", "keep.txt"), "utf8"); } catch { preLanded = false; }
  need("landing absent before paste", preLanded === false, preLanded ? "present" : "absent");
  stopIfFailed(`seed`);

  await page(`(() => { window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.files.toggle" } })); return "toggled"; })()`);
  const listed = await (async () => {
    const deadline = Date.now() + ROW_GUARD_MS;
    for (;;) {
      let open = false;
      try {
        open = await page(`(() => !!document.querySelector('.browser [role="listbox"], .browser [role="tree"]'))()`);
      } catch (err) {
        return `failed: ${err.message}`;
      }
      if (open === true) return "files";
      if (Date.now() > deadline) return "no file listing appeared";
      await sleep(250);
    }
  })();
  need("open files", listed === "files", String(listed).slice(0, 120));
  stopIfFailed(`open files`);

  const keep = await waitRow("keep.txt").catch((err) => `failed: ${err.message}`);
  need("keep.txt row present", typeof keep === "string" && keep.endsWith("/keep.txt"), keep === null ? "absent" : String(keep).slice(0, 120));
  stopIfFailed(`keep row`);
  const copyMenu = await openMenu("keep.txt").catch((err) => `failed: ${err.message}`);
  need("copy menu opened", copyMenu === "opened", String(copyMenu));
  const copied = await clickMenu("Copy").catch((err) => `failed: ${err.message}`);
  if (copied === "disabled") need("copy row enabled", false, "disabled");
  else need("copy row clicked", copied === "clicked", String(copied));
  stopIfFailed(`copy`);

  const sub = await waitRow("notes").catch((err) => `failed: ${err.message}`);
  need("notes row present", typeof sub === "string" && sub.endsWith("/notes"), sub === null ? "absent" : String(sub).slice(0, 120));
  stopIfFailed(`notes row`);
  const pasteMenu = await openMenu("notes").catch((err) => `failed: ${err.message}`);
  need("paste menu opened", pasteMenu === "opened", String(pasteMenu));
  const rootBefore = (() => { try { return readdirSync(ws); } catch { return null; } })();
  const pasted = await clickMenu("Paste").catch((err) => `failed: ${err.message}`);
  if (pasted === "disabled") need("paste row enabled", false, "disabled");
  else need("paste row clicked", pasted === "clicked", String(pasted));
  stopIfFailed(`paste`);

  // The base's paste lands `keep copy.txt` at the root instead of refusing,
  // so a new root entry is the fault itself: poll the landing and the root
  // together, and name the entry at once instead of timing out.
  let landed = null, extra = [], rootAfter = null;
  const diskDeadline = Date.now() + DISK_GUARD_MS;
  for (;;) {
    try { landed = readFileSync(join(ws, "notes", "keep.txt"), "utf8"); } catch { landed = null; }
    if (landed !== null) break;
    rootAfter = (() => { try { return readdirSync(ws); } catch { return null; } })();
    if (rootBefore !== null && rootAfter !== null) extra = rootAfter.filter((e) => !rootBefore.includes(e));
    if (extra.length > 0) break;
    if (Date.now() > diskDeadline) break;
    await sleep(500);
  }
  rootAfter = rootAfter ?? (() => { try { return readdirSync(ws); } catch { return null; } })();
  run.listings = { rootBefore, rootAfter, landedFile: landed === null ? null : "notes/keep.txt" };
  if (extra.length > 0) check("landed on disk", false, `root gained ${extra.join(",")}`);
  else if (landed === null) need("paste reached disk within the hang guard", false, `notes/keep.txt absent after ${DISK_GUARD_MS} ms`);
  else check("landed on disk", landed === "keep me\n", JSON.stringify(landed).slice(0, 60));
  stopIfFailed(`disk`);
  let kept = null;
  try { kept = readFileSync(join(ws, "keep.txt"), "utf8"); } catch {}
  check("source kept", kept === "keep me\n", kept === null ? "absent" : JSON.stringify(kept).slice(0, 60));
  const selected = await waitSelected().catch((err) => `failed: ${err.message}`);
  if (typeof selected === "string" && selected.startsWith("failed:")) need("selection readable", false, selected.slice(0, 120));
  else check("landed entry selected", selected === "true", JSON.stringify(selected));

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
