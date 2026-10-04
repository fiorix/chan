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
//               wasm backend (canvas, no xterm DOM); the toggle surfaces
//               "unavailable on ghostty backend" instead of failing
//               silently, and no decoration elements ever appear.
//
// Output progress is polled through `cs terminal scrollback`
// (server-side, renderer-independent; headless Chrome runs xterm's
// WebGL renderer so there is no .xterm-rows DOM to read). Decorations
// are renderer-independent: xterm always paints them as DOM overlay
// elements, so .terminal-secret-mask is a real observable.

import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { assertTerminalPrefs, readTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const TAB_DEFAULT = "SmokeMask93Default";
const TAB = "SmokeMask93";
const TAB_OFF = "SmokeMask93Off";
const TAB_G = "SmokeMask93G";
const SECRET_VALUE = "smoke93secret";
const CLIPBOARD_SENTINEL = "SMOKE93_CLIPBOARD_SENTINEL";

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

      // ---- Leg 5: GHOSTTY (unavailable, no decoration code) ----
      // Masking goes back ON here. Leg 4 turned it off, and leaving it off
      // made "no mask decorations on the wasm backend" true because the
      // feature was disabled, not because the backend has no decoration code.
      // The assertion could not fail for the reason it names.
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
      await dispatchToggle();
      await awaitStatus("Secret masking unavailable on ghostty backend");
      if ((await awaitMaskCount(0)) !== 0) {
        throw new Error("ghostty leg: mask decorations on the wasm backend");
      }
      details.ghosttyLeg = {
        unavailableReported: true,
        decorations: 0,
        maskingEnabled: true,
      };
      await ctx.shot("ghostty-unavailable");
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
