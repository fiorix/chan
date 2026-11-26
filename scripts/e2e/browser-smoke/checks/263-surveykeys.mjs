// A real terminal survey covers one pane while another terminal keeps the
// keyboard. Raw PTY recorders establish where the keys went; separate surveys
// cover a deliberate keyboard answer after a pane switch and a pointer answer.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { dispatchCommand, readPaneStripPreference, writePaneStripPreference } from "../lib/pane-strip.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { recordedSince } from "../lib/pty-recorder.mjs";
import { maskTokens } from "../lib/token-mask.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const describeError = (error) => maskTokens(error?.stack ?? String(error));
const terminalSelector = (tab) => `.terminal-tab[data-terminal-tab-id="${tab}"]`;
const bytes = (file, offset = 0) => existsSync(file)
  ? [...readFileSync(file).subarray(offset)].map((byte) => byte.toString(16).padStart(2, "0"))
  : [];

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function until(label, predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await predicate();
    if (value) return value;
    await sleep(50);
  } while (Date.now() < deadline);
  throw new Error(`${label}: condition not reached within ${timeout} ms`);
}

async function state(page, targetTab, awayTab) {
  return page.evaluate(({ targetTab, awayTab }) => {
    const terminal = (tab) => document.querySelector(`.terminal-tab[data-terminal-tab-id="${tab}"]`);
    const target = terminal(targetTab);
    const away = terminal(awayTab);
    const card = target?.querySelector(".survey-card");
    const active = document.activeElement;
    return {
      targetPane: target?.closest(".pane")?.getAttribute("data-pane-id") ?? null,
      awayPane: away?.closest(".pane")?.getAttribute("data-pane-id") ?? null,
      focusedPane: document.querySelector(".pane.focused")?.getAttribute("data-pane-id") ?? null,
      keyboard: card?.contains(active) ? "survey"
        : away?.querySelector(".terminal-host")?.contains(active) ? "away"
          : target?.querySelector(".terminal-host")?.contains(active) ? "target"
            : `${active?.tagName ?? "none"}.${active?.className?.toString?.() ?? ""}`,
      surveyOpen: Boolean(card),
    };
  }, { targetTab, awayTab });
}

async function clickTerminal(page, tab) {
  await page.click(`${terminalSelector(tab)} .terminal-host`);
  await page.waitForFunction((selector) => {
    const terminal = document.querySelector(selector);
    const pane = terminal?.closest(".pane");
    // The focus border is drawn only when there is more than one pane.
    const focused = pane && (document.querySelectorAll(".pane").length === 1 || pane.classList.contains("focused"));
    return focused &&
      terminal.querySelector(".terminal-host")?.contains(document.activeElement);
  }, { timeout: 10_000 }, terminalSelector(tab));
}

// Selecting the already selected terminal still emits the real focus pulse.
async function clickTab(page, name) {
  for (const tab of await page.$$(".pane .tabs .tab-row > .tab")) {
    const label = await tab.$eval(".path", (path) => path.textContent?.trim() ?? "");
    if (label !== name) continue;
    await tab.click();
    await settle(page);
    return;
  }
  throw new Error(`terminal tab ${name} is absent`);
}

function expectBackground(result, reading, label) {
  if (!reading.surveyOpen) result.failures.push(`${label}: survey disappeared`);
  if (reading.focusedPane !== reading.awayPane) result.failures.push(`${label}: the other pane lost its focus border`);
  if (reading.keyboard !== "away") result.failures.push(`${label}: keyboard belongs to ${reading.keyboard}`);
}

async function runSurvey(ctx, directory, save) {
  const run = {
    setup: "pending", setupErrors: [], pageErrors: [], cleanupErrors: [], legs: [],
  };
  save(run);
  const page = await ctx.browser.newPage();
  page.on("pageerror", (error) => run.pageErrors.push(describeError(error)));
  const suffix = Date.now().toString(36);
  const names = { target: `Survey263Target-${suffix}`, away: `Survey263Away-${suffix}` };
  const files = { target: join(directory, "target.bytes"), away: join(directory, "away.bytes") };
  const url = new URL(ctx.serverUrl);
  const token = url.searchParams.get("t") ?? "";
  const windowId = `surveykeys-263-${suffix}`;
  url.searchParams.set("w", windowId);
  const env = { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId };
  const cs = (args, options = {}) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
    cwd: ctx.workspaceDir, env, timeout: 75_000, ...options,
  });
  let originalStrip = null;
  let target;
  let away;
  const requested = [];
  const surveys = [];

  async function raiseSurvey(label) {
    await ctx.waitWindowLive(windowId);
    const handle = { result: null, promise: null };
    handle.promise = cs([
      "survey", "--tab-name", names.target, "--timeout", "60",
      "--title", `Keyboard ownership: ${label}`, "--option", "Alpha", "--option", "Beta",
      "The other pane keeps its keyboard until this pane is selected.",
    ]).then(
      ({ stdout, stderr }) => (handle.result = { code: 0, stdout: maskTokens(stdout.trim()), stderr: maskTokens(stderr.trim()) }),
      (error) => (handle.result = { code: error.code ?? "unknown", stdout: maskTokens(error.stdout ?? ""), stderr: maskTokens(error.stderr ?? String(error)) }),
    );
    surveys.push(handle);
    await until(`survey ${label} appears`, async () => {
      if (handle.result) throw new Error(`survey exited before appearance: ${JSON.stringify(handle.result)}`);
      return Boolean(await page.$(`${terminalSelector(target.tab)} .survey-card`));
    });
    await settle(page);
    return handle;
  }

  async function finishSurvey(handle, label, reply) {
    const result = await until(`${label} reply`, () => handle.result);
    if (result.code !== 0 || result.stdout !== reply) {
      throw new Error(`${label}: expected ${JSON.stringify(reply)}, read ${JSON.stringify(result)}`);
    }
    await page.waitForSelector(`${terminalSelector(target.tab)} .survey-card`, { hidden: true, timeout: 10_000 });
    return result;
  }

  async function runLeg(kind) {
    const result = { kind, observed: false, failures: [], interactionErrors: [], cleanupErrors: [] };
    run.legs.push(result);
    let handle;
    try {
      await clickTerminal(page, away.tab);
      result.before = await state(page, target.tab, away.tab);
      const targetOffset = bytes(files.target).length;
      const awayOffset = bytes(files.away).length;
      handle = await raiseSurvey(kind);
      result.appeared = await state(page, target.tab, away.tab);
      expectBackground(result, result.appeared, "appearance");
      await clickTab(page, names.away);
      result.pulse = await state(page, target.tab, away.tab);
      expectBackground(result, result.pulse, "focus pulse in the other pane");

      if (kind === "background-key") {
        await page.keyboard.press("1");
        // Either delivery or an unintended reply is an observation. A lost
        // key remains an explicit failure once the bounded observation ends.
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && !handle.result && bytes(files.away, awayOffset).length === 0) await sleep(50);
        await settle(page);
        result.afterKey = await state(page, target.tab, away.tab);
        result.awayBytes = bytes(files.away, awayOffset);
        result.targetBytes = bytes(files.target, targetOffset);
        result.unsolicitedReply = handle.result;
        expectBackground(result, result.afterKey, "after typing 1");
        if (JSON.stringify(result.awayBytes) !== JSON.stringify(["31"])) result.failures.push(`the other PTY read ${JSON.stringify(result.awayBytes)}, expected ["31"]`);
        if (result.targetBytes.length) result.failures.push(`survey PTY took unintended bytes ${JSON.stringify(result.targetBytes)}`);
        if (handle.result) result.failures.push(`typing in the other pane answered the survey: ${JSON.stringify(handle.result)}`);
        result.screenshot = basename(await ctx.shot(`263-${kind}`, page));
        result.observed = true;
      } else {
        result.beforeAnswer = await state(page, target.tab, away.tab);
        result.screenshot = basename(await ctx.shot(`263-${kind}`, page));
        if (kind === "return-keyboard") {
          await clickTab(page, names.target);
          await until("return to the survey gives its card the keyboard", async () => {
            const current = await state(page, target.tab, away.tab);
            return current.focusedPane === current.targetPane && current.keyboard === "survey";
          });
          result.returned = await state(page, target.tab, away.tab);
          await page.keyboard.press("2");
        } else {
          await page.click(`${terminalSelector(target.tab)} .survey-options li:first-child .survey-option`);
        }
        result.reply = await finishSurvey(handle, kind, kind === "return-keyboard" ? "Beta" : "Alpha");
        result.targetBytes = bytes(files.target, targetOffset);
        result.awayBytes = bytes(files.away, awayOffset);
        if (result.targetBytes.length || result.awayBytes.length) result.failures.push(`answer leaked into a PTY: target=${JSON.stringify(result.targetBytes)}, away=${JSON.stringify(result.awayBytes)}`);
        await until("resolved survey returns the keyboard", async () => (await state(page, target.tab, away.tab)).keyboard === "target");
        result.afterAnswer = await state(page, target.tab, away.tab);
        await page.keyboard.press("z");
        result.restoredBytes = await recordedSince(`${kind} restored keyboard`, files.target, targetOffset, "7a");
        if (JSON.stringify(result.restoredBytes) !== JSON.stringify(["7a"])) result.failures.push(`restored target PTY read ${JSON.stringify(result.restoredBytes)}, expected ["7a"]`);
        result.observed = true;
      }
    } catch (error) {
      result.interactionErrors.push(describeError(error));
      result.screenshot = basename(await ctx.shot(`263-${kind}-failure`, page).catch(() => "unavailable"));
    } finally {
      try {
        const dismiss = await page.$(`${terminalSelector(target.tab)} .survey-dismiss`);
        if (dismiss) await dismiss.click();
        if (handle && !handle.result) await until(`${kind} cleanup reply`, () => handle.result);
        if (handle) result.finalReply = handle.result;
        await page.waitForSelector(`${terminalSelector(target.tab)} .survey-card`, { hidden: true, timeout: 10_000 });
      } catch (error) {
        result.cleanupErrors.push(describeError(error));
      }
      save();
    }
  }

  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.bringToFront();
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".pane", { timeout: 30_000 });
    await ctx.waitWindowLive(windowId);
    originalStrip = await readPaneStripPreference(page, token);
    if (originalStrip.on) await writePaneStripPreference(page, token, false);
    requested.push(names.target);
    target = await openAttachedTerminal(ctx, page, cs, windowId, names.target, [
      "--command", `stty raw -echo && exec dd bs=1 status=none of=${shellQuote(files.target)}`,
    ]);
    await until("target recorder starts", () => existsSync(files.target));
    await clickTerminal(page, target.tab);
    await page.keyboard.press("t");
    run.targetControl = await recordedSince("target control", files.target, 0, "74");
    if (JSON.stringify(run.targetControl) !== JSON.stringify(["74"])) throw new Error(`target control bytes ${JSON.stringify(run.targetControl)}`);
    await dispatchCommand(page, "app.pane.splitDown");
    await page.waitForFunction(() => document.querySelectorAll(".pane").length === 2, { timeout: 10_000 });
    requested.push(names.away);
    away = await openAttachedTerminal(ctx, page, cs, windowId, names.away, [
      "--command", `stty raw -echo && exec dd bs=1 status=none of=${shellQuote(files.away)}`,
    ]);
    await until("other recorder starts", () => existsSync(files.away));
    await clickTerminal(page, away.tab);
    await page.keyboard.press("a");
    run.awayControl = await recordedSince("other control", files.away, 0, "61");
    if (JSON.stringify(run.awayControl) !== JSON.stringify(["61"])) throw new Error(`other control bytes ${JSON.stringify(run.awayControl)}`);
    run.initial = await state(page, target.tab, away.tab);
    if (!run.initial.targetPane || !run.initial.awayPane || run.initial.targetPane === run.initial.awayPane) throw new Error(`terminals are not in two panes: ${JSON.stringify(run.initial)}`);
    run.setup = "observed";
    for (const kind of ["background-key", "return-keyboard", "pointer"]) await runLeg(kind);
  } catch (error) {
    run.setupErrors.push(describeError(error));
    run.setup = "incomplete";
    await ctx.shot("263-setup-failure", page).catch(() => {});
  } finally {
    for (const name of requested.reverse()) {
      try { await cs(["close", "--tab-name", name]); }
      catch (error) { run.cleanupErrors.push(`close ${name}: ${describeError(error)}`); }
    }
    for (const handle of surveys) {
      try { await until("survey process exits during cleanup", () => handle.result, 15_000); }
      catch (error) { run.cleanupErrors.push(describeError(error)); }
    }
    if (originalStrip?.on) {
      try { await writePaneStripPreference(page, token, true); }
      catch (error) { run.cleanupErrors.push(`restore pane strip: ${describeError(error)}`); }
    }
    run.finalBytes = { target: bytes(files.target), away: bytes(files.away) };
    try { await page.close(); }
    catch (error) { run.cleanupErrors.push(`close page: ${describeError(error)}`); }
    save();
  }
}

export default {
  name: "surveykeys",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const report = { run: null, cleanupErrors: [] };
    const save = (run) => {
      if (run) report.run = run;
      writeFileSync(join(ctx.outDir, "263-surveykeys.json"), JSON.stringify(report, null, 2) + "\n");
    };
    const directory = mkdtempSync(join(ctx.workspaceDir, ".surveykeys-263-"));
    try {
      await runSurvey(ctx, directory, save);
    } finally {
      try { rmSync(directory, { recursive: true, force: true }); }
      catch (error) { report.cleanupErrors.push(describeError(error)); }
      save();
    }
    const { run } = report;
    const failed = !run || run.setup !== "observed" || run.setupErrors.length || run.pageErrors.length || run.cleanupErrors.length || run.legs.length !== 3 ||
      run.legs.some((leg) => !leg.observed || leg.failures.length || leg.interactionErrors.length || leg.cleanupErrors.length);
    if (failed || report.cleanupErrors.length) {
      throw Object.assign(new Error(`survey keyboard contract failed: ${failed ? "incomplete or failed run" : "cleanup"}`), { smokeDetails: report });
    }
    return report;
  },
};
