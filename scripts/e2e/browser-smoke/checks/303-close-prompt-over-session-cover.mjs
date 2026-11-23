// The close prompt over the session-ended cover holds the keyboard, and no
// key reaches the cover under it. The page captures its watcher socket and
// counts window.close calls (the cover's "Close window" button's only
// effect); a terminal keeps a tab in the window, since a window with none
// closes on app.window.confirmClose without a prompt. A window_hidden frame
// on the watcher raises the session-ended cover; app.window.confirmClose,
// the one command a cover lets through, raises the prompt over it:
//   - Cancel holds the keyboard when the prompt shows;
//   - Tab cycles the prompt's buttons and never leaves it;
//   - Escape cancels it, and the cover's button holds the keyboard again;
//   - Enter acts on the focused button: on Cancel it cancels, on Hide it
//     hides and the prompt goes (off the desktop the two have the same
//     effect, so this cannot tell them apart);
//   - no key reaches the cover while the prompt shows: window.close is never
//     called and the cover stays up; once the last prompt goes, Enter on the
//     cover's button calls it once.
// The product never composes this state: the window_hidden arm is the web
// page's, and app.window.confirmClose comes only from chan-desktop. The
// cover's keyboard code is shared by its arms (button.close in each), so the
// readings hold for the arm the desktop shows. A window_shown frame lowers
// the cover at the end.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeEveryTerminal, dispatchCommand } from "../lib/pane-strip.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { CLOSE_PROMPT, checkWindowId, keyboardSurface, settle, until } from "../lib/keyboard-layers.mjs";

const COVER = '[data-cover="session-ended"]';
const COVER_BUTTON = `${COVER} button.close`;

export default {
  name: "close-prompt-over-session-cover",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    await page.evaluateOnNewDocument(() => {
      window.__closeCalls = 0;
      window.close = () => { window.__closeCalls += 1; };
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          if (new URL(args[0], location.href).pathname === "/ws") {
            this.addEventListener("open", () => { window.__watch303 = this; });
          }
        }
      };
    });
    await page.goto(page.url(), { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".pane", { timeout: 30_000 });
    await page.waitForFunction(() => Boolean(window.__watch303), { timeout: 30_000 });
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
    const frame = (command) => page.evaluate((windowId, command) => {
      window.__watch303.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "window_command", window_id: windowId, command }),
      }));
    }, windowId, command);
    const focusOn = () => page.evaluate((prompt, coverButton) => {
      const active = document.activeElement;
      if (!active || active === document.body) return "body";
      if (active.matches(coverButton)) return "cover-button";
      const button = active.closest(prompt) ? active.closest("button") : null;
      if (button) return `prompt:${[...button.classList].find((c) => ["cancel", "hide", "close", "detach"].includes(c)) ?? button.className}`;
      return active.closest(prompt) ? "prompt" : `${active.tagName}.${active.className?.toString?.() ?? ""}`.slice(0, 80);
    }, CLOSE_PROMPT, COVER_BUTTON);
    const state = async () => ({
      prompt: Boolean(await page.$(CLOSE_PROMPT)),
      cover: Boolean(await page.$(COVER)),
      focus: await focusOn(),
      closeCalls: await page.evaluate(() => window.__closeCalls),
    });
    const openPrompt = async (label) => {
      await dispatchCommand(page, "app.window.confirmClose");
      await page.waitForSelector(CLOSE_PROMPT, { visible: true, timeout: 10_000 });
      await settle(page);
      const read = await state();
      if (!read.cover) throw new Error(`${label}: the cover went when the prompt showed: ${JSON.stringify(read)}`);
      return read;
    };
    const result = { backend: "ghostty", legs: {}, cleanupErrors: [] };
    const failures = [];
    const check = (name, ok, detail) => {
      result.legs[name] = { ok, detail };
      if (!ok) failures.push(`${name}: ${JSON.stringify(detail)}`);
    };
    try {
      await openAttachedTerminal(ctx, page, cs, windowId, "Close303", "ghostty");
      await frame("window_hidden");
      await page.waitForSelector(COVER, { visible: true, timeout: 10_000 });
      result.coverUp = await until("precondition: the cover's button holds the keyboard", focusOn,
        (at) => at === "cover-button", 5000).catch(async () => `not held: ${await focusOn()}`);
      await ctx.shot("303-cover");

      const shown = await openPrompt("first prompt");
      check("cancelHoldsTheKeyboard", shown.focus === "prompt:cancel", shown);
      await ctx.shot("303-prompt");

      const cycle = [];
      for (let press = 0; press < 4; press += 1) {
        await page.keyboard.press("Tab");
        cycle.push(await focusOn());
      }
      check("tabCyclesInsideThePrompt",
        cycle.every((at) => at.startsWith("prompt:")) && cycle.includes("prompt:cancel") && new Set(cycle).size >= 2, cycle);
      await until("precondition: Cancel holds the keyboard again", async () => {
        const at = await focusOn();
        if (at !== "prompt:cancel") await page.keyboard.press("Tab");
        return at;
      }, (at) => at === "prompt:cancel", 5000).catch(() => {});

      await page.keyboard.press("Escape");
      const escaped = await until("Escape cancels the prompt", state, (s) => !s.prompt, 5000).catch(state);
      await settle(page);
      escaped.focus = await focusOn();
      check("escapeCancels", !escaped.prompt && escaped.cover && escaped.closeCalls === 0, escaped);
      check("coverButtonHoldsTheKeyboardAfterEscape", escaped.focus === "cover-button", escaped.focus);

      const again = await openPrompt("second prompt");
      const enterOn = again.focus;
      await page.keyboard.press("Enter");
      const entered = await until("Enter acts on Cancel", state, (s) => !s.prompt, 5000).catch(state);
      await settle(page);
      entered.focus = await focusOn();
      check("enterOnCancelCancels", enterOn === "prompt:cancel" && !entered.prompt && entered.cover && entered.closeCalls === 0,
        { enterOn, ...entered });
      check("coverButtonHoldsTheKeyboardAfterEnter", entered.focus === "cover-button", entered.focus);

      await openPrompt("third prompt");
      await until("precondition: Hide holds the keyboard", async () => {
        const at = await focusOn();
        if (at !== "prompt:hide") await page.keyboard.press("Tab");
        return at;
      }, (at) => at === "prompt:hide", 5000);
      await page.keyboard.press("Enter");
      const hidden = await until("Enter acts on Hide", state, (s) => !s.prompt, 5000).catch(state);
      await settle(page);
      hidden.focus = await focusOn();
      check("enterOnHideActs", !hidden.prompt && hidden.cover && hidden.closeCalls === 0, hidden);

      result.keysThatReachedTheCover = await page.evaluate(() => window.__closeCalls);
      check("noKeyReachedTheCover", result.keysThatReachedTheCover === 0 && Boolean(await page.$(COVER)),
        { closeCalls: result.keysThatReachedTheCover });
      // The cover's button holds the keyboard now: Enter is its own effect.
      await page.keyboard.press("Enter");
      const acted = await until("Enter on the cover's button", () => page.evaluate(() => window.__closeCalls),
        (calls) => calls === 1, 3000).catch(() => page.evaluate(() => window.__closeCalls));
      check("enterOnTheCoverButtonActs", acted === 1, { closeCalls: acted, focus: await focusOn() });
    } catch (error) {
      result.failure = String(error.message ?? error);
      failures.push(result.failure);
      await ctx.shot("303-failure").catch(() => {});
    } finally {
      if (await page.$(CLOSE_PROMPT)) await page.keyboard.press("Escape").catch(() => {});
      await frame("window_shown").catch((error) => result.cleanupErrors.push(`window_shown: ${error.message}`));
      await until("the cover lowers", async () => Boolean(await page.$(COVER)), (up) => !up, 10_000)
        .catch((error) => result.cleanupErrors.push(error.message));
      await closeEveryTerminal(page, "303 cleanup", token).catch((error) => result.cleanupErrors.push(`terminals: ${error.message}`));
      for (const error of result.cleanupErrors) failures.push(`cleanup: ${error}`);
      result.keyboardAtEnd = await keyboardSurface(page).catch(() => null);
      writeFileSync(join(ctx.outDir, "303-close-prompt.json"), `${JSON.stringify(result, null, 2)}\n`);
    }
    if (failures.length) throw new Error(failures.join("\n"));
  },
};
