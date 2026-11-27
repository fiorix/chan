// A press on a survey's overlay beside its card leaves the keyboard on the
// card. Pane A's terminal carries the survey, pane B's terminal is the
// other pane, and raw PTY recorders on both establish where the keys went.
// The point pressed is in A's terminal above the card, where the overlay
// that covers the terminal around the card is what the page hit-tests; the
// leg refuses a point that lands anywhere else. One survey per leg:
//
// - unfocused: B's terminal holds the keyboard when the survey shows; the
//   press makes A the focused pane and leaves the keyboard on the card, and
//   a 2 then answers A's survey with its second option and reaches neither
//   PTY.
// - focused: a click on the card's title first makes A the focused pane
//   with the keyboard on the card; the same press keeps it there, and a 2
//   answers the same way.
//
// Where the overlay leaves the press its default, Chrome blurs the card and
// the keyboard falls to <body>, where the 2 answers nothing: each leg then
// fails on "after the press beside the card the keyboard is on BODY." and on
// "the 2 left the survey unanswered".

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { dispatchCommand } from "../lib/pane-strip.mjs";
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const LEGS = ["unfocused", "focused"];

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

/// Where the keyboard is and which pane is focused, read in one pass.
async function state(page, targetTab, awayTab) {
  return page.evaluate(({ targetTab, awayTab }) => {
    const terminal = (tab) => document.querySelector(`.terminal-tab[data-terminal-tab-id="${tab}"]`);
    const target = terminal(targetTab);
    const away = terminal(awayTab);
    const card = target?.querySelector(".survey-card") ?? null;
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

/// A point in A's terminal above its survey's card, halfway between the top
/// of the overlay and the top of the card, with what the page hit-tests
/// there.
async function pointBesideCard(page, tab) {
  return page.evaluate((selector) => {
    const terminal = document.querySelector(selector);
    const overlay = terminal?.querySelector(".survey-overlay");
    const card = overlay?.querySelector(".survey-card");
    const host = terminal?.querySelector(".terminal-host");
    if (!overlay || !card || !host) return { x: null, y: null, hit: "no survey overlay, card or terminal host", onOverlay: false };
    const o = overlay.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    const x = Math.round(c.left + c.width / 2);
    const y = Math.round(o.top + (c.top - o.top) / 2);
    const element = document.elementFromPoint(x, y);
    return {
      x, y,
      hit: `${element?.tagName ?? "none"}.${element?.className?.toString?.() ?? ""}`,
      onOverlay: element === overlay,
      inTerminal: x >= h.left && x <= h.right && y >= h.top && y <= h.bottom,
    };
  }, terminalSelector(tab));
}

async function clickTerminal(page, tab) {
  await page.click(`${terminalSelector(tab)} .terminal-host`);
  await page.waitForFunction((selector) => {
    const terminal = document.querySelector(selector);
    const pane = terminal?.closest(".pane");
    const focused = pane && (document.querySelectorAll(".pane").length === 1 || pane.classList.contains("focused"));
    return focused &&
      terminal.querySelector(".terminal-host")?.contains(document.activeElement);
  }, { timeout: 10_000 }, terminalSelector(tab));
}

async function runSurvey(ctx, directory, save) {
  const run = {
    setup: "pending", setupErrors: [], pageErrors: [], cleanupErrors: [], legs: [],
  };
  save(run);
  const page = await ctx.browser.newPage();
  page.on("pageerror", (error) => run.pageErrors.push(describeError(error)));
  const suffix = Date.now().toString(36);
  const names = { target: `Survey351A-${suffix}`, away: `Survey351B-${suffix}` };
  const files = { target: join(directory, "a.bytes"), away: join(directory, "b.bytes") };
  const url = new URL(ctx.serverUrl);
  const windowId = `surveypress-351-${suffix}`;
  url.searchParams.set("w", windowId);
  const env = { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId };
  const cs = (args, options = {}) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
    cwd: ctx.workspaceDir, env, timeout: 75_000, ...options,
  });
  let target;
  let away;
  const requested = [];
  const surveys = [];
  const read = () => state(page, target.tab, away.tab);

  async function raiseSurvey(label) {
    await ctx.waitWindowLive(windowId);
    const handle = { result: null };
    cs([
      "survey", "--tab-name", names.target, "--timeout", "60",
      "--title", `Press beside: ${label}`, "--option", "Alpha", "--option", "Beta",
      "A press beside this card leaves the keyboard on it.",
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

  async function runLeg(kind) {
    const result = { kind, observed: false, failures: [], interactionErrors: [], cleanupErrors: [] };
    run.legs.push(result);
    let handle;
    try {
      await clickTerminal(page, away.tab);
      result.before = await read();
      handle = await raiseSurvey(kind);
      result.appeared = await read();
      if (result.appeared.focusedPane !== result.appeared.awayPane || result.appeared.keyboard !== "away") {
        throw new Error(`the survey's arrival over pane A left pane ${result.appeared.focusedPane} focused with the keyboard on ${result.appeared.keyboard}, expected B's terminal`);
      }
      if (kind === "focused") {
        await page.click(`${terminalSelector(target.tab)} .survey-title`);
        result.afterTitle = await until("a click on the card's title makes A the focused pane with the keyboard on the card", async () => {
          const current = await read();
          return current.focusedPane === current.targetPane && current.keyboard === "survey" ? current : null;
        });
      }
      const offsets = { target: bytes(files.target).length, away: bytes(files.away).length };
      result.point = await pointBesideCard(page, target.tab);
      if (!result.point.onOverlay || !result.point.inTerminal) {
        throw new Error(`the point beside the card lands on ${result.point.hit} (in A's terminal: ${result.point.inTerminal}), expected the survey's overlay over A's terminal`);
      }
      await page.mouse.click(result.point.x, result.point.y);
      await settle(page);
      await sleep(300);
      result.afterPress = await read();
      if (!result.afterPress.surveyOpen) result.failures.push("the press beside the card closed the survey");
      if (result.afterPress.focusedPane !== result.afterPress.targetPane) {
        result.failures.push(`after the press beside the card pane ${result.afterPress.focusedPane} is focused, expected pane A`);
      }
      if (result.afterPress.keyboard !== "survey") {
        result.failures.push(`after the press beside the card the keyboard is on ${result.afterPress.keyboard}, expected the survey card`);
      }
      await page.keyboard.press("2");
      result.reply = await until("the 2 answers the survey", () => handle.result, 5_000).catch(() => null);
      if (!result.reply) result.failures.push("the 2 left the survey unanswered");
      else if (result.reply.code !== 0 || result.reply.stdout !== "Beta") {
        result.failures.push(`the 2 answered ${JSON.stringify(result.reply)}, expected "Beta"`);
      }
      // A byte the key sent to a PTY lands well inside this wait.
      await sleep(500);
      result.targetBytes = bytes(files.target, offsets.target);
      result.awayBytes = bytes(files.away, offsets.away);
      if (result.targetBytes.length || result.awayBytes.length) {
        result.failures.push(`the 2 reached a PTY: A=${JSON.stringify(result.targetBytes)}, B=${JSON.stringify(result.awayBytes)}`);
      }
      result.screenshot = basename(await ctx.shot(`351-${kind}`, page));
      result.observed = true;
    } catch (error) {
      result.interactionErrors.push(describeError(error));
      result.screenshot = basename(await ctx.shot(`351-${kind}-failure`, page).catch(() => "unavailable"));
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
    requested.push(names.target);
    target = await openAttachedTerminal(ctx, page, cs, windowId, names.target, [
      "--command", `stty raw -echo && exec dd bs=1 status=none of=${shellQuote(files.target)}`,
    ]);
    await until("A's recorder starts", () => existsSync(files.target));
    await clickTerminal(page, target.tab);
    await page.keyboard.press("t");
    run.targetControl = await recordedSince("A control", files.target, 0, "74");
    if (!same(run.targetControl, ["74"])) throw new Error(`A control bytes ${JSON.stringify(run.targetControl)}`);
    await dispatchCommand(page, "app.pane.splitDown");
    await page.waitForFunction(() => document.querySelectorAll(".pane").length === 2, { timeout: 10_000 });
    requested.push(names.away);
    away = await openAttachedTerminal(ctx, page, cs, windowId, names.away, [
      "--command", `stty raw -echo && exec dd bs=1 status=none of=${shellQuote(files.away)}`,
    ]);
    await until("B's recorder starts", () => existsSync(files.away));
    await clickTerminal(page, away.tab);
    await page.keyboard.press("a");
    run.awayControl = await recordedSince("B control", files.away, 0, "61");
    if (!same(run.awayControl, ["61"])) throw new Error(`B control bytes ${JSON.stringify(run.awayControl)}`);
    run.initial = await read();
    if (!run.initial.targetPane || !run.initial.awayPane || run.initial.targetPane === run.initial.awayPane) {
      throw new Error(`terminals are not in two panes: ${JSON.stringify(run.initial)}`);
    }
    run.setup = "observed";
    for (const kind of LEGS) await runLeg(kind);
  } catch (error) {
    run.setupErrors.push(describeError(error));
    run.setup = "incomplete";
    await ctx.shot("351-setup-failure", page).catch(() => {});
  } finally {
    for (const name of requested.reverse()) {
      try { await cs(["close", "--tab-name", name]); }
      catch (error) { run.cleanupErrors.push(`close ${name}: ${describeError(error)}`); }
    }
    for (const handle of surveys) {
      try { await until("survey process exits during cleanup", () => handle.result, 15_000); }
      catch (error) { run.cleanupErrors.push(describeError(error)); }
    }
    run.finalBytes = { target: bytes(files.target), away: bytes(files.away) };
    try { await page.close(); }
    catch (error) { run.cleanupErrors.push(`close page: ${describeError(error)}`); }
    save();
  }
}

export default {
  name: "survey-overlay-press",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const report = { run: null, cleanupErrors: [] };
    const save = (run) => {
      if (run) report.run = run;
      writeFileSync(join(ctx.outDir, "351-survey-overlay-press.json"), JSON.stringify(report, null, 2) + "\n");
    };
    const directory = mkdtempSync(join(ctx.workspaceDir, ".surveypress-351-"));
    try {
      await runSurvey(ctx, directory, save);
    } finally {
      try { rmSync(directory, { recursive: true, force: true }); }
      catch (error) { report.cleanupErrors.push(describeError(error)); }
      save();
    }
    const { run } = report;
    const failed = !run || run.setup !== "observed" || run.setupErrors.length || run.pageErrors.length || run.cleanupErrors.length ||
      run.legs.length !== LEGS.length ||
      run.legs.some((leg) => !leg.observed || leg.failures.length || leg.interactionErrors.length || leg.cleanupErrors.length);
    if (failed || report.cleanupErrors.length) {
      const reasons = run ? [
        ...run.setupErrors.map((error) => `setup: ${error.split("\n")[0]}`),
        ...run.legs.flatMap((leg) => [...leg.failures, ...leg.interactionErrors.map((error) => error.split("\n")[0])].map((reason) => `${leg.kind}: ${reason}`)),
      ] : [];
      throw Object.assign(new Error(`survey overlay press contract failed: ${reasons.join("; ") || "incomplete run or cleanup"}`), { smokeDetails: report });
    }
    return report;
  },
};
