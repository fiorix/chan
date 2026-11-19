// Search and Settings opened over the open command deck keep the keyboard,
// and Escape hands it back to the deck's input. Two legs, the same shape:
// the deck holds the keyboard with a query typed; a host command opens the
// overlay over it; typed text stays in the overlay and the deck's query is
// unchanged, Search's field shows it, and in Settings ArrowDown on a
// section tab moves the current section; Escape closes the overlay; the
// deck's input holds the keyboard again, paints at 29800, and the next typed
// key lands in its query.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchCommand } from "../lib/pane-strip.mjs";
import { keyboardAt } from "../lib/keyboard-owners.mjs";
import {
  DECK, DECK_INPUT, SEARCH, SETTINGS, checkWindowId, closeDeck, inputValue, keyboardSurface, layerOf,
  openDeck, settingsArrowDown, settle, until,
} from "../lib/keyboard-layers.mjs";

const SEARCH_INPUT = ".search .head input";

export default {
  name: "overlay-over-deck-hands-back",
  async run(ctx) {
    const { page } = ctx;
    await page.bringToFront();
    const windowId = await checkWindowId(page);
    assert.ok(windowId, "the check page has a window id");
    const result = { legs: {}, cleanupErrors: [] };
    const failures = [];
    const overlays = [
      // `answers` reads what the overlay did with the keys typed into it.
      { name: "search", command: "app.search.toggle", selector: SEARCH, typed: "hello304",
        answers: async () => {
          const text = await inputValue(page, SEARCH_INPUT);
          return { text, ok: String(text).includes("hello304") };
        },
        holds: (at) => at === "search" },
      { name: "settings", command: "app.settings.open", selector: SETTINGS, typed: "xyz",
        answers: async () => {
          const arrowDown = await settingsArrowDown(page);
          return { arrowDown, ok: arrowDown.moved };
        },
        holds: (at) => at === "settings" },
    ];
    for (const overlay of overlays) {
      const r = { passed: false };
      result.legs[overlay.name] = r;
      try {
        await openDeck(page);
        await page.keyboard.type("dk");
        r.deckQuery = await inputValue(page, DECK_INPUT);
        await dispatchCommand(page, overlay.command);
        await page.waitForSelector(overlay.selector, { visible: true, timeout: 10_000 });
        r.opened = await until(`precondition: ${overlay.name} holds the keyboard over the deck`,
          () => keyboardSurface(page), overlay.holds, 5000)
          .catch(async () => `not held: ${await keyboardSurface(page)}`);
        await settle(page);
        await page.keyboard.type(overlay.typed);
        r.deckQueryAfterTyping = await inputValue(page, DECK_INPUT);
        r.keyboardAfterTyping = await keyboardSurface(page);
        r.answered = await overlay.answers();
        await ctx.shot(`304-${overlay.name}-typed`);
        assert.ok(overlay.holds(r.keyboardAfterTyping) && r.deckQueryAfterTyping === r.deckQuery,
          `typed text stays in ${overlay.name}: the keyboard is at ${r.keyboardAfterTyping}, the deck's query went from ` +
          `${JSON.stringify(r.deckQuery)} to ${JSON.stringify(r.deckQueryAfterTyping)}`);
        assert.ok(r.answered.ok, `${overlay.name} answers the keys typed into it: ${JSON.stringify(r.answered)}`);
        await page.keyboard.press("Escape");
        await until(`${overlay.name} closes on Escape`, async () => Boolean(await page.$(overlay.selector)), (open) => !open, 5000);
        await settle(page);
        r.afterEscape = { keyboard: await keyboardAt(page), deckOpen: Boolean(await page.$(DECK)), deckLayer: await layerOf(page, DECK) };
        await page.keyboard.type("z");
        r.deckQueryAfterEscape = await inputValue(page, DECK_INPUT);
        await ctx.shot(`304-${overlay.name}-after-escape`);
        assert.ok(r.afterEscape.deckOpen && r.afterEscape.keyboard === "deck",
          `Escape hands the keyboard back to the deck's input: ${JSON.stringify(r.afterEscape)}`);
        assert.equal(r.afterEscape.deckLayer, 29800, "the deck paints at 29800 again");
        assert.equal(r.deckQueryAfterEscape, `${r.deckQuery}z`, "the next key lands in the deck's query");
        r.passed = true;
      } catch (error) {
        r.failure = String(error.message ?? error);
        failures.push(`${overlay.name}: ${r.failure}`);
        await ctx.shot(`304-${overlay.name}-failure`).catch(() => {});
      } finally {
        if (await page.$(overlay.selector)) await page.keyboard.press("Escape").catch(() => {});
        if (await page.$(SEARCH)) await dispatchCommand(page, "app.search.toggle").catch(() => {});
        await closeDeck(page).catch((error) => result.cleanupErrors.push(`${overlay.name} deck: ${error.message}`));
        await settle(page);
      }
    }
    for (const error of result.cleanupErrors) failures.push(`cleanup: ${error}`);
    writeFileSync(join(ctx.outDir, "304-overlay-over-deck.json"), `${JSON.stringify(result, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
  },
};
