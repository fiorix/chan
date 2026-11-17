#!/usr/bin/env node
// The Workspace details command clears the tab that shows the details, not the focused dock, on WebKitGTK.
// The desktop guest counterpart of browser-smoke check 233: the shell seeds
// dock-a.md and tab-b.md at the workspace root; the driver selects the tab
// file, focuses the dock last, and runs Workspace details through the real
// launcher. It asserts the tab's inspector shows the workspace body while the
// dock keeps its selection and the tab's own selection is gone. DOM events
// are dispatched in-page; the engine, dispatch, handlers and rendering are
// WebKitGTK's own.
// Usage: node detailsclear-native.mjs --inspector HOST:PORT --out DIR --xid XID
//   --workspace DIR --sha SHA --engine-version V
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function argsOf(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] ?? "";
  }
  return out;
}

const a = argsOf(process.argv.slice(2));
for (const k of ["inspector", "out", "xid", "workspace", "sha", "engine-version"]) {
  if (!a[k]) throw new Error(`usage: detailsclear-native.mjs --inspector H:P --out DIR --xid XID --workspace DIR --sha SHA --engine-version V (missing --${k})`);
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

function inspectorEval(endpoint, titleSub, expression, timeoutMs = 8000) {
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
  console.log(`detailsclear-native: ${ok ? "ok" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`);
  if (!ok) failures.push({ name, kind, detail });
};
const check = (name, ok, detail) => record(name, ok, detail, "property");
const need = (name, ok, detail) => record(name, ok, detail, "precondition");
const xdo = (args) => spawnSync("xdotool", args.map(String), { encoding: "utf8", timeout: 15_000 });

const page = (expr, timeoutMs) => inspectorEval(a.inspector, "/workspace-", expr, timeoutMs);
const DOCK = 'aside[aria-label="left file browser"]';
// The page relists after the seed and follows its selection after the
// command, so every row and selection read below polls to a bounded deadline
// instead of reading once. An in-page deadline always fits inside the eval
// timeout. An inspector failure ("failed: ...") is recorded with need, never
// check, so the instrument cannot report a fault.
const failed = (value) => typeof value === "string" && value.startsWith("failed:");
const waitTabRow = (timeoutMs = 15000) => page(`(() => new Promise((resolve) => {
  const deadline = Date.now() + ${timeoutMs};
  const tick = () => {
    const rows = [...document.querySelectorAll('.browser:not(.dock) [role="option"]')];
    const row = rows.find((r) => (r.getAttribute("title") || "").endsWith("/tab-b.md"));
    if (row) resolve(row.getAttribute("title"));
    else if (Date.now() > deadline) resolve(null);
    else setTimeout(tick, 250);
  };
  tick();
})())`, timeoutMs + 5000);
const waitDockRow = (timeoutMs = 15000) => page(`(() => new Promise((resolve) => {
  const deadline = Date.now() + ${timeoutMs};
  const tick = () => {
    const rows = [...document.querySelectorAll('${DOCK} [role="treeitem"]')];
    const row = rows.find((r) => (r.getAttribute("title") || "").endsWith("/dock-a.md"));
    if (row) resolve(row.getAttribute("title"));
    else if (Date.now() > deadline) resolve(null);
    else setTimeout(tick, 250);
  };
  tick();
})())`, timeoutMs + 5000);
const waitTabSelected = (timeoutMs = 15000) => page(`(() => new Promise((resolve) => {
  const deadline = Date.now() + ${timeoutMs};
  const tick = () => {
    const rows = [...document.querySelectorAll('.browser:not(.dock) [role="option"]')];
    const row = rows.find((r) => (r.getAttribute("title") || "").endsWith("/tab-b.md"));
    if (!row) {
      if (Date.now() > deadline) resolve("absent");
      else setTimeout(tick, 250);
    } else if (row.getAttribute("aria-selected") === "true") resolve("selected");
    else if (Date.now() > deadline) resolve(row.getAttribute("aria-selected") ?? "unselected");
    else setTimeout(tick, 250);
  };
  tick();
})())`, timeoutMs + 5000);
const waitChip = (timeoutMs = 15000) => page(`(() => new Promise((resolve) => {
  const deadline = Date.now() + ${timeoutMs};
  const tick = () => {
    const chips = [...document.querySelectorAll('.browser:not(.dock) .kind-chip.workspace')];
    if (chips.some((c) => c.textContent.trim() === "workspace")) resolve("workspace");
    else if (Date.now() > deadline) resolve("absent");
    else setTimeout(tick, 250);
  };
  tick();
})())`, timeoutMs + 5000);
const waitDockSelected = (timeoutMs = 15000) => page(`(() => new Promise((resolve) => {
  const deadline = Date.now() + ${timeoutMs};
  const tick = () => {
    const rows = [...document.querySelectorAll('${DOCK} [role="treeitem"]')];
    const row = rows.find((r) => (r.getAttribute("title") || "").endsWith("/dock-a.md"));
    if (!row) {
      if (Date.now() > deadline) resolve("absent");
      else setTimeout(tick, 250);
    } else if (Date.now() > deadline || row.getAttribute("aria-selected") === "true") resolve(row.getAttribute("aria-selected") ?? "unselected");
    else setTimeout(tick, 250);
  };
  tick();
})())`, timeoutMs + 5000);
const waitTabCleared = (timeoutMs = 15000) => page(`(() => new Promise((resolve) => {
  const deadline = Date.now() + ${timeoutMs};
  const tick = () => {
    const rows = [...document.querySelectorAll('.browser:not(.dock) [role="option"]')];
    const row = rows.find((r) => (r.getAttribute("title") || "").endsWith("/tab-b.md"));
    if (!row) {
      if (Date.now() > deadline) resolve("absent");
      else setTimeout(tick, 250);
    } else if (row.getAttribute("aria-selected") !== "true") resolve(row.getAttribute("aria-selected") ?? "unselected");
    else if (Date.now() > deadline) resolve("true");
    else setTimeout(tick, 250);
  };
  tick();
})())`, timeoutMs + 5000);

try {
  xdo(["windowactivate", "--sync", a.xid]);
  const ws = a.workspace;
  mkdirSync(ws, { recursive: true });
  let seededDock = null;
  let seededTab = null;
  try { seededDock = readFileSync(join(ws, "dock-a.md"), "utf8"); } catch {}
  try { seededTab = readFileSync(join(ws, "tab-b.md"), "utf8"); } catch {}
  need("shell seeded root files", seededDock === "dock file\n" && seededTab === "tab file\n",
    seededDock === null || seededTab === null ? "absent" : `${JSON.stringify(seededDock).slice(0, 40)} ${JSON.stringify(seededTab).slice(0, 40)}`);

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
  })())`, 20000).catch((err) => `failed: ${err.message}`);
  need("open files", listed === "files", String(listed).slice(0, 120));

  const docked = await page(`(() => (async () => {
    const prefix = document.querySelector('meta[name="chan-prefix"]')?.getAttribute("content") ?? "";
    const token = new URLSearchParams(location.search).get("t") ?? sessionStorage.getItem("chan.token");
    if (!token) return "no-token";
    const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
    const got = await fetch(prefix + "/api/config", { headers });
    if (!got.ok) return "get-" + got.status;
    const config = await got.json();
    const response = await fetch(prefix + "/api/config", { method: "PATCH", headers,
      body: JSON.stringify({ expected_revision: config.revision,
        preferences: { browser_side_panes: { ...config.preferences.browser_side_panes, left: true } } }) });
    if (!response.ok) return "patch-" + response.status;
    return "docked";
  })())()`).catch((err) => `failed: ${err.message}`);
  need("left dock enabled", docked === "docked", String(docked).slice(0, 120));
  const dockVisible = await page(`(() => new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const tick = () => {
      const el = document.querySelector('${DOCK} .browser .tree');
      if (el && el.checkVisibility()) resolve("dock");
      else if (Date.now() > deadline) reject(new Error("no dock tree appeared"));
      else setTimeout(tick, 250);
    };
    tick();
  })())`, 20000).catch((err) => `failed: ${err.message}`);
  need("dock tree visible", dockVisible === "dock", String(dockVisible).slice(0, 120));

  const tabRow = await waitTabRow().catch((err) => `failed: ${err.message}`);
  need("tab file row present", typeof tabRow === "string" && tabRow.endsWith("/tab-b.md"),
    tabRow === null ? "absent" : String(tabRow).slice(0, 120));
  const clicked = await page(`(() => {
    const row = [...document.querySelectorAll('.browser:not(.dock) [role="option"]')]
      .find((r) => (r.getAttribute("title") || "").endsWith("/tab-b.md"));
    if (!row) return "missing";
    row.click();
    return "clicked";
  })()`).catch((err) => `failed: ${err.message}`);
  need("tab file clicked", clicked === "clicked", String(clicked).slice(0, 120));
  const tabSelected = await waitTabSelected().catch((err) => `failed: ${err.message}`);
  need("tab file selected", tabSelected === "selected", String(tabSelected).slice(0, 120));

  const dockRow = await waitDockRow().catch((err) => `failed: ${err.message}`);
  need("dock file row present", typeof dockRow === "string" && dockRow.endsWith("/dock-a.md"),
    dockRow === null ? "absent" : String(dockRow).slice(0, 120));
  const dockTarget = await page(`(() => {
    const row = [...document.querySelectorAll('${DOCK} [role="treeitem"]')]
      .find((r) => (r.getAttribute("title") || "").endsWith("/dock-a.md"));
    if (!row) return "missing";
    const icon = row.querySelector(".row-icon");
    if (!icon) return "no-icon";
    icon.click();
    const tree = document.querySelector('${DOCK} .tree');
    if (!tree) return "no-tree";
    tree.focus();
    const active = document.getElementById(tree.getAttribute("aria-activedescendant") ?? "");
    return (active?.getAttribute("title") || "").endsWith("/dock-a.md") ? "targeted" : "unfocused";
  })()`).catch((err) => `failed: ${err.message}`);
  need("dock row targeted last", dockTarget === "targeted", String(dockTarget).slice(0, 120));

  await page(`(() => { window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.launcher.toggle" } })); return "toggled"; })()`);
  const launcherOpen = await page(`(() => new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const tick = () => {
      const input = document.querySelector('[role="dialog"][aria-label="Command launcher"] input[role="combobox"]');
      if (input && input === document.activeElement) resolve("open");
      else if (Date.now() > deadline) reject(new Error("launcher input never took focus"));
      else setTimeout(tick, 250);
    };
    tick();
  })())`, 15000).catch((err) => `failed: ${err.message}`);
  need("launcher open and focused", launcherOpen === "open", String(launcherOpen).slice(0, 120));
  xdo(["type", "--delay", "60", "Workspace details"]);
  const launcherPick = await page(`(() => new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const tick = () => {
      const title = document.querySelector('[role="dialog"][aria-label="Command launcher"] [role="option"][aria-selected="true"] .deck-result-title');
      if (title && title.textContent.trim() === "Workspace details") resolve("picked");
      else if (Date.now() > deadline) reject(new Error("Workspace details never selected"));
      else setTimeout(tick, 250);
    };
    tick();
  })())`, 15000).catch((err) => `failed: ${err.message}`);
  need("launcher picked Workspace details", launcherPick === "picked", String(launcherPick).slice(0, 120));
  xdo(["key", "Return"]);
  const launcherGone = await page(`(() => new Promise((resolve) => {
    const deadline = Date.now() + 10000;
    const tick = () => {
      if (!document.querySelector('[role="dialog"][aria-label="Command launcher"]')) resolve("closed");
      else if (Date.now() > deadline) resolve("stuck");
      else setTimeout(tick, 250);
    };
    tick();
  })())`, 15000).catch((err) => `failed: ${err.message}`);
  need("launcher dispatched", launcherGone === "closed", String(launcherGone).slice(0, 120));

  const body = await waitChip().catch((err) => `failed: ${err.message}`);
  if (failed(body)) need("inspector readable", false, String(body).slice(0, 120));
  else check("tab inspector shows the workspace", body === "workspace", String(body).slice(0, 120));
  const dockKept = await waitDockSelected().catch((err) => `failed: ${err.message}`);
  if (failed(dockKept)) need("inspector readable", false, String(dockKept).slice(0, 120));
  else check("dock keeps its selection", dockKept === "true", JSON.stringify(dockKept));
  const tabCleared = await waitTabCleared().catch((err) => `failed: ${err.message}`);
  if (failed(tabCleared)) need("inspector readable", false, String(tabCleared).slice(0, 120));
  else check("tab selection cleared", tabCleared !== "true" && tabCleared !== "absent", JSON.stringify(tabCleared));

  run.finished = new Date().toISOString();
  const preFailed = failures.some((f) => f.kind === "precondition");
  const code = preFailed ? 3 : failures.length > 0 ? 10 : 0;
  run.ok = code === 0;
  run.exitCode = code;
  writeFileSync(join(a.out, "detailsclear-native.json"), `${JSON.stringify(run, null, 2)}\n`);
  console.log(code === 0 ? "detailsclear-native: PASS" : `detailsclear-native: ${failures.length} check(s) failed`);
  process.exitCode = code;
} catch (error) {
  run.finished = new Date().toISOString();
  run.ok = false;
  run.exitCode = 3;
  run.error = String(error && error.message ? error.message : error).slice(0, 300);
  try { writeFileSync(join(a.out, "detailsclear-native.json"), `${JSON.stringify(run, null, 2)}\n`); } catch {}
  console.error(`detailsclear-native: FAIL ${run.error}`);
  process.exitCode = 3;
}
