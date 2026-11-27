// A link in a survey's body follows the editor's model and never navigates
// the app. Pane A's terminal carries the survey while pane B's terminal is
// focused, as in check 348, and raw PTY recorders establish that no key
// reached a terminal. The page's `window.open` is stubbed, as in check 316,
// and records what the app's external opener would have opened. A
// bubble-phase listener on the window reads each click and middle click on
// a body link after the app's own listeners, and holds a default the app
// left alone only so that a red run stays on the page. One survey per leg:
//
// - click: a click on the body's https link is cancelled, the page's URL is
//   unchanged, and the drop-down shows under the link with its one row,
//   OPEN and the URL, and the URL's copy button; nothing opens and the
//   survey is unanswered.
// - styles: with no editor in the page, the drop-down wears the editor's
//   look from the app's stylesheet (a 6px radius, a 240px minimum width, a
//   shadow) and its copy button the copy button's (a 1px border, a 3px
//   radius).
// - enter: Enter with the drop-down open opens the URL once and closes the
//   drop-down; the survey stays up, unanswered.
// - row: a press on the drop-down's row does the same.
// - mod-click: Ctrl with a click opens the URL once, with no drop-down.
// - middle: a middle-button click is cancelled, opens nothing and shows
//   nothing.
// - escape: Escape closes the drop-down and answers nothing; a second
//   Escape dismisses the survey.
// - tab-enter: with pane A focused by a press beside the card, Tab from the
//   card reaches the link, and Enter makes the engine's click, which is
//   cancelled and shows the drop-down; a second Enter opens the URL once.
// - tab-mod-enter: Tab to the link and Ctrl+Enter make the engine's
//   modified click, which is cancelled and opens the URL once with no
//   drop-down.
// - path: a click on a link to a seeded note shows its OPEN row with the
//   path as written and no copy button; Enter opens the note as pane A's
//   active tab while pane B keeps its terminal, the survey stays pending,
//   and selecting A's terminal tab again shows it.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const LINK_URL = "https://example.com/notes/354";
const NOTE_DIR = "survey354-notes";
const NOTE = `${NOTE_DIR}/a354.md`;
const NOTE_TEXT = "NOTE354 opened from a survey body";
const URL_BODY = `Pane B keeps the keyboard; read [the notes](${LINK_URL}) first.`;
const PATH_BODY = `Pane B keeps the keyboard; read [the note](${NOTE}) first.`;
const OPENED = [[LINK_URL, "_blank", "noopener,noreferrer"]];
const LEG_BODY = { path: PATH_BODY };
const LEG_COUNT = 10;

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
      keyboard: active?.matches?.(".survey-body [href]") ? "link"
        : card?.contains(active) ? "survey"
          : away?.querySelector(".terminal-host")?.contains(active) ? "away"
            : target?.querySelector(".terminal-host")?.contains(active) ? "target"
              : `${active?.tagName ?? "none"}.${active?.className?.toString?.() ?? ""}`,
      surveyOpen: Boolean(card),
      targetTabActive: Boolean(target?.classList.contains("active")),
      awayTabActive: Boolean(away?.classList.contains("active")),
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

/// The stubbed opener and the window's bubble-phase readers. Installed once
/// per page; each leg takes what they recorded since the last take.
async function installProbes(page) {
  await page.evaluate(() => {
    const probe = { clicks: [], auxclicks: [], opened: [] };
    window.__survey354 = probe;
    window.open = (url, target, features) => {
      probe.opened.push([String(url), String(target ?? ""), String(features ?? "")]);
      return null;
    };
    const record = (list) => (event) => {
      const link = event.target instanceof Element ? event.target.closest(".survey-body [href]") : null;
      if (!link) return;
      list.push({ prevented: event.defaultPrevented, ctrl: event.ctrlKey, meta: event.metaKey, button: event.button });
      if (!event.defaultPrevented) event.preventDefault();
    };
    window.addEventListener("click", record(probe.clicks));
    window.addEventListener("auxclick", record(probe.auxclicks));
  });
}

async function takeProbe(page) {
  return page.evaluate(() => {
    const probe = window.__survey354;
    return { clicks: probe.clicks.splice(0), auxclicks: probe.auxclicks.splice(0), opened: probe.opened.splice(0) };
  });
}

/// The drop-downs showing: each one's rows as text (the OPEN tag and the
/// target as written), its copy button, whether it sits under `linkQuery`'s
/// link, and the styles only the app's stylesheet gives it.
async function dropDowns(page, linkQuery) {
  return page.evaluate((query) => {
    const linkBox = document.querySelector(query)?.getBoundingClientRect() ?? null;
    return [...document.querySelectorAll(".md-bubble")].map((wrap) => {
      const box = wrap.getBoundingClientRect();
      const style = getComputedStyle(wrap);
      const copy = wrap.querySelector(".copy-btn");
      const copyStyle = copy ? getComputedStyle(copy) : null;
      return {
        rows: [...wrap.querySelectorAll(".md-bubble-row")]
          .map((row) => [...row.querySelectorAll(":scope > span")].map((span) => span.textContent)),
        copy: Boolean(copy),
        underLink: Boolean(linkBox && box.top >= linkBox.bottom - 1),
        style: { borderRadius: style.borderRadius, minWidth: style.minWidth, boxShadow: style.boxShadow },
        copyStyle: copyStyle ? { borderTopWidth: copyStyle.borderTopWidth, borderRadius: copyStyle.borderTopLeftRadius } : null,
      };
    });
  }, linkQuery);
}

/// Where the page is: its origin and path (the app keeps its layout in the
/// hash and drops the token from the query, so neither is compared), and
/// whether the document is still the one the probes were installed in.
async function pageWhere(page) {
  return page.evaluate(() => ({ at: location.origin + location.pathname, probed: Boolean(window.__survey354) }))
    .catch((error) => ({ at: null, probed: false, error: String(error) }));
}

async function runSurvey(ctx, directory, save) {
  const run = {
    setup: "pending", setupErrors: [], pageErrors: [], cleanupErrors: [], legs: [],
  };
  save(run);
  const page = await ctx.browser.newPage();
  page.on("pageerror", (error) => run.pageErrors.push(describeError(error)));
  const suffix = Date.now().toString(36);
  const names = { target: `Survey354A-${suffix}`, away: `Survey354B-${suffix}` };
  const files = { target: join(directory, "a.bytes"), away: join(directory, "b.bytes") };
  const url = new URL(ctx.serverUrl);
  const token = url.searchParams.get("t") ?? "";
  const windowId = `surveylinks-354-${suffix}`;
  url.searchParams.set("w", windowId);
  const env = { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId };
  const cs = (args, options = {}) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
    cwd: ctx.workspaceDir, env, timeout: 75_000, ...options,
  });
  let originalStrip = null;
  let target;
  let away;
  let start = null;
  const requested = [];
  const surveys = [];
  const read = () => state(page, target.tab, away.tab);
  const linkQuery = () => `${terminalSelector(target.tab)} .survey-body a[href]`;

  async function raiseSurvey(label, body = URL_BODY) {
    await ctx.waitWindowLive(windowId);
    const handle = { result: null, promise: null };
    handle.promise = cs([
      "survey", "--tab-name", names.target, "--timeout", "60",
      "--title", `Body links: ${label}`, "--option", "Alpha", "--option", "Beta",
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
  async function unsolicitedReply(handle, ms = 1_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !handle.result) await sleep(50);
    return handle.result;
  }

  /// The drop-downs once one shows, or none after the wait.
  async function waitDropDowns(timeout = 3_000) {
    return until("a drop-down shows", async () => {
      const shown = await dropDowns(page, linkQuery());
      return shown.length ? shown : null;
    }, timeout).catch(() => dropDowns(page, linkQuery()));
  }

  /// No drop-down, read after a pause in which one would have shown.
  async function noDropDown(result, label) {
    await sleep(300);
    await settle(page);
    const shown = await dropDowns(page, linkQuery());
    if (shown.length) result.failures.push(`${label} shows a drop-down: ${JSON.stringify(shown.map((d) => d.rows))}`);
  }

  function expectRow(result, shown, written, copy) {
    if (!same(shown.map((d) => d.rows), [[["OPEN", written]]])) {
      result.failures.push(`the drop-downs read ${JSON.stringify(shown.map((d) => d.rows))}, expected one with the row OPEN ${written}`);
      return;
    }
    if (shown[0].copy !== copy) result.failures.push(`the drop-down ${copy ? "lacks" : "carries"} a copy button`);
    if (!shown[0].underLink) result.failures.push("the drop-down is not under the link");
  }

  function expectClicks(result, clicks, label, mods = {}) {
    const want = [{ prevented: true, ctrl: Boolean(mods.ctrl), meta: false, button: 0 }];
    if (!same(clicks, want)) result.failures.push(`${label}: the window read clicks ${JSON.stringify(clicks)}, expected ${JSON.stringify(want)}`);
  }

  async function expectPageStays(result, label) {
    result.where = await pageWhere(page);
    if (result.where.at !== start.at || !result.where.probed) {
      result.failures.push(`${label} took the page away from the app: ${maskTokens(JSON.stringify(result.where))}`);
    }
  }

  async function expectSurveyUp(result, handle, label) {
    result.unsolicitedReply = await unsolicitedReply(handle);
    if (result.unsolicitedReply) result.failures.push(`${label} answered the survey: ${JSON.stringify(result.unsolicitedReply)}`);
    const now = await read();
    if (!now.surveyOpen) result.failures.push(`${label} closed the survey`);
  }

  /// A plain click on the body link, through the page's hit-testing, and the
  /// drop-down it shows.
  async function clickLink(result) {
    await page.click(linkQuery());
    await settle(page);
    result.shown = await waitDropDowns();
    result.clickProbe = await takeProbe(page);
    expectClicks(result, result.clickProbe.clicks, "the click");
    if (result.clickProbe.opened.length) result.failures.push(`the click opened ${JSON.stringify(result.clickProbe.opened)}`);
    return result.shown;
  }

  /// The opener's record once it has one, or none after the wait.
  async function waitOpened(timeout = 3_000) {
    const probe = { clicks: [], auxclicks: [], opened: [] };
    await until("the opener is called", async () => {
      const taken = await takeProbe(page);
      for (const key of Object.keys(probe)) probe[key].push(...taken[key]);
      return probe.opened.length ? probe : null;
    }, timeout).catch(() => null);
    await sleep(200);
    const late = await takeProbe(page);
    for (const key of Object.keys(probe)) probe[key].push(...late[key]);
    return probe;
  }

  /// Pane A focused by a press on its overlay beside the card, the keyboard
  /// on the card, then Tab onto the body link.
  async function tabToLink(result) {
    const point = await page.evaluate((query) => {
      const box = document.querySelector(query)?.getBoundingClientRect();
      return box ? { x: box.left + 4, y: box.top + 4 } : null;
    }, `${terminalSelector(target.tab)} .survey-overlay`);
    if (!point) throw new Error("precondition: A's survey overlay is absent");
    await page.mouse.click(point.x, point.y);
    result.onCard = await until("the press beside the card gives A's survey the keyboard", async () => {
      const current = await read();
      return current.focusedPane === current.targetPane && current.keyboard === "survey" ? current : null;
    });
    await page.keyboard.press("Tab");
    await settle(page);
    result.onLink = await read();
    if (result.onLink.keyboard !== "link") throw new Error(`precondition: Tab from the card reached ${result.onLink.keyboard}, not the body link`);
  }

  const legs = {
    async click(result, handle, offsets) {
      const shown = await clickLink(result);
      expectRow(result, shown, LINK_URL, true);
      await expectPageStays(result, "the click");
      await expectSurveyUp(result, handle, "the click");
      expectNoBytes(result, "the click", bytes(files.target, offsets.target), bytes(files.away, offsets.away));
      result.screenshot = basename(await ctx.shot("354-click", page));
    },

    async styles(result) {
      result.editors = await page.evaluate(() => document.querySelectorAll(".cm-editor").length);
      if (result.editors !== 0) throw new Error(`precondition: the page holds ${result.editors} editors`);
      const shown = await clickLink(result);
      expectRow(result, shown, LINK_URL, true);
      result.style = shown[0]?.style ?? null;
      result.copyStyle = shown[0]?.copyStyle ?? null;
      if (result.style?.borderRadius !== "6px") result.failures.push(`the drop-down's radius reads ${result.style?.borderRadius}, expected 6px`);
      if (result.style?.minWidth !== "240px") result.failures.push(`the drop-down's minimum width reads ${result.style?.minWidth}, expected 240px`);
      if (!result.style?.boxShadow || result.style.boxShadow === "none") result.failures.push(`the drop-down has no shadow: ${result.style?.boxShadow}`);
      if (result.copyStyle?.borderTopWidth !== "1px") result.failures.push(`the copy button's border reads ${result.copyStyle?.borderTopWidth}, expected 1px`);
      if (result.copyStyle?.borderRadius !== "3px") result.failures.push(`the copy button's radius reads ${result.copyStyle?.borderRadius}, expected 3px`);
      result.screenshot = basename(await ctx.shot("354-styles", page));
    },

    async enter(result, handle, offsets) {
      const shown = await clickLink(result);
      expectRow(result, shown, LINK_URL, true);
      await page.keyboard.press("Enter");
      result.probe = await waitOpened();
      if (!same(result.probe.opened, OPENED)) result.failures.push(`Enter opened ${JSON.stringify(result.probe.opened)}, expected ${JSON.stringify(OPENED)}`);
      await noDropDown(result, "after Enter the page");
      await expectPageStays(result, "Enter");
      await expectSurveyUp(result, handle, "Enter");
      expectNoBytes(result, "Enter", bytes(files.target, offsets.target), bytes(files.away, offsets.away));
    },

    async row(result, handle) {
      const shown = await clickLink(result);
      expectRow(result, shown, LINK_URL, true);
      await page.click(".md-bubble .md-bubble-row > span:nth-of-type(2)");
      result.probe = await waitOpened();
      if (!same(result.probe.opened, OPENED)) result.failures.push(`the press on the row opened ${JSON.stringify(result.probe.opened)}, expected ${JSON.stringify(OPENED)}`);
      await noDropDown(result, "after the press on the row the page");
      await expectPageStays(result, "the press on the row");
      await expectSurveyUp(result, handle, "the press on the row");
    },

    async "mod-click"(result, handle) {
      await page.keyboard.down("Control");
      try {
        await page.click(linkQuery());
      } finally {
        await page.keyboard.up("Control");
      }
      result.probe = await waitOpened();
      expectClicks(result, result.probe.clicks, "Ctrl with a click", { ctrl: true });
      if (!same(result.probe.opened, OPENED)) result.failures.push(`Ctrl with a click opened ${JSON.stringify(result.probe.opened)}, expected ${JSON.stringify(OPENED)}`);
      await noDropDown(result, "Ctrl with a click");
      await expectPageStays(result, "Ctrl with a click");
      await expectSurveyUp(result, handle, "Ctrl with a click");
    },

    async middle(result, handle) {
      const created = [];
      const onTarget = (t) => created.push(t.url());
      ctx.browser.on("targetcreated", onTarget);
      try {
        await page.click(linkQuery(), { button: "middle" });
        await sleep(500);
        await settle(page);
      } finally {
        ctx.browser.off("targetcreated", onTarget);
      }
      result.probe = await takeProbe(page);
      result.created = created.map(maskTokens);
      const want = [{ prevented: true, ctrl: false, meta: false, button: 1 }];
      if (!same(result.probe.auxclicks, want)) result.failures.push(`the window read middle clicks ${JSON.stringify(result.probe.auxclicks)}, expected ${JSON.stringify(want)}`);
      if (result.probe.clicks.length) result.failures.push(`the middle button made clicks ${JSON.stringify(result.probe.clicks)}`);
      if (result.probe.opened.length) result.failures.push(`the middle button opened ${JSON.stringify(result.probe.opened)}`);
      if (result.created.length) result.failures.push(`the middle button opened tabs ${JSON.stringify(result.created)}`);
      await noDropDown(result, "the middle button");
      await expectPageStays(result, "the middle button");
      await expectSurveyUp(result, handle, "the middle button");
    },

    async escape(result, handle) {
      const shown = await clickLink(result);
      expectRow(result, shown, LINK_URL, true);
      await page.keyboard.press("Escape");
      await noDropDown(result, "after the first Escape the page");
      await expectSurveyUp(result, handle, "the first Escape");
      await page.keyboard.press("Escape");
      result.reply = await until("the second Escape dismisses the survey", () => handle.result).catch(() => null);
      if (!result.reply) result.failures.push("the second Escape sent no reply");
      result.afterSecond = await read();
      if (result.afterSecond.surveyOpen) result.failures.push("the second Escape left the survey up");
      result.probe = await takeProbe(page);
      if (result.probe.opened.length) result.failures.push(`Escape opened ${JSON.stringify(result.probe.opened)}`);
    },

    async "tab-enter"(result, handle, offsets) {
      await tabToLink(result);
      await page.keyboard.press("Enter");
      await settle(page);
      result.shown = await waitDropDowns();
      result.enterProbe = await takeProbe(page);
      expectClicks(result, result.enterProbe.clicks, "Enter on the focused link");
      if (result.enterProbe.opened.length) result.failures.push(`Enter on the focused link opened ${JSON.stringify(result.enterProbe.opened)}`);
      expectRow(result, result.shown, LINK_URL, true);
      await page.keyboard.press("Enter");
      result.probe = await waitOpened();
      if (!same(result.probe.opened, OPENED)) result.failures.push(`the second Enter opened ${JSON.stringify(result.probe.opened)}, expected ${JSON.stringify(OPENED)}`);
      await noDropDown(result, "after the second Enter the page");
      await expectPageStays(result, "Enter on the focused link");
      await expectSurveyUp(result, handle, "Enter on the focused link");
      expectNoBytes(result, "Enter on the focused link", bytes(files.target, offsets.target), bytes(files.away, offsets.away));
    },

    async "tab-mod-enter"(result, handle, offsets) {
      await tabToLink(result);
      await chord(page, ["Control"], "Enter");
      result.probe = await waitOpened();
      expectClicks(result, result.probe.clicks, "Ctrl+Enter on the focused link", { ctrl: true });
      if (!same(result.probe.opened, OPENED)) result.failures.push(`Ctrl+Enter on the focused link opened ${JSON.stringify(result.probe.opened)}, expected ${JSON.stringify(OPENED)}`);
      await noDropDown(result, "Ctrl+Enter on the focused link");
      await expectPageStays(result, "Ctrl+Enter on the focused link");
      await expectSurveyUp(result, handle, "Ctrl+Enter on the focused link");
      expectNoBytes(result, "Ctrl+Enter on the focused link", bytes(files.target, offsets.target), bytes(files.away, offsets.away));
    },

    async path(result, handle) {
      const shown = await clickLink(result);
      expectRow(result, shown, NOTE, false);
      await page.keyboard.press("Enter");
      result.note = await until("the note opens as pane A's active tab", () => page.evaluate(({ pane, text }) => {
        const root = document.querySelector(`.pane[data-pane-id="${pane}"]`);
        const editor = [...(root?.querySelectorAll(".cm-content") ?? [])]
          .find((el) => el.textContent?.includes(text) && el.getBoundingClientRect().width > 0);
        return editor ? { inTargetPane: true } : null;
      }, { pane: result.appeared.targetPane, text: NOTE_TEXT }), 15_000).catch(() => null);
      if (!result.note) result.failures.push("Enter opened no tab on the note in pane A");
      result.afterOpen = await read();
      if (result.afterOpen.targetTabActive) result.failures.push("pane A still shows the survey's terminal tab");
      if (!result.afterOpen.awayTabActive) result.failures.push("pane B no longer shows its terminal");
      if (result.afterOpen.surveyOpen) result.failures.push("the survey still shows over the note");
      result.probe = await takeProbe(page);
      if (result.probe.opened.length) result.failures.push(`the path opened a browser tab: ${JSON.stringify(result.probe.opened)}`);
      await noDropDown(result, "after Enter on the path the page");
      await expectPageStays(result, "Enter on the path");
      result.unsolicitedReply = await unsolicitedReply(handle);
      if (result.unsolicitedReply) result.failures.push(`opening the note answered the survey: ${JSON.stringify(result.unsolicitedReply)}`);
      result.screenshot = basename(await ctx.shot("354-path", page));
      await clickTab(page, names.target);
      result.back = await until("selecting A's terminal tab shows the survey again", async () => {
        const current = await read();
        return current.surveyOpen ? current : null;
      }).catch(async () => ({ ...(await read()), timedOut: true }));
      if (result.back.timedOut) result.failures.push("selecting A's terminal tab again does not show the survey");
    },
  };

  function expectNoBytes(result, label, targetBytes, awayBytes) {
    if (targetBytes.length || awayBytes.length) {
      result.failures.push(`${label} leaked into a PTY: A=${JSON.stringify(targetBytes)}, B=${JSON.stringify(awayBytes)}`);
    }
  }

  async function runLeg(kind) {
    const result = { kind, observed: false, failures: [], interactionErrors: [], cleanupErrors: [] };
    run.legs.push(result);
    let handle;
    try {
      await clickTerminal(page, away.tab);
      await takeProbe(page);
      result.before = await read();
      const offsets = { target: bytes(files.target).length, away: bytes(files.away).length };
      handle = await raiseSurvey(kind, LEG_BODY[kind]);
      result.appeared = await read();
      if (!result.appeared.surveyOpen) result.failures.push("appearance: survey absent");
      if (result.appeared.focusedPane !== result.appeared.awayPane) result.failures.push("appearance: pane B lost its focus border");
      await legs[kind](result, handle, offsets);
      result.observed = true;
    } catch (error) {
      result.interactionErrors.push(describeError(error));
      result.screenshot = basename(await ctx.shot(`354-${kind}-failure`, page).catch(() => "unavailable"));
    } finally {
      try {
        // A red run can leave the page elsewhere; the next leg needs the app.
        const where = start ? await pageWhere(page) : null;
        if (where && (where.at !== start.at || !where.probed)) {
          await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
          await page.waitForSelector(".pane", { timeout: 30_000 });
          await installProbes(page);
          result.cleanupErrors.push("the page had left the app and was loaded again");
        }
        if (handle && !handle.result && !(await read()).surveyOpen) await clickTab(page, names.target).catch(() => {});
        const dismiss = await page.$(`${terminalSelector(target.tab)} .survey-dismiss`);
        if (dismiss) await dismiss.click();
        if (handle && !handle.result) await until(`${kind} cleanup reply`, () => handle.result);
        if (handle) result.finalReply = handle.result;
        await page.waitForSelector(`${terminalSelector(target.tab)} .survey-card`, { hidden: true, timeout: 10_000 });
        await page.waitForSelector(".md-bubble", { hidden: true, timeout: 5_000 });
      } catch (error) {
        result.cleanupErrors.push(describeError(error));
      }
      save();
    }
  }

  try {
    const notes = join(ctx.workspaceDir, NOTE_DIR);
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(ctx.workspaceDir, NOTE), `# A354\n\n${NOTE_TEXT}\n`);
    await page.setViewport({ width: 1280, height: 900 });
    await page.bringToFront();
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".pane", { timeout: 30_000 });
    await ctx.waitWindowLive(windowId);
    await installProbes(page);
    start = await pageWhere(page);
    // The path leg selects A's terminal tab by its label, so the strip must
    // paint.
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
    await ctx.shot("354-setup-failure", page).catch(() => {});
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
    try { rmSync(join(ctx.workspaceDir, NOTE_DIR), { recursive: true, force: true }); }
    catch (error) { run.cleanupErrors.push(`remove notes: ${describeError(error)}`); }
    save();
  }
}

export default {
  name: "survey-body-links",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const report = { run: null, cleanupErrors: [] };
    const save = (run) => {
      if (run) report.run = run;
      writeFileSync(join(ctx.outDir, "354-survey-body-links.json"), JSON.stringify(report, null, 2) + "\n");
    };
    const directory = mkdtempSync(join(ctx.workspaceDir, ".surveylinks-354-"));
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
        ...run.legs.flatMap((leg) => [...leg.failures, ...leg.interactionErrors.map((error) => error.split("\n")[0]), ...leg.cleanupErrors.map((error) => `cleanup: ${error.split("\n")[0]}`)].map((reason) => `${leg.kind}: ${reason}`)),
      ] : [];
      throw Object.assign(new Error(`survey body links contract failed: ${reasons.join("; ") || "incomplete run or cleanup"}`), { smokeDetails: report });
    }
    return report;
  },
};
