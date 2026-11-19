#!/usr/bin/env node
// The dock hands its file commands to the focused pane's tab on close, on WebKitGTK.
// The desktop guest counterpart of browser-smoke check 234: the shell seeds
// docs/a.md and notes/b.md beside an empty target folder; the driver clicks
// the dock row, closes the dock by its own menu row, copies through the
// launcher's Copy path and pastes into target, asserting the tab's file on
// disk and selected. DOM clicks are real in-page clicks and the launcher runs
// on real keystrokes; the engine, dispatch, handlers and rendering are
// WebKitGTK's own.
// Usage: node docktarget-native.mjs --inspector HOST:PORT --out DIR --xid XID
//   --workspace DIR --sha SHA --engine-version V
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Hang guards at 15 s, the same bound the sibling file-browser legs use for
// row, menu, disk and selection reads (their whole driver runs take seconds;
// the lane bound is 2700 s). A rejected eval fails fast as "failed: ...".
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
  if (!a[k]) throw new Error(`usage: docktarget-native.mjs --inspector H:P --out DIR --xid XID --workspace DIR --sha SHA --engine-version V (missing --${k})`);
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
  console.log(`docktarget-native: ${ok ? "ok" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`);
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
const failed = (value) => typeof value === "string" && value.startsWith("failed:");
const readOf = (expr) => () => page(expr).catch((err) => `failed: ${err.message}`);
const waitForValue = async (expr, accept, label, timeoutMs = ROW_GUARD_MS) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await readOf(expr)();
    if (failed(value)) return value;
    if (accept(value)) return value;
    if (Date.now() > deadline) return typeof value === "string" ? value : "unreadable";
    await sleep(250);
  }
};
const DOCK = 'aside[aria-label="left file browser"] .browser';
const rowTitleExpr = (root, path) => `(() => {
  const rows = [...document.querySelectorAll('${root} [role="option"], ${root} [role="treeitem"]')];
  const row = rows.find((r) => (r.getAttribute("title") || "").endsWith("/${path}"));
  return row ? row.getAttribute("title") : null;
})()`;
const waitRow = async (root, path, timeoutMs = ROW_GUARD_MS) => {
  try {
    return await until(() => page(rowTitleExpr(root, path)).catch((err) => `failed: ${err.message}`),
      (t) => typeof t === "string", `row ${path} to appear`, timeoutMs);
  } catch (err) {
    return String((err && err.message) || err).startsWith("timeout waiting for") ? null : `failed: ${String((err && err.message) || err).slice(0, 120)}`;
  }
};
const clickRow = (root, path) => page(`(() => {
  const rows = [...document.querySelectorAll('${root} [role="option"], ${root} [role="treeitem"]')];
  const row = rows.find((r) => (r.getAttribute("title") || "").endsWith("/${path}"));
  if (!row) return "missing";
  row.click();
  return "clicked";
})()`).catch((err) => `failed: ${err.message}`);
const openMenu = async (root, path) => {
  const found = await waitRow(root, path);
  if (found === null) return "missing";
  if (typeof found !== "string" || found.startsWith("failed:")) return found;
  const opened = await page(`(() => {
    const rows = [...document.querySelectorAll('${root} [role="option"], ${root} [role="treeitem"]')];
    const row = rows.find((r) => (r.getAttribute("title") || "").endsWith("/${path}"));
    if (!row) return "missing";
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    return "opened";
  })()`).catch((err) => `failed: ${err.message}`);
  if (opened !== "opened") return opened;
  try {
    const menu = await until(() => page(`(() => !!document.querySelector(".ctx"))()`).catch((err) => `failed: ${err.message}`),
      (v) => v === true || (typeof v === "string" && v.startsWith("failed:")), `menu for ${path}`, MENU_GUARD_MS);
    return menu === true ? "opened" : menu;
  } catch (err) {
    return String((err && err.message) || err).startsWith("timeout waiting for") ? "no menu appeared" : `failed: ${String((err && err.message) || err).slice(0, 120)}`;
  }
};
const clickMenuRow = (title) => page(`(() => {
  const button = [...document.querySelectorAll(".ctx button")].find(
    (b) => b.querySelector(".menu-row-label")?.textContent?.trim() === ${JSON.stringify(title)});
  if (!button) return "missing";
  if (button.disabled) return "disabled";
  button.click();
  return "clicked";
})()`).catch((err) => `failed: ${err.message}`);
const expandDock = async (path) => {
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join("/");
    const row = await waitRow(".browser.dock", sub);
    if (row === null) return "missing";
    if (typeof row === "string" && row.startsWith("failed:")) return row;
    const twirled = await page(`(() => {
      const rows = [...document.querySelectorAll('.browser.dock [role="option"], .browser.dock [role="treeitem"]')];
      const found = rows.find((r) => (r.getAttribute("title") || "").endsWith("/${sub}"));
      if (!found) return "missing";
      if (found.getAttribute("aria-expanded") === "true") return "open";
      const twirl = found.querySelector(".twirl");
      if (!twirl) return "no-twirl";
      twirl.click();
      return "opening";
    })()`).catch((err) => `failed: ${err.message}`);
    if (twirled !== "open" && twirled !== "opening") return twirled;
    if (twirled === "opening") {
      const opened = await waitForValue(`(() => {
        const rows = [...document.querySelectorAll('.browser.dock [role="option"], .browser.dock [role="treeitem"]')];
        const found = rows.find((r) => (r.getAttribute("title") || "").endsWith("/${sub}"));
        return found && found.getAttribute("aria-expanded") === "true" ? "open" : null;
      })()`, (v) => v === "open" || failed(v), `dock folder ${sub} to open`, ROW_GUARD_MS);
      if (opened !== "open") return opened === null ? "not opened" : opened;
    }
  }
  return "expanded";
};

try {
  xdo(["windowactivate", "--sync", a.xid]);
  const ws = a.workspace;
  let seededDock = null;
  let seededTab = null;
  try { seededDock = readFileSync(join(ws, "docs", "a.md"), "utf8"); } catch {}
  try { seededTab = readFileSync(join(ws, "notes", "b.md"), "utf8"); } catch {}
  try { if (!readdirSync(join(ws, "target"))) throw new Error("empty"); } catch { seededTab = null; }
  need("shell seeded root files", seededDock === "dock file\n" && seededTab === "tab file\n",
    seededDock === null || seededTab === null ? "absent" : "present");
  stopIfFailed("seed");

  const toggled = await page(`(() => { window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.files.toggle" } })); return "toggled"; })()`)
    .catch((err) => `failed: ${err.message}`);
  need("files view toggled", toggled === "toggled", String(toggled).slice(0, 120));
  stopIfFailed("files view");
  const listed = await waitForValue(`(() => !!document.querySelector('.browser [role="listbox"], .browser [role="tree"]'))()`,
    (v) => v === true || failed(v), "file listing", ROW_GUARD_MS);
  if (failed(listed)) need("listing readable", false, String(listed).slice(0, 120));
  else need("open files", listed === true, String(listed).slice(0, 120));
  stopIfFailed("open files");

  const notesRow = await waitRow(".browser:not(.dock)", "notes");
  if (notesRow === null) need("notes row present", false, "absent");
  else if (typeof notesRow === "string" && notesRow.startsWith("failed:")) need("notes row readable", false, notesRow.slice(0, 120));
  else need("notes row present", notesRow.endsWith("/notes"), String(notesRow).slice(0, 120));
  stopIfFailed("notes row");
  const entered = await clickRow(".browser:not(.dock)", "notes");
  if (entered !== "clicked") need("notes folder entered", false, String(entered).slice(0, 120));
  stopIfFailed("notes folder");
  const tabRow = await waitRow(".browser:not(.dock)", "notes/b.md");
  if (tabRow === null) need("tab file row present", false, "absent");
  else if (typeof tabRow === "string" && tabRow.startsWith("failed:")) need("tab row readable", false, tabRow.slice(0, 120));
  else need("tab file row present", tabRow.endsWith("/notes/b.md"), String(tabRow).slice(0, 120));
  stopIfFailed("tab file row");
  const tabClicked = await clickRow(".browser:not(.dock)", "notes/b.md");
  need("tab file row selected", tabClicked === "clicked", String(tabClicked).slice(0, 120));
  stopIfFailed("tab file select");

  const docked = await page(`(() => { window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.browser.toggleLeftDock" } })); return "toggled"; })()`)
    .catch((err) => `failed: ${err.message}`);
  need("dock toggled", docked === "toggled", String(docked).slice(0, 120));
  stopIfFailed("dock toggle");
  const dockVisible = await waitForValue(`(() => !!document.querySelector('.browser-side-pane.left .browser.dock'))()`,
    (v) => v === true || failed(v), "dock mounted", ROW_GUARD_MS);
  if (failed(dockVisible)) need("dock readable", false, String(dockVisible).slice(0, 120));
  else need("dock visible", dockVisible === true, String(dockVisible).slice(0, 120));
  stopIfFailed("dock visible");

  const expanded = await expandDock("docs");
  if (expanded === null || (typeof expanded === "string" && expanded.startsWith("failed:"))) {
    need("dock readable", false, String(expanded).slice(0, 120));
  } else need("dock folder expanded", expanded === "expanded", String(expanded).slice(0, 120));
  stopIfFailed("dock expand");
  const dockRow = await waitRow(".browser.dock", "docs/a.md");
  if (dockRow === null) need("dock file row present", false, "absent");
  else if (typeof dockRow === "string" && dockRow.startsWith("failed:")) need("dock row readable", false, dockRow.slice(0, 120));
  else need("dock file row present", dockRow.endsWith("/docs/a.md"), String(dockRow).slice(0, 120));
  stopIfFailed("dock file row");
  const dockClicked = await clickRow(".browser.dock", "docs/a.md");
  need("dock file row selected", dockClicked === "clicked", String(dockClicked).slice(0, 120));
  stopIfFailed("dock file select");
  const focused = await page(`(() => { const ae = document.activeElement; return ae ? !!ae.closest(".browser.dock") : false; })()`)
    .catch((err) => `failed: ${err.message}`);
  need("dock row focused", focused === true, String(focused).slice(0, 120));
  stopIfFailed("dock row focus");

  const menuOpened = await page(`(() => {
    const button = document.querySelector(".browser.dock .browser-toolbar button[aria-label=\\"Menu\\"]");
    if (!button) return "missing";
    button.click();
    return "opened";
  })()`).catch((err) => `failed: ${err.message}`);
  if (menuOpened !== "opened") need("dock menu opened", false, String(menuOpened).slice(0, 120));
  else {
    const menuRow = await waitForValue(`(() => {
      const found = [...document.querySelectorAll(".hamburger-menu button")].find((b) =>
        (b.querySelector(".menu-row-label") || {}).textContent?.trim() === "Left file browser dock");
      return found ? "toggle" : null;
    })()`, (v) => v === "toggle" || failed(v), "dock menu toggle row", MENU_GUARD_MS);
    if (failed(menuRow)) need("dock menu readable", false, String(menuRow).slice(0, 120));
    else need("dock menu names its toggle", menuRow === "toggle", String(menuRow).slice(0, 120));
  }
  stopIfFailed("dock menu");
  const toggled2 = await page(`(() => {
    const found = [...document.querySelectorAll(".hamburger-menu button")].find((b) =>
      (b.querySelector(".menu-row-label") || {}).textContent?.trim() === "Left file browser dock");
    if (!found) return "missing";
    found.click();
    return "clicked";
  })()`).catch((err) => `failed: ${err.message}`);
  need("dock toggle clicked", toggled2 === "clicked", String(toggled2).slice(0, 120));
  stopIfFailed("dock toggle click");
  const dockGone = await waitForValue(`(() => document.querySelector(".browser-side-pane.left") ? null : "closed")()`,
    (v) => v === "closed" || failed(v), "dock close", ROW_GUARD_MS);
  if (failed(dockGone)) need("dock readable", false, String(dockGone).slice(0, 120));
  else need("left dock closed", dockGone === "closed", String(dockGone).slice(0, 120));
  stopIfFailed("dock close");

  await page(`(() => { window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.launcher.toggle" } })); return "toggled"; })()`)
    .catch(() => {});
  const launcherOpen = await waitForValue(
    `(() => { const input = document.querySelector('[role="dialog"][aria-label="Command launcher"] input[role="combobox"]');
      return input && input === document.activeElement ? "open" : null; })()`,
    (v) => v === "open" || failed(v), "launcher input", ROW_GUARD_MS);
  if (failed(launcherOpen)) need("launcher readable", false, String(launcherOpen).slice(0, 120));
  else need("launcher open and focused", launcherOpen === "open", String(launcherOpen).slice(0, 120));
  stopIfFailed("launcher open");
  await xdo(["type", "--delay", "60", "Copy path"]);
  const launcherPick = await waitForValue(
    `(() => { const title = document.querySelector('[role="dialog"][aria-label="Command launcher"] [role="option"][aria-selected="true"] .deck-result-title');
      return title && title.textContent.trim() === "Copy path" ? "picked" : null; })()`,
    (v) => v === "picked" || failed(v), "launcher pick", ROW_GUARD_MS);
  if (failed(launcherPick)) need("launcher readable", false, String(launcherPick).slice(0, 120));
  else need("launcher picked Copy path", launcherPick === "picked", String(launcherPick).slice(0, 120));
  stopIfFailed("launcher pick");
  await xdo(["key", "Return"]);
  const launcherGone = await waitForValue(
    `(() => document.querySelector('[role="dialog"][aria-label="Command launcher"]') ? null : "closed")()`,
    (v) => v === "closed" || failed(v), "launcher close", ROW_GUARD_MS);
  if (failed(launcherGone)) need("launcher readable", false, String(launcherGone).slice(0, 120));
  else need("launcher dispatched", launcherGone === "closed", String(launcherGone).slice(0, 120));
  stopIfFailed("launcher dispatched");

  const tabFocused = await page(`(() => { const ae = document.activeElement; return ae ? !!ae.closest(".browser:not(.dock)") : false; })()`)
    .catch((err) => `failed: ${err.message}`);
  check("keyboard is inside the tab's tree", tabFocused === true, String(tabFocused).slice(0, 120));

  const targetMenu = await openMenu(".browser:not(.dock)", "target");
  if (targetMenu !== "opened") need("target menu opened", false, String(targetMenu).slice(0, 200));
  else {
    const pasted = await clickMenuRow("Paste");
    if (pasted === "disabled") need("paste row enabled", false, "disabled");
    else need("paste row clicked", pasted === "clicked", String(pasted).slice(0, 120));
  }
  stopIfFailed("paste click");
  let landed = null;
  let rootAfter = null;
  const deadLine = Date.now() + DISK_GUARD_MS;
  for (;;) {
    try { landed = readFileSync(join(ws, "target", "b.md"), "utf8"); } catch { landed = null; }
    if (landed !== null) break;
    try { rootAfter = readdirSync(join(ws, "target")); } catch { rootAfter = null; }
    if (Date.now() > deadLine) break;
    await sleep(500);
  }
  rootAfter = rootAfter ?? (() => { try { return readdirSync(join(ws, "target")); } catch { return null; } })();
  run.listings = { rootAfter, landedFile: landed === null ? null : "target/b.md" };
  if (landed === null) need("paste reached disk within the hang guard", false, `target/b.md absent after ${DISK_GUARD_MS} ms`);
  else check("landed on disk", landed === "tab file\n", JSON.stringify(landed).slice(0, 60));
  stopIfFailed("disk");
  const kept = await page(`(() => {
    const rows = [...document.querySelectorAll('.browser [role="option"], .browser [role="treeitem"]')];
    const row = rows.find((r) => (r.getAttribute("title") || "").endsWith("/target/b.md"));
    if (!row) return "absent";
    return row.getAttribute("aria-selected") ?? "unselected";
  })()`).catch((err) => `failed: ${err.message}`);
  if (typeof kept === "string" && kept.startsWith("failed:")) need("selection readable", false, kept.slice(0, 120));
  else check("landed entry selected", kept === "true", JSON.stringify(kept));

  run.finished = new Date().toISOString();
  const preFailed = failures.some((f) => f.kind === "precondition");
  const code = preFailed ? 3 : failures.length > 0 ? 10 : 0;
  run.ok = code === 0;
  run.exitCode = code;
  writeFileSync(join(a.out, "docktarget-native.json"), `${JSON.stringify(run, null, 2)}\n`);
  console.log(code === 0 ? "docktarget-native: PASS" : `docktarget-native: ${failures.length} check(s) failed`);
  process.exitCode = code;
} catch (error) {
  run.finished = new Date().toISOString();
  run.ok = false;
  run.exitCode = 3;
  run.error = String(error && error.message ? error.message : error).slice(0, 300);
  try { writeFileSync(join(a.out, "docktarget-native.json"), `${JSON.stringify(run, null, 2)}\n`); } catch {}
  console.error(`docktarget-native: FAIL ${run.error}`);
  process.exitCode = 3;
}

