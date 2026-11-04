// A launcher command that moves focus nowhere hands the keyboard back to the
// terminal the launcher opened from, and a prompt a command opens returns it
// there when the prompt closes. Toggle group broadcast flips a flag and opens
// no surface: after it, typed keys must reach the PTY again with no click.
// Set terminal name opens a prompt that outlives the launcher: after Escape
// the keyboard must be back in the terminal. One arm per engine the terminal
// preference can store; each arm types a marker before and after and reads
// the PTY's scrollback for the shell's answer, which is the only proof that
// keys reach the program.

import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const LAUNCHER = '[role="dialog"][aria-label="Command launcher"]';
const LAUNCHER_INPUT = `${LAUNCHER} input[role="combobox"]`;
const SELECTED_TITLE = `${LAUNCHER} [role="option"][aria-selected="true"] .deck-result-title`;
const PROMPT = '[role="dialog"][aria-modal="true"][aria-labelledby="prompt-title"]';
const BROADCAST_MARKER = ".tab.active .broadcast-marker";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(condition, message) {
  if (!condition) throw new Error(message);
}

/// Where the keyboard is: the active element and whether it sits inside the
/// active terminal tab's host, where both engines keep their input element.
async function keyboardOwner(page) {
  return page.evaluate((launcher) => {
    const active = document.activeElement;
    const host = document.querySelector(".terminal-tab.active .terminal-host");
    return {
      tag: active?.tagName ?? null,
      className: active instanceof Element ? active.className : null,
      inTerminal: !!active && !!host && active !== document.body && host.contains(active),
      launcherOpen: !!document.querySelector(launcher),
    };
  }, LAUNCHER);
}

async function waitForTerminalKeyboard(page, label) {
  try {
    await page.waitForFunction(() => {
      const active = document.activeElement;
      const host = document.querySelector(".terminal-tab.active .terminal-host");
      return !!active && !!host && active !== document.body && host.contains(active);
    }, { timeout: 5_000 });
  } catch (cause) {
    const owner = await keyboardOwner(page);
    throw new Error(`${label}: the keyboard is not in the terminal: ${JSON.stringify(owner)}`, { cause });
  }
}

async function waitForScrollback(cs, name, marker, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = (await cs(["scrollback", "--tab-name", name])).stdout;
    if (last.includes(marker)) return;
    await pause(100);
  }
  throw new Error(`${label}: ${marker} never reached the scrollback; tail=${JSON.stringify(last.slice(-300))}`);
}

/// Open the launcher from the terminal with its web chord, Ctrl+Alt+K, the
/// keystroke a user makes; the chord escapes the terminal.
async function openLauncher(page, label) {
  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyK");
  await page.keyboard.up("Alt");
  await page.keyboard.up("Control");
  try {
    await page.waitForSelector(LAUNCHER_INPUT, { timeout: 5_000 });
  } catch (cause) {
    const owner = await keyboardOwner(page);
    throw new Error(`${label}: Ctrl+Alt+K did not open the launcher: ${JSON.stringify(owner)}`, { cause });
  }
}

/// Type a command's exact title, prove it is the selected row, and run it
/// with Enter; the launcher closes before the command runs.
async function runLauncherCommand(page, title, label) {
  await openLauncher(page, label);
  await page.type(LAUNCHER_INPUT, title);
  await page.waitForFunction(
    (selector, wanted) => document.querySelector(selector)?.textContent?.trim() === wanted,
    { timeout: 10_000 },
    SELECTED_TITLE,
    title,
  );
  await page.keyboard.press("Enter");
  await page.waitForSelector(LAUNCHER, { hidden: true, timeout: 10_000 });
}

async function typeLine(page, line) {
  await page.keyboard.type(line, { delay: 10 });
  await page.keyboard.press("Enter");
}

async function tabGone(page, name) {
  await page.waitForFunction(
    (wanted) => ![...document.querySelectorAll(".tab .path")].some((node) => node.textContent?.trim() === wanted),
    { timeout: 15_000 },
    name,
  );
}

export default {
  name: "launcher-run-returns-focus",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    const windowId = await page.evaluate(() =>
      new URL(location.href).searchParams.get("w")?.trim() ||
      sessionStorage.getItem("chan.session.window")?.trim() || "",
    );
    if (!windowId) throw new Error("could not resolve the page's window id");
    await ctx.waitWindowLive(windowId);
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const env = { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId };
    const cs = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
      cwd: ctx.workspaceDir, env, timeout: 30_000,
    });
    const originalPrefs = await readTerminalPrefs(page, token);
    const details = { arms: [] };
    const opened = [];
    try {
      for (const engine of ["xterm", "ghostty"]) {
        const name = `LauncherFocus203${engine}`;
        await writeTerminalPrefs(page, token, { ghostty: engine === "ghostty" });
        await openAttachedTerminal(ctx, page, cs, windowId, name, engine);
        opened.push(name);
        // The keyboard starts in the terminal the way a user's does: by a click.
        await page.click(engine === "ghostty"
          ? ".terminal-tab.active .terminal-host canvas"
          : ".terminal-tab.active .terminal.xterm .xterm-screen");
        await waitForTerminalKeyboard(page, `${engine}: after the click`);
        await typeLine(page, `printf 'BEFORE_%s_OK\\n' ${engine}`);
        await waitForScrollback(cs, name, `BEFORE_${engine}_OK`, `${engine}: typed before the launcher`);
        const arm = { engine };

        // A command that opens no surface: the keyboard comes back by itself.
        await runLauncherCommand(page, "Toggle group broadcast", `${engine}: broadcast`);
        await page.waitForSelector(BROADCAST_MARKER, { timeout: 10_000 });
        await waitForTerminalKeyboard(page, `${engine}: after Toggle group broadcast`);
        arm.afterBroadcast = await keyboardOwner(page);
        await typeLine(page, `printf 'FOCUS_%s_OK\\n' ${engine}`);
        await waitForScrollback(cs, name, `FOCUS_${engine}_OK`, `${engine}: typed after the launcher closed`);
        await ctx.shot(`203-${engine}-after-broadcast`);

        // A command that opens a prompt: the prompt keeps the keyboard while
        // it shows, and the terminal gets it back when the prompt closes.
        await runLauncherCommand(page, "Set terminal name", `${engine}: set name`);
        await page.waitForSelector(`${PROMPT} input`, { timeout: 10_000 });
        await page.waitForFunction(
          (selector) => document.activeElement === document.querySelector(selector),
          { timeout: 5_000 },
          `${PROMPT} input`,
        );
        await pause(500);
        const promptHolds = await page.evaluate(
          (selector) => document.activeElement === document.querySelector(selector),
          `${PROMPT} input`,
        );
        check(promptHolds, `${engine}: the prompt lost the keyboard after the launcher settled: ${JSON.stringify(await keyboardOwner(page))}`);
        await page.keyboard.press("Escape");
        await page.waitForSelector(PROMPT, { hidden: true, timeout: 10_000 });
        await waitForTerminalKeyboard(page, `${engine}: after the prompt closed`);
        arm.afterPrompt = await keyboardOwner(page);
        await typeLine(page, `printf 'PROMPT_%s_OK\\n' ${engine}`);
        await waitForScrollback(cs, name, `PROMPT_${engine}_OK`, `${engine}: typed after the prompt closed`);
        await ctx.shot(`203-${engine}-after-prompt`);

        // Broadcast off again before the terminal goes, the state as found.
        await page.evaluate(() =>
          window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.terminal.broadcastToggle" } })),
        );
        await page.waitForSelector(BROADCAST_MARKER, { hidden: true, timeout: 10_000 });
        details.arms.push(arm);
        console.log(`[smoke]   arm ${JSON.stringify(arm)}`);
        // The tab leaves the page before the engine switches, or the saved
        // layout respawns the session under the next preference.
        await cs(["close", "--tab-name", name]);
        opened.pop();
        await tabGone(page, name);
      }
      details.engine = await page.browser().version();
      return details;
    } finally {
      for (const name of opened.reverse()) {
        await cs(["close", "--tab-name", name]).catch(() => {});
      }
      await restoreTerminalPrefs(ctx, page, token, originalPrefs);
    }
  },
};
