// Proves that the terminal's late start() focus rechecks Rich Prompt
// visibility after the core loads. A restored composer keeps the keyboard,
// including across transient focus moves, and DECSET 1004 receives no
// unrequested focus reports. A deliberate terminal/composer move is the
// positive PTY control. Chrome only; no native webview claim.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { draftsStore, listDrafts, waitFor } from "../lib/drafts.mjs";
import { drainPointerInput } from "../lib/terminal-pointer.mjs";
import {
  assertKeyboard, captureFocusTerminals, clearFocus, clickTerminal,
  enableFocusReports, focusReports, installFocusTrace, readFocus,
  runFocusCheck, settleFocus, waitFocus,
} from "../lib/terminal-focus.mjs";

const DRAFT = "focus reload draft";

// Wait until the draft made since `known` was read holds `text` in its
// store, and answer the server's row for it. Opening a composer saves no
// session: the page writes which terminal shows one, and on which draft, as
// it unloads. Until the reload the saved session may name neither, so the
// draft is the one part of the composer the server can be asked for.
export async function waitComposerDraft(ctx, known, text) {
  const draft = await waitFor("the composer's draft in the server's list", 20_000, async () =>
    (await listDrafts(ctx)).drafts.find((row) => !known.has(row.primary.draft_id)) ?? null);
  const stored = join(draftsStore(ctx, draft.name), draft.primary.path);
  await waitFor("the typed text in the composer's draft", 20_000, () => readFileSync(stored, "utf8").includes(text));
  return draft;
}

export default {
  name: "rich-prompt-reload-focus",
  run(ctx) {
    return runFocusCheck(ctx, 344, async ({ page, details, windowId, open, attach, leg, restore }) => {
      const known = new Set((await listDrafts(ctx)).drafts.map((row) => row.primary.draft_id));
      const terminal = await open("composer");
      await clickTerminal(page, terminal.query);
      await enableFocusReports(terminal);
      await page.keyboard.down("Control");
      await page.keyboard.down("Alt");
      try { await page.keyboard.press("KeyP"); }
      finally { await page.keyboard.up("Alt"); await page.keyboard.up("Control"); }
      await waitFocus("the composer holds the keyboard before reload", () => readFocus(page, terminal.query),
        (read) => read.terminal.composerFocused);
      await page.keyboard.type(DRAFT);
      const draft = await waitComposerDraft(ctx, known, DRAFT);
      details.draft = { name: draft.name, path: draft.primary.path };
      await drainPointerInput(terminal.fixture);

      const held = [];
      let holding = true;
      const requestErrors = [];
      const onRequest = (request) => {
        if (request.isInterceptResolutionHandled()) return;
        if (holding && new URL(request.url()).pathname.endsWith(".wasm")) held.push(request);
        else void request.continue().catch((error) => requestErrors.push(error.message));
      };
      const release = async () => {
        holding = false;
        for (const request of held.splice(0)) {
          if (!request.isInterceptResolutionHandled()) await request.continue();
        }
      };
      await page.setCacheEnabled(false);
      await page.setRequestInterception(true);
      page.on("request", onRequest);
      restore("restore core requests", async () => {
        await release();
        page.off("request", onRequest);
        await page.setRequestInterception(false);
        await page.setCacheEnabled(true);
        assert.deepEqual(requestErrors, [], "every non-core request continued");
      });
      const script = await page.evaluateOnNewDocument(installFocusTrace);
      restore("remove navigation focus observer", () => page.removeScriptToEvaluateOnNewDocument(script.identifier));
      let restored = false;
      await leg("reload-keeps-composer", async (result) => {
        const index = terminal.fixture.records.length;
        result.before = await readFocus(page, terminal.query);
        assertKeyboard(result.before, "composer");
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        await ctx.waitWindowLive(windowId);
        await waitFocus("the restored composer mounts ahead of the held core", () => readFocus(page, ".terminal-tab.active"),
          (read) => read.terminal.composerFocused);
        result.heldRequests = held.length;
        assert.ok(result.heldRequests > 0, "the real core request was held");
        result.whileHeld = await readFocus(page, ".terminal-tab.active");
        assert.equal(result.whileHeld.terminal.textareaPresent, false, "the widget has not opened ahead of the composer");
        await captureFocusTerminals(page);
        const session = terminal.row.session_id;
        await terminal.term.dispose();
        terminal.term = null;
        await release();
        await attach(terminal, (entry) => entry.session_id === session);
        restored = true;
        await settleFocus(page);
        result.receipt = await drainPointerInput(terminal.fixture, "", index);
        result.mode = await terminal.term.evaluate((term) => term.getMode(1004));
        result.after = await readFocus(page, terminal.query);
        result.reports = focusReports(result.receipt.input);
        assert.equal(result.mode, true, "the existing program's DECSET 1004 survived reload");
        assert.deepEqual(result.reports, [], "reload sends no unrequested CSI I or CSI O");
        assertKeyboard(result.after, "composer");
        assert.deepEqual(result.after.events.filter((event) => event.type === "focusin" && event.target.terminal), [],
          "the terminal never takes the keyboard during restore, even transiently");
      });
      await leg("requested-focus-reports", async (result) => {
        assert.ok(restored, "the restored real widget is available for the positive control");
        // Start the control in the composer even when the regression stole it.
        await page.click(`${terminal.query} .rich-prompt .cm-content`);
        await settleFocus(page);
        await drainPointerInput(terminal.fixture);
        await clearFocus(page);
        const index = terminal.fixture.records.length;
        await clickTerminal(page, terminal.query);
        result.terminal = await readFocus(page, terminal.query);
        await page.click(`${terminal.query} .rich-prompt .cm-content`);
        await settleFocus(page);
        result.composer = await readFocus(page, terminal.query);
        result.receipt = await drainPointerInput(terminal.fixture, "", index);
        result.reports = focusReports(result.receipt.input);
        assertKeyboard(result.terminal, "terminal");
        assertKeyboard(result.composer, "composer");
        assert.deepEqual(result.reports, ["\x1b[I", "\x1b[O"], "the raw PTY sees the requested focus pair exactly once");
      });
    });
  },
};
