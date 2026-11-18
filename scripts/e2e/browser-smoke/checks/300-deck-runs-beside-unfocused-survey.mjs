// The command deck runs a row while a survey shows over a terminal in a pane
// that is not the focused one. Pane A's terminal carries the survey and pane
// B is focused; the deck opens, its query selects "Split right", and Enter
// runs the row: the window gains a third pane. The survey over the unfocused
// pane owns nothing, so it must not stop the deck's keys.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  closeEveryTerminal, closeExtraPanes, dispatchCommand, selectLauncherCommand,
} from "../lib/pane-strip.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";
import { answerOpenSurveys, keyboardAt, raiseSurvey, terminalCard } from "../lib/keyboard-owners.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DECK = '[role="dialog"][aria-label="Command launcher"]';
const ROW = "Split right";

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

const panes = (page) => page.evaluate(() => [...document.querySelectorAll(".pane[data-pane-id]")].map((pane) => ({
  id: pane.getAttribute("data-pane-id"),
  focused: pane.classList.contains("focused"),
  terminals: pane.querySelectorAll(".terminal-tab").length,
})));

export default {
  name: "deck-runs-beside-unfocused-survey",
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
    const original = await readTerminalPrefs(page, token);
    const failures = [];
    try {
      for (const backend of ["xterm", "ghostty"]) {
        const name = `Deck300-${backend}`;
        const result = { backend, passed: false, cleanupErrors: [] };
        const calls = [];
        try {
          await writeTerminalPrefs(page, token, { ghostty: backend === "ghostty" });
          const row = await openAttachedTerminal(ctx, page, cs, windowId, name, backend);
          const terminal = `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"]`;
          await page.click(`${terminal} .terminal-host`);

          await dispatchCommand(page, "app.pane.splitRight");
          await until("precondition: the split makes two panes", () => panes(page), (list) => list.length === 2);
          const empty = await page.evaluate(() => {
            const pane = [...document.querySelectorAll(".pane[data-pane-id]")].find((node) => !node.querySelector(".terminal-tab"));
            if (!pane) return null;
            const box = pane.getBoundingClientRect();
            return { id: pane.getAttribute("data-pane-id"), x: box.left + box.width / 2, y: box.top + 40 };
          });
          assert.ok(empty, "precondition: the split leaves an empty pane");
          await page.mouse.click(empty.x, empty.y);
          await until("precondition: the empty pane is the focused one", () => panes(page),
            (list) => list.find((pane) => pane.id === empty.id)?.focused === true);

          const survey = raiseSurvey(cs, ["--tab-name", name, "--timeout", "60",
            "--title", `Keyboard owners: 300-${backend}`,
            "--option", "Alpha", "--option", "Beta",
            "A survey over the terminal of the pane that is not focused."]);
          calls.push(survey);
          await page.waitForSelector(terminalCard(row.tab), { visible: true, timeout: 15_000 });
          await settle(page);
          result.afterSurvey = { keyboard: await keyboardAt(page), panes: await panes(page) };
          assert.ok(result.afterSurvey.panes.find((pane) => pane.id === empty.id)?.focused,
            `precondition: the empty pane stays focused under the other pane's survey: ${JSON.stringify(result.afterSurvey)}`);

          await selectLauncherCommand(page, ROW);
          result.deck = await keyboardAt(page);
          assert.equal(result.deck, "deck", "precondition: the deck holds the keyboard with the row selected");
          await ctx.shot(`300-${backend}-deck-selected`);
          await page.keyboard.press("Enter");
          const after = await until("the row runs", async () => ({
            panes: (await panes(page)).length,
            deckOpen: Boolean(await page.$(DECK)),
          }), (state) => state.panes === 3 && !state.deckOpen, 5000).catch(async () => ({
            panes: (await panes(page)).length,
            deckOpen: Boolean(await page.$(DECK)),
            timedOut: true,
          }));
          result.after = after;
          await ctx.shot(`300-${backend}-after-enter`);
          assert.ok(!after.timedOut,
            `Enter runs "${ROW}" beside the other pane's survey: the window has ${after.panes} panes ` +
            `and the deck is ${after.deckOpen ? "still open" : "closed"}`);
          result.passed = true;
        } catch (error) {
          result.failure = String(error.message ?? error);
          failures.push(`${backend}: ${result.failure}`);
          await ctx.shot(`300-${backend}-failure`).catch(() => {});
        } finally {
          try {
            if (await page.$(DECK)) await dispatchCommand(page, "app.launcher.toggle");
          } catch (error) {
            result.cleanupErrors.push(`deck: ${error.message}`);
          }
          await answerOpenSurveys(page, calls).catch((error) => result.cleanupErrors.push(`surveys: ${error.message}`));
          await closeExtraPanes(page).catch((error) => result.cleanupErrors.push(`panes: ${error.message}`));
          await closeEveryTerminal(page, `${backend} cleanup`, token)
            .catch((error) => result.cleanupErrors.push(`terminals: ${error.message}`));
          for (const error of result.cleanupErrors) failures.push(`${backend}: cleanup: ${error}`);
          writeFileSync(join(ctx.outDir, `300-${backend}.json`), `${JSON.stringify(result, null, 2)}\n`);
        }
      }
    } finally {
      await writeTerminalPrefs(page, token, { ghostty: original.ghostty });
    }
    if (failures.length) throw new Error(failures.join("\n"));
  },
};
