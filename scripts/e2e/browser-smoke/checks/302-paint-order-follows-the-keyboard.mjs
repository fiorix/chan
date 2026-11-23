// What paints on top holds the keyboard, over the command deck and Search.
// Each leg reads the surface `elementFromPoint` finds at the top surface's
// centre and the layers the page paints at, then types keys:
//   1. the deck alone paints at 29800 and typed text lands in its input;
//   2. a window-wide survey raised over the open deck: its card is on top,
//      the deck drops under it, and a digit answers it; then the deck holds
//      the keyboard again at 29800 and takes the next key;
//   3. a dialog over the deck (the path prompt, opened by app.file.new): the
//      dialog is on top and typed text lands in its field;
//   4. Settings opened over the deck by a host command: Settings is on top,
//      typed text stays out of the deck, and ArrowDown on a section tab moves
//      Settings' current section;
//   5. the Team dialog over Search: the dialog is on top and typed text lands
//      in its name field.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeEveryTerminal, dispatchCommand } from "../lib/pane-strip.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { WINDOW_CARD, answerOpenSurveys, keyboardAt, raiseSurvey, surveyOutcome, waitForCard } from "../lib/keyboard-owners.mjs";
import {
  DECK, DECK_INPUT, PATH_PROMPT, SEARCH, SETTINGS, TEAM, checkWindowId, closeDeck, inputValue,
  keyboardSurface, layerOf, openDeck, settingsArrowDown, settle, surfaceAt, until,
} from "../lib/keyboard-layers.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TEAM_NAME = `${TEAM} .team-field input[type="text"]`;

export default {
  name: "paint-order-follows-the-keyboard",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    const windowId = await checkWindowId(page);
    assert.ok(windowId, "the check page has a window id");
    await ctx.waitWindowLive(windowId);
    const cs = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
      cwd: ctx.workspaceDir,
      env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
      timeout: 90_000,
    });
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const result = { backend: "ghostty", legs: {}, cleanupErrors: [] };
    const failures = [];
    const calls = [];
    // leg NAME FN: run one leg, record its readings and failure, and leave
    // nothing open for the next.
    const leg = async (name, fn) => {
      const record = { passed: false };
      result.legs[name] = record;
      try {
        await fn(record);
        record.passed = true;
      } catch (error) {
        record.failure = String(error.message ?? error);
        failures.push(`${name}: ${record.failure}`);
        await ctx.shot(`302-${name}-failure`).catch(() => {});
      } finally {
        await page.keyboard.press("Escape").catch(() => {});
        await answerOpenSurveys(page, calls).catch((error) => result.cleanupErrors.push(`${name} surveys: ${error.message}`));
        if (await page.$(TEAM)) await page.click(".team-dialog-close").catch((error) => result.cleanupErrors.push(`${name} team: ${error.message}`));
        if (await page.$(SETTINGS)) await page.keyboard.press("Escape").catch(() => {});
        await closeDeck(page).catch((error) => result.cleanupErrors.push(`${name} deck: ${error.message}`));
        if (await page.$(SEARCH)) await dispatchCommand(page, "app.search.toggle").catch(() => {});
        await settle(page);
      }
    };
    try {
      await openAttachedTerminal(ctx, page, cs, windowId, "Paint302", "ghostty");

      await leg("deckAlone", async (r) => {
        await openDeck(page);
        await settle(page);
        r.deckLayer = await layerOf(page, DECK);
        r.top = await surfaceAt(page, DECK);
        await page.keyboard.type("abc");
        r.deckInput = await inputValue(page, DECK_INPUT);
        r.keyboard = await keyboardAt(page);
        await ctx.shot("302-deck-alone");
        assert.equal(r.top.surface, "deck", "the deck paints at its own centre");
        assert.ok(r.keyboard === "deck" && String(r.deckInput).endsWith("abc"),
          `typed text lands in the deck's input: the keyboard is at ${r.keyboard}, the input reads ${JSON.stringify(r.deckInput)}`);
        assert.equal(r.deckLayer, 29800, "the deck alone paints at 29800");
      });

      await leg("surveyOverDeck", async (r) => {
        await openDeck(page);
        const survey = raiseSurvey(cs, ["--tab-group", "default", "--timeout", "60",
          "--title", "Paint order: 302 survey over the deck",
          "--option", "DeckOne", "--option", "DeckTwo",
          "A window-wide survey raised over the open command deck."]);
        calls.push(survey);
        await waitForCard(page, WINDOW_CARD, survey, "the window-wide survey shows over the deck", { visible: true });
        await settle(page);
        r.deckOpen = Boolean(await page.$(DECK));
        r.deckLayer = await layerOf(page, DECK);
        r.cardLayer = await layerOf(page, WINDOW_CARD);
        r.top = await surfaceAt(page, WINDOW_CARD);
        r.keyboard = await keyboardSurface(page);
        await ctx.shot("302-survey-over-deck");
        await page.keyboard.press("1");
        r.outcome = await surveyOutcome(survey, 5000);
        await settle(page);
        r.after = { keyboard: await keyboardAt(page), deckLayer: await layerOf(page, DECK), deckInput: await inputValue(page, DECK_INPUT) };
        await page.keyboard.type("k");
        r.after.deckInputTyped = await inputValue(page, DECK_INPUT);
        assert.ok(r.deckOpen, "precondition: the deck stays open under the survey");
        assert.equal(r.top.surface, "window-survey", "the card paints at its own centre");
        assert.equal(r.keyboard, "window-survey", "the card holds the keyboard");
        assert.ok(r.cardLayer > r.deckLayer, `the card paints over the deck: card ${r.cardLayer}, deck ${r.deckLayer}`);
        assert.equal(r.outcome?.stdout, "DeckOne", `a digit answers the survey: ${JSON.stringify(r.outcome)}`);
        // The deck selects its query as it takes the keyboard back, so the
        // key replaces it or follows it.
        assert.ok(r.after.keyboard === "deck" && String(r.after.deckInputTyped).endsWith("k")
          && r.after.deckInputTyped !== r.after.deckInput,
          `the deck holds the keyboard again and takes the next key: ${JSON.stringify(r.after)}`);
        assert.equal(r.after.deckLayer, 29800, "the deck paints at 29800 again");
      });

      await leg("dialogOverDeck", async (r) => {
        await openDeck(page);
        await dispatchCommand(page, "app.file.new");
        await page.waitForSelector(PATH_PROMPT, { visible: true, timeout: 10_000 });
        await settle(page);
        r.deckOpen = Boolean(await page.$(DECK));
        r.deckLayer = await layerOf(page, DECK);
        r.dialogLayer = await layerOf(page, PATH_PROMPT);
        r.top = await surfaceAt(page, PATH_PROMPT);
        const field = `${PATH_PROMPT} input`;
        r.fieldBefore = await inputValue(page, field);
        await page.keyboard.type("q302");
        r.fieldAfter = await inputValue(page, field);
        r.keyboard = await keyboardSurface(page);
        r.deckInput = await inputValue(page, DECK_INPUT);
        await ctx.shot("302-dialog-over-deck");
        assert.ok(r.deckOpen, "precondition: the deck stays open under the dialog");
        assert.equal(r.top.surface, "path-prompt", "the dialog paints at its own centre");
        assert.ok(r.keyboard === "path-prompt" && String(r.fieldAfter).includes("q302"),
          `typed text lands in the dialog's field: the keyboard is at ${r.keyboard}, the field reads ${JSON.stringify(r.fieldAfter)}`);
        assert.ok(r.dialogLayer > r.deckLayer, `the dialog paints over the deck: dialog ${r.dialogLayer}, deck ${r.deckLayer}`);
      });

      await leg("settingsOverDeck", async (r) => {
        await openDeck(page);
        await dispatchCommand(page, "app.settings.open");
        await page.waitForSelector(SETTINGS, { visible: true, timeout: 10_000 });
        await settle(page);
        r.deckOpen = Boolean(await page.$(DECK));
        r.deckLayer = await layerOf(page, DECK);
        r.settingsLayer = await layerOf(page, SETTINGS);
        r.top = await surfaceAt(page, SETTINGS);
        r.deckInputBefore = await inputValue(page, DECK_INPUT);
        await page.keyboard.type("xyz");
        r.deckInputAfter = await inputValue(page, DECK_INPUT);
        r.keyboard = await keyboardSurface(page);
        r.arrowDown = await settingsArrowDown(page);
        await ctx.shot("302-settings-over-deck");
        assert.ok(r.deckOpen, "precondition: the deck stays open under Settings");
        assert.equal(r.top.surface, "settings", "Settings paints at its own centre");
        assert.ok(r.keyboard === "settings" && r.deckInputAfter === r.deckInputBefore,
          `typed text stays out of the deck: the keyboard is at ${r.keyboard}, the deck's input went from ` +
          `${JSON.stringify(r.deckInputBefore)} to ${JSON.stringify(r.deckInputAfter)}`);
        assert.ok(r.arrowDown.moved, `ArrowDown on a section tab moves Settings' current section: ${JSON.stringify(r.arrowDown)}`);
        assert.ok(r.settingsLayer > r.deckLayer, `Settings paints over the deck: Settings ${r.settingsLayer}, deck ${r.deckLayer}`);
      });

      await leg("teamOverSearch", async (r) => {
        await dispatchCommand(page, "app.search.toggle");
        await until("precondition: Search holds the keyboard", () => keyboardAt(page), (at) => at === "search");
        await dispatchCommand(page, "app.terminal.teamWork");
        await page.waitForSelector(TEAM, { visible: true, timeout: 15_000 });
        await settle(page);
        r.searchOpen = Boolean(await page.$(SEARCH));
        r.searchLayer = await layerOf(page, SEARCH);
        r.teamLayer = await layerOf(page, TEAM);
        r.top = await surfaceAt(page, TEAM);
        r.nameBefore = await inputValue(page, TEAM_NAME);
        await page.keyboard.type("Trin");
        r.nameAfter = await inputValue(page, TEAM_NAME);
        r.keyboard = await keyboardSurface(page);
        await ctx.shot("302-team-over-search");
        assert.ok(r.searchOpen, "precondition: Search stays open under the Team dialog");
        assert.equal(r.top.surface, "team", "the Team dialog paints at its own centre");
        assert.ok(r.keyboard === "team" && String(r.nameAfter).includes("Trin"),
          `typed text lands in the Team dialog's name field: the keyboard is at ${r.keyboard}, the field went from ` +
          `${JSON.stringify(r.nameBefore)} to ${JSON.stringify(r.nameAfter)}`);
        assert.ok(r.teamLayer > r.searchLayer, `the Team dialog paints over Search: Team ${r.teamLayer}, Search ${r.searchLayer}`);
      });
    } catch (error) {
      result.failure = String(error.message ?? error);
      failures.push(result.failure);
      await ctx.shot("302-failure").catch(() => {});
    } finally {
      await sleep(200);
      await closeEveryTerminal(page, "302 cleanup", token).catch((error) => result.cleanupErrors.push(`terminals: ${error.message}`));
      for (const error of result.cleanupErrors) failures.push(`cleanup: ${error}`);
      writeFileSync(join(ctx.outDir, "302-paint-order.json"), `${JSON.stringify(result, null, 2)}\n`);
    }
    if (failures.length) throw new Error(failures.join("\n"));
  },
};
