// Secret masking through the PTY, server ring and Ghostty canvas.
// Default: no stored choice leaves a workspace terminal unmasked.
// Stored on: suffix matches mask only values, preserving ring and copy text.
// Toggle: the live tab changes in place without changing its stored choice.
// Settings: On and the suffix list are visible; Default clears the choice.
// Stored off: a fresh terminal paints output without masks.
// Re-enabled: a fresh terminal masks, copies cleartext and toggles again.

import { openAttachedTerminal, TERMINAL_SURFACE } from "../lib/terminal-attach.mjs";
import { assertTerminalPrefs, readTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const TAB_DEFAULT = "SmokeMask93Default";
const TAB = "SmokeMask93";
const TAB_OFF = "SmokeMask93Off";
const TAB_REENABLED = "SmokeMask93Reenabled";
const SECRET_VALUE = "smoke93secret";
const CLIPBOARD_SENTINEL = "SMOKE93_CLIPBOARD_SENTINEL";
// Quoted values include their quotes in the painted span.
const MASK_CELLS = [13, 7];
const LAUNCHER = '[role="dialog"][aria-label="Command launcher"]';
const LAUNCHER_INPUT = `${LAUNCHER} input[role="combobox"]`;
const LAUNCHER_SELECTED_TITLE = `${LAUNCHER} [role="option"][aria-selected="true"] .deck-result-title`;
const TOGGLE_ROW = "Secret masking (this terminal)";

// The printf args split every positive secret NAME across two quoted
// words, so the echoed command line contains no NAME= match. Clear/home
// puts output on known rows for selection; the coloured ready marker proves
// the canvas painted it even when the expected mask count is zero.
const PAYLOAD =
  `printf '\\033[2J\\033[H%s%s\\n%s%s\\n%s\\n\\033[48;2;37;181;123mM93_%s\\033[0m\\n' ` +
  `'GH_TO' 'KEN=${SECRET_VALUE}' 'QUOTED_SE' 'CRET="a b c"' ` +
  `'TOKENIZE=1 MONKEY=2 AUTHOR=alex' READY\n`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  name: "terminal-secret-masking",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) throw new Error("secret masking setup: control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    // The URL's window id takes precedence over the cached session id.
    const windowId = await page.evaluate(
      () =>
        new URL(location.href).searchParams.get("w")?.trim() ||
        window.sessionStorage.getItem("chan.session.window")?.trim() ||
        "",
    );
    if (!windowId) throw new Error("could not resolve the page's window id");
    const authToken = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const origin = new URL(ctx.serverUrl).origin;
    const env = {
      ...process.env,
      CHAN_CONTROL_SOCKET: socket,
      CHAN_WINDOW_ID: windowId,
    };
    const cs = (args, opts = {}) =>
      ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
        cwd: ctx.workspaceDir,
        env,
        timeout: 90_000,
        ...opts,
      });

    // The copy probe reads/writes the real clipboard.
    const cdp = await page.createCDPSession();
    await cdp.send("Browser.grantPermissions", {
      browserContextId: ctx.browser.id,
      origin,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });

    const originalPrefs = await readTerminalPrefs(page, authToken);
    const patchTerminalConfig = (changes) => writeTerminalPrefs(page, authToken, changes);
    const assertToml = (expected) => assertTerminalPrefs(ctx, expected);
    const openTerminal = (name) =>
      openAttachedTerminal(ctx, page, cs, windowId, name);

    async function closeTerminal(name) {
      await cs(["close", "--tab-name", name]);
      await page.waitForFunction(
        () => !document.querySelector(".terminal-tab"),
        { timeout: 15_000 },
      );
    }

    /// Poll the server-side scrollback until `needle` shows, proving the
    /// PTY ran the command and emitted its output. `cs terminal write`
    /// acks with "queued" -- queued is NOT delivered -- so this poll is
    /// also what proves delivery.
    async function waitScrollback(tab, needle, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      let last = "";
      for (;;) {
        try {
          last = (await cs(["scrollback", "--tab-name", tab])).stdout;
          if (last.includes(needle)) return last;
        } catch {
          // Session may still be registering; keep polling.
        }
        if (Date.now() > deadline) {
          throw new Error(
            `scrollback of ${tab} never showed ${JSON.stringify(needle)}; ` +
              `last scrollback:\n${last.slice(-2000)}`,
          );
        }
        await sleep(300);
      }
    }

    /// Emit the payload and its ready marker, then prove delivery.
    async function emitPayload(tab) {
      await cs(["write", "--tab-name", tab, PAYLOAD]);
      await waitScrollback(tab, "M93_READY");
    }

    /// The transient status pill auto-dismisses after 3s; poll for its
    /// text immediately after the action that sets it.
    async function awaitStatus(text) {
      await page.waitForFunction(
        (t) => document.body.textContent.includes(t),
        { timeout: 5_000, polling: 100 },
        text,
      );
    }

    /// Run the per-tab toggle from its launcher row and wait for `status`.
    /// The row changes in place and leaves the launcher open, so the status
    /// is read before Escape closes it; a closed launcher keeps its query,
    /// which the next run clears before typing.
    async function toggleFromLauncher(status) {
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("chan:command", { detail: { name: "app.launcher.toggle" } }),
        );
      });
      await page.waitForSelector(LAUNCHER_INPUT, { timeout: 10_000 });
      await page.$eval(LAUNCHER_INPUT, (input) => {
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.type(LAUNCHER_INPUT, TOGGLE_ROW);
      await page.waitForFunction(
        (selector, title) => document.querySelector(selector)?.textContent?.trim() === title,
        { timeout: 10_000 },
        LAUNCHER_SELECTED_TITLE,
        TOGGLE_ROW,
      );
      await page.keyboard.press("Enter");
      await awaitStatus(status);
      await page.keyboard.press("Escape");
      await page.waitForSelector(LAUNCHER, { hidden: true, timeout: 10_000 });
    }

    /// The opaque rectangles of the mask colour on the terminal's canvas, read
    /// back from its pixels: runs of mask pixels at least 16px long on a
    /// row, merged with the same run on the rows below. Text in the
    /// palette's bright black (the same colour) never makes a solid run
    /// a cell high, so a rectangle is a painted mask. Returns null while
    /// no ghostty canvas is mounted.
    function canvasMaskRects() {
      return page.evaluate((selector) => {
        const canvas = document.querySelector(selector);
        if (!(canvas instanceof HTMLCanvasElement) || !canvas.width || !canvas.height) return null;
        const { width, height } = canvas;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Ghostty canvas has no readable 2D context");
        const data = context.getImageData(0, 0, width, height).data;
        const mask = (i) =>
          data[i + 3] === 255 && (
            (data[i] === 0x6c && data[i + 1] === 0x6c && data[i + 2] === 0x70) ||
            (data[i] === 0x57 && data[i + 1] === 0x60 && data[i + 2] === 0x6a)
          );
        let markerPixels = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] === 37 && data[i + 1] === 181 && data[i + 2] === 123 && data[i + 3] === 255) markerPixels++;
        }
        const open = new Map();
        const rects = [];
        for (let y = 0; y < height; y++) {
          const runs = [];
          for (let x = 0; x < width; x++) {
            if (!mask((y * width + x) * 4)) continue;
            const run = runs[runs.length - 1];
            if (run && run.x1 === x) run.x1 = x + 1;
            else runs.push({ x0: x, x1: x + 1 });
          }
          const next = new Map();
          for (const run of runs) {
            if (run.x1 - run.x0 < 16) continue;
            const key = `${run.x0}:${run.x1}`;
            const above = open.get(key);
            if (above && above.y + above.h === y) {
              above.h += 1;
              next.set(key, above);
            } else {
              const rect = { x: run.x0, y, w: run.x1 - run.x0, h: 1 };
              rects.push(rect);
              next.set(key, rect);
            }
          }
          open.clear();
          for (const [key, rect] of next) open.set(key, rect);
        }
        return { rects: rects.filter((rect) => rect.h >= 8), markerPixels };
      }, `.terminal-tab ${TERMINAL_SURFACE}`);
    }

    /// Wait until the canvas holds exactly `want` mask rectangles, and
    /// for 0, that it still holds none half a second later.
    async function awaitCanvasMasks(want) {
      let last = null;
      const deadline = Date.now() + 20_000;
      for (;;) {
        last = await canvasMaskRects();
        if (last?.markerPixels >= 10 && last.rects.length === want) break;
        if (Date.now() > deadline) {
          throw new Error(`expected ${want} mask rectangles on the ghostty canvas, found ${JSON.stringify(last)}`);
        }
        await sleep(200);
      }
      if (want === 0) {
        await sleep(500);
        last = await canvasMaskRects();
        if (!last || last.markerPixels < 10 || last.rects.length !== 0) {
          throw new Error(`mask rectangles came back after clearing: ${JSON.stringify(last)}`);
        }
      }
      return last.rects;
    }

    function assertMaskGeometry(rects) {
      const [wide, narrow] = [...rects].sort((a, b) => b.w - a.w);
      if (rects.length !== 2 || wide.h !== narrow.h || wide.h < 8 || wide.y === narrow.y ||
          Math.abs(wide.w / narrow.w - MASK_CELLS[0] / MASK_CELLS[1]) > 0.05 ||
          wide.y !== 0 || narrow.y !== wide.h ||
          Math.abs(wide.x - 9 * wide.w / 13) > 2 ||
          Math.abs(narrow.x - 14 * narrow.w / 7) > 2) {
        throw new Error(`expected two one-row masks with ${MASK_CELLS.join(":")} cell widths: ${JSON.stringify(rects)}`);
      }
    }

    // A trusted canvas drag must focus the terminal without a private input seam.
    async function dragAndCopy(rects) {
      const canvas = await page.$(`.terminal-tab ${TERMINAL_SURFACE}`);
      if (!canvas) throw new Error(`${TERMINAL_SURFACE} missing`);
      const box = await canvas.boundingBox();
      if (!box) throw new Error(`${TERMINAL_SURFACE} has no bounding box`);
      const pixelHeight = await canvas.evaluate((element) => element.height);
      const cellHeight = rects[0].h * box.height / pixelHeight;
      const x0 = box.x + 1;
      const y0 = box.y + cellHeight / 2;
      const x1 = box.x + box.width - 2;
      const y1 = box.y + cellHeight * 2.5;
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      for (let s = 1; s <= 6; s++) {
        await page.mouse.move(
          x0 + ((x1 - x0) * s) / 6,
          y0 + ((y1 - y0) * s) / 6,
        );
      }
      await page.mouse.up();
      await sleep(250);
      await page.evaluate(async (sentinel) => {
        if (!document.querySelector(".terminal-host")?.contains(document.activeElement)) {
          throw new Error("canvas drag did not focus the terminal for copy");
        }
        await navigator.clipboard.writeText(sentinel);
      }, CLIPBOARD_SENTINEL);
      await page.keyboard.down("Control");
      await page.keyboard.down("Shift");
      await page.keyboard.press("KeyC");
      await page.keyboard.up("Shift");
      await page.keyboard.up("Control");
      await sleep(300);
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      for (const line of [`GH_TOKEN=${SECRET_VALUE}`, 'QUOTED_SECRET="a b c"', "TOKENIZE=1 MONKEY=2 AUTHOR=alex"]) {
        if (!copied.includes(line)) throw new Error(`masked copy lost ${JSON.stringify(line)}: ${JSON.stringify(copied.slice(0, 200))}`);
      }
      return copied;
    }

    const details = {};
    let runError = null;
    try {
      await ctx.waitWindowLive(windowId);
      await patchTerminalConfig({ secret_masking: null });
      await assertToml({ secret_masking: null });
      // The workspace default paints the corpus without masking its values.
      await openTerminal(TAB_DEFAULT);
      await emitPayload(TAB_DEFAULT);
      if (!(await cs(["scrollback", "--tab-name", TAB_DEFAULT])).stdout.includes(`GH_TOKEN=${SECRET_VALUE}`)) {
        throw new Error("workspace-default scrollback lost the cleartext secret line");
      }
      await awaitCanvasMasks(0);
      details.defaultLeg = { masks: 0, outputPainted: true, ringCleartext: true, storedChoice: null };
      await closeTerminal(TAB_DEFAULT);

      // Stored On masks the two suffix matches and leaves the negative corpus clear.
      await patchTerminalConfig({ secret_masking: true });
      await assertToml({ secret_masking: true });
      await openTerminal(TAB);
      await emitPayload(TAB);
      // Contract: the server ring (and therefore copy/replay/snapshots)
      // carries CLEARTEXT at all times. waitScrollback already proved it
      // for the marker; pin it for the secret line itself.
      const scrollback = (await cs(["scrollback", "--tab-name", TAB])).stdout;
      if (!scrollback.includes(`GH_TOKEN=${SECRET_VALUE}`)) {
        throw new Error(
          "server-side scrollback lost the cleartext secret line -- " +
            "masking must be visual only, the ring stays intact",
        );
      }
      const masked = await awaitCanvasMasks(2);
      assertMaskGeometry(masked);
      details.maskedLeg = { rects: masked, ringCleartext: true, storedChoice: true };
      await ctx.shot("masked-default-on");

      // Contract: copy of a masked region yields the real value.
      await dragAndCopy(masked);
      details.maskedLeg.copyYieldsCleartext = true;

      // The live toggle clears and restores masks without changing stored On.
      await toggleFromLauncher("Secret masking disabled for this terminal");
      await awaitCanvasMasks(0);
      await assertToml({ secret_masking: true });
      if ((await readTerminalPrefs(page, authToken)).secret_masking !== true) {
        throw new Error("per-tab toggle changed the stored masking preference");
      }
      await ctx.shot("toggle-off-revealed");
      await toggleFromLauncher("Secret masking enabled for this terminal");
      assertMaskGeometry(await awaitCanvasMasks(2));
      details.toggleLeg = { offCleared: true, onRemasked: true, storedChoice: true };

      // Settings shows On and twelve suffixes; Default clears the stored choice.
      await page.keyboard.down("Control");
      await page.keyboard.press("Comma");
      await page.keyboard.up("Control");
      await page.waitForSelector('[aria-label="Settings sections"]', {
        visible: true,
        timeout: 15_000,
      });
      await page.evaluate(() => {
        const rail = document.querySelector('[aria-label="Settings sections"]');
        const btn = [...rail.querySelectorAll("button")].find((b) =>
          b.textContent.trim().includes("Terminal"),
        );
        if (!btn) throw new Error("settings rail has no Terminal section");
        btn.click();
      });
      const settings = await page.evaluate(() => {
        const h3 = [...document.querySelectorAll("h3")].find(
          (el) => el.textContent.trim() === "Secret masking",
        );
        if (!h3) throw new Error("Terminal settings lack the Secret masking row");
        const field = h3.closest("section");
        if (!field) throw new Error("Secret masking row is not in a field section");
        const group = field.querySelector('[role="radiogroup"][aria-label="Secret masking"]');
        if (!group) throw new Error("Secret masking row has no radio group");
        return {
          // Each pill by its word, chosen when its radio is checked and the
          // row's own value lights it.
          pills: [...group.querySelectorAll("label.pill")].map((pill) => [
            pill.textContent.trim(),
            pill.querySelector('input[type="radio"]')?.checked === true &&
              pill.classList.contains("on"),
          ]),
          summary: field.querySelector("details summary")?.textContent.trim(),
          chipCount: field.querySelectorAll(".chips.readonly .chip").length,
        };
      });
      if (JSON.stringify(settings.pills) !==
          JSON.stringify([["On", true], ["Off", false], ["Default", false]])) {
        throw new Error(`stored masking choice not shown in settings: ${JSON.stringify(settings)}`);
      }
      if (settings.summary !== "Suffixes (12)" || settings.chipCount !== 12) {
        throw new Error(`read-only suffixes differ: ${JSON.stringify(settings)}`);
      }
      details.settingsLeg = settings;
      await ctx.shot("settings-stored-choice");
      const patch = page.waitForResponse(
        (response) => response.request().method() === "PATCH" &&
          response.url().includes("/api/config") && response.ok(),
        { timeout: 15_000 },
      );
      await page.evaluate(() => {
        const field = [...document.querySelectorAll("h3")].find(
          (h3) => h3.textContent.trim() === "Secret masking",
        )?.closest("section");
        const pill = [...(field?.querySelectorAll('[role="radiogroup"] label.pill') ?? [])].find(
          (candidate) => candidate.textContent.trim() === "Default",
        );
        const radio = pill?.querySelector('input[type="radio"]');
        if (!(radio instanceof HTMLInputElement)) throw new Error("Default pill missing");
        radio.click();
      });
      await patch;
      await assertToml({ secret_masking: null });
      await page.waitForFunction(() => {
        const field = [...document.querySelectorAll("h3")].find(
          (h3) => h3.textContent.trim() === "Secret masking",
        )?.closest("section");
        const pills = [...(field?.querySelectorAll('[role="radiogroup"] label.pill') ?? [])];
        const words = (chosen) => pills.filter(chosen).map((pill) => pill.textContent.trim()).join();
        // The radio the click checked and the pill the row's value lights.
        return words((pill) => pill.querySelector('input[type="radio"]')?.checked === true) === "Default" &&
          words((pill) => pill.classList.contains("on")) === "Default";
      }, { timeout: 15_000 });
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => !document.querySelector('[aria-label="Settings sections"]'),
        { timeout: 10_000 },
      );
      if ((await readTerminalPrefs(page, authToken)).secret_masking != null) {
        throw new Error("Default did not clear the stored masking preference");
      }
      // A preference save seeds future terminals; this live tab keeps its toggle.
      assertMaskGeometry(await awaitCanvasMasks(2));
      details.settingsLeg.defaultCleared = true;
      details.settingsLeg.liveChoiceRetained = true;
      await closeTerminal(TAB);

      // Stored Off survives persistence and seeds an unmasked fresh terminal.
      await patchTerminalConfig({ secret_masking: false });
      await assertToml({ secret_masking: false });
      await openTerminal(TAB_OFF);
      await emitPayload(TAB_OFF);
      await waitScrollback(TAB_OFF, `GH_TOKEN=${SECRET_VALUE}`);
      await awaitCanvasMasks(0);
      details.configOffLeg = { masks: 0, outputPainted: true, ringCleartext: true, tomlPersisted: true };
      await ctx.shot("config-off-unmasked");
      await closeTerminal(TAB_OFF);

      // Re-enabling the stored choice masks a fresh terminal and preserves copy.
      await patchTerminalConfig({ secret_masking: true });
      await assertToml({ secret_masking: true });
      await openTerminal(TAB_REENABLED);
      await emitPayload(TAB_REENABLED);
      await waitScrollback(TAB_REENABLED, `GH_TOKEN=${SECRET_VALUE}`);
      const rects = await awaitCanvasMasks(2);
      assertMaskGeometry(rects);
      await ctx.shot("reenabled-masked");
      await dragAndCopy(rects);
      details.reenabledLeg = { rects, ringCleartext: true, copyYieldsCleartext: true };

      // The per-tab toggle clears the canvas in place and paints again.
      await toggleFromLauncher("Secret masking disabled for this terminal");
      await awaitCanvasMasks(0);
      await ctx.shot("ghostty-toggle-off-revealed");
      await toggleFromLauncher("Secret masking enabled for this terminal");
      assertMaskGeometry(await awaitCanvasMasks(2));
      details.reenabledLeg.toggle = { offCleared: true, onRemasked: true };
      await closeTerminal(TAB_REENABLED);
      for (const leg of ["defaultLeg", "maskedLeg", "toggleLeg", "settingsLeg", "configOffLeg", "reenabledLeg"]) {
        if (!details[leg]) throw new Error(`secret masking leg did not run: ${leg}`);
      }
      return details;
    } catch (error) {
      runError = error;
      throw error;
    } finally {
      // Keep server preferences independent of check order.
      let restoreError = null;
      try {
        await restoreTerminalPrefs(ctx, page, authToken, originalPrefs);
      } catch (error) {
        restoreError = error;
      }
      for (const tab of [TAB_DEFAULT, TAB, TAB_OFF, TAB_REENABLED]) {
        try {
          await cs(["close", "--tab-name", tab]);
        } catch {}
      }
      try {
        await page.waitForFunction(
          () => !document.querySelector(".terminal-tab"),
          { timeout: 10_000 },
        );
      } catch {}
      await cdp.detach().catch(() => {});
      if (restoreError) {
        if (runError) console.error(`[93-terminal-secret-masking] restore failed: ${restoreError.message}`);
        else throw restoreError;
      }
    }
  },
};
