#!/usr/bin/env node
// The dock hands its file commands to the focused pane's tab on close, on
// WebKitGTK. The desktop guest counterpart of browser-smoke check 234: the
// shell seeds docs/a.md and notes/b.md; the driver enters notes in the tab's
// list by a dispatched double click and selects b.md, opens the left dock by
// the deck's row and selects its docs/a.md, closes the dock by its own menu
// row, and runs the deck's Copy path, asserting the keyboard inside the tab's
// tree and the tab's file on the X clipboard. With --close-by deck it closes
// the dock instead by the deck's "Left file browser dock" row, a toggle the
// deck stays open on, and Escape dismisses the deck: its close hands the
// keyboard to the tab, which is asserted there, before the copy. Row clicks
// are in-page clicks, the deck runs on real keystrokes, and the engine,
// dispatch, handlers and rendering are WebKitGTK's own.
// Usage: node docktarget-native.mjs --inspector HOST:PORT --out DIR --xid XID
//   --workspace DIR --sha SHA --engine-version V [--close-by menu|deck]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Hang guards, not expected times: 15 s for row and menu reads, the bound the
// sibling file-browser legs use (their whole driver runs take seconds; the
// lane bound is 2700 s); 5 s for the clipboard to hold Copy path's text; 3 s
// for the deck's close to hand the keyboard on. A rejected eval fails fast as
// "failed: ...".
const INSPECTOR_LIST_MS = 5000;
const EVAL_MS = 8000;
const ROW_GUARD_MS = 15000;
const MENU_GUARD_MS = 15000;
const CLIP_GUARD_MS = 5000;
const HANDBACK_GUARD_MS = 3000;

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
const closeBy = a["close-by"] || "menu";
if (closeBy !== "menu" && closeBy !== "deck") throw new Error(`--close-by is menu or deck, not ${JSON.stringify(closeBy)}`);
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

const run = { engine: "webkitgtk", engineVersion: a["engine-version"], worktreeSha: a.sha, closeBy, started: new Date().toISOString(), steps: [] };
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
const clip = () => spawnSync("xclip", ["-o", "-selection", "clipboard"], { encoding: "utf8", timeout: 5_000 });
// Write the verdict: 3 when a precondition failed, 10 when a property did,
// 0 when the contract held.
const finish = () => {
  run.finished = new Date().toISOString();
  const preFailed = failures.some((f) => f.kind === "precondition");
  const code = preFailed ? 3 : failures.length > 0 ? 10 : 0;
  run.ok = code === 0;
  run.exitCode = code;
  writeFileSync(join(a.out, "docktarget-native.json"), `${JSON.stringify(run, null, 2)}\n`);
  console.log(code === 0 ? "docktarget-native: PASS" : `docktarget-native: ${failures.length} check(s) failed`);
  process.exitCode = code;
};
// A failed property that leaves nothing for the later steps to read ends the
// run with its verdict.
const STOP = Symbol("stop");

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
  // The list selects a folder on a click and enters it on a double click.
  const entered = await page(`(() => {
    const rows = [...document.querySelectorAll('.browser:not(.dock) [role="option"], .browser:not(.dock) [role="treeitem"]')];
    const row = rows.find((r) => (r.getAttribute("title") || "").endsWith("/notes"));
    if (!row) return "missing";
    row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    return "entered";
  })()`).catch((err) => `failed: ${err.message}`);
  if (entered !== "entered") need("notes folder entered", false, String(entered).slice(0, 120));
  stopIfFailed("notes folder");
  const tabRow = await waitRow(".browser:not(.dock)", "notes/b.md");
  if (tabRow === null) need("tab file row present", false, "absent");
  else if (typeof tabRow === "string" && tabRow.startsWith("failed:")) need("tab row readable", false, tabRow.slice(0, 120));
  else need("tab file row present", tabRow.endsWith("/notes/b.md"), String(tabRow).slice(0, 120));
  stopIfFailed("tab file row");
  const tabClicked = await clickRow(".browser:not(.dock)", "notes/b.md");
  need("tab file row selected", tabClicked === "clicked", String(tabClicked).slice(0, 120));
  stopIfFailed("tab file select");

  // The dock opens by the deck's "Left file browser dock" row, as a user
  // opens it: the command has no case on the host bus. The deck stays open
  // on a toggle, and Escape dismisses it.
  await page(`(() => { window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.launcher.toggle" } })); return "toggled"; })()`)
    .catch(() => {});
  const openerDeck = await waitForValue(
    `(() => { const input = document.querySelector('[role="dialog"][aria-label="Command launcher"] input[role="combobox"]');
      return input && input === document.activeElement ? "open" : null; })()`,
    (v) => v === "open" || failed(v), "deck input to open the dock", ROW_GUARD_MS);
  if (failed(openerDeck)) need("deck readable", false, String(openerDeck).slice(0, 120));
  else need("deck open to open the dock", openerDeck === "open", String(openerDeck).slice(0, 120));
  stopIfFailed("deck open to open the dock");
  await xdo(["type", "--delay", "60", "Left file browser dock"]);
  const openerPick = await waitForValue(
    `(() => { const title = document.querySelector('[role="dialog"][aria-label="Command launcher"] [role="option"][aria-selected="true"] .deck-result-title');
      return title && title.textContent.trim() === "Left file browser dock" ? "picked" : null; })()`,
    (v) => v === "picked" || failed(v), "deck dock row to open it", ROW_GUARD_MS);
  if (failed(openerPick)) need("deck readable", false, String(openerPick).slice(0, 120));
  else need("deck picked the dock row to open it", openerPick === "picked", String(openerPick).slice(0, 120));
  stopIfFailed("deck dock row to open it");
  await xdo(["key", "Return"]);
  const dockVisible = await waitForValue(`(() => !!document.querySelector('.browser-side-pane.left .browser.dock'))()`,
    (v) => v === true || failed(v), "dock mounted", ROW_GUARD_MS);
  if (failed(dockVisible)) need("dock readable", false, String(dockVisible).slice(0, 120));
  else need("dock visible", dockVisible === true, String(dockVisible).slice(0, 120));
  stopIfFailed("dock visible");
  await xdo(["key", "Escape"]);
  const openerGone = await waitForValue(
    `(() => document.querySelector('[role="dialog"][aria-label="Command launcher"]') ? null : "closed")()`,
    (v) => v === "closed" || failed(v), "deck dismissal after opening the dock", ROW_GUARD_MS);
  if (failed(openerGone)) need("deck readable", false, String(openerGone).slice(0, 120));
  else need("deck dismissed after opening the dock", openerGone === "closed", String(openerGone).slice(0, 120));
  stopIfFailed("deck dismissal after opening the dock");

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

  if (closeBy === "menu") {
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
  } else {
    // The deck's row closes the dock while the deck holds the keyboard, so
    // the dock's own close moves nothing; Escape then dismisses the deck,
    // whose close finds its opener gone and hands the keyboard on.
    await page(`(() => { window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.launcher.toggle" } })); return "toggled"; })()`)
      .catch(() => {});
    const deckOpen = await waitForValue(
      `(() => { const input = document.querySelector('[role="dialog"][aria-label="Command launcher"] input[role="combobox"]');
        return input && input === document.activeElement ? "open" : null; })()`,
      (v) => v === "open" || failed(v), "deck input over the dock", ROW_GUARD_MS);
    if (failed(deckOpen)) need("deck readable", false, String(deckOpen).slice(0, 120));
    else need("deck open and focused over the dock", deckOpen === "open", String(deckOpen).slice(0, 120));
    stopIfFailed("deck open over the dock");
    await xdo(["type", "--delay", "60", "Left file browser dock"]);
    const dockPick = await waitForValue(
      `(() => { const title = document.querySelector('[role="dialog"][aria-label="Command launcher"] [role="option"][aria-selected="true"] .deck-result-title');
        return title && title.textContent.trim() === "Left file browser dock" ? "picked" : null; })()`,
      (v) => v === "picked" || failed(v), "deck dock row pick", ROW_GUARD_MS);
    if (failed(dockPick)) need("deck readable", false, String(dockPick).slice(0, 120));
    else need("deck picked the dock row", dockPick === "picked", String(dockPick).slice(0, 120));
    stopIfFailed("deck dock row");
    await xdo(["key", "Return"]);
    const dockGone = await waitForValue(`(() => document.querySelector(".browser-side-pane.left") ? null : "closed")()`,
      (v) => v === "closed" || failed(v), "dock close from the deck", ROW_GUARD_MS);
    if (failed(dockGone)) need("dock readable", false, String(dockGone).slice(0, 120));
    else need("left dock closed by the deck's row", dockGone === "closed", String(dockGone).slice(0, 120));
    stopIfFailed("dock close from the deck");
    // The row is a toggle the deck stays open on, so Escape below lands in
    // the deck; a deck that closed on the row would leave the dock's own
    // close to hand the keyboard on.
    run.deckAfterRow = await page(`(() => document.querySelector('[role="dialog"][aria-label="Command launcher"]') ? "open" : "closed")()`)
      .catch((err) => `failed: ${err.message}`);
    need("deck stays open on the dock row", run.deckAfterRow === "open", String(run.deckAfterRow).slice(0, 120));
    stopIfFailed("deck stays open on the dock row");
    await xdo(["key", "Escape"]);
    const deckGone = await waitForValue(
      `(() => document.querySelector('[role="dialog"][aria-label="Command launcher"]') ? null : "closed")()`,
      (v) => v === "closed" || failed(v), "deck dismissal", ROW_GUARD_MS);
    if (failed(deckGone)) need("deck readable", false, String(deckGone).slice(0, 120));
    else need("deck dismissed by Escape", deckGone === "closed", String(deckGone).slice(0, 120));
    stopIfFailed("deck dismissal");
    const handedBack = await waitForValue(
      `(() => {
        const ae = document.activeElement;
        if (ae && ae.closest(".browser:not(.dock)")) return "tab";
        return ae ? ("elsewhere: " + ae.tagName + "." + String(ae.className || "")).slice(0, 100) : "elsewhere: none";
      })()`,
      (v) => v === "tab" || failed(v), "the tab's tree after Escape", HANDBACK_GUARD_MS);
    check("keyboard is inside the tab's tree after Escape", handedBack === "tab", String(handedBack).slice(0, 120));
    if (handedBack !== "tab") throw STOP;
  }

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

  // Copy path writes the selection's path to the system clipboard, which the
  // X clipboard holds once the run settles: the workspace-relative path.
  let copied = "";
  const clipDeadline = Date.now() + CLIP_GUARD_MS;
  for (;;) {
    const read = clip();
    copied = read.status === 0 ? String(read.stdout ?? "").trim() : "";
    if (copied || Date.now() > clipDeadline) break;
    await sleep(250);
  }
  run.clipboard = copied.slice(-160);
  if (!copied) need("clipboard readable within the hang guard", false, `empty after ${CLIP_GUARD_MS} ms`);
  else check("Copy path copied the tab's file", copied === "notes/b.md" || copied.endsWith("/notes/b.md"), JSON.stringify(copied.slice(-80)));
  finish();
} catch (error) {
  if (error === STOP) {
    finish();
  } else {
    run.finished = new Date().toISOString();
    run.ok = false;
    run.exitCode = 3;
    run.error = String(error && error.message ? error.message : error).slice(0, 300);
    try { writeFileSync(join(a.out, "docktarget-native.json"), `${JSON.stringify(run, null, 2)}\n`); } catch {}
    console.error(`docktarget-native: FAIL ${run.error}`);
    process.exitCode = 3;
  }
}

