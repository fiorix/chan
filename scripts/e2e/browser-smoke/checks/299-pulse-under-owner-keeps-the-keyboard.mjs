// A focus pulse under an owner leaves the keyboard with the owner when the
// tab it reaches is an editor or a Files tab. A window-wide survey holds the
// keyboard; `cs open` from the workspace, as an agent's shell runs it, opens
// a Markdown file in one leg and a directory in the other, and the new tab
// becomes the active one; `1` then answers the survey, read from the
// `cs terminal survey` call's output, and the file on disk and in the editor
// stays as it was. A terminal anchors the window-wide survey (it goes to the
// windows owning a tab in the group), so each backend runs both legs.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeActiveTab, closeEveryTerminal } from "../lib/pane-strip.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";
import {
  WINDOW_CARD, answerOpenSurveys, keyboardAt, raiseSurvey, surveyOutcome, waitForCard,
} from "../lib/keyboard-owners.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// No digit in the text: a typed `1` would show in the editor and on disk.
const FIXTURE = "Keyboard owner fixture: a pulse under a survey types nothing here.\n";

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

/// The text of the visible surface of `kind` ("editor" or "files") that
/// holds `marker`, or null while none does. An inactive editor tab keeps
/// its box under `visibility: hidden`, so the editor must be the active one.
const surfaceText = (page, kind, marker) => page.evaluate((kind, marker) => {
  const selector = kind === "editor" ? ".editor-tab.active" : ".browser";
  for (const node of document.querySelectorAll(selector)) {
    const box = node.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const text = kind === "editor"
      ? node.querySelector('[contenteditable="true"]')?.textContent ?? ""
      : node.textContent ?? "";
    if (text.includes(marker)) return text;
  }
  return null;
}, kind, marker);

export default {
  name: "pulse-under-owner-keeps-the-keyboard",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    const windowId = await page.evaluate(() => new URL(location.href).searchParams.get("w")?.trim()
      || sessionStorage.getItem("chan.session.window")?.trim() || "");
    assert.ok(windowId, "the check page has a window id");
    await ctx.waitWindowLive(windowId);
    const env = { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId };
    const cs = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], { cwd: ctx.workspaceDir, env, timeout: 90_000 });
    const csOpen = (path) => ctx.exec(ctx.chanBin, ["shell", "open", path], { cwd: ctx.workspaceDir, env, timeout: 30_000 });
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const original = await readTerminalPrefs(page, token);
    const fixtures = [];
    const failures = [];
    try {
      for (const backend of ["xterm", "ghostty"]) {
        const name = `Pulse299-${backend}`;
        const result = { backend, legs: {}, cleanupErrors: [] };
        const calls = [];
        try {
          await writeTerminalPrefs(page, token, { ghostty: backend === "ghostty" });
          const row = await openAttachedTerminal(ctx, page, cs, windowId, name, backend);
          const terminal = `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"]`;
          const file = `owner299-${backend}.md`;
          const directory = `owner299-${backend}-dir`;
          writeFileSync(join(ctx.workspaceDir, file), FIXTURE);
          mkdirSync(join(ctx.workspaceDir, directory), { recursive: true });
          writeFileSync(join(ctx.workspaceDir, directory, "a299.txt"), FIXTURE);
          fixtures.push(join(ctx.workspaceDir, file), join(ctx.workspaceDir, directory));

          for (const [kind, target, marker] of [["editor", file, "Keyboard owner fixture"], ["files", `${directory}/`, "a299.txt"]]) {
            const leg = { passed: false };
            result.legs[kind] = leg;
            let opened = false;
            try {
              await page.click(`${terminal} .terminal-host`);
              const survey = raiseSurvey(cs, ["--tab-group", "default", "--timeout", "60",
                "--title", `Keyboard owners: 299-${backend} ${kind}`,
                "--option", "Alpha", "--option", "Beta",
                `A window-wide survey is up when cs open brings a ${kind} tab forward.`]);
              calls.push(survey);
              await waitForCard(page, WINDOW_CARD, survey, "the window-wide survey shows", { visible: true });
              leg.before = await until("precondition: the window-wide survey holds the keyboard",
                () => keyboardAt(page), (at) => at === "window-survey");
              await csOpen(target);
              opened = true;
              leg.surface = await until(`precondition: the ${kind} tab shows ${target}`,
                () => surfaceText(page, kind, marker), (text) => text !== null);
              // The opened tab is the strip's selected one: a tab that never
              // came forward runs no focus mover, and 1 would answer anyway.
              const tabName = target.replace(/\/$/, "");
              leg.selected = await until(`precondition: the strip selects the ${kind} tab for ${tabName}`,
                () => page.evaluate(() => [...document.querySelectorAll('.tab-label[role="tab"][aria-selected="true"]')]
                  .map((label) => ({ text: label.textContent?.trim() ?? "", title: label.closest(".tab")?.getAttribute("title") ?? "" }))),
                (selected) => selected.some((tab) => tab.text.includes(tabName) || tab.title.includes(tabName)));
              await settle(page);
              await sleep(500);
              leg.afterOpen = await keyboardAt(page);
              await ctx.shot(`299-${backend}-${kind}-opened-under-survey`);
              await page.keyboard.press("1");
              leg.outcome = await surveyOutcome(survey, 5000);
              await sleep(2500);
              leg.surfaceAfter = await surfaceText(page, kind, marker);
              if (kind === "editor") leg.disk = readFileSync(join(ctx.workspaceDir, file), "utf8");
              await ctx.shot(`299-${backend}-${kind}-after-1`);
              assert.equal(leg.outcome?.stdout, "Alpha",
                `1 answers the window-wide survey: it reads ${JSON.stringify(leg.outcome)}; ` +
                `after the open the keyboard was at ${leg.afterOpen}`);
              if (kind === "editor") {
                assert.ok(!String(leg.surfaceAfter).includes("1"), `the editor holds no typed 1: ${JSON.stringify(leg.surfaceAfter)}`);
                assert.equal(leg.disk, FIXTURE, "the file on disk is unchanged");
              }
              leg.passed = true;
            } catch (error) {
              leg.failure = String(error.message ?? error);
              failures.push(`${backend} ${kind}: ${leg.failure}`);
            } finally {
              await answerOpenSurveys(page, calls).catch((error) => result.cleanupErrors.push(`${kind} surveys: ${error.message}`));
              if (opened) {
                await closeActiveTab(page, `${backend} ${kind} tab`)
                  .catch((error) => result.cleanupErrors.push(`${kind} tab: ${error.message}`));
              }
              writeFileSync(join(ctx.workspaceDir, file), FIXTURE);
            }
          }
        } catch (error) {
          result.failure = String(error.message ?? error);
          failures.push(`${backend}: ${result.failure}`);
          await ctx.shot(`299-${backend}-failure`).catch(() => {});
        } finally {
          await answerOpenSurveys(page, calls).catch((error) => result.cleanupErrors.push(`surveys: ${error.message}`));
          await closeEveryTerminal(page, `${backend} cleanup`, token)
            .catch((error) => result.cleanupErrors.push(`terminals: ${error.message}`));
          for (const error of result.cleanupErrors) failures.push(`${backend}: cleanup: ${error}`);
          writeFileSync(join(ctx.outDir, `299-${backend}.json`), `${JSON.stringify(result, null, 2)}\n`);
        }
      }
    } finally {
      for (const path of fixtures) {
        try { rmSync(path, { recursive: true, force: true }); } catch { /* The workspace teardown removes it. */ }
      }
      await writeTerminalPrefs(page, token, { ghostty: original.ghostty });
    }
    if (failures.length) throw new Error(failures.join("\n"));
  },
};
