// A modal dialog closing over a survey hands the keyboard to the survey's
// card, not to the element the dialog opened from. The composer holds the
// keyboard; the path prompt opens from the command deck's "Open..." row (the
// command has no built-in chord); a survey arrives over the terminal while
// the dialog keeps the keyboard; Escape closes the dialog and `1` answers the
// survey. The terminal is a raw PTY recorder, so a `1` that reached it would
// show as byte 31, and the composer stays empty.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeEveryTerminal, selectLauncherCommand } from "../lib/pane-strip.mjs";
import { recordedSince } from "../lib/pty-recorder.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import {
  answerOpenSurveys, chord, keyboardAt, raiseSurvey, surveyOutcome, terminalCard, waitForCard,
} from "../lib/keyboard-owners.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const PATH_DIALOG = '[role="dialog"][aria-labelledby="path-prompt-title"]';
const bytesOf = (file, offset) => existsSync(file)
  ? [...readFileSync(file).subarray(offset)].map((byte) => byte.toString(16).padStart(2, "0"))
  : [];

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

const composerText = (page, card) => page.evaluate((card) =>
  document.querySelector(`${card} .cm-content`)?.textContent ?? null, card);

export default {
  name: "modal-close-hands-survey-the-keyboard",
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
    const directory = mkdtempSync(join(ctx.workspaceDir, ".modalclose-298-"));
    const failures = [];
    try {
      const name = "Modal298";
      const recorder = join(directory, "recorder.bytes");
      const result = { passed: false, cleanupErrors: [] };
      const calls = [];
      try {
        const row = await openAttachedTerminal(ctx, page, cs, windowId, name,
          ["--command", `stty raw -echo && exec dd bs=1 status=none of=${shellQuote(recorder)}`]);
        const terminal = `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"]`;
        const card = `${terminal} .rich-prompt`;
        await until("precondition: the recorder started", () => existsSync(recorder), Boolean);
        await cs(["write", "--tab-name", name, "Z"]);
        const offset = (await recordedSince("precondition: the recorder records the PTY", recorder, 0, "5a")).length;

        await page.click(`${terminal} .terminal-host`);
        await chord(page, ["Control", "Alt"], "KeyP");
        await page.waitForSelector(`${card} .cm-content`, { visible: true, timeout: 15_000 });
        await page.click(`${card} .cm-content`);
        result.composer = await until("precondition: the composer holds the keyboard", () => keyboardAt(page),
          (at) => at === `composer:${row.tab}`);

        await selectLauncherCommand(page, "Open...");
        await page.keyboard.press("Enter");
        await page.waitForSelector(`${PATH_DIALOG} input`, { visible: true, timeout: 15_000 });
        result.dialog = await until("precondition: the path prompt holds the keyboard", () => keyboardAt(page),
          (at) => at === "path-prompt");

        const survey = raiseSurvey(cs, ["--tab-name", name, "--timeout", "60",
          "--title", "Keyboard owners: 298",
          "--option", "Alpha", "--option", "Beta",
          "A survey arrives over the terminal while the path prompt is open."]);
        calls.push(survey);
        await waitForCard(page, terminalCard(row.tab), survey, "the survey arrives under the dialog");
        await settle(page);
        result.underDialog = await keyboardAt(page);
        await ctx.shot("298-survey-under-dialog");
        assert.equal(result.underDialog, "path-prompt", "the open dialog keeps the keyboard while the survey arrives");

        await page.keyboard.press("Escape");
        await until("the path prompt closes", () => page.$(PATH_DIALOG), (dialog) => dialog === null);
        await settle(page);
        result.afterClose = await keyboardAt(page);
        await ctx.shot("298-dialog-closed");
        await page.keyboard.press("1");
        result.outcome = await surveyOutcome(survey, 5000);
        await sleep(500);
        result.composerText = await composerText(page, card);
        result.bytes = bytesOf(recorder, offset);
        await ctx.shot("298-after-1");
        assert.equal(result.outcome?.stdout, "Alpha",
          `1 answers the survey once the dialog closes: the survey reads ${JSON.stringify(result.outcome)}; ` +
          `after the close the keyboard was at ${result.afterClose}, and the composer reads ${JSON.stringify(result.composerText)}`);
        assert.equal(result.composerText, "", "the composer stays empty");
        assert.ok(!result.bytes.includes("31"), `the 1 reached the PTY: ${JSON.stringify(result.bytes)}`);
        result.passed = true;
      } catch (error) {
        result.failure = String(error.message ?? error);
        failures.push(result.failure);
        await ctx.shot("298-failure").catch(() => {});
      } finally {
        try {
          if (await page.$(PATH_DIALOG)) await page.keyboard.press("Escape");
        } catch (error) {
          result.cleanupErrors.push(`dialog: ${error.message}`);
        }
        await answerOpenSurveys(page, calls).catch((error) => result.cleanupErrors.push(`surveys: ${error.message}`));
        await closeEveryTerminal(page, "cleanup", token)
          .catch((error) => result.cleanupErrors.push(`terminals: ${error.message}`));
        for (const error of result.cleanupErrors) failures.push(`cleanup: ${error}`);
        writeFileSync(join(ctx.outDir, "298-result.json"), `${JSON.stringify(result, null, 2)}\n`);
      }
    } finally {
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* The workspace teardown removes it. */ }
    }
    if (failures.length) throw new Error(failures.join("\n"));
  },
};
