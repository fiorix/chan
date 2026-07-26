// terminal.ghostty toggle: the ghostty-web backend end-to-end.
//
// Three legs against the REAL settings round-trip and the REAL wasm
// terminal, mirroring 97-terminal-mouse-toggle's harness:
//
//   ON       -- flip terminal.ghostty=true via the same GET-mutate-PATCH
//               /api/config chain the settings UI uses, prove it
//               persisted into the SANDBOXED ${chanHome}/server.toml,
//               open a NEW terminal (the setting is read at spawn time)
//               and assert the ghostty backend actually loaded: its
//               .wasm asset was fetched, the host holds ghostty's canvas
//               and NO xterm DOM exists.
//   OSC52    -- ghostty-web's WASM parser swallows OSC 52 with no JS
//               hook, so chan bridges it byte-level (osc52Bridge.ts).
//               Seed the clipboard with a sentinel, printf a real OSC 52
//               copy down the PTY, poll the clipboard until the payload
//               text replaces the sentinel.
//   MOUSE    -- the full 97 matrix under the ghostty backend. With
//               mouse_capture ON (default), DECSET 1002;1006 engages
//               ghostty's InputHandler reporting: a click reaches the
//               PTY as an SGR report (`[<0;`) and a wheel as `[<64`
//               (chan's wheel shim -- upstream's capture-phase scroller
//               swallows the wheel before InputHandler sees it), while
//               a drag selects NOTHING (xterm ON-leg parity: reporting
//               clears the selection). With mouse_capture OFF the DECSET
//               strip runs ahead of the wasm parser, so the drag now
//               SELECTS and neither click nor wheel reports.
//   RESTORE  -- flip back to false, open another terminal, assert the
//               xterm DOM is back (the spawn-time read picks xterm
//               again), so later checks run the default backend.
//
// The OSC52/mouse drives go through the PTY like a real program: `cs
// terminal write` of a printf whose FORMAT string carries the escape
// text, so the echoed command line shows literal backslashes and only
// program OUTPUT contains real ESC bytes. Output progress is polled
// through `cs terminal scrollback` (server-side, renderer-independent).
// The drag uses trusted CDP input via page.mouse; selection is probed
// through the terminal's own copy chord (Ctrl+Shift+C ->
// copySelectionToClipboard no-ops on empty selection) with the
// clipboard pre-seeded with a sentinel, same as 97. Report probes are
// PTY-echo based: `cat -v` renders any SGR report as visible `^[[<...`
// text in the server-side scrollback.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const TAB_G = "SmokeGhostty98";
const TAB_X = "SmokeGhostty98X";
const MARK_PREFIX = "G98_";
const MARK_ARG = "READY";
const OSC52_TEXT = "GHOSTTY98_OSC52_OK";
const CLIPBOARD_SENTINEL = "SMOKE98_CLIPBOARD_SENTINEL";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  name: "terminal-ghostty-toggle",
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

    // The OSC52 + selection probes read/write the real clipboard.
    const cdp = await page.createCDPSession();
    await cdp.send("Browser.grantPermissions", {
      origin,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });

    /// Flip one terminal.* preference via the revisioned partial config
    /// contract. The terminal composite remains one server-owned field.
    /// Mirrors 97's setMouseCapture.
    async function setTerminalPref(key, on) {
      await page.evaluate(
        async ({ key, on, token }) => {
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
                [key]: on,
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
        { key, on, token: authToken },
      );
    }
    const setGhostty = (on) => setTerminalPref("ghostty", on);
    const setMouseCapture = (on) => setTerminalPref("mouse_capture", on);

    /// Assert the sandboxed server.toml records the expected value --
    /// proves the PATCH persisted into the throwaway CHAN_HOME, never
    /// the host's real config. Mirrors 97's assertTomlMouseCapture.
    async function assertTomlPref(key, expected) {
      const tomlPath = join(ctx.chanHome, "server.toml");
      const want = new RegExp(`${key}\\s*=\\s*${expected}`);
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
            `server.toml never recorded ${key} = ${expected}; ` +
              `path=${tomlPath} content:\n${last}`,
          );
        }
        await sleep(200);
      }
    }
    const assertTomlGhostty = (expected) => assertTomlPref("ghostty", expected);
    const assertTomlMouseCapture = (expected) =>
      assertTomlPref("mouse_capture", expected);

    /// Open a named terminal tab and wait for its live session AND its
    /// backend's DOM. Exactly one terminal tab may exist afterwards so
    /// the drag/selectors are unambiguous. backendSel distinguishes the
    /// renderers: ghostty mounts a bare canvas under .terminal-host and
    /// creates NO xterm DOM; xterm always builds .terminal.xterm.
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
      await page.waitForSelector(`.terminal-tab ${backendSel}`, {
        visible: true,
        timeout: 30_000,
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

    /// Poll the server-side scrollback (renderer-independent; see 97)
    /// until `needle` shows, proving the PTY ran the command and emitted
    /// its output. `cs terminal write` acks "queued at position N" --
    /// queued is NOT delivered, the idle-gate drains it -- so this poll
    /// is also what proves delivery.
    async function waitScrollback(tab, needle, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      let last = "";
      for (;;) {
        try {
          last = (await cs(["scrollback", "--tab-name", tab])).stdout;
          if (last.includes(needle)) return;
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

    /// The ghostty CANVAS's bounding box for trusted-input gestures.
    /// Measure the canvas, not .terminal-host: the host carries 8px of
    /// padding, and a mousedown that lands in the padding never reaches
    /// the canvas (SelectionManager listens there), so a drag starting
    /// at host+5 silently selects nothing. Same role as 97's
    /// .xterm-screen box.
    async function screenBox() {
      const canvas = await page.$(".terminal-tab .terminal-host canvas");
      if (!canvas) throw new Error(".terminal-host canvas missing");
      const box = await canvas.boundingBox();
      if (!box) throw new Error(".terminal-host canvas has no bounding box");
      return box;
    }

    /// Trusted-input click-drag diagonally across the top rows (prompt +
    /// echoed command + marker output all live there, so a multi-row
    /// selection necessarily covers rendered text). Mirrors 97.
    async function dragOverTopRows() {
      const box = await screenBox();
      const x0 = box.x + 5;
      const y0 = box.y + 8;
      const x1 = box.x + Math.min(320, box.width - 10);
      const y1 = box.y + Math.min(70, box.height - 10);
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      for (let s = 1; s <= 6; s++) {
        await page.mouse.move(
          x0 + ((x1 - x0) * s) / 6,
          y0 + ((y1 - y0) * s) / 6,
        );
      }
      await page.mouse.up();
      // Let the selection refresh settle.
      await sleep(250);
    }

    /// Trusted wheel-up over the terminal's center. Mirrors 97.
    async function wheelOverScreen() {
      const box = await screenBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel({ deltaY: -240 });
      await page.mouse.wheel({ deltaY: -240 });
    }

    /// Start `cat -v` so any bytes the terminal SENDS to the PTY echo
    /// into the server-side scrollback as visible text -- a
    /// renderer-independent observable for the wheel-report probe.
    async function startCatProbe(tab) {
      await cs(["write", "--tab-name", tab, "cat -v\n"]);
      await waitScrollback(tab, "cat -v");
      await sleep(800);
    }

    /// Selection probe via the terminal's own copy chord
    /// (Ctrl+Shift+C -> copySelectionToClipboard, a no-op on empty
    /// selection) with the clipboard pre-seeded with a sentinel.
    /// ghostty's hidden textarea (no xterm helper class) gets focus
    /// first so the keydown lands on the terminal.
    async function readSelectionViaCopy() {
      await page.evaluate(async (sentinel) => {
        const ta = document.querySelector(".terminal-host textarea");
        if (!ta) {
          throw new Error(
            "ghostty textarea selector missing: .terminal-host textarea",
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
      const text = await page.evaluate(() => navigator.clipboard.readText());
      return text === CLIPBOARD_SENTINEL ? "" : text;
    }

    const details = {};
    try {
      // ---- Leg 1: ON -- the ghostty backend loads for new terminals ----
      await setGhostty(true);
      await assertTomlGhostty(true);
      // The SPA learns of the flip via the config_changed WS frame ->
      // debounced (250ms) workspace refresh; give it a moment so the
      // NEW terminal's spawn-time read sees the fresh value.
      await sleep(2_000);
      await openTerminal(TAB_G, ".terminal-host canvas");
      // The lazy loader fetched the wasm asset (vite emits it hashed as
      // ghostty-vt-*.wasm) -- the definitive proof the backend is real,
      // not a silent xterm fallback.
      await page.waitForFunction(
        () =>
          performance
            .getEntriesByType("resource")
            .some((e) => e.name.includes("ghostty-vt")),
        { timeout: 20_000 },
      );
      if (
        await page.evaluate(() => !!document.querySelector(".terminal-tab .xterm"))
      ) {
        throw new Error(
          "ghostty leg: xterm DOM present under terminal.ghostty=true -- " +
            "the terminal fell back to (or never left) the xterm backend",
        );
      }
      await ctx.shot("ghostty-backend-loaded");
      details.onLeg = { wasmFetched: true, xtermDomAbsent: true };

      // ---- Leg 2: OSC52 clipboard copy reaches the system clipboard ----
      await page.evaluate(
        (sentinel) => navigator.clipboard.writeText(sentinel),
        CLIPBOARD_SENTINEL,
      );
      const osc52Payload = Buffer.from(OSC52_TEXT, "utf8").toString("base64");
      await cs([
        "write",
        "--tab-name",
        TAB_G,
        `printf '\\033]52;c;${osc52Payload}\\007${MARK_PREFIX}%s\\n' ${MARK_ARG}\n`,
      ]);
      await waitScrollback(TAB_G, `${MARK_PREFIX}${MARK_ARG}`);
      {
        const deadline = Date.now() + 15_000;
        let clip = "";
        for (;;) {
          clip = await page.evaluate(() => navigator.clipboard.readText());
          if (clip === OSC52_TEXT) break;
          if (Date.now() > deadline) {
            throw new Error(
              `OSC 52 never reached the clipboard under ghostty; ` +
                `clipboard=${JSON.stringify(clip.slice(0, 120))} -- ` +
                `the byte-level Osc52Bridge is not observing the write path`,
            );
          }
          await sleep(250);
        }
      }
      await ctx.shot("ghostty-osc52-clipboard");
      details.osc52Leg = { clipboard: true };

      // ---- Leg 3a: mouse_capture ON -- click + wheel report, drag does not select ----
      // DECSET 1002 (drag tracking) + 1006 (SGR encoding) down the PTY.
      await cs([
        "write",
        "--tab-name",
        TAB_G,
        `printf '\\033[?1002;1006h${MARK_PREFIX}MOUSE_%s\\n' ${MARK_ARG}\n`,
      ]);
      await waitScrollback(TAB_G, `${MARK_PREFIX}MOUSE_${MARK_ARG}`);
      await sleep(1_000);
      await startCatProbe(TAB_G);
      // Click positive control: with tracking active, a click reaches
      // the PTY as an SGR press/release pair (`[<0;c;rM` / `[<0;c;rm`,
      // echoed by cat -v) -- ghostty's InputHandler end-to-end through
      // chan's input path.
      {
        const box = await screenBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.up();
        await waitScrollback(TAB_G, "[<0;");
        details.mouseOnLeg = { clickReported: true };
      }
      // Wheel positive control via chan's shim (upstream's capture-phase
      // scroller stopPropagation()s the wheel before its InputHandler
      // sees it, so TerminalTab's handleGhosttyWheel encodes the report).
      await wheelOverScreen();
      await waitScrollback(TAB_G, "[<64");
      details.mouseOnLeg.wheelReported = true;
      await ctx.shot("ghostty-mouse-on-reported");
      // xterm ON-leg parity: with the TUI owning the pointer, a drag
      // selects NOTHING (under ghostty the report path clears the
      // in-progress selection; under xterm mouse mode disables the
      // SelectionService outright -- same user-visible outcome).
      await dragOverTopRows();
      const onSelection = await readSelectionViaCopy();
      if (onSelection !== "") {
        throw new Error(
          `mouse-on leg: drag selected text under an active mouse mode ` +
            `(${JSON.stringify(onSelection.slice(0, 120))}); expected ` +
            `xterm-ON parity (selection dies while a TUI owns the pointer)`,
        );
      }
      details.mouseOnLeg.selection = "";
      await closeTerminal(TAB_G);

      // ---- Leg 3b: mouse_capture OFF -- the DECSET strip works under ghostty ----
      await setMouseCapture(false);
      await assertTomlMouseCapture(false);
      // The SPA learns of the flip via config_changed; the NEW terminal's
      // spawn-time read must see it (mirrors 97's settle).
      await sleep(2_000);
      await openTerminal(TAB_G, ".terminal-host canvas");
      await cs([
        "write",
        "--tab-name",
        TAB_G,
        `printf '\\033[?1002;1006h${MARK_PREFIX}STRIP_%s\\n' ${MARK_ARG}\n`,
      ]);
      await waitScrollback(TAB_G, `${MARK_PREFIX}STRIP_${MARK_ARG}`);
      await sleep(1_000);
      // With the DECSET stripped ahead of the wasm parser, ghostty never
      // enters mouse mode, so the drag now SELECTS text.
      await dragOverTopRows();
      const offSelection = await readSelectionViaCopy();
      if (offSelection === "") {
        throw new Error(
          "mouse-off leg: mouse_capture=false yet the drag selected NOTHING " +
            "-- the DECSET strip did not keep the ghostty backend out of " +
            "mouse mode",
        );
      }
      details.mouseOffLeg = { selection: offSelection.slice(0, 120) };
      await ctx.shot("ghostty-mouse-off-drag-selected");
      // Negative probes: with tracking refused, the same click + wheel
      // that reported on the ON leg must send the PTY NOTHING. cat -v
      // would echo any report bytes; settle, then require their absence.
      // The ON leg's green reports are the positive controls.
      await startCatProbe(TAB_G);
      {
        const box = await screenBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.up();
        await wheelOverScreen();
        await sleep(1_500);
        const offTail = (await cs(["scrollback", "--tab-name", TAB_G])).stdout;
        if (offTail.includes("[<0;") || offTail.includes("[<64")) {
          throw new Error(
            "mouse-off leg: an SGR mouse report reached the PTY despite " +
              "mouse_capture=false -- the DECSET strip did not keep the " +
              "ghostty backend out of mouse mode",
          );
        }
      }
      details.mouseOffLeg.reportsSuppressed = true;
      await ctx.shot("ghostty-mouse-off-not-reported");
      await closeTerminal(TAB_G);
      await setMouseCapture(true);
      await assertTomlMouseCapture(true);

      // ---- Leg 4: RESTORE -- new terminals pick xterm again ----
      await setGhostty(false);
      await assertTomlGhostty(false);
      await sleep(2_000);
      await openTerminal(TAB_X, ".terminal.xterm .xterm-screen");
      await ctx.shot("xterm-backend-restored");
      details.restoreLeg = { xtermDom: true };
      await closeTerminal(TAB_X);
      return details;
    } finally {
      // Cleanup so nothing leaks into later checks: restore the default
      // settings, close any terminal tab either leg left open, keep the
      // clipboard grant (matches 97's final state).
      try {
        await setMouseCapture(true);
        await assertTomlMouseCapture(true);
      } catch (e) {
        console.error(
          `[z98-terminal-ghostty-toggle] WARNING: failed to restore mouse_capture=true: ${e.message}`,
        );
      }
      try {
        await setGhostty(false);
        await assertTomlGhostty(false);
      } catch (e) {
        // Loud, not fatal: a throw here would mask the real failure,
        // but a silently-failed restore would leave every later check
        // running with terminal.ghostty=true.
        console.error(
          `[z98-terminal-ghostty-toggle] WARNING: failed to restore ghostty=false: ${e.message}`,
        );
      }
      for (const tab of [TAB_G, TAB_X]) {
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
