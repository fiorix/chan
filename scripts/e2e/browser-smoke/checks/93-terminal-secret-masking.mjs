// terminal.secret_masking: the visual secret-masking feature end to end.
//
// Five legs against the REAL xterm pipeline (PTY -> server ring -> WS ->
// xterm buffer -> scan -> decoration DOM), mirroring 97's harness:
//
//   MASKED   -- workspace default off, then a stored on choice: printf
//               secret-looking assignments down the
//               PTY (the printf args split the secret NAMES so the echoed
//               command line itself carries no NAME= match), then assert
//               (a) the SERVER-side scrollback holds the CLEARTEXT (the
//               ring/replay contract: masking is visual only), and (b)
//               exactly two .terminal-secret-mask decoration elements
//               exist -- one for GH_TOKEN's value, one for the quoted
//               QUOTED_SECRET value -- while TOKENIZE/MONKEY/AUTHOR stay
//               unmasked. A trusted-input drag over the rows plus the
//               terminal's own copy chord then proves the clipboard
//               receives the REAL value: copy of a masked region yields
//               cleartext, which is a requirement, not a leak.
//   TOGGLE   -- the ephemeral per-tab toggle (chan:command
//               app.terminal.secretMasking.toggle, the launcher's path)
//               clears the decorations in place and surfaces the
//               transient status; a second dispatch re-masks in place.
//   SETTINGS -- the Terminal row shows the stored-on toggle and read-only
//               suffixes; Use default clears the choice and the workspace
//               default leaves the toggle off.
//   CONFIG   -- PATCH terminal.secret_masking=false through the
//               revisioned /api/config contract (the settings UI's own
//               chain), prove it persisted into the SANDBOXED
//               ${chanHome}/server.toml, and show a NEW terminal (the
//               flag is read at spawn time) renders NO masks.
//   GHOSTTY  -- with terminal.ghostty=true a new terminal mounts the
//               wasm backend (canvas, no xterm DOM) and masks on it: the
//               canvas pixels hold exactly two opaque rectangles of the
//               mask colour, one cell high, 13 and 7 cells wide (the two
//               values), while no decoration element exists; a drag over
//               the rows and the copy chord yield the cleartext; the
//               per-tab toggle clears the rectangles in place and a
//               second dispatch paints them again.
//
// Output progress is polled through `cs terminal scrollback`
// (server-side, renderer-independent; headless Chrome runs xterm's
// WebGL renderer so there is no .xterm-rows DOM to read). Decorations
// are renderer-independent: xterm always paints them as DOM overlay
// elements, so .terminal-secret-mask is a real observable. Under ghostty
// the mask is painted onto its 2D canvas, so the observable is the
// canvas's own pixels read back through getImageData.

import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { assertTerminalPrefs, readTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const TAB_DEFAULT = "SmokeMask93Default";
const TAB = "SmokeMask93";
const TAB_OFF = "SmokeMask93Off";
const TAB_G = "SmokeMask93G";
const SECRET_VALUE = "smoke93secret";
const CLIPBOARD_SENTINEL = "SMOKE93_CLIPBOARD_SENTINEL";
// The two masked values' widths in cells: GH_TOKEN's 13 and the quoted
// "a b c" with its quotes, 7. Under ghostty the mask rectangles on the
// canvas are these many cells wide, one cell high.
const MASK_CELLS = [13, 7];

// The printf args split every positive secret NAME across two quoted
// words, so the echoed command line contains no NAME= match and only
// program OUTPUT does. The third line is the negative corpus.
const PAYLOAD =
  `printf '%s%s\\n%s%s\\n%s\\n' 'GH_TO' 'KEN=${SECRET_VALUE}' ` +
  `'QUOTED_SE' 'CRET="a b c"' 'TOKENIZE=1 MONKEY=2 AUTHOR=alex'\n`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  name: "terminal-secret-masking",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    // Same window-id precedence as 70-cs-paste/96/97: the URL `?w=`
    // param may have been rewritten by an earlier check.
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
    const openTerminal = (name, backend) =>
      openAttachedTerminal(ctx, page, cs, windowId, name, backend);

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
      await cs(["write", "--tab-name", tab, "printf 'M93_%s\\n' READY\n"]);
      await waitScrollback(tab, "M93_READY");
    }

    function maskCount() {
      return page.evaluate(
        () => document.querySelectorAll(".terminal-secret-mask").length,
      );
    }

    /// Wait until exactly `want` mask decorations exist (or none, when
    /// `want` is 0 -- a settle window, since absence cannot be polled).
    async function awaitMaskCount(want) {
      if (want === 0) {
        await sleep(1_500);
        return maskCount();
      }
      try {
        await page.waitForFunction(
          (n) => document.querySelectorAll(".terminal-secret-mask").length === n,
          { timeout: 20_000 },
          want,
        );
      } catch (error) {
        throw new Error(`expected ${want} mask decorations, found ${await maskCount()}`, { cause: error });
      }
      return want;
    }

    /// Fire the launcher toggle exactly the way the catalog routes it.
    async function dispatchToggle() {
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("chan:command", {
            detail: { name: "app.terminal.secretMasking.toggle" },
          }),
        );
      });
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

    /// Renderer-independent selection probe via the terminal's own copy
    /// chord (Ctrl+Shift+C -> copySelectionToClipboard), same as 97.
    async function dragAndCopy() {
      const screen = await page.$(".terminal-tab .terminal.xterm .xterm-screen");
      if (!screen) {
        throw new Error(
          "xterm selector missing: .xterm-screen -- xterm internals renamed?",
        );
      }
      const box = await screen.boundingBox();
      if (!box) throw new Error("xterm screen has no bounding box");
      const x0 = box.x + 5;
      const y0 = box.y + 8;
      const x1 = box.x + Math.min(420, box.width - 10);
      const y1 = box.y + Math.min(90, box.height - 10);
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
        const ta = document.querySelector(".xterm-helper-textarea");
        if (!ta) {
          throw new Error(
            "xterm selector missing: .xterm-helper-textarea -- xterm internals renamed?",
          );
        }
        ta.focus();
        await navigator.clipboard.writeText(sentinel);
      }, CLIPBOARD_SENTINEL);
      await page.keyboard.down("Control");
      await page.keyboard.down("Shift");
      await page.keyboard.press("KeyC");
      await page.keyboard.up("Shift");
      await page.keyboard.up("Control");
      await sleep(300);
      return page.evaluate(() => navigator.clipboard.readText());
    }

    /// The opaque rectangles of the mask colour on ghostty's canvas, read
    /// back from its pixels: runs of mask pixels at least 16px long on a
    /// row, merged with the same run on the rows below. Text in the
    /// palette's bright black (the same colour) never makes a solid run
    /// a cell high, so a rectangle is a painted mask. Returns null while
    /// no ghostty canvas is mounted.
    function canvasMaskRects() {
      return page.evaluate(() => {
        const canvas = document.querySelector(".terminal-tab .terminal-host canvas");
        if (!canvas) return null;
        const { width, height } = canvas;
        const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
        const mask = (i) =>
          (data[i] === 0x6c && data[i + 1] === 0x6c && data[i + 2] === 0x70) ||
          (data[i] === 0x57 && data[i + 1] === 0x60 && data[i + 2] === 0x6a);
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
        return rects.filter((rect) => rect.h >= 8);
      });
    }

    /// Wait until the canvas holds exactly `want` mask rectangles, and
    /// for 0, that it still holds none half a second later.
    async function awaitCanvasMasks(want) {
      let last = null;
      const deadline = Date.now() + 20_000;
      for (;;) {
        last = await canvasMaskRects();
        if (last && last.length === want) break;
        if (Date.now() > deadline) {
          throw new Error(`expected ${want} mask rectangles on the ghostty canvas, found ${JSON.stringify(last)}`);
        }
        await sleep(200);
      }
      if (want === 0) {
        await sleep(500);
        last = await canvasMaskRects();
        if (!last || last.length !== 0) {
          throw new Error(`mask rectangles came back after clearing: ${JSON.stringify(last)}`);
        }
      }
      return last;
    }

    /// The ghostty counterpart of dragAndCopy: a trusted drag across the
    /// canvas (its SelectionManager listens there, not on the padded
    /// host) and the terminal's own copy chord from ghostty's textarea.
    async function dragAndCopyGhostty() {
      const canvas = await page.$(".terminal-tab .terminal-host canvas");
      if (!canvas) throw new Error(".terminal-host canvas missing");
      const box = await canvas.boundingBox();
      if (!box) throw new Error(".terminal-host canvas has no bounding box");
      const x0 = box.x + 5;
      const y0 = box.y + 8;
      const x1 = box.x + Math.min(420, box.width - 10);
      const y1 = box.y + Math.min(90, box.height - 10);
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
        const ta = document.querySelector(".terminal-host textarea");
        if (!ta) throw new Error("ghostty textarea selector missing: .terminal-host textarea");
        ta.focus();
        await navigator.clipboard.writeText(sentinel);
      }, CLIPBOARD_SENTINEL);
      await page.keyboard.down("Control");
      await page.keyboard.down("Shift");
      await page.keyboard.press("KeyC");
      await page.keyboard.up("Shift");
      await page.keyboard.up("Control");
      await sleep(300);
      return page.evaluate(() => navigator.clipboard.readText());
    }

    const details = {};
    let runError = null;
    try {
      await patchTerminalConfig({ ghostty: false, secret_masking: null });
      await assertToml({ ghostty: false, secret_masking: null });
      // ---- Leg 1a: the workspace default leaves xterm unmasked ----
      await openTerminal(TAB_DEFAULT, "xterm");
      await emitPayload(TAB_DEFAULT);
      if (!(await cs(["scrollback", "--tab-name", TAB_DEFAULT])).stdout.includes(`GH_TOKEN=${SECRET_VALUE}`)) {
        throw new Error("workspace-default scrollback lost the cleartext secret line");
      }
      if ((await awaitMaskCount(0)) !== 0) {
        throw new Error("workspace default painted secret masks without a stored choice");
      }
      await closeTerminal(TAB_DEFAULT);

      // ---- Leg 1b: a stored choice masks new xterm terminals ----
      await patchTerminalConfig({ secret_masking: true });
      await assertToml({ secret_masking: true });
      await openTerminal(TAB, "xterm");
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
      const masked = await awaitMaskCount(2);
      if (masked !== 2) {
        throw new Error(`expected 2 mask decorations, found ${masked}`);
      }
      details.maskedLeg = { decorations: 2, ringCleartext: true };
      await ctx.shot("masked-default-on");

      // Contract: copy of a masked region yields the real value.
      const copied = await dragAndCopy();
      if (!copied.includes(SECRET_VALUE)) {
        throw new Error(
          `copy of the masked rows did not yield the cleartext value; ` +
            `clipboard: ${JSON.stringify(copied.slice(0, 160))}`,
        );
      }
      details.maskedLeg.copyYieldsCleartext = true;

      // ---- Leg 2: TOGGLE (ephemeral, in place) ----
      await dispatchToggle();
      await awaitStatus("Secret masking disabled for this terminal");
      if ((await awaitMaskCount(0)) !== 0) {
        throw new Error("toggle off left mask decorations in place");
      }
      await ctx.shot("toggle-off-revealed");
      await dispatchToggle();
      await awaitStatus("Secret masking enabled for this terminal");
      await awaitMaskCount(2);
      details.toggleLeg = { offCleared: true, onRemasked: true };

      // ---- Leg 3: SETTINGS (stored choice and Use default) ----
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
        return {
          label: field.querySelector("label.pill")?.textContent.trim(),
          checked: field.querySelector('label.pill input[type="checkbox"]')?.checked,
          useDefault: [...field.querySelectorAll("button")].some(
            (button) => button.textContent.trim() === "Use default",
          ),
          summary: field.querySelector("details summary")?.textContent.trim(),
          chipCount: field.querySelectorAll(".chips.readonly .chip").length,
        };
      });
      if (settings.label !== "Mask secrets in new terminals" ||
          settings.checked !== true || settings.useDefault !== true) {
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
        const button = [...(field?.querySelectorAll("button") ?? [])].find(
          (candidate) => candidate.textContent.trim() === "Use default",
        );
        if (!button) throw new Error("Use default button missing");
        button.click();
      });
      await patch;
      await assertToml({ secret_masking: null });
      await page.waitForFunction(() => {
        const field = [...document.querySelectorAll("h3")].find(
          (h3) => h3.textContent.trim() === "Secret masking",
        )?.closest("section");
        return field?.querySelector('label.pill input[type="checkbox"]')?.checked === false &&
          ![...(field?.querySelectorAll("button") ?? [])].some(
            (button) => button.textContent.trim() === "Use default",
          );
      }, { timeout: 15_000 });
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => !document.querySelector('[aria-label="Settings sections"]'),
        { timeout: 10_000 },
      );
      await closeTerminal(TAB);

      // ---- Leg 4: CONFIG OFF (PATCH round-trip; spawn-time read) ----
      await patchTerminalConfig({ secret_masking: false });
      await assertToml({ secret_masking: false });
      await openTerminal(TAB_OFF, "xterm");
      await emitPayload(TAB_OFF);
      await waitScrollback(TAB_OFF, `GH_TOKEN=${SECRET_VALUE}`);
      if ((await awaitMaskCount(0)) !== 0) {
        throw new Error(
          "secret_masking=false yet a new terminal painted mask decorations",
        );
      }
      details.configOffLeg = { decorations: 0, tomlPersisted: true };
      await ctx.shot("config-off-unmasked");
      await closeTerminal(TAB_OFF);

      // ---- Leg 5: GHOSTTY (masked on the canvas, copy in clear) ----
      // Masking goes back ON here: leg 4 turned it off.
      await patchTerminalConfig({ secret_masking: true, ghostty: true });
      await assertToml({ secret_masking: true, ghostty: true });
      await openTerminal(TAB_G, "ghostty");
      await emitPayload(TAB_G);
      await waitScrollback(TAB_G, `GH_TOKEN=${SECRET_VALUE}`);
      if (
        await page.evaluate(() =>
          document.querySelector(".terminal-tab .terminal.xterm"),
        )
      ) {
        throw new Error("ghostty leg: xterm DOM present on a ghostty terminal");
      }
      // Two values, two rectangles: one cell high each, 13 and 7 cells
      // wide, so their widths stand in the values' ratio and their
      // heights agree. The xterm decorations are not built under ghostty.
      const rects = await awaitCanvasMasks(2);
      const [wide, narrow] = [...rects].sort((a, b) => b.w - a.w);
      if (wide.h !== narrow.h || wide.h < 8) {
        throw new Error(`ghostty leg: mask rectangles differ in height: ${JSON.stringify(rects)}`);
      }
      if (Math.abs(wide.w / narrow.w - MASK_CELLS[0] / MASK_CELLS[1]) > 0.05) {
        throw new Error(`ghostty leg: mask widths are not ${MASK_CELLS[0]}:${MASK_CELLS[1]} cells: ${JSON.stringify(rects)}`);
      }
      if (wide.y === narrow.y) {
        throw new Error(`ghostty leg: both masks on one row: ${JSON.stringify(rects)}`);
      }
      if ((await maskCount()) !== 0) {
        throw new Error("ghostty leg: xterm mask decorations on the wasm backend");
      }
      details.ghosttyLeg = { rects, decorations: 0, ringCleartext: true };
      await ctx.shot("ghostty-masked");

      // Contract: copy of a masked region yields the real value here too.
      const copiedG = await dragAndCopyGhostty();
      if (!copiedG.includes(SECRET_VALUE)) {
        throw new Error(
          `ghostty leg: copy of the masked rows did not yield the cleartext value; ` +
            `clipboard: ${JSON.stringify(copiedG.slice(0, 160))}`,
        );
      }
      details.ghosttyLeg.copyYieldsCleartext = true;

      // The per-tab toggle clears the canvas in place and paints again.
      await dispatchToggle();
      await awaitStatus("Secret masking disabled for this terminal");
      await awaitCanvasMasks(0);
      await ctx.shot("ghostty-toggle-off-revealed");
      await dispatchToggle();
      await awaitStatus("Secret masking enabled for this terminal");
      const again = await awaitCanvasMasks(2);
      details.ghosttyLeg.toggle = { offCleared: true, onRemasked: again.length === 2 };
      await closeTerminal(TAB_G);
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
      for (const tab of [TAB_DEFAULT, TAB, TAB_OFF, TAB_G]) {
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
