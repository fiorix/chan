// Item B: terminal.mouse_capture toggle, narrow variant.
//
// Two legs against the REAL settings round-trip and the REAL xterm mouse
// machinery:
//
//   DEFAULT-ON  -- today's behavior: a program that enables DECSET mouse
//                  reporting (1002;1006, what a real ncurses TUI sends)
//                  captures the pointer, so a click-drag over rendered
//                  text selects NOTHING.
//   OFF         -- flip terminal.mouse_capture=false via the same
//                  GET-mutate-PATCH /api/config chain the settings UI
//                  uses, prove it persisted into the SANDBOXED
//                  ${chanHome}/server.toml (never the host's), open a
//                  NEW terminal (the setting is read at spawn time),
//                  drive the same DECSET, and assert the drag now
//                  SELECTS text and the wheel no longer reports to
//                  the TUI.
//
// The wheel probes are PTY-echo based (`cat -v` renders any SGR wheel
// report as visible `^[[<64...` text in the server-side scrollback):
// the ON leg requires the report (also proving the wheel synthesis
// works), the OFF leg requires its absence. DOM scroll positions are
// NOT probed: xterm 6's WebGL renderer paints its own scrollbar and
// never moves `.xterm-viewport`'s scrollTop.
//
// The mouse-mode drive goes through the PTY like a real TUI: `cs
// terminal write` of a printf whose FORMAT string contains the DECSET
// enable plus half the ready marker (the %s arg carries the other half,
// so the contiguous marker only ever appears in program OUTPUT, never in
// the echoed command line). Output progress is polled through `cs
// terminal scrollback` because headless Chrome runs xterm's WEBGL
// renderer (shouldUseWebglRenderer is true off the Linux Tauri desktop),
// so there is no .xterm-rows/.xterm-selection DOM to read.
//
// The drag uses trusted CDP input via page.mouse: mouse.down() carries
// clickCount:1 -> event.detail 1, which xterm's SelectionService
// requires (it ignores detail:0 synthetics). Selection is then probed
// renderer-independently through the terminal's own copy chord
// (Ctrl+Shift+C -> navigator.clipboard.writeText(term.getSelection()),
// an explicit NO-OP on empty selection): seed the clipboard with a
// sentinel, fire the chord, read the clipboard back -- sentinel still
// there means no selection existed.
//
// The remaining DOM probes (.terminal.xterm's enable-mouse-events class,
// .xterm-screen, .xterm-helper-textarea) come from
// CoreBrowserTerminal and exist under every renderer; each throws loudly
// if an xterm bump renames them instead of passing vacuously.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const TAB_ON = "SmokeMouse97On";
const TAB_OFF = "SmokeMouse97Off";
// Split markers: format half + arg half; contiguous only in output.
const MARK_PREFIX = { on: "M97ON_", off: "M97OFF_" };
const MARK_ARG = "READY";
const CLIPBOARD_SENTINEL = "SMOKE97_CLIPBOARD_SENTINEL";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  name: "terminal-mouse-toggle",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    // Same window-id precedence as 70-cs-paste/96: the URL `?w=` param
    // may have been rewritten by an earlier check.
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

    // The selection probe reads/writes the real clipboard.
    const cdp = await page.createCDPSession();
    await cdp.send("Browser.grantPermissions", {
      origin,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });

    /// Flip terminal.mouse_capture via the exact settings-UI shape: a
    /// serialized in-page GET /api/config -> mutate the terminal slice
    /// preserving siblings -> whole-block PATCH (updateGlobalConfigSerial's
    /// contract, state/configWrite.ts).
    async function setMouseCapture(on) {
      await page.evaluate(
        async ({ on, token }) => {
          const headers = { "content-type": "application/json" };
          if (token) headers.authorization = `Bearer ${token}`;
          const got = await fetch("/api/config", { headers });
          if (!got.ok) throw new Error(`GET /api/config -> ${got.status}`);
          const cfg = await got.json();
          const body = {
            ...cfg,
            preferences: {
              ...cfg.preferences,
              terminal: {
                ...(cfg.preferences?.terminal ?? {}),
                mouse_capture: on,
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
        { on, token: authToken },
      );
    }

    /// Assert the sandboxed server.toml records the expected value --
    /// proves the PATCH persisted into the throwaway CHAN_HOME, never
    /// the host's real config. apply_preferences saves before the PATCH
    /// responds, so a short poll only papers over fs latency.
    async function assertTomlMouseCapture(expected) {
      const tomlPath = join(ctx.chanHome, "server.toml");
      const want = new RegExp(`mouse_capture\\s*=\\s*${expected}`);
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
            `server.toml never recorded mouse_capture = ${expected}; ` +
              `path=${tomlPath} content:\n${last}`,
          );
        }
        await sleep(200);
      }
    }

    /// Open a named terminal tab and wait for its live session AND its
    /// xterm DOM. Exactly one terminal tab may exist afterwards so the
    /// drag/selectors are unambiguous.
    async function openTerminal(name) {
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
      await page.waitForSelector(".terminal-tab .terminal.xterm .xterm-screen", {
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

    /// Poll the server-side scrollback (renderer-independent; see header)
    /// until `needle` shows, proving the PTY ran the command and emitted
    /// its output. `cs terminal write` acks with "queued at position N"
    /// -- queued is NOT delivered, the idle-gate drains it -- so this
    /// poll is also what proves delivery.
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

    /// Drive the shell into mouse-reporting mode like a real TUI: DECSET
    /// 1002 (drag tracking) + 1006 (SGR encoding) straight down the PTY,
    /// then the ready marker.
    async function enableMouseMode(tab, markPrefix) {
      const cmd = `printf '\\033[?1002;1006h${markPrefix}%s\\n' ${MARK_ARG}\n`;
      await cs(["write", "--tab-name", tab, cmd]);
      const marker = `${markPrefix}${MARK_ARG}`;
      await waitScrollback(tab, marker);
      // The scrollback poll proves the SERVER saw the output; give the
      // WS frame a beat to reach the page's xterm before DOM asserts.
      await sleep(1_000);
      return marker;
    }

    function hasMouseEventsClass() {
      return page.evaluate(() => {
        const el = document.querySelector(".terminal.xterm");
        if (!el) {
          throw new Error(
            "xterm selector missing: .terminal.xterm -- xterm internals renamed?",
          );
        }
        return el.classList.contains("enable-mouse-events");
      });
    }

    async function screenBox() {
      const screen = await page.$(".terminal-tab .terminal.xterm .xterm-screen");
      if (!screen) {
        throw new Error(
          "xterm selector missing: .xterm-screen -- xterm internals renamed?",
        );
      }
      const box = await screen.boundingBox();
      if (!box) throw new Error("xterm screen has no bounding box");
      return box;
    }

    /// Trusted-input click-drag diagonally across the top rows (prompt +
    /// echoed command + marker output all live there, so a multi-row
    /// selection necessarily covers rendered text). page.mouse.down()
    /// dispatches clickCount:1 -> detail 1, which SelectionService
    /// requires.
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
      // Let xterm's selection refresh settle.
      await sleep(250);
    }

    /// Synthesize a trusted wheel-up over the terminal screen's center.
    async function wheelOverScreen() {
      const box = await screenBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel({ deltaY: -240 });
      await page.mouse.wheel({ deltaY: -240 });
    }

    /// Start `cat -v` in the tab's PTY so any byte the terminal SENDS to
    /// the PTY (e.g. an SGR wheel report) echoes into the server-side
    /// scrollback as visible text (`^[[<64;x;yM`) -- a renderer-independent
    /// observable. xterm 6's WebGL renderer paints its own scrollbar and
    /// keeps `.xterm-viewport` unscrolled, so DOM scrollTop probes cannot
    /// see wheel behavior; the PTY echo can.
    async function startCatProbe(tab) {
      await cs(["write", "--tab-name", tab, "cat -v\n"]);
      await waitScrollback(tab, "cat -v");
      // The echo proves delivery; give the shell a beat to exec cat so the
      // wheel bytes land in cat's stdin, not readline's.
      await sleep(800);
    }

    /// Renderer-independent selection probe via the terminal's own copy
    /// chord (Ctrl+Shift+C on non-mac): copySelectionToClipboard writes
    /// term.getSelection() to the clipboard and no-ops when empty.
    /// Returns the selected text ("" when no selection existed).
    async function readSelectionViaCopy() {
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
      const text = await page.evaluate(() => navigator.clipboard.readText());
      return text === CLIPBOARD_SENTINEL ? "" : text;
    }

    const details = {};
    try {
      // ---- Leg 1: DEFAULT ON (today's behavior) ----
      await openTerminal(TAB_ON);
      await enableMouseMode(TAB_ON, MARK_PREFIX.on);
      // Mouse mode engaged: xterm stamps enable-mouse-events exactly
      // when it binds the mouse-report listeners.
      await page.waitForFunction(
        () =>
          document
            .querySelector(".terminal.xterm")
            ?.classList.contains("enable-mouse-events"),
        { timeout: 20_000 },
      );
      await ctx.shot("on-mouse-mode");
      await dragOverTopRows();
      const onSelection = await readSelectionViaCopy();
      if (onSelection !== "") {
        throw new Error(
          `default-on leg: drag selected text under an active mouse mode ` +
            `(${JSON.stringify(onSelection.slice(0, 120))}); capture no ` +
            `longer matches today's behavior`,
        );
      }
      details.onLeg = { mouseMode: true, selection: "" };
      await ctx.shot("on-drag-captured");
      // Positive wheel control: with capture on and mouse mode active,
      // a wheel-up over the terminal must reach the TUI as an SGR wheel
      // report (`\x1b[<64;x;yM`, echoed by cat -v as `^[[<64...`). This
      // also proves the wheel synthesis works, so the OFF leg's
      // absence-assert below cannot pass vacuously.
      await startCatProbe(TAB_ON);
      await wheelOverScreen();
      await waitScrollback(TAB_ON, "[<64");
      details.onLeg.wheelReported = true;
      await closeTerminal(TAB_ON);

      // ---- Leg 2: OFF (new terminal reads the setting at spawn) ----
      await setMouseCapture(false);
      await assertTomlMouseCapture(false);
      // The SPA learns of the flip via the config_changed WS frame ->
      // debounced (250ms) workspace refresh; give it a moment so the
      // NEW terminal's spawn-time read sees the fresh value.
      await sleep(2_000);
      await openTerminal(TAB_OFF);
      await enableMouseMode(TAB_OFF, MARK_PREFIX.off);
      await ctx.shot("off-mouse-mode-refused");
      await dragOverTopRows();
      const offSelection = await readSelectionViaCopy();
      if (offSelection === "") {
        throw new Error(
          "off leg: mouse_capture=false yet the drag selected NOTHING -- " +
            "the terminal still let the TUI capture the mouse " +
            "(DECSET strip mechanism missing or inactive)",
        );
      }
      // With the DECSET stripped, xterm must never have bound the
      // mouse-report listeners.
      if (await hasMouseEventsClass()) {
        throw new Error(
          "off leg: enable-mouse-events class present -- xterm entered " +
            "mouse mode despite mouse_capture=false",
        );
      }
      await ctx.shot("off-drag-selected");

      // Wheel negative probe: with the DECSET stripped, the same wheel
      // that produced an SGR report on the ON leg must send the TUI
      // NOTHING (xterm keeps the wheel for local scrollback / native
      // scrolling instead). cat -v would echo any report bytes into the
      // scrollback; settle, then require their absence. The ON leg's
      // green report is the positive control for this probe's synthesis.
      await startCatProbe(TAB_OFF);
      await wheelOverScreen();
      await sleep(1_500);
      const offTail = (await cs(["scrollback", "--tab-name", TAB_OFF])).stdout;
      if (offTail.includes("[<64") || offTail.includes("[<65")) {
        throw new Error(
          "off leg: an SGR wheel report reached the PTY despite " +
            "mouse_capture=false -- the DECSET strip did not keep xterm " +
            "out of mouse mode",
        );
      }
      details.offLeg = {
        selection: offSelection.slice(0, 120),
        mouseMode: false,
        wheelReportSuppressed: true,
      };
      await ctx.shot("off-wheel-not-reported");
      await closeTerminal(TAB_OFF);
      return details;
    } finally {
      // Cleanup so nothing leaks into later checks: restore the default
      // setting, close any terminal tab either leg left open, keep the
      // clipboard grant (matches 70-cs-paste's final state).
      try {
        await setMouseCapture(true);
        await assertTomlMouseCapture(true);
      } catch (e) {
        // Loud, not fatal: a throw here would mask the real failure,
        // but a silently-failed restore would leave every later check
        // running with mouse_capture=false.
        console.error(
          `[97-terminal-mouse-toggle] WARNING: failed to restore mouse_capture=true: ${e.message}`,
        );
      }
      for (const tab of [TAB_ON, TAB_OFF]) {
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
