// A survey that arrives while another owner holds the keyboard leaves the
// keyboard there. Owners take precedence by visual stacking, top first: the
// Computers launcher; a modal dialog or a window-wide survey; the top overlay
// (Search, Settings, the command deck); the survey over the focused pane's
// active Ghostty terminal. Two legs: with Search open and its input
// focused, a survey over the active terminal arrives and typed text still
// lands in Search; with a window-wide survey up, a survey over the active
// terminal arrives and `1` answers the window-wide one, read from each
// `cs terminal survey` call's output.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeEveryTerminal, dispatchCommand } from "../lib/pane-strip.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import {
  WINDOW_CARD, answerOpenSurveys, chord, keyboardAt, raiseSurvey, surveyOutcome, terminalCard, waitForCard,
} from "../lib/keyboard-owners.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SEARCH_INPUT = ".search .head input";

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  await sleep(300);
}

async function until(label, read, accept, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (accept(value)) return value;
    await sleep(50);
  } while (Date.now() < deadline);
  throw new Error(`${label}: last read ${JSON.stringify(value)}`);
}

export default {
  name: "survey-arrival-under-owner",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    const windowId = await page.evaluate(() => new URL(location.href).searchParams.get("w")?.trim()
      || sessionStorage.getItem("chan.session.window")?.trim() || "");
    assert.ok(windowId, "the check page has a window id");
    await ctx.waitWindowLive(windowId);
    const cs = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
      cwd: ctx.workspaceDir,
      env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
      timeout: 90_000,
    });
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const backend = "ghostty";
    const failures = [];
    const name = `Owner297-${backend}`;
    const result = { backend, legs: {}, cleanupErrors: [] };
    const calls = [];
    try {
      const row = await openAttachedTerminal(ctx, page, cs, windowId, name);
      const terminal = `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"]`;

      // Leg 1: Search holds the keyboard when the survey arrives.
      const search = { passed: false };
      result.legs.search = search;
      try {
        await page.click(`${terminal} .terminal-host`);
        await dispatchCommand(page, "app.search.toggle");
        await page.waitForSelector(SEARCH_INPUT, { visible: true, timeout: 15_000 });
        await page.click(SEARCH_INPUT);
        await chord(page, ["Control"], "KeyA");
        await page.keyboard.press("Backspace");
        search.before = await until("precondition: Search holds the keyboard", () => keyboardAt(page),
          (at) => at === "search");
        const survey = raiseSurvey(cs, ["--tab-name", name, "--timeout", "60",
          "--title", `Keyboard owners: 297-${backend} under Search`,
          "--option", "Alpha", "--option", "Beta",
          "A survey arrives over the active terminal while Search is open."]);
        calls.push(survey);
        await waitForCard(page, terminalCard(row.tab), survey, "the survey shows over the terminal", { visible: true });
        await settle(page);
        search.afterArrival = await keyboardAt(page);
        await ctx.shot(`297-${backend}-search-survey-arrived`);
        await page.keyboard.type("kq");
        await sleep(300);
        search.query = await page.$eval(SEARCH_INPUT, (input) => input.value);
        search.surveyOutcome = survey.result;
        await ctx.shot(`297-${backend}-search-typed`);
        assert.equal(search.query, "kq",
          `typed text lands in Search, not the arriving card: Search reads ${JSON.stringify(search.query)}; ` +
          `after the arrival the keyboard was at ${search.afterArrival}`);
        search.passed = true;
      } catch (error) {
        search.failure = String(error.message ?? error);
        failures.push(`${backend} under Search: ${search.failure}`);
      } finally {
        try {
          // Search closes with its query cleared before the next leg
          // clicks the terminal it covers.
          if (await page.$(SEARCH_INPUT)) {
            await page.$eval(SEARCH_INPUT, (input) => {
              input.value = "";
              input.dispatchEvent(new Event("input", { bubbles: true }));
            });
            await dispatchCommand(page, "app.search.toggle");
            await page.waitForSelector(SEARCH_INPUT, { hidden: true, timeout: 15_000 });
          }
          await answerOpenSurveys(page, calls);
        } catch (error) {
          result.cleanupErrors.push(`search leg: ${error.message}`);
        }
      }

      // Leg 2: a window-wide survey holds the keyboard when a survey
      // over the active terminal arrives.
      const wide = { passed: false };
      result.legs.windowWide = wide;
      try {
        await page.click(`${terminal} .terminal-host`);
        const windowSurvey = raiseSurvey(cs, ["--tab-group", "default", "--timeout", "60",
          "--title", `Keyboard owners: 297-${backend} window-wide`,
          "--option", "WideOne", "--option", "WideTwo",
          "A window-wide survey is up when a survey over the terminal arrives."]);
        calls.push(windowSurvey);
        await waitForCard(page, WINDOW_CARD, windowSurvey, "the window-wide survey shows", { visible: true });
        wide.before = await until("precondition: the window-wide survey holds the keyboard",
          () => keyboardAt(page), (at) => at === "window-survey");
        const terminalSurvey = raiseSurvey(cs, ["--tab-name", name, "--timeout", "60",
          "--title", `Keyboard owners: 297-${backend} over the terminal`,
          "--option", "TermOne", "--option", "TermTwo",
          "This survey arrives under a window-wide one."]);
        calls.push(terminalSurvey);
        await waitForCard(page, terminalCard(row.tab), terminalSurvey, "the terminal's survey arrives");
        await settle(page);
        wide.afterArrival = await keyboardAt(page);
        await ctx.shot(`297-${backend}-window-wide-terminal-arrived`);
        await page.keyboard.press("1");
        wide.windowOutcome = await surveyOutcome(windowSurvey, 5000);
        await sleep(500);
        wide.terminalOutcome = terminalSurvey.result;
        await ctx.shot(`297-${backend}-window-wide-answered`);
        assert.ok(wide.windowOutcome?.stdout === "WideOne" && wide.terminalOutcome === null,
          `1 answers the window-wide survey: it reads ${JSON.stringify(wide.windowOutcome)}, ` +
          `the terminal's survey reads ${JSON.stringify(wide.terminalOutcome)}; ` +
          `after the arrival the keyboard was at ${wide.afterArrival}`);
        wide.passed = true;
      } catch (error) {
        wide.failure = String(error.message ?? error);
        failures.push(`${backend} under a window-wide survey: ${wide.failure}`);
      } finally {
        try {
          await answerOpenSurveys(page, calls);
        } catch (error) {
          result.cleanupErrors.push(`window-wide leg: ${error.message}`);
        }
      }
    } catch (error) {
      result.failure = String(error.message ?? error);
      failures.push(`${backend}: ${result.failure}`);
      await ctx.shot(`297-${backend}-failure`).catch(() => {});
    } finally {
      await answerOpenSurveys(page, calls).catch((error) => result.cleanupErrors.push(`surveys: ${error.message}`));
      await closeEveryTerminal(page, `${backend} cleanup`, token)
        .catch((error) => result.cleanupErrors.push(`terminals: ${error.message}`));
      for (const error of result.cleanupErrors) failures.push(`${backend}: cleanup: ${error}`);
      writeFileSync(join(ctx.outDir, `297-${backend}.json`), `${JSON.stringify(result, null, 2)}\n`);
    }
    if (failures.length) throw new Error(failures.join("\n"));
  },
};
