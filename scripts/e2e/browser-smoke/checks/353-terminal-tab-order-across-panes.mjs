// A Tab walk never lands in the terminal of a pane that is not the active
// one, and keys typed after the walk never reach that terminal's program.
// Pane A's terminal sits before pane B in the page, pane B is the active
// pane, and a raw PTY recorder behind each terminal establishes where typed
// keys went. Each walk starts on a tab label placed by script, since a press
// on a label hands the keyboard to its terminal, and records every element
// it lands on with that element's pane and the active pane. It ends back at
// its start, in a terminal, where Tab and Shift+Tab are the program's keys
// and a further step would write a byte rather than move the keyboard, or at
// a step limit. Then `zq` is typed and both recorders are read.
//
// Every leg starts by a press on B's terminal with no survey up, so it reads
// the same whatever leg ran before it. A survey leg's cleanup presses the
// card's dismiss in pane A, which makes A the active pane, so the next leg's
// start is itself a press on a terminal outside the active pane, as the
// control's press is: with both terminals attached and recording, one that
// leaves B inactive or the keyboard outside B's terminal fails the leg that
// makes it.
//
// The legs other than the control keep B the active pane. Each fails if a
// step lands in A's terminal, if the active pane moves, or if A's PTY reads
// a byte; a walk toward A's terminal must also pass its place, so that its
// pass is not a walk that never got there, and a Tab walk must end in B's
// terminal with `zq` on B's PTY, so that a walk that stalls is red.
//
// - forward: Tab from B's tab label. In this layout it meets B's terminal
//   before A's place, so it crosses nothing.
// - backward: Shift+Tab from B's tab label, across A's place.
// - forward-from-a: Tab from A's tab label, placed by script with B still
//   the active pane, across A's place and on to B's terminal.
// - survey-forward, survey-backward, survey-forward-from-a: the same three
//   walks with a survey up over A's terminal.
// - control: A made the active pane by a press, Tab from A's tab label lands
//   in A's terminal and the typed keys reach A's PTY. Without it a pass could
//   not tell a terminal that is out of the Tab order from a walk that never
//   lands in any terminal in this engine. The press is on A's terminal with
//   B active and both terminals attached and recording, so a press that
//   leaves pane A inactive or the keyboard outside A's terminal fails it.
//
// A setup the check could not make (no control socket, a terminal that did
// not attach or record, a survey that did not appear, a start the script
// focus could not place) is an environment result, never a pass.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { chord } from "../lib/keyboard-owners.mjs";
import { dispatchCommand, readPaneStripPreference, writePaneStripPreference } from "../lib/pane-strip.mjs";
import { recordedSince } from "../lib/pty-recorder.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { maskTokens } from "../lib/token-mask.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const describeError = (error) => maskTokens(error?.stack ?? String(error));
const firstLine = (error) => describeError(error).split("\n")[0];
const terminalSelector = (tab) => `.terminal-tab[data-terminal-tab-id="${tab}"]`;
const labelSelector = (pane) => `.pane[data-pane-id="${pane}"] .tabs [role="tab"]`;
const bytes = (file, offset = 0) => existsSync(file)
  ? [...readFileSync(file).subarray(offset)].map((byte) => byte.toString(16).padStart(2, "0"))
  : [];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const WALK_LIMIT = 24;
/// How long typed keys get to reach a PTY that is not expected to read them.
const QUIET_MS = 1_500;
const TYPED = ["z", "q"];
const TYPED_BYTES = ["7a", "71"];
/// Each leg's walk starts on the tab label of pane `from`: "away" is B,
/// "target" is A.
const LEGS = [
  { kind: "forward", key: "Tab", survey: false, from: "away" },
  { kind: "backward", key: "Shift+Tab", survey: false, from: "away" },
  { kind: "survey-forward", key: "Tab", survey: true, from: "away" },
  { kind: "survey-backward", key: "Shift+Tab", survey: true, from: "away" },
  { kind: "forward-from-a", key: "Tab", survey: false, from: "target" },
  { kind: "survey-forward-from-a", key: "Tab", survey: true, from: "target" },
  { kind: "control", key: "Tab", survey: false, from: "target" },
];

/// The check could not make what it reads; the runner records an
/// environment result instead of a product red or a pass.
function environment(message) {
  return Object.assign(new Error(message), { smokeEnvironment: true });
}

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

/// Where the keyboard is, read in one pass against A's and B's terminals and
/// the walk's start: the element, its pane, the active pane, and where the
/// element lies against A's terminal host in document order.
async function where(page, targetTab, awayTab, start = null) {
  return page.evaluate(({ targetTab, awayTab, start }) => {
    const terminal = (tab) => document.querySelector(`.terminal-tab[data-terminal-tab-id="${tab}"]`);
    const target = terminal(targetTab);
    const away = terminal(awayTab);
    const targetHost = target?.querySelector(".terminal-host") ?? null;
    const awayHost = away?.querySelector(".terminal-host") ?? null;
    const active = document.activeElement;
    const onBody = !active || active === document.body;
    const name = onBody ? "" : (active.getAttribute("aria-label") || active.getAttribute("title") ||
      active.textContent?.trim() || "").slice(0, 32);
    const tabIndex = (element) => element?.getAttribute("tabindex") ?? null;
    let relation = "none";
    if (targetHost && !onBody) {
      relation = targetHost.contains(active) ? "inside"
        : targetHost.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_PRECEDING ? "before" : "after";
    }
    return {
      element: `${active?.tagName ?? "none"}.${active?.getAttribute?.("class") ?? ""}`,
      name,
      pane: onBody ? null : active.closest(".pane")?.getAttribute("data-pane-id") ?? null,
      focusedPane: document.querySelector(".pane.focused")?.getAttribute("data-pane-id") ?? null,
      targetPane: target?.closest(".pane")?.getAttribute("data-pane-id") ?? null,
      awayPane: away?.closest(".pane")?.getAttribute("data-pane-id") ?? null,
      inTargetHost: relation === "inside",
      inAwayHost: Boolean(awayHost && !onBody && awayHost.contains(active)),
      // A terminal is attached while its widget's input is in its host.
      targetAttached: Boolean(targetHost?.querySelector("textarea")),
      awayAttached: Boolean(awayHost?.querySelector("textarea")),
      inTargetTab: Boolean(target && !onBody && target.contains(active)),
      relation,
      atStart: Boolean(start) && !onBody && active === document.querySelector(start),
      surveyOpen: Boolean(target?.querySelector(".survey-card")),
      tabIndexes: {
        targetHost: tabIndex(targetHost),
        targetInput: tabIndex(targetHost?.querySelector("textarea")),
        awayHost: tabIndex(awayHost),
        awayInput: tabIndex(awayHost?.querySelector("textarea")),
      },
    };
  }, { targetTab, awayTab, start });
}

const PRESS_MS = 10_000;

/// Press a terminal's host: true once its pane is the active one and its
/// host holds the keyboard, false when that is not so within the wait. A
/// press that cannot be made throws.
async function pressTerminal(page, tab) {
  await page.click(`${terminalSelector(tab)} .terminal-host`);
  try {
    await page.waitForFunction((selector) => {
      const terminal = document.querySelector(selector);
      const pane = terminal?.closest(".pane");
      const focused = pane && (document.querySelectorAll(".pane").length === 1 || pane.classList.contains("focused"));
      return focused &&
        terminal.querySelector(".terminal-host")?.contains(document.activeElement);
    }, { timeout: PRESS_MS }, terminalSelector(tab));
    return true;
  } catch (error) {
    if (error?.name === "TimeoutError") return false;
    throw error;
  }
}

async function clickTerminal(page, tab) {
  if (!(await pressTerminal(page, tab))) {
    throw new Error(`a press on ${tab} did not make its pane active with the keyboard in its terminal within ${PRESS_MS} ms`);
  }
}

/// Script focus on the walk's start, as assistive technology can place it;
/// retried while the strip repaints after its preference write.
async function placeFocus(page, selector) {
  const deadline = Date.now() + 10_000;
  do {
    const focused = await page.evaluate((query) => {
      const element = document.querySelector(query);
      element?.focus();
      return Boolean(element) && document.activeElement === element;
    }, selector);
    if (focused) {
      await settle(page);
      return;
    }
    await sleep(100);
  } while (Date.now() < deadline);
  throw environment(`script focus did not land on ${selector} within 10000 ms`);
}

async function runTabOrder(ctx, directory, save) {
  const run = {
    setup: "pending", setupErrors: [], pageErrors: [], cleanupErrors: [], legs: [],
  };
  save(run);
  const page = await ctx.browser.newPage();
  page.on("pageerror", (error) => run.pageErrors.push(describeError(error)));
  const suffix = Date.now().toString(36);
  const names = { target: `TabOrder353A-${suffix}`, away: `TabOrder353B-${suffix}` };
  const files = { target: join(directory, "a.bytes"), away: join(directory, "b.bytes") };
  const url = new URL(ctx.serverUrl);
  const token = url.searchParams.get("t") ?? "";
  const windowId = `taborder-353-${suffix}`;
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
  const read = (start = null) => where(page, target.tab, away.tab, start);
  /// A pane id as the failure lines name it: pane A, pane B, or the id.
  const paneName = (id) => id === run.panes?.target ? "pane A" : id === run.panes?.away ? "pane B" : id ?? "no pane";
  /// A screenshot is evidence, not a reading: one that fails is named so.
  const shot = (name) => ctx.shot(name, page).then((file) => basename(file), () => "unavailable");

  /// Raise the survey over A's terminal; `slot` holds it from the moment it
  /// is asked for, so a leg whose card never shows still cleans it up.
  async function raiseSurvey(label, slot) {
    await ctx.waitWindowLive(windowId);
    const handle = { result: null, promise: null };
    handle.promise = cs([
      "survey", "--tab-name", names.target, "--timeout", "60",
      "--title", `Tab order: ${label}`, "--option", "Alpha", "--option", "Beta",
      "Pane B is the active pane; no Tab walk from it lands in this terminal.",
    ]).then(
      ({ stdout, stderr }) => (handle.result = { code: 0, stdout: maskTokens(stdout.trim()), stderr: maskTokens(stderr.trim()) }),
      (error) => (handle.result = { code: error.code ?? "unknown", stdout: maskTokens(error.stdout ?? ""), stderr: maskTokens(error.stderr ?? String(error)) }),
    );
    surveys.push(handle);
    slot.handle = handle;
    try {
      await until(`survey ${label} appears`, async () => {
        if (handle.result) throw new Error(`survey exited before appearance: ${JSON.stringify(handle.result)}`);
        return Boolean(await page.$(`${terminalSelector(target.tab)} .survey-card`));
      });
    } catch (error) {
      throw environment(`the survey over pane A did not appear: ${firstLine(error)}`);
    }
    await settle(page);
  }

  /// Walk from `pane`'s tab label with `key` while `activePane` is the
  /// active pane, recording every landing. The walk stops back at its
  /// start, in either terminal, or at the limit; a step that moves the
  /// active pane fails the leg and the walk goes on.
  async function walk(result, pane, activePane, key) {
    const start = labelSelector(pane);
    await placeFocus(page, start);
    result.start = await read(start);
    if (!result.start.atStart || result.start.focusedPane !== activePane) {
      throw environment(`the walk's start is not ${paneName(pane)}'s tab label with ${paneName(activePane)} active: ${JSON.stringify(result.start)}`);
    }
    result.phase = "walk";
    result.walk = [];
    result.ended = "limit";
    for (let step = 1; step <= WALK_LIMIT; step += 1) {
      if (key === "Shift+Tab") await chord(page, ["Shift"], "Tab");
      else await page.keyboard.press("Tab");
      await settle(page);
      const at = await read(start);
      result.walk.push({
        step, element: at.element, name: at.name, pane: at.pane, focusedPane: at.focusedPane,
        relation: at.relation, inTargetTab: at.inTargetTab,
      });
      if (at.inTargetHost) {
        result.ended = "A's terminal";
        break;
      }
      if (at.inAwayHost) {
        result.ended = "B's terminal";
        break;
      }
      if (at.atStart) {
        result.ended = "start";
        break;
      }
    }
    const moved = result.walk.filter((at) => at.focusedPane !== activePane);
    result.moved = moved.map((at) => `step ${at.step}: ${at.focusedPane}`);
    if (moved.length) {
      result.failures.push(`${key} from ${paneName(pane)}'s tab label moved the active pane at ${moved.map((at) => `step ${at.step}: ${paneName(at.focusedPane)}`).join(", ")}`);
    }
  }

  /// Type `zq` where the walk left the keyboard and read both recorders. A
  /// walk that ended in a terminal waits for its PTY first; then both wait
  /// out a quiet window, so a byte that reaches the other PTY late is read.
  async function typeAfterWalk(result, offsets) {
    for (const key of TYPED) await page.keyboard.press(key);
    const expected = { "A's terminal": ["target", files.target], "B's terminal": ["away", files.away] }[result.ended];
    if (expected) {
      const [side, file] = expected;
      await recordedSince(`"zq" in ${result.ended}`, file, offsets[side], "71")
        .catch((error) => (result.typedWait = firstLine(error)));
    }
    await sleep(QUIET_MS);
    result.targetBytes = bytes(files.target, offsets.target);
    result.awayBytes = bytes(files.away, offsets.away);
  }

  const walkLine = (result) => result.walk
    .map((at) => `${at.step}:${at.name || at.element}@${at.pane ?? "-"}/${at.relation}`).join(" > ");

  /// Both terminals attached and recording, as a press across panes needs.
  const ready = (at) => at.targetAttached && at.awayAttached && existsSync(files.target) && existsSync(files.away);

  /// A press on the terminal of pane `side` ("target" is A, "away" is B)
  /// with the other pane active and both terminals attached and recording:
  /// true once its pane is the active one with the keyboard in its
  /// terminal. A press that leaves its pane inactive or the keyboard
  /// outside its terminal is the leg's failure, and false is returned; a
  /// press that cannot be made is an environment result.
  async function pressAcross(result, side) {
    const [pane, other] = side === "target" ? ["A", "B"] : ["B", "A"];
    const took = await pressTerminal(page, side === "target" ? target.tab : away.tab).catch((error) => {
      throw environment(`the press on pane ${pane}'s terminal could not be made: ${firstLine(error)}`);
    });
    if (took) return true;
    result.afterPress = await read();
    const { focusedPane, inTargetHost, inAwayHost, name, element } = result.afterPress;
    const inside = side === "target" ? inTargetHost : inAwayHost;
    result.failures.push(`a press on pane ${pane}'s terminal with pane ${other} active left the active pane ${focusedPane} (pane ${pane} is ${run.panes[side]}) and the keyboard ${inside ? `in ${pane}'s terminal` : `on ${name || element}`} after ${PRESS_MS} ms`);
    result.screenshot = await shot(`353-${result.kind}-press`);
    return false;
  }

  /// Every leg starts from B the active pane, made by a press on B's
  /// terminal, with no survey over A's terminal, whatever the leg before it
  /// left: a survey leg's cleanup presses the card's dismiss in pane A, which
  /// makes A the active pane, and a cleanup that could not close its survey
  /// leaves the card up. With A active and both terminals attached and
  /// recording, the press is a press across panes, and one that fails is
  /// the leg's failure: false is returned and the leg goes no further. Any
  /// other start that cannot be made is an environment result.
  async function startOnB(result) {
    result.beforeStart = await read();
    if (result.beforeStart.focusedPane === run.panes.target && ready(result.beforeStart)) {
      if (!(await pressAcross(result, "away"))) return false;
    } else {
      await clickTerminal(page, away.tab).catch((error) => {
        throw environment(`a press did not give pane B's terminal the keyboard: ${firstLine(error)}`);
      });
    }
    const at = await read();
    if (at.surveyOpen) {
      throw environment(`a survey is up over pane A before the leg raised one: ${JSON.stringify(at)}`);
    }
    return true;
  }

  /// A walk from B's or A's tab label with B the active pane, with or
  /// without a survey over A's terminal, which `slot` holds for the leg's
  /// cleanup.
  async function hold(result, leg, slot) {
    if (!(await startOnB(result))) return;
    if (leg.survey) {
      await raiseSurvey(leg.kind, slot);
      result.appeared = await read();
      if (!result.appeared.surveyOpen || result.appeared.focusedPane !== result.appeared.awayPane) {
        throw environment(`the survey over pane A is not up with pane B active: ${JSON.stringify(result.appeared)}`);
      }
    }
    const offsets = { target: bytes(files.target).length, away: bytes(files.away).length };
    const from = `${leg.key} from pane ${leg.from === "target" ? "A" : "B"}'s tab label`;
    await walk(result, run.panes[leg.from], run.panes.away, leg.key);
    const landed = result.walk.filter((at) => at.relation === "inside");
    if (landed.length) {
      result.failures.push(`${from} landed in pane A's terminal at ${landed.map((at) => `step ${at.step} (${at.element})`).join(", ")}`);
    }
    // Where a step lies once a walk toward A's terminal has passed it:
    // before it for Shift+Tab from B, after it for Tab from A. Tab from B
    // walks away from it.
    const passed = leg.from === "target" ? "after" : leg.key === "Shift+Tab" ? "before" : null;
    result.passedTarget = passed !== null && result.walk.some((at) => at.relation === passed);
    if (!landed.length) {
      if (passed && !result.passedTarget) {
        result.failures.push(`${from} did not pass the place of pane A's terminal (ended: ${result.ended}): ${walkLine(result)}`);
      }
      if (leg.key === "Tab" && result.ended !== "B's terminal") {
        result.failures.push(`${from} did not end in pane B's terminal (ended: ${result.ended}): ${walkLine(result)}`);
      }
    }
    if (leg.survey) {
      result.afterWalk = await read();
      if (!result.afterWalk.surveyOpen) result.failures.push(`the survey over pane A was gone after the walk: ${JSON.stringify(slot.handle?.result)}`);
    }
    await typeAfterWalk(result, offsets);
    if (result.targetBytes.length) {
      result.failures.push(`pane A's PTY read ${JSON.stringify(result.targetBytes)} after the walk (ended: ${result.ended}) and the typed "zq"`);
    }
    if (leg.key === "Tab" && result.ended === "B's terminal" && !same(result.awayBytes, TYPED_BYTES)) {
      result.failures.push(`pane B's PTY read ${JSON.stringify(result.awayBytes)} after the walk and the typed "zq", expected ${JSON.stringify(TYPED_BYTES)}`);
    }
    result.screenshot = await shot(`353-${leg.kind}`);
  }

  /// A press on A's terminal with B the active pane makes A the active pane
  /// and gives A's terminal the keyboard; then Tab from A's tab label lands
  /// in A's terminal and the typed keys reach A's PTY.
  async function control(result) {
    if (!(await startOnB(result))) return;
    result.beforePress = await read();
    if (!ready(result.beforePress) || result.beforePress.focusedPane !== run.panes.away) {
      throw environment(`the press on pane A's terminal is not set up (both terminals attached and recording, pane B active): ${JSON.stringify(result.beforePress)}`);
    }
    if (!(await pressAcross(result, "target"))) return;
    const offsets = { target: bytes(files.target).length, away: bytes(files.away).length };
    await walk(result, run.panes.target, run.panes.target, "Tab");
    if (result.ended !== "A's terminal") {
      result.failures.push(`Tab from pane A's tab label, pane A active, did not land in pane A's terminal (ended: ${result.ended}): ${walkLine(result)}`);
    }
    await typeAfterWalk(result, offsets);
    if (!same(result.targetBytes, TYPED_BYTES)) {
      result.failures.push(`pane A's PTY read ${JSON.stringify(result.targetBytes)} after the typed "zq", expected ${JSON.stringify(TYPED_BYTES)}`);
    }
    if (result.awayBytes.length) result.failures.push(`pane B's PTY read ${JSON.stringify(result.awayBytes)}`);
    result.screenshot = await shot("353-control");
  }

  async function runLeg(leg) {
    const result = {
      kind: leg.kind, key: leg.key, survey: leg.survey, from: leg.from, phase: "setup", observed: false,
      failures: [], setupErrors: [], interactionErrors: [], cleanupErrors: [],
    };
    run.legs.push(result);
    const slot = { handle: null };
    try {
      if (leg.kind === "control") await control(result);
      else await hold(result, leg, slot);
      result.observed = true;
    } catch (error) {
      if (error?.smokeEnvironment || result.phase === "setup") result.setupErrors.push(describeError(error));
      else result.interactionErrors.push(describeError(error));
      result.screenshot = await shot(`353-${leg.kind}-failure`);
    } finally {
      try {
        const dismiss = await page.$(`${terminalSelector(target.tab)} .survey-dismiss`);
        if (dismiss) await dismiss.click();
        const open = slot.handle;
        if (open && !open.result) await until(`${leg.kind} cleanup reply`, () => open.result);
        if (open) result.surveyReply = open.result;
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
    // Every walk starts from a tab label, so each pane's strip must paint
    // with its one tab.
    originalStrip = await readPaneStripPreference(page, token);
    if (originalStrip.on) await writePaneStripPreference(page, token, false);
    requested.push(names.target);
    target = await openAttachedTerminal(ctx, page, cs, windowId, names.target, [
      "--command", `stty raw -echo && exec dd bs=1 status=none of=${shellQuote(files.target)}`,
    ]);
    await until("A's recorder starts", () => existsSync(files.target));
    await clickTerminal(page, target.tab);
    await page.keyboard.press("t");
    run.targetControl = await recordedSince("A control", files.target, 0, "74");
    if (!same(run.targetControl, ["74"])) throw new Error(`A control bytes ${JSON.stringify(run.targetControl)}`);
    // The split puts the new pane after A in the page, so a Shift+Tab walk
    // from B's strip passes A's terminal.
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
    const { targetPane, awayPane } = run.initial;
    if (!targetPane || !awayPane || targetPane === awayPane) throw new Error(`terminals are not in two panes: ${JSON.stringify(run.initial)}`);
    run.panes = { target: targetPane, away: awayPane };
    run.order = await page.evaluate(({ targetTab, awayLabel }) => {
      const host = document.querySelector(`.terminal-tab[data-terminal-tab-id="${targetTab}"] .terminal-host`);
      const label = document.querySelector(awayLabel);
      return Boolean(host && label && (host.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING));
    }, { targetTab: target.tab, awayLabel: labelSelector(awayPane) });
    if (!run.order) throw new Error("pane A's terminal does not precede pane B's tab label in the page");
    run.setup = "observed";
    for (const leg of LEGS) await runLeg(leg);
  } catch (error) {
    run.setupErrors.push(describeError(error));
    run.setup = "incomplete";
    await ctx.shot("353-setup-failure", page).catch(() => {});
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
  name: "terminal-tab-order-across-panes",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const report = { run: null, cleanupErrors: [] };
    const save = (run) => {
      if (run) report.run = run;
      writeFileSync(join(ctx.outDir, "353-terminal-tab-order-across-panes.json"), JSON.stringify(report, null, 2) + "\n");
    };
    const directory = mkdtempSync(join(ctx.workspaceDir, ".taborder-353-"));
    try {
      await runTabOrder(ctx, directory, save);
    } finally {
      try { rmSync(directory, { recursive: true, force: true }); }
      catch (error) { report.cleanupErrors.push(describeError(error)); }
      save();
    }
    const { run } = report;
    // A product red outranks an incomplete reading; an incomplete reading
    // with no red is an environment result, never a pass.
    const failures = [];
    const incomplete = [...report.cleanupErrors.map((error) => `cleanup: ${error.split("\n")[0]}`)];
    if (!run || run.setup !== "observed") {
      incomplete.push(...(run?.setupErrors ?? []).map((error) => `setup: ${error.split("\n")[0]}`));
      if (!run?.setupErrors.length) incomplete.push("setup incomplete");
    } else if (run.legs.length !== LEGS.length) {
      incomplete.push(`${run.legs.length} of ${LEGS.length} legs ran`);
    }
    for (const leg of run?.legs ?? []) {
      failures.push(...[...leg.failures, ...leg.interactionErrors.map((error) => error.split("\n")[0])].map((reason) => `${leg.kind}: ${reason}`));
      incomplete.push(...[...leg.setupErrors, ...leg.cleanupErrors].map((error) => `${leg.kind}: ${error.split("\n")[0]}`));
      if (!leg.observed && !leg.setupErrors.length && !leg.interactionErrors.length) incomplete.push(`${leg.kind}: not observed`);
    }
    failures.push(...(run?.pageErrors ?? []).map((error) => `page error: ${error.split("\n")[0]}`));
    incomplete.push(...(run?.cleanupErrors ?? []).map((error) => `cleanup: ${error.split("\n")[0]}`));
    if (failures.length) {
      throw Object.assign(new Error(`terminal Tab order across panes failed: ${failures.join("; ")}`), { smokeDetails: report });
    }
    if (incomplete.length) {
      throw Object.assign(new Error(`terminal Tab order across panes was not read: ${incomplete.join("; ")}`), { smokeEnvironment: true, smokeDetails: report });
    }
    return report;
  },
};
