import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { FILE_ROW, navigateFiles } from "../lib/files.mjs";
import {
  closeEveryTerminal,
  dispatchCommand,
  readPaneStripPreference,
  writePaneStripPreference,
} from "../lib/pane-strip.mjs";
import { recordedSince, startRecorder } from "../lib/pty-recorder.mjs";
import { readTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const RUN = Date.now().toString(36);
const DIR = `reloadfocus-262-${RUN}`;
const FILES = 60;
const TERMINAL = ".pane .terminal-tab.active";
const ENGINE = { xterm: ".terminal.xterm .xterm-screen", ghostty: ".terminal-host canvas" };
const MENU = ".terminal-tab-menu-bubble";
const TYPED = "78";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ptySince = (label, file, offset) => recordedSince(label, file, offset, TYPED);

function seedFolder(ctx) {
  const dir = join(ctx.workspaceDir, DIR);
  mkdirSync(dir);
  for (let i = 0; i < FILES; i += 1) writeFileSync(join(dir, `f${String(i).padStart(2, "0")}.txt`), `${i}\n`);
  return dir;
}

/// Where the keyboard is: the terminal's host or its textarea, an element of
/// the file browser, or another element.
function focusOf(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el?.closest?.(".terminal-tab .terminal-host")) return el.tagName === "TEXTAREA" ? "terminal-textarea" : "terminal";
    const browser = el?.closest?.(".browser");
    if (browser) return el.getAttribute("role") === "listbox" ? "browser-list" : `browser-${el.tagName}`;
    return "other";
  });
}

/// A timed-out keyboard transition makes the sequence incomplete.
async function focusSettled(page, accept, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  let focus = await focusOf(page);
  while (!accept(focus) && Date.now() < deadline) {
    await sleep(50);
    focus = await focusOf(page);
  }
  if (!accept(focus)) throw new Error(`keyboard wait expired: ${focus}`);
  return focus;
}

/// The browser pane's selected row, its list's scroll offset and whether the
/// pane carries the focus border.
function browserState(page) {
  return page.evaluate((rowSelector) => {
    const browser = document.querySelector(".pane .browser");
    const pane = browser?.closest(".pane");
    const rows = [...(browser?.querySelectorAll(rowSelector) ?? [])];
    const selected = rows.filter((row) => row.getAttribute("aria-selected") === "true")
      .map((row) => row.querySelector('button, [role="button"]')?.textContent?.trim() ?? "")
      .map((name) => /^f[0-5]\d\.txt$/.test(name) ? name : "unexpected-row");
    return {
      focusedPane: Boolean(pane?.classList.contains("focused")),
      selected,
      scroll: Math.round(browser?.querySelector(".tree-wrap")?.scrollTop ?? -1),
    };
  }, FILE_ROW);
}

function centreOf(page, selector) {
  return page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

async function openTerminal(page, engine) {
  const before = await page.$$eval(".terminal-tab", (tabs) => tabs.length);
  await dispatchCommand(page, "app.terminal.toggle");
  await page.waitForFunction((n) => document.querySelectorAll(".terminal-tab").length > n, { timeout: 30_000 }, before);
  await page.waitForSelector(`${TERMINAL} ${ENGINE[engine]}`, { visible: true, timeout: 30_000 });
  await sleep(1_000);
}

/// Press into the terminal with `button`; a right press opens the terminal's
/// menu, which Escape closes without moving the keyboard. With `want`, the
/// press is made again until that element holds the keyboard through a short
/// hold: a host resume (the window regaining focus) refocuses the terminal's
/// host and can take it from the textarea.
async function pressTerminal(page, button, want = null) {
  let focus = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const host = await centreOf(page, `${TERMINAL} .terminal-host`);
    await page.mouse.click(host.x, host.y, { button });
    if (button === "right") {
      await page.waitForSelector(MENU, { visible: true, timeout: 10_000 });
      await page.keyboard.press("Escape");
      await page.waitForSelector(MENU, { hidden: true, timeout: 10_000 });
    }
    focus = await focusSettled(page, (held) => held.startsWith("terminal"));
    if (!want) return focus;
    await sleep(150);
    focus = await focusOf(page);
    if (focus === want) return focus;
  }
  return focus;
}

async function chord(page, modifier, key) {
  await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  await page.keyboard.up(modifier);
}

async function clickIn(page, selector) {
  const point = await centreOf(page, selector);
  await page.mouse.click(point.x, point.y);
}

/// Enter Hybrid Nav, run `steps` in it and commit with Enter. A Hybrid Nav that
/// did not open or close fails the arm through what the keyboard did, not a
/// throw, so every arm reads.
async function hybridNav(page, steps) {
  const PREVIEW = '[aria-label="Hybrid Nav preview"]';
  await chord(page, "Control", "Period");
  await page.keyboard.press("KeyH");
  const opened = await page.waitForSelector(PREVIEW, { timeout: 5_000 }).then(() => true, () => false);
  if (!opened) return false;
  for (const key of steps) await page.keyboard.press(key);
  await page.keyboard.press("Enter");
  const closed = await page.waitForSelector(PREVIEW, { hidden: true, timeout: 5_000 }).then(() => true, () => false);
  if (!closed) {
    // Leave Hybrid Nav so the next arm starts from the window, not the
    // preview: the element that kept the keys took the Enter.
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press("Escape");
    await page.waitForSelector(PREVIEW, { hidden: true, timeout: 5_000 }).catch(() => {});
  }
  return closed;
}

const MOVES = {
  next: (page) => chord(page, "Alt", "BracketRight"),
  hybrid: (page) => hybridNav(page, ["ArrowDown"]),
  strip: (page) => clickIn(page, ".pane:has(.browser) .tabs .dead-zone"),
  tab: (page) => clickIn(page, ".pane:has(.browser) .tabs .tab-row > .tab.active"),
};

/// Type the marker back in the terminal and read every byte the PTY took
/// since `offset`; anything before the marker leaked from the browser arm.
async function markerSince(page, file, offset, label) {
  await pressTerminal(page, "left");
  await page.keyboard.type("x");
  return ptySince(label, file, offset);
}

async function moveArm(page, file, engine, press, move) {
  const arm = `${engine}-${press}-${move}`;
  const holder = await pressTerminal(page, press, expectedHolder(engine, press));
  const offset = statSync(file).size;
  const before = await browserState(page);
  await MOVES[move](page);
  const focus = await focusSettled(page, (held) => held.startsWith("browser-"));
  const after = await browserState(page);
  await page.keyboard.press("ArrowDown");
  const stepped = await selectionSettled(page, before.selected);
  const pty = await markerSince(page, file, offset, arm);
  return { arm, holder, expected: expectedHolder(engine, press), focus, before, after, stepped, pty };
}

/// The browser's state once its selection differs from `from`, or after the
/// wait.
async function selectionSettled(page, from, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  let state = await browserState(page);
  while (JSON.stringify(state.selected) === JSON.stringify(from) && Date.now() < deadline) {
    await sleep(50);
    state = await browserState(page);
  }
  return state;
}

/// The keyboard holder a press leaves in the terminal: the host after a left
/// press on ghostty, the textarea after a right one (the case the blur has to
/// reach) and always on xterm.js.
function expectedHolder(engine, press) {
  return engine === "ghostty" && press === "left" ? "terminal" : "terminal-textarea";
}

function checkMove(result, failures) {
  const { arm, holder, expected, focus, before, after, stepped, pty } = result;
  if (holder !== expected) failures.push(`${arm}: the press left the keyboard on ${holder}, not ${expected}`);
  if (!after.focusedPane) failures.push(`${arm}: the browser's pane did not take the focus border`);
  if (!focus.startsWith("browser-")) failures.push(`${arm}: the keyboard went to ${focus}, not the browser`);
  if (JSON.stringify(after.selected) !== JSON.stringify(before.selected)) failures.push(`${arm}: the move changed the selection ${JSON.stringify(before.selected)} to ${JSON.stringify(after.selected)}`);
  if (after.scroll !== before.scroll) failures.push(`${arm}: the move scrolled the list from ${before.scroll} to ${after.scroll}`);
  const index = (names) => (names.length === 1 ? Number(names[0].slice(1, 3)) : NaN);
  if (index(stepped.selected) !== index(before.selected) + 1) failures.push(`${arm}: ArrowDown moved the selection ${JSON.stringify(before.selected)} to ${JSON.stringify(stepped.selected)}`);
  if (JSON.stringify(pty) !== JSON.stringify([TYPED])) failures.push(`${arm}: the PTY did not read only the marker`);
}

async function stayArm(page, file, engine, press) {
  const arm = `${engine}-${press}-hybrid-stay`;
  const holder = await pressTerminal(page, press, expectedHolder(engine, press));
  const offset = statSync(file).size;
  const committed = await hybridNav(page, []);
  const focus = await focusSettled(page, (held) => held.startsWith("terminal"));
  await page.keyboard.type("x");
  const pty = await ptySince(arm, file, offset);
  return { arm, holder, expected: expectedHolder(engine, press), committed, focus, pty };
}

/// A press on the browser's own chrome, at a point whose element has no
/// focusable ancestor inside the browser.
async function browserChromePoint(page, engine) {
  await pressTerminal(page, "left");
  const point = await page.evaluate(() => {
    const browser = document.querySelector(".pane .browser");
    const r = browser.getBoundingClientRect();
    for (let y = r.top + 2; y < r.bottom; y += 6) {
      for (let x = r.left + 2; x < r.right; x += 12) {
        const el = document.elementFromPoint(x, y);
        if (!el || !browser.contains(el)) continue;
        if (el.closest("button, input, textarea, select, a[href], [tabindex], [role='option']")) continue;
        return { x, y };
      }
    }
    return null;
  });
  if (!point) throw new Error(`${engine}-chrome: no point on the browser's chrome without a focusable ancestor`);
  return point;
}

async function actionSequence(page, file, engine, report) {
  const control = { arm: `${engine}-recorder-control`, offset: statSync(file).size };
  control.focus = await pressTerminal(page, "left");
  await page.keyboard.type("x");
  control.pty = await recordedSince(control.arm, file, control.offset, TYPED);
  report.arms.push(control);
  if (!control.focus.startsWith("terminal") || JSON.stringify(control.pty) !== JSON.stringify([TYPED])) {
    throw new Error("recorder control failed");
  }
  for (const press of ["left", "right"]) {
    for (const move of Object.keys(MOVES)) {
      const result = await moveArm(page, file, engine, press, move);
      report.arms.push(result);
      checkMove(result, report.sequenceFailures);
    }
    const stay = await stayArm(page, file, engine, press);
    report.arms.push(stay);
    if (stay.holder !== stay.expected || !stay.committed || !stay.focus.startsWith("terminal") || JSON.stringify(stay.pty) !== JSON.stringify([TYPED])) {
      report.sequenceFailures.push(`${stay.arm}: keyboard/commit/recorder disagreement`);
    }
  }
}

// Read only surface kinds. Never retain the authenticated URL, file paths,
// terminal identifiers, command text, or arbitrary exception messages.
function installReader() {
  function hashFocus() {
    try {
      const raw = new URLSearchParams(location.hash.slice(1)).get("s");
      const leaf = (node) => !node ? null : node.k === "s" ? leaf(node.a) ?? leaf(node.b) : node.f === 1 ? node : null;
      const focused = leaf(raw ? JSON.parse(raw) : null);
      const tabs = focused ? (focused.sb ? focused.bt : focused.t) ?? [] : [];
      const active = tabs.find((tab) => tab.a === 1) ?? tabs[0];
      return active?.k === "b" ? "browser" : active?.k === "t" ? "terminal" : "other";
    } catch { return "invalid"; }
  }
  function state() {
    const visible = (element) => {
      const r = element.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility === "visible";
    };
    const pane = document.querySelector(".pane.focused");
    const browser = [...(pane?.querySelectorAll(".browser") ?? [])].some(visible);
    const terminal = [...(pane?.querySelectorAll(".terminal-host") ?? [])].some(visible);
    const active = document.activeElement;
    const keyboard = active?.closest(".browser") ? "browser"
      : active?.closest(".terminal-host") ? (active.tagName === "TEXTAREA" ? "terminal-textarea" : "terminal") : "other";
    return { at: performance.now(), document: performance.timeOrigin, hashFocus: hashFocus(),
      focused: browser ? "browser" : terminal ? "terminal" : "other", keyboard,
      panes: document.querySelectorAll(".pane").length };
  }
  window.__reloadfocusCheck = { state, incoming: { document: performance.timeOrigin, hashFocus: hashFocus() } };
}

function safeError(error) {
  const names = ["Error", "TypeError", "RangeError", "SyntaxError", "AssertionError", "TimeoutError", "AbortError", "SecurityError", "ProtocolError", "TargetCloseError"];
  return { name: names.includes(error?.name) ? error.name : "Error" };
}

async function cleanSession(ctx, windowId) {
  const url = new URL("/api/session", ctx.serverUrl);
  url.search = "";
  url.searchParams.set("w", windowId);
  const token = new URL(ctx.serverUrl).searchParams.get("t");
  const response = await fetch(url, {
    method: "DELETE", headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("session cleanup failed");
  url.pathname = "/api/terminals/roster";
  url.search = "";
  const until = Date.now() + 10_000;
  do {
    const roster = await fetch(url, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
    if (!roster.ok) throw new Error("terminal cleanup roster read failed");
    const { sessions = [] } = await roster.json();
    if (!sessions.some((session) => session.window_id === windowId)) return;
    await sleep(200);
  } while (Date.now() < until);
  throw new Error("terminal cleanup left sessions behind");
}

async function reloadAtFocusClick(ctx, page, engine, delay, report) {
  const point = await browserChromePoint(page, engine);
  report.before = await page.evaluate(() => window.__reloadfocusCheck.state());
  assert.equal(report.before.focused, "terminal", "terminal pane setup did not hold focus");
  assert.ok(report.before.keyboard.startsWith("terminal"), "terminal setup did not hold keyboard");
  assert.equal(report.before.hashFocus, "terminal", "terminal setup hash was not settled");
  const key = `chan.smoke.reloadfocus.${RUN}.${engine}.${delay}`;
  await page.evaluate(({ key, delay }) => {
    const read = window.__reloadfocusCheck.state;
    const trace = { pointer: null, click: null, outgoing: null, unload: null };
    const save = () => sessionStorage.setItem(key, JSON.stringify(trace));
    const pressed = (event) => {
      if (!event.isTrusted || !event.target.closest?.(".browser")) return;
      removeEventListener("pointerdown", pressed, true);
      trace.pointer = { at: performance.now(), trusted: true };
    };
    const clicked = (event) => {
      if (!event.isTrusted || !event.target.closest?.(".browser")) return;
      removeEventListener("click", clicked, true);
      trace.click = { at: performance.now(), trusted: true };
      // A new task lets the focus event's microtasks finish. Only DOM/keyboard
      // focus may delay the reload; hash and session state never gate it.
      const afterFocus = () => {
        const current = read();
        if ((current.focused !== "browser" || current.keyboard !== "browser") && current.at - trace.click.at < 3_000) {
          requestAnimationFrame(afterFocus);
          return;
        }
        trace.outgoing = current;
        save();
        location.reload();
      };
      setTimeout(afterFocus, delay);
    };
    addEventListener("pointerdown", pressed, true);
    addEventListener("click", clicked, true);
    addEventListener("beforeunload", () => { trace.unload = read(); save(); }, { once: true });
  }, { key, delay });
  const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 });
  navigation.catch(() => {});
  await page.mouse.click(point.x, point.y);
  await navigation;
  report.step = "new-document";
  // A hash replacement can satisfy navigation before the delayed reload.
  // Readback belongs to the new document, not that same-document event.
  await page.waitForFunction((previous) =>
    performance.timeOrigin !== previous && document.readyState === "complete",
  { timeout: 30_000 }, report.before.document);
  report.step = "readback";
  await page.waitForSelector(`${TERMINAL} ${ENGINE[engine]}`, { visible: true, timeout: 30_000 });
  await page.waitForSelector(".pane .browser", { visible: true, timeout: 15_000 });
  await page.waitForFunction((selector) => document.querySelectorAll(selector).length > 0, { timeout: 15_000 }, FILE_ROW);
  report.incoming = await page.evaluate(() => window.__reloadfocusCheck.incoming);
  report.after = await page.evaluate(() => window.__reloadfocusCheck.state());
  await sleep(1_500);
  report.settled = await page.evaluate(() => window.__reloadfocusCheck.state());
  report.trace = await page.evaluate((key) => {
    const trace = JSON.parse(sessionStorage.getItem(key));
    sessionStorage.removeItem(key);
    return trace;
  }, key);
  report.screenshot = basename(await ctx.shot(`reloadfocus-${engine}-${report.mode}`, page));
  const trace = report.trace;
  assert.ok(trace?.pointer?.trusted && trace?.click?.trusted, "trusted focus click was not recorded");
  assert.equal(trace.outgoing?.focused, "browser", "focus click did not focus the browser");
  assert.equal(trace.outgoing?.keyboard, "browser", "focus click did not give the browser the keyboard");
  report.reloadDelayMs = trace.outgoing.at - trace.pointer.at;
  assert.ok(report.reloadDelayMs >= 0 && Number.isFinite(report.reloadDelayMs), "reload timing missing");
  if (delay === 0) assert.ok(report.reloadDelayMs < 150, "immediate reload missed the pre-debounce window");
  else assert.ok(trace.outgoing.at - trace.click.at >= 350, "settled control reloaded before 350 ms");
  assert.notEqual(report.incoming.document, report.before.document, "reload did not create a new document");
  assert.equal(report.settled.panes, 2, "reloaded pane layout did not restore");
  report.observed = true;
  for (const [label, state] of [["outgoing", trace.outgoing], ["incoming", report.incoming], ["restored", report.settled]]) {
    if (state.hashFocus !== "browser") report.failures.push(`${label} hash names ${state.hashFocus}`);
  }
  if (report.settled.focused !== "browser" || report.settled.keyboard !== "browser") {
    report.failures.push(`restored focus/keyboard ${report.settled.focused}/${report.settled.keyboard}`);
  }
}

async function trial(ctx, directory, engine, mode) {
  const windowId = `reloadfocus-262-${engine}-${mode}-${RUN}`;
  const report = { engine, mode, step: "setup", arms: [], sequenceFailures: [], failures: [], cleanupFailures: [], pageErrors: [], observed: false };
  const page = await ctx.browser.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(safeError(error)));
  const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
  let originalPrefs = null;
  let originalStrip = null;
  const timeout = setTimeout(() => { report.timedOut = true; void page.close().catch(() => {}); }, 120_000);
  try {
    await page.evaluateOnNewDocument(installReader);
    await page.setViewport({ width: 1280, height: 900 });
    await page.bringToFront();
    const url = new URL(ctx.serverUrl);
    url.searchParams.set("w", windowId);
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector(".pane .editor-wrap", { timeout: 30_000 });
    originalPrefs = await readTerminalPrefs(page, token);
    originalStrip = await readPaneStripPreference(page, token);
    if (originalStrip.on) await writePaneStripPreference(page, token, false);
    await writeTerminalPrefs(page, token, { ghostty: engine === "ghostty" });
    await openTerminal(page, engine);
    const file = join(directory, `${engine}-${mode}.bytes`);
    await startRecorder(page, file);
    await dispatchCommand(page, "app.pane.splitDown");
    await page.waitForFunction(() => document.querySelectorAll(".pane").length === 2, { timeout: 10_000 });
    await navigateFiles(page, DIR);
    await page.waitForFunction((selector, count) => document.querySelectorAll(selector).length === count, { timeout: 15_000 }, FILE_ROW, FILES);
    await page.$eval(".pane .browser .tree-wrap", (wrap) => { wrap.scrollTop = 40; });
    const visible = [];
    for (const row of await page.$$(FILE_ROW)) if (await row.isIntersectingViewport()) visible.push(row);
    if (visible.length < 3) throw new Error("browser fixture has fewer than three visible rows");
    await visible[2].click();
    await sleep(300);
    if (mode === "sequence") {
      report.step = "keyboard-sequence";
      await actionSequence(page, file, engine, report);
      assert.equal(report.sequenceFailures.length, 0, "keyboard action sequence failed");
    } else {
      await pressTerminal(page, "left");
      await sleep(350);
    }
    report.step = "reload";
    await reloadAtFocusClick(ctx, page, engine, mode === "control" ? 400 : 0, report);
  } catch (error) {
    report.error = { ...safeError(error), step: report.step };
  } finally {
    clearTimeout(timeout);
    try {
      if (!page.isClosed()) {
        const host = await centreOf(page, `${TERMINAL} .terminal-host`).catch(() => null);
        if (host) await page.mouse.click(host.x, host.y);
        await closeEveryTerminal(page, "reload focus cleanup", token);
      }
    } catch (error) { report.cleanupFailures.push({ step: "terminals", ...safeError(error) }); }
    const preferencesPage = page.isClosed() ? ctx.page : page;
    try { if (originalPrefs) await writeTerminalPrefs(preferencesPage, token, { ghostty: originalPrefs.ghostty }); }
    catch (error) { report.cleanupFailures.push({ step: "terminal-preference", ...safeError(error) }); }
    try { if (originalStrip?.on) await writePaneStripPreference(preferencesPage, token, true); }
    catch (error) { report.cleanupFailures.push({ step: "strip-preference", ...safeError(error) }); }
    await page.close().catch(() => {});
    try { await cleanSession(ctx, windowId); }
    catch (error) { report.cleanupFailures.push({ step: "session", ...safeError(error) }); }
    if (report.pageErrors.length) report.failures.push(`application page errors: ${report.pageErrors.length}`);
    report.arms = report.arms.map(({ pty, ...arm }) => ({
      ...arm, ptyMarkerOnly: JSON.stringify(pty) === JSON.stringify([TYPED]), ptyBytes: pty?.length ?? 0,
    }));
    writeFileSync(join(ctx.outDir, `262-${engine}-${mode}.json`), JSON.stringify(report, null, 2) + "\n");
  }
  return report;
}

export default {
  name: "reloadfocus",
  async run(ctx) {
    const directory = mkdtempSync(join(tmpdir(), "chan-reloadfocus-262-"));
    const folder = seedFolder(ctx);
    const reports = [];
    try {
      for (const engine of ["xterm", "ghostty"]) {
        for (const mode of ["control", "sequence"]) {
          const report = await trial(ctx, directory, engine, mode);
          reports.push(report);
          if (report.cleanupFailures.length) throw new Error("reload focus cleanup failed; later trials refused");
        }
      }
      const incomplete = reports.filter((report) => !report.observed || report.error || report.sequenceFailures.length);
      assert.equal(incomplete.length, 0, "reload focus incomplete: inspect 262 artifacts for timing/setup failures");
      const failures = reports.filter((report) => report.failures.length);
      assert.equal(failures.length, 0, "reload focus contract failed: " + failures.map((report) => `${report.engine}/${report.mode}`).join(", "));
      return { results: reports };
    } catch (error) {
      error.smokeDetails = { results: reports };
      throw error;
    } finally {
      writeFileSync(join(ctx.outDir, "262-reloadfocus.json"), JSON.stringify({ results: reports }, null, 2) + "\n");
      rmSync(directory, { recursive: true });
      rmSync(folder, { recursive: true });
    }
  },
};
