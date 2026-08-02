// terminal.secret_masking: the visual secret-masking feature end to end.
//
// Five legs against the REAL xterm pipeline (PTY -> server ring -> WS ->
// xterm buffer -> scan -> decoration DOM), mirroring 97's harness:
//
//   MASKED   -- default on: printf secret-looking assignments down the
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
//   SETTINGS -- the display-only Terminal settings row: Ctrl+, opens the
//               overlay, the Terminal section shows "Secret masking" with
//               the effective Enabled state and the collapsed Suffixes
//               (12) chip list, and the field owns NO button (every
//               editable sibling renders a PillToggle button).
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

import { readFileSync } from "node:fs";
import { join } from "node:path";

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
      origin,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });

    /// Mutate terminal.* fields through the revisioned partial config
    /// contract -- the same GET-mutate-PATCH chain the settings UI uses.
    async function patchTerminalConfig(patch) {
      await page.evaluate(
        async ({ patch, token }) => {
          const headers = { "content-type": "application/json" };
          if (token) headers.authorization = `Bearer ${token}`;
          const got = await fetch("/api/config", { headers });
          if (!got.ok) throw new Error(`GET /api/config -> ${got.status}`);
          const cfg = await got.json();
          const body = {
            expected_revision: cfg.revision,
            preferences: {
              terminal: {
                ...(cfg.preferences?.terminal ?? {}),
                ...patch,
              },
            },
          };
          const patched = await fetch("/api/config", {
            method: "PATCH",
            headers,
            body: JSON.stringify(body),
          });
          if (!patched.ok) {
            throw new Error(`PATCH /api/config -> ${patched.status}`);
          }
        },
        { patch, token: authToken },
      );
    }

    /// Assert the sandboxed server.toml records the expected assignment --
    /// proves the PATCH persisted into the throwaway CHAN_HOME, never the
    /// host's real config.
    async function assertToml(want, label) {
      const tomlPath = join(ctx.chanHome, "server.toml");
      const deadline = Date.now() + 5_000;
      let last = "";
      for (;;) {
        try {
          last = readFileSync(tomlPath, "utf8");
          if (want.test(last)) return;
        } catch {
          // File may not exist until the first settings write.
        }
        if (Date.now() > deadline) {
          throw new Error(
            `server.toml never recorded ${label}; ` +
              `path=${tomlPath} content:\n${last}`,
          );
        }
        await sleep(200);
      }
    }

    /// Open a named terminal tab and wait for its live session AND its
    /// backend DOM. Exactly one terminal tab may exist afterwards so the
    /// selectors are unambiguous.
    async function openTerminal(name, backendSel) {
      await cs(["new", "--tab-name", name]);
      const deadline = Date.now() + 30_000;
      for (;;) {
        const { stdout } = await cs(["list", "--json"]);
        const sessions = Object.values(JSON.parse(stdout).groups ?? {}).flat();
        if (sessions.some((s) => s.name === name)) break;
        if (Date.now() > deadline) {
          throw new Error(`session ${name} never registered`);
        }
        await sleep(250);
      }
      // 60s, not a fitted value: the ghostty leg's wasm load is the
      // slowest mount in the suite (94 established the same bound).
      await page.waitForSelector(`.terminal-tab ${backendSel}`, {
        visible: true,
        timeout: 60_000,
      });
      const tabs = await page.$$(".terminal-tab");
      if (tabs.length !== 1) {
        throw new Error(`expected exactly 1 terminal tab, found ${tabs.length}`);
      }
    }

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
      await page.waitForFunction(
        (n) => document.querySelectorAll(".terminal-secret-mask").length === n,
        { timeout: 20_000 },
        want,
      );
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
    try {
      // ---- Leg 1: MASKED (default on) ----
      await openTerminal(TAB, ".terminal.xterm .xterm-screen");
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

      // ---- Leg 3: SETTINGS (display-only row) ----
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
        const value = field.querySelector(".value")?.textContent.trim();
        const summary = field.querySelector("details summary");
        if (!summary) throw new Error("Secret masking row lacks the suffix list");
        const chipCount = field.querySelectorAll(".chips.readonly .chip").length;
        return {
          value,
          summary: summary.textContent.trim(),
          buttons: field.querySelectorAll("button").length,
          chipCount,
        };
      });
      if (settings.value !== "Enabled") {
        throw new Error(
          `settings row shows ${JSON.stringify(settings.value)}, expected Enabled`,
        );
      }
      if (settings.summary !== "Suffixes (12)") {
        throw new Error(
          `settings row shows ${JSON.stringify(settings.summary)}, expected "Suffixes (12)"`,
        );
      }
      if (settings.buttons !== 0) {
        throw new Error(
          "settings row renders a button -- the display-only row must own no control",
        );
      }
      if (settings.chipCount !== 12) {
        throw new Error(`expected 12 read-only suffix chips, found ${settings.chipCount}`);
      }
      details.settingsLeg = settings;
      await ctx.shot("settings-readonly-row");
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => !document.querySelector('[aria-label="Settings sections"]'),
        { timeout: 10_000 },
      );
      await closeTerminal(TAB);

      // ---- Leg 4: CONFIG OFF (PATCH round-trip; spawn-time read) ----
      await patchTerminalConfig({ secret_masking: false });
      await assertToml(/secret_masking\s*=\s*false/, "secret_masking = false");
      // The SPA learns of the flip via the config_changed WS frame; give
      // it a moment so the NEW terminal's spawn-time read sees it.
      await sleep(2_000);
      await openTerminal(TAB_OFF, ".terminal.xterm .xterm-screen");
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
      await patchTerminalConfig({ ghostty: true });
      await assertToml(/ghostty\s*=\s*true/, "ghostty = true");
      await sleep(2_000);
      await openTerminal(TAB_G, ".terminal-host canvas");
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
      details.ghosttyLeg = { unavailableReported: true, decorations: 0 };
      await ctx.shot("ghostty-unavailable");
      await closeTerminal(TAB_G);
      return details;
    } finally {
      // Cleanup so nothing leaks into later checks: restore both config
      // fields, close any terminal tab a leg left open, keep the
      // clipboard grant (matches 94/97's final state).
      try {
        await patchTerminalConfig({ secret_masking: true, ghostty: false });
        await assertToml(/secret_masking\s*=\s*true/, "secret_masking = true");
        await assertToml(/ghostty\s*=\s*false/, "ghostty = false");
      } catch (e) {
        // Loud, not fatal: a silently-failed restore would leave every
        // later check running with masking off or the ghostty backend.
        console.error(
          `[93-terminal-secret-masking] WARNING: failed to restore config: ${e.message}`,
        );
      }
      for (const tab of [TAB, TAB_OFF, TAB_G]) {
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
    }
  },
};
