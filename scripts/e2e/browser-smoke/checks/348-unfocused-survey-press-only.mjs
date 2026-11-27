// A survey over a terminal whose pane is not the focused one is answered by
// a press only. Pane A's terminal carries the survey while pane B's terminal
// is focused, and raw PTY recorders establish where the keys went. One
// survey per leg:
//
// - terminal: A's buttons are out of the Tab order while B is focused; a
//   Shift+Tab in B's terminal is B's own (backtab, ESC [ Z, on B's PTY) and
//   a 1 after it reaches B's PTY as byte 31; once A is focused its buttons
//   are back in the Tab order.
// - strip-walk: the survey's body renders a bare URL and a link; from B's
//   tab label, which keeps Tab's browser default, Shift+Tab walks back
//   through the page until it passes the place of A's card, and never lands
//   in it, its body's links included. A step that lands in the card fails
//   the leg and the walk goes on, so a red names every element it reached.
// - shape-walk: the survey's body is raw HTML with three shapes no markdown
//   makes: an SVG link written with xlink:href, a details with no summary
//   and a scroll container with no focusable child. The same walk passes the
//   card without landing in it. Then A is focused, and a Tab walk from its
//   card reaches all three, so the engine puts each in the Tab order and the
//   first walk's pass is the survey's hold.
// - card-key: focus placed on A's option by script, as assistive technology
//   can place it, and a 1 typed there answers nothing; selecting B's tab
//   takes the keyboard back to B's terminal, where a 1 reaches B's PTY.
// - link-press: the survey's body renders the same two links; a press on
//   the first, through the page's hit-testing, clicks that link, makes A
//   the focused pane, puts the link back in the Tab order and answers
//   nothing. The app cancels the click, read from a bubble-phase listener
//   on the window after the app's, so the page stays where it was, and
//   the click shows the link's drop-down with its OPEN row and the URL.
//   Nothing holds the default for the app: a run where the page leaves
//   loads the app again for the next leg.
// - pointer: a click on A's option answers it and makes A the focused pane.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { chord } from "../lib/keyboard-owners.mjs";
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const WALK_LIMIT = 16;
const BODY = "Pane B keeps the keyboard; this survey answers a press only.";
const LINKED_BODY = "Pane B keeps the keyboard; see https://example.com/pull/348 or [the notes](https://example.com/notes).";
/// Raw HTML the sanitizer keeps, with three shapes a browser puts in the Tab
/// order and no markdown makes, each named by its data-shape, in body order.
const SHAPES = ["svg-link", "details", "scroller"];
const SHAPES_BODY = [
  "Pane B keeps the keyboard; none of these shapes is in its Tab order.",
  'A chart <svg width="24" height="24"><a data-shape="svg-link" xlink:href="https://example.com/svg/348"><text y="16">s</text></a></svg>',
  '<details data-shape="details">no summary of its own</details>',
  '<div data-shape="scroller" style="overflow:auto;height:2em">one<br>two<br>three<br>four<br>five</div>',
].join("\n\n");
/// A leg's survey body where the default does not serve it.
const LEG_BODY = {
  "strip-walk": LINKED_BODY,
  "shape-walk": SHAPES_BODY,
  "link-press": LINKED_BODY,
};
const LEG_COUNT = 6;

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

/// Where the keyboard is and how A's survey card stands, read in one pass.
async function state(page, targetTab, awayTab) {
  return page.evaluate(({ targetTab, awayTab }) => {
    const terminal = (tab) => document.querySelector(`.terminal-tab[data-terminal-tab-id="${tab}"]`);
    const target = terminal(targetTab);
    const away = terminal(awayTab);
    const card = target?.querySelector(".survey-card") ?? null;
    const active = document.activeElement;
    const targetPane = target?.closest(".pane") ?? null;
    const awayPane = away?.closest(".pane") ?? null;
    return {
      targetPane: targetPane?.getAttribute("data-pane-id") ?? null,
      awayPane: awayPane?.getAttribute("data-pane-id") ?? null,
      focusedPane: document.querySelector(".pane.focused")?.getAttribute("data-pane-id") ?? null,
      keyboard: card?.contains(active) ? "survey"
        : away?.querySelector(".terminal-host")?.contains(active) ? "away"
          : target?.querySelector(".terminal-host")?.contains(active) ? "target"
            : `${active?.tagName ?? "none"}.${active?.className?.toString?.() ?? ""}`,
      element: `${active?.tagName ?? "none"}.${active?.className?.toString?.() ?? ""}`,
      inTargetPane: Boolean(targetPane?.contains(active)),
      inAwayPane: Boolean(awayPane?.contains(active)),
      // The walk has passed the card's place once the keyboard sits on an
      // element before it in document order.
      precedesCard: Boolean(card && active && active !== document.body &&
        (card.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_PRECEDING)),
      // The shape of the shapes body the keyboard is on, if any.
      shape: card?.contains(active) ? active.closest("[data-shape]")?.getAttribute("data-shape") ?? null : null,
      surveyOpen: Boolean(card),
      tabIndexes: card
        ? [...card.querySelectorAll(".survey-option, .survey-followup, .survey-dismiss")].map((button) => button.tabIndex)
        : [],
    };
  }, { targetTab, awayTab });
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
  if (reading.focusedPane !== reading.awayPane) result.failures.push(`${label}: pane B lost its focus border`);
  if (reading.keyboard !== "away") result.failures.push(`${label}: keyboard belongs to ${reading.keyboard}`);
}

function expectNoBytes(result, label, targetBytes, awayBytes) {
  if (targetBytes.length || awayBytes.length) {
    result.failures.push(`${label} leaked into a PTY: A=${JSON.stringify(targetBytes)}, B=${JSON.stringify(awayBytes)}`);
  }
}

async function runSurvey(ctx, directory, save) {
  const run = {
    setup: "pending", setupErrors: [], pageErrors: [], cleanupErrors: [], legs: [],
  };
  save(run);
  const page = await ctx.browser.newPage();
  page.on("pageerror", (error) => run.pageErrors.push(describeError(error)));
  const suffix = Date.now().toString(36);
  const names = { target: `Survey348A-${suffix}`, away: `Survey348B-${suffix}` };
  const files = { target: join(directory, "a.bytes"), away: join(directory, "b.bytes") };
  const url = new URL(ctx.serverUrl);
  const token = url.searchParams.get("t") ?? "";
  const windowId = `surveypress-348-${suffix}`;
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
  const read = () => state(page, target.tab, away.tab);

  async function raiseSurvey(label, body = BODY) {
    await ctx.waitWindowLive(windowId);
    const handle = { result: null, promise: null };
    handle.promise = cs([
      "survey", "--tab-name", names.target, "--timeout", "60",
      "--title", `Press only: ${label}`, "--option", "Alpha", "--option", "Beta",
      body,
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

  /// Wait out a window in which a reply would arrive, and report one that did.
  async function unsolicitedReply(handle, ms = 3_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !handle.result) await sleep(50);
    return handle.result;
  }

  /// The linked body's two links, rendered in A's survey card.
  async function expectBodyLinks(result) {
    result.bodyLinks = await page.evaluate((card) =>
      [...document.querySelectorAll(`${card} .survey-body a[href]`)].map((link) => link.textContent),
    `${terminalSelector(target.tab)} .survey-card`);
    if (!same(result.bodyLinks, ["https://example.com/pull/348", "the notes"])) {
      throw new Error(`precondition: the survey body renders its two links: ${JSON.stringify(result.bodyLinks)}`);
    }
  }

  /// The shapes body rendered in A's survey card as written: the SVG link
  /// by xlink:href alone, the details with no summary of its own, and the
  /// scroller overflowing its height with no element in it but line breaks.
  async function expectBodyShapes(result) {
    result.shapes = await page.evaluate((cardQuery) => {
      const body = document.querySelector(`${cardQuery} .survey-body`);
      const at = (shape) => body?.querySelector(`[data-shape="${shape}"]`) ?? null;
      const link = at("svg-link");
      const details = at("details");
      const scroller = at("scroller");
      const overflow = scroller ? getComputedStyle(scroller).overflowY : null;
      return {
        "svg-link": Boolean(link && link.namespaceURI === "http://www.w3.org/2000/svg" &&
          link.hasAttributeNS("http://www.w3.org/1999/xlink", "href") && !link.hasAttribute("href")),
        details: Boolean(details && !details.querySelector("summary")),
        scroller: Boolean(scroller && overflow === "auto" && scroller.scrollHeight > scroller.clientHeight &&
          !scroller.querySelector(":not(br)")),
        overflow,
        html: body?.innerHTML.slice(0, 800) ?? null,
      };
    }, `${terminalSelector(target.tab)} .survey-card`);
    const missing = SHAPES.filter((shape) => !result.shapes[shape]);
    if (missing.length) {
      throw new Error(`precondition: the survey body renders ${missing.join(", ")} as written: ${JSON.stringify(result.shapes)}`);
    }
  }

  async function focusByScript(selector) {
    const focused = await page.evaluate((query) => {
      const element = document.querySelector(query);
      element?.focus();
      return Boolean(element) && document.activeElement === element;
    }, selector);
    if (!focused) throw new Error(`precondition: script focus did not land on ${selector}`);
    await settle(page);
  }

  /// From B's tab label, Shift+Tab back through the page until the keyboard
  /// passes the place of A's card. A step that lands in the card is a
  /// failure, and the walk goes on past it to name every element it reaches.
  async function walkBackPastCard(result) {
    const label = `.pane[data-pane-id="${result.appeared.awayPane}"] .tabs [role="tab"]`;
    await focusByScript(label);
    result.start = await read();
    if (!result.start.inAwayPane || result.start.focusedPane !== result.start.awayPane) {
      throw new Error(`precondition: B's tab label holds the keyboard with B focused: ${JSON.stringify(result.start)}`);
    }
    result.walk = [];
    let passed = false;
    for (let step = 1; step <= WALK_LIMIT; step += 1) {
      await chord(page, ["Shift"], "Tab");
      await settle(page);
      const at = await read();
      result.walk.push({ step, element: at.element, shape: at.shape, inCard: at.keyboard === "survey", inTargetPane: at.inTargetPane, inAwayPane: at.inAwayPane, precedesCard: at.precedesCard, focusedPane: at.focusedPane });
      if (at.focusedPane !== at.awayPane) {
        result.failures.push(`Shift+Tab moved the focused pane to ${at.focusedPane} at step ${step} (${at.element})`);
        break;
      }
      if (at.precedesCard) {
        passed = true;
        break;
      }
    }
    result.landed = result.walk.filter((at) => at.inCard).map((at) => `step ${at.step}: ${at.shape ?? at.element}`);
    if (result.landed.length) {
      result.failures.push(`Shift+Tab from pane B's tab label reached pane A's survey card at ${result.landed.join(", ")}`);
    }
    result.passedCard = passed;
    if (!passed && !result.failures.length) result.failures.push(`the walk did not pass the place of A's card within ${WALK_LIMIT} steps: ${JSON.stringify(result.walk)}`);
  }

  const legs = {
    async terminal(result, handle, offsets) {
      result.tabIndexes = (await read()).tabIndexes;
      if (!same(result.tabIndexes, [-1, -1, -1, -1])) {
        result.failures.push(`pane A's survey buttons read tabIndex ${JSON.stringify(result.tabIndexes)} while pane B is focused; expected [-1,-1,-1,-1]`);
      }
      await chord(page, ["Shift"], "Tab");
      result.backtabBytes = await recordedSince("B's backtab", files.away, offsets.away, "5a");
      if (!same(result.backtabBytes, ["1b", "5b", "5a"])) result.failures.push(`B's PTY read ${JSON.stringify(result.backtabBytes)} for Shift+Tab, expected ["1b","5b","5a"]`);
      result.afterBacktab = await read();
      if (result.afterBacktab.keyboard !== "away") result.failures.push(`Shift+Tab in B's terminal moved the keyboard to ${result.afterBacktab.keyboard}`);
      await page.keyboard.press("1");
      result.awayBytes = await recordedSince("B's 1", files.away, offsets.away, "31");
      if (!same(result.awayBytes, ["1b", "5b", "5a", "31"])) result.failures.push(`B's PTY read ${JSON.stringify(result.awayBytes)}, expected ["1b","5b","5a","31"]`);
      result.unsolicitedReply = await unsolicitedReply(handle, 1_000);
      if (result.unsolicitedReply) result.failures.push(`typing in pane B answered the survey: ${JSON.stringify(result.unsolicitedReply)}`);
      result.targetBytes = bytes(files.target, offsets.target);
      if (result.targetBytes.length) result.failures.push(`A's PTY took ${JSON.stringify(result.targetBytes)}`);
      result.screenshot = basename(await ctx.shot("348-terminal", page));

      await clickTab(page, names.target);
      result.returned = await until("selecting A's tab gives its survey the keyboard", async () => {
        const current = await read();
        return current.focusedPane === current.targetPane && current.keyboard === "survey" ? current : null;
      });
      if (!same(result.returned.tabIndexes, [0, 0, 0, 0])) {
        result.failures.push(`pane A focused, its survey buttons read tabIndex ${JSON.stringify(result.returned.tabIndexes)}; expected [0,0,0,0]`);
      }
    },

    async "strip-walk"(result, handle, offsets) {
      await expectBodyLinks(result);
      await walkBackPastCard(result);
      result.screenshot = basename(await ctx.shot("348-strip-walk", page));
      result.unsolicitedReply = await unsolicitedReply(handle, 500);
      if (result.unsolicitedReply) result.failures.push(`the walk answered the survey: ${JSON.stringify(result.unsolicitedReply)}`);
      expectNoBytes(result, "the walk", bytes(files.target, offsets.target), bytes(files.away, offsets.away));
    },

    async "shape-walk"(result, handle, offsets) {
      await expectBodyShapes(result);
      await walkBackPastCard(result);
      result.screenshot = basename(await ctx.shot("348-shape-walk", page));

      // The control: with A focused its survey takes the keyboard on its
      // card, and Tab from the card reaches each shape in body order, then
      // leaves the shapes. A shape this engine leaves out of the Tab order
      // would pass the first walk with no hold at all.
      await clickTab(page, names.target);
      result.owned = await until("selecting A's tab gives its survey the keyboard", async () => {
        const current = await read();
        return current.focusedPane === current.targetPane && current.keyboard === "survey" ? current : null;
      });
      result.ownedWalk = [];
      for (let step = 1; step <= SHAPES.length + 1; step += 1) {
        await page.keyboard.press("Tab");
        await settle(page);
        const at = await read();
        result.ownedWalk.push({ step, element: at.element, shape: at.shape, inCard: at.keyboard === "survey", focusedPane: at.focusedPane });
        if (!at.shape) break;
      }
      result.reached = result.ownedWalk.map((at) => at.shape).filter(Boolean);
      if (!same(result.reached, SHAPES)) {
        result.failures.push(`control: with pane A focused, Tab from its card reached ${JSON.stringify(result.reached)}, expected ${JSON.stringify(SHAPES)}`);
      }
      result.unsolicitedReply = await unsolicitedReply(handle, 500);
      if (result.unsolicitedReply) result.failures.push(`the walks answered the survey: ${JSON.stringify(result.unsolicitedReply)}`);
      expectNoBytes(result, "the walks", bytes(files.target, offsets.target), bytes(files.away, offsets.away));
    },

    async "card-key"(result, handle, offsets) {
      await focusByScript(`${terminalSelector(target.tab)} .survey-options li:first-child .survey-option`);
      result.focused = await read();
      if (result.focused.keyboard !== "survey" || result.focused.focusedPane !== result.focused.awayPane) {
        throw new Error(`precondition: A's option holds the keyboard with B focused: ${JSON.stringify(result.focused)}`);
      }
      await page.keyboard.press("1");
      result.unsolicitedReply = await unsolicitedReply(handle);
      if (result.unsolicitedReply) result.failures.push(`a 1 at the unfocused pane's card answered its survey: ${JSON.stringify(result.unsolicitedReply)}`);
      result.afterKey = await read();
      if (result.afterKey.focusedPane !== result.afterKey.awayPane) result.failures.push(`the key moved the focused pane to ${result.afterKey.focusedPane}`);
      expectNoBytes(result, "the 1 at the card", bytes(files.target, offsets.target), bytes(files.away, offsets.away));
      result.screenshot = basename(await ctx.shot("348-card-key", page));

      await clickTab(page, names.away);
      result.afterPulse = await until("selecting B's tab gives B's terminal the keyboard", async () => {
        const current = await read();
        return current.keyboard === "away" ? current : null;
      }).catch(async () => ({ ...(await read()), timedOut: true }));
      if (result.afterPulse.timedOut) result.failures.push(`after the pulse the keyboard belongs to ${result.afterPulse.keyboard}, expected B's terminal`);
      await page.keyboard.press("1");
      result.awayBytes = await recordedSince("B's 1 after the pulse", files.away, offsets.away, "31");
      if (!same(result.awayBytes, ["31"])) result.failures.push(`B's PTY read ${JSON.stringify(result.awayBytes)}, expected ["31"]`);
      result.targetBytes = bytes(files.target, offsets.target);
      if (result.targetBytes.length) result.failures.push(`A's PTY took ${JSON.stringify(result.targetBytes)}`);
      if (!result.unsolicitedReply && handle.result) result.failures.push(`typing in pane B answered the survey: ${JSON.stringify(handle.result)}`);
    },

    async "link-press"(result, handle, offsets) {
      await expectBodyLinks(result);
      const link = `${terminalSelector(target.tab)} .survey-body a[href]`;
      // The app keeps its layout in the hash, so the page's place is its
      // origin and path, and the marker shows the document is the same one.
      const where = () => page.evaluate(() => ({
        at: location.origin + location.pathname,
        same: Boolean(window.__survey348LinkPress),
      })).catch((error) => ({ at: null, same: false, error: String(error) }));
      await page.evaluate((query) => {
        const clicks = [];
        const seen = (event) => {
          const at = event.target;
          clicks.push({
            link: at === document.querySelector(query),
            prevented: event.defaultPrevented,
            element: `${at?.tagName ?? "none"}.${at?.className?.toString?.() ?? ""}`,
          });
        };
        window.__survey348LinkPress = { clicks, seen };
        window.addEventListener("click", seen);
      }, link);
      const before = await where();
      await page.click(link);
      await settle(page);
      // A followed link leaves the page once its navigation commits.
      await sleep(1_000);
      result.where = await where();
      if (result.where.at !== before.at || !result.where.same) {
        result.failures.push(`the press on the body link took the page away from the app: ${maskTokens(JSON.stringify(result.where))}`);
        await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForSelector(".pane", { timeout: 30_000 });
        return;
      }
      result.clicks = await page.evaluate(() => {
        const { clicks, seen } = window.__survey348LinkPress;
        window.removeEventListener("click", seen);
        delete window.__survey348LinkPress;
        return clicks;
      });
      if (!same(result.clicks.map((click) => [click.link, click.prevented]), [[true, true]])) {
        result.failures.push(`the press on the body link clicked ${JSON.stringify(result.clicks)}, expected the link once with its click cancelled`);
      }
      result.dropDown = await page.evaluate(() => [...document.querySelectorAll(".md-bubble")].map((wrap) =>
        [...wrap.querySelectorAll(".md-bubble-row")].map((row) => [...row.querySelectorAll(":scope > span")].map((span) => span.textContent))));
      if (!same(result.dropDown, [[["OPEN", "https://example.com/pull/348"]]])) {
        result.failures.push(`the press on the body link shows the drop-downs ${JSON.stringify(result.dropDown)}, expected one with the row OPEN https://example.com/pull/348`);
      }
      result.afterPress = await until("the press on the body link makes A the focused pane", async () => {
        const current = await read();
        return current.focusedPane === current.targetPane ? current : null;
      }).catch(async () => ({ ...(await read()), timedOut: true }));
      if (result.afterPress.timedOut) result.failures.push(`the press on the body link left pane ${result.afterPress.focusedPane} focused, expected pane A`);
      if (!result.afterPress.surveyOpen) result.failures.push("the press on the body link closed the survey");
      if (!result.afterPress.inTargetPane) result.failures.push(`after the press on the body link the keyboard belongs to ${result.afterPress.keyboard}, outside pane A`);
      result.linkTabIndex = await page.$eval(link, (anchor) => anchor.tabIndex);
      if (result.linkTabIndex !== 0) result.failures.push(`pane A focused, the body link reads tabIndex ${result.linkTabIndex}; expected 0`);
      result.unsolicitedReply = await unsolicitedReply(handle, 1_000);
      if (result.unsolicitedReply) result.failures.push(`the press on the body link answered the survey: ${JSON.stringify(result.unsolicitedReply)}`);
      expectNoBytes(result, "the press on the body link", bytes(files.target, offsets.target), bytes(files.away, offsets.away));
      result.screenshot = basename(await ctx.shot("348-link-press", page));
    },

    async pointer(result, handle, offsets) {
      await page.click(`${terminalSelector(target.tab)} .survey-options li:first-child .survey-option`);
      result.reply = await until("pointer reply", () => handle.result);
      if (result.reply.code !== 0 || result.reply.stdout !== "Alpha") result.failures.push(`the click answered ${JSON.stringify(result.reply)}, expected "Alpha"`);
      await page.waitForSelector(`${terminalSelector(target.tab)} .survey-card`, { hidden: true, timeout: 10_000 });
      result.afterAnswer = await read();
      if (result.afterAnswer.focusedPane !== result.afterAnswer.targetPane) result.failures.push(`the click left pane ${result.afterAnswer.focusedPane} focused, expected pane A`);
      expectNoBytes(result, "the click", bytes(files.target, offsets.target), bytes(files.away, offsets.away));
      result.screenshot = basename(await ctx.shot("348-pointer", page));
    },
  };

  async function runLeg(kind) {
    const result = { kind, observed: false, failures: [], interactionErrors: [], cleanupErrors: [] };
    run.legs.push(result);
    let handle;
    try {
      await clickTerminal(page, away.tab);
      result.before = await read();
      const offsets = { target: bytes(files.target).length, away: bytes(files.away).length };
      handle = await raiseSurvey(kind, LEG_BODY[kind]);
      result.appeared = await read();
      expectBackground(result, result.appeared, "appearance");
      await legs[kind](result, handle, offsets);
      result.observed = true;
    } catch (error) {
      result.interactionErrors.push(describeError(error));
      result.screenshot = basename(await ctx.shot(`348-${kind}-failure`, page).catch(() => "unavailable"));
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
    // The strip walk starts from B's tab label, so the strip must paint.
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
    if (!run.initial.targetPane || !run.initial.awayPane || run.initial.targetPane === run.initial.awayPane) throw new Error(`terminals are not in two panes: ${JSON.stringify(run.initial)}`);
    run.setup = "observed";
    for (const kind of Object.keys(legs)) await runLeg(kind);
  } catch (error) {
    run.setupErrors.push(describeError(error));
    run.setup = "incomplete";
    await ctx.shot("348-setup-failure", page).catch(() => {});
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
  name: "unfocused-survey-press-only",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const report = { run: null, cleanupErrors: [] };
    const save = (run) => {
      if (run) report.run = run;
      writeFileSync(join(ctx.outDir, "348-unfocused-survey-press-only.json"), JSON.stringify(report, null, 2) + "\n");
    };
    const directory = mkdtempSync(join(ctx.workspaceDir, ".surveypress-348-"));
    try {
      await runSurvey(ctx, directory, save);
    } finally {
      try { rmSync(directory, { recursive: true, force: true }); }
      catch (error) { report.cleanupErrors.push(describeError(error)); }
      save();
    }
    const { run } = report;
    const failed = !run || run.setup !== "observed" || run.setupErrors.length || run.pageErrors.length || run.cleanupErrors.length || run.legs.length !== LEG_COUNT ||
      run.legs.some((leg) => !leg.observed || leg.failures.length || leg.interactionErrors.length || leg.cleanupErrors.length);
    if (failed || report.cleanupErrors.length) {
      const reasons = run ? [
        ...run.setupErrors.map((error) => `setup: ${error.split("\n")[0]}`),
        ...run.legs.flatMap((leg) => [...leg.failures, ...leg.interactionErrors.map((error) => error.split("\n")[0])].map((reason) => `${leg.kind}: ${reason}`)),
      ] : [];
      throw Object.assign(new Error(`unfocused survey press-only contract failed: ${reasons.join("; ") || "incomplete run or cleanup"}`), { smokeDetails: report });
    }
    return report;
  },
};
