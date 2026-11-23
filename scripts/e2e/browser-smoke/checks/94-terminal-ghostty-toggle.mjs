// Ghostty loading and compatibility with the retired terminal.ghostty key.
// Absent and boolean API patches must open Ghostty. A stored false must be
// ignored on load, survive that read unchanged, and disappear on normal save.
// Reload must retain the PTY. The real wasm, full-width initial fit, macOS
// host chords, OSC 52, paste bytes and mouse capture/selection stay required.
// PTY output and cat -v witness the byte contracts independently of paint;
// trusted CDP gestures and the copy chord witness selection.
// A raw fixture pins press-only tracking, wrapped multi-clicks and Shift release;
// every drag seeds its sentinel before pressing, including reporting drags.

import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openAttachedTerminal, TERMINAL_SURFACES } from "../lib/terminal-attach.mjs";
import { startTerminalFixture } from "../lib/terminal-fixture.mjs";
import { capturePointerTerminals, copyPointerSelection, drainPointerInput, pointerGrid, pointerReports, pointerTerminal, seedPointerClipboard, settlePointer } from "../lib/terminal-pointer.mjs";
import { assertTerminalPrefs, openLegacyConfiguredTerminal, readTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";
import { waitRestoredTerminal, waitSaved } from "./290-rich-prompt-disconnected.mjs";

const TAB_G = "SmokeGhostty98";
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
    const originalPrefs = await readTerminalPrefs(page, authToken);
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
    await cdp.send("Network.enable");
    const terminalSocketUrls = [];
    const resizeFrames = [];
    cdp.on("Network.webSocketCreated", ({ url }) => {
      if (url.includes("/api/terminal/ws")) terminalSocketUrls.push(url);
    });
    cdp.on("Network.webSocketFrameSent", ({ response }) => {
      try {
        const frame = JSON.parse(response.payloadData);
        if (
          frame?.type === "resize" &&
          Number.isInteger(frame.cols) &&
          Number.isInteger(frame.rows)
        ) {
          resizeFrames.push({ cols: frame.cols, rows: frame.rows });
        }
      } catch {
        // Binary terminal input and non-JSON frames are not resize evidence.
      }
    });
    await cdp.send("Browser.grantPermissions", {
      origin,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });

    const setMouseCapture = (on) => writeTerminalPrefs(page, authToken, { mouse_capture: on });
    const assertTomlMouseCapture = (on) => assertTerminalPrefs(ctx, { mouse_capture: on });

    async function assertOnlyGhostty() {
      const tabs = await page.$$(".terminal-tab");
      assert.equal(tabs.length, 1, "exactly one terminal tab makes the input probes unambiguous");
      assert.equal(await page.evaluate(() => !!document.querySelector(".terminal-tab .terminal.xterm")),
        false, "Ghostty must not fall back to xterm DOM");
    }

    async function openTerminal(newArgs = []) {
      const row = await openAttachedTerminal(ctx, page, cs, windowId, TAB_G, "ghostty", newArgs);
      await assertOnlyGhostty();
      return row;
    }

    async function closeTerminal(name) {
      await cs(["close", "--tab-name", name]);
      await page.waitForFunction(
        () => !document.querySelector(".terminal-tab"),
        { timeout: 15_000 },
      );
    }

    /// Wait for the browser's PTY resize frame to settle, then capture the
    /// host content box and Ghostty canvas before any user resize.
    async function terminalFitSnapshot(tabName, frameStart, socketStart) {
      const deadline = Date.now() + 15_000;
      let lastFrame = null;
      let stableSince = 0;
      for (;;) {
        const candidate = resizeFrames.at(-1) ?? null;
        if (resizeFrames.length > frameStart && candidate) {
          if (
            !lastFrame ||
            candidate.cols !== lastFrame.cols ||
            candidate.rows !== lastFrame.rows
          ) {
            lastFrame = candidate;
            stableSince = Date.now();
          } else if (Date.now() - stableSince >= 500) {
            break;
          }
        }
        if (Date.now() > deadline) {
          throw new Error(
            `Ghostty fit probe: no stable PTY resize frame after index ${frameStart}`,
          );
        }
        await sleep(100);
      }
      const layout = await page.evaluate((surface) => {
        const host = document.querySelector(".terminal-tab .terminal-host");
        const canvas = document.querySelector(`.terminal-tab ${surface}`);
        if (!(host instanceof HTMLElement)) {
          throw new Error(`Ghostty fit probe: terminal host missing`);
        }
        const style = window.getComputedStyle(host);
        return {
          backend: "ghostty",
          hostWidth: host.clientWidth,
          hostHeight: host.clientHeight,
          padding: {
            top: Number.parseFloat(style.paddingTop) || 0,
            right: Number.parseFloat(style.paddingRight) || 0,
            bottom: Number.parseFloat(style.paddingBottom) || 0,
            left: Number.parseFloat(style.paddingLeft) || 0,
          },
          canvasWidth: canvas?.getBoundingClientRect().width ?? null,
        };
      }, TERMINAL_SURFACES.ghostty);
      const socketUrl = terminalSocketUrls
        .slice(socketStart)
        .find(
          (url) => new URL(url).searchParams.get("tab_name") === tabName,
        );
      if (!socketUrl) {
        throw new Error(`Ghostty fit probe: terminal socket URL missing`);
      }
      const socketQuery = new URL(socketUrl).searchParams;
      const initialSocket = {
        cols: Number(socketQuery.get("cols")),
        rows: Number(socketQuery.get("rows")),
      };
      if (
        initialSocket.cols !== lastFrame.cols ||
        initialSocket.rows !== lastFrame.rows
      ) {
        throw new Error(
          `Ghostty fit probe: initial socket grid did not match the measured grid; ` +
            `socket=${JSON.stringify(initialSocket)} measured=${JSON.stringify(lastFrame)}`,
        );
      }
      return { ...layout, ...lastFrame, initialSocket };
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
    /// at host+5 silently selects nothing.
    async function screenBox() {
      const canvas = await page.$(`.terminal-tab ${TERMINAL_SURFACES.ghostty}`);
      if (!canvas) throw new Error(`${TERMINAL_SURFACES.ghostty} missing`);
      const box = await canvas.boundingBox();
      if (!box) throw new Error(`${TERMINAL_SURFACES.ghostty} has no bounding box`);
      return box;
    }

    /// Trusted-input click-drag diagonally across the top rows (prompt +
    /// echoed command + marker output all live there, so a multi-row
    /// selection necessarily covers rendered text). Mirrors 97.
    async function dragOverTopRows() {
      await seedPointerClipboard(page, CLIPBOARD_SENTINEL);
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
      const probe = `G98_CAT_PROBE_${Date.now().toString(36)}`;
      await cs(["write", "--tab-name", tab,
        `sh -c 'printf "G98_CAT_%s\\n" READY; exec cat -v'\n`]);
      await waitScrollback(tab, "G98_CAT_READY");
      await cs(["write", "--tab-name", tab, `${probe}\n`]);
      const deadline = Date.now() + 30_000;
      let last = "";
      for (;;) {
        last = (await cs(["scrollback", "--tab-name", tab])).stdout;
        // The tty echoes once; cat's own output is the second copy.
        if (last.split(probe).length >= 3) return;
        if (Date.now() > deadline) {
          throw new Error(`${tab}: cat did not echo ${probe}; last=${last.slice(-2000)}`);
        }
        await sleep(300);
      }
    }

    /// The PTY-side witness for chan's two ghostty paste repairs. The shell
    /// prints DECSET 2004 so the terminal is in bracketed paste, and starts
    /// `cat -v` with the tty's literal-next undefined, since a cooked tty
    /// would otherwise eat the 0x16 byte as lnext. A paste event with an
    /// empty DataTransfer stands in for an image-only clipboard; both
    /// ghostty-web's listener and chan's capture listener handle it as a
    /// user's. The control byte comes from a real keydown on ghostty's
    /// textarea. Each probe ends in Enter so cooked cat echoes its line.
    async function probePasteParity(tab) {
      const ready = `G98_PASTE_${Date.now().toString(36)}`;
      await cs(["write", "--tab-name", tab,
        `printf '\\033[?2004h'; sh -c 'stty lnext undef; printf "${ready}_%s\\n" READY; exec cat -v'\n`]);
      await waitScrollback(tab, `${ready}_READY`);
      await page.evaluate(() => {
        const textarea = document.querySelector(".terminal-tab .terminal-host textarea");
        if (!(textarea instanceof HTMLTextAreaElement)) {
          throw new Error("ghostty textarea missing for the paste probe");
        }
        textarea.focus();
        textarea.dispatchEvent(new ClipboardEvent("paste", {
          clipboardData: new DataTransfer(), bubbles: true, cancelable: true,
        }));
      });
      await page.keyboard.press("Enter");
      await waitScrollback(tab, "^[[200~^[[201~");
      await page.keyboard.down("Control");
      await page.keyboard.press("KeyV");
      await page.keyboard.up("Control");
      await page.keyboard.press("Enter");
      await waitScrollback(tab, "^V");
      // Leave cat and bracketed paste before the later shell-command legs.
      await cs(["write", "--tab-name", tab, "\u0003"]);
      await sleep(500);
      await cs(["write", "--tab-name", tab,
        `printf '\\033[?2004l${MARK_PREFIX}PASTE_%s\\n' ${MARK_ARG}\n`]);
      await waitScrollback(tab, `${MARK_PREFIX}PASTE_${MARK_ARG}`);
      return { emptyBracketedPaste: true, controlV: true };
    }

    /// A real ghostty keydown reaches the hidden textarea under the host.
    /// Override only the live userAgent while dispatching so TerminalTab's
    /// currentOS() takes the macOS policy branch on this Linux Chrome host.
    /// `cat -v` is the PTY-side witness: any encoded key bytes change the
    /// server-side scrollback, independent of what the canvas renders.
    async function probeHostOwnedKeys(tab) {
      await startCatProbe(tab);
      const before = (await cs(["scrollback", "--tab-name", tab])).stdout;
      const events = await page.evaluate(() => {
        const host = document.querySelector(".terminal-tab .terminal-host");
        const textarea = host?.querySelector("textarea");
        if (!(host instanceof HTMLElement) || !(textarea instanceof HTMLTextAreaElement)) {
          throw new Error("ghostty host or textarea missing for key probe");
        }
        if (!host.contains(textarea)) {
          throw new Error("ghostty textarea is outside the terminal host");
        }
        textarea.focus();
        if (document.activeElement !== textarea) {
          throw new Error("ghostty textarea did not take focus");
        }

        const ownUserAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");
        Object.defineProperty(navigator, "userAgent", {
          configurable: true,
          value:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
            "AppleWebKit/537.36 Chrome/140 Safari/537.36",
        });
        try {
          const dispatch = (name, init) => {
            const event = new KeyboardEvent("keydown", {
              bubbles: true,
              cancelable: true,
              composed: true,
              metaKey: true,
              ...init,
            });
            textarea.dispatchEvent(event);
            return { name, defaultPrevented: event.defaultPrevented };
          };
          return [
            dispatch("Cmd+`", { key: "`", code: "Backquote" }),
            dispatch("Cmd+Shift+N", {
              key: "N",
              code: "KeyN",
              shiftKey: true,
            }),
          ];
        } finally {
          if (ownUserAgent) {
            Object.defineProperty(navigator, "userAgent", ownUserAgent);
          } else {
            delete navigator.userAgent;
          }
        }
      });
      await sleep(1_000);
      const after = (await cs(["scrollback", "--tab-name", tab])).stdout;
      const suppressed = events.filter((event) => event.defaultPrevented);
      if (suppressed.length > 0) {
        throw new Error(
          `ghostty key leg: native default suppressed for ` +
            suppressed.map((event) => event.name).join(", "),
        );
      }
      if (after !== before) {
        throw new Error(
          "ghostty key leg: a host-owned macOS chord wrote bytes to the PTY; " +
            `before tail=${JSON.stringify(before.slice(-240))} ` +
            `after tail=${JSON.stringify(after.slice(-240))}`,
        );
      }

      // Leave cat before the later shell-command legs. The expanded marker
      // proves the shell, rather than cat's input echo, received the command.
      await cs(["write", "--tab-name", tab, "\u0003"]);
      await sleep(500);
      await cs([
        "write",
        "--tab-name",
        tab,
        `printf '${MARK_PREFIX}KEYS_%s\\n' ${MARK_ARG}\n`,
      ]);
      await waitScrollback(tab, `${MARK_PREFIX}KEYS_${MARK_ARG}`);
      return {
        defaultPrevented: Object.fromEntries(
          events.map((event) => [event.name, event.defaultPrevented]),
        ),
        ptyBytes: false,
        textareaInsideHost: true,
      };
    }

    /// Selection probe via the terminal's own copy chord
    /// (Ctrl+Shift+C -> copySelectionToClipboard, a no-op on empty
    /// selection) with the clipboard pre-seeded with a sentinel.
    /// The sentinel is seeded before the drag, so this read cannot erase
    /// a copy made by the release. Focus alone routes the copy chord.
    async function readSelectionViaCopy() {
      await page.evaluate(() => {
        const ta = document.querySelector(".terminal-host textarea");
        if (!ta) {
          throw new Error(
            "ghostty textarea selector missing: .terminal-host textarea",
          );
        }
        ta.focus();
      });
      await page.keyboard.down("Control");
      await page.keyboard.down("Shift");
      await page.keyboard.press("KeyC");
      await page.keyboard.up("Shift");
      await page.keyboard.up("Control");
      await sleep(300);
      const text = await page.evaluate(() => navigator.clipboard.readText());
      return text === CLIPBOARD_SENTINEL ? "" : text;
    }

    async function probePressOnlyTracking() {
      const result = { gestures: {}, failures: [] };
      const word = "POINTERWORD";
      const selected = "SHIFT_SELECT_94";
      const fixture = await startTerminalFixture({ logPath: join(ctx.outDir, "94-pointer-output.bin"), deadlineMs: 20_000 });
      let term;
      try {
        await capturePointerTerminals(page);
        const args = ["--command", "stty -opost -echo && " + fixture.command,
          ...Object.entries(fixture.env).flatMap(([key, value]) => ["--env", `${key}=${value}`])];
        let row;
        try { row = await openTerminal(args); }
        catch (error) { throw new Error(String(error.message).replaceAll(fixture.env.TERMINAL_FIXTURE_TOKEN, "[redacted]")); }
        result.fixture = await fixture.ready();
        assert.ok(result.fixture.tty && result.fixture.raw, "1000: fixture is a raw PTY");
        term = await pointerTerminal(page, `.pane[data-pane-id="${row.pane}"] .terminal-tab[data-terminal-tab-id="${row.tab}"] .terminal-host`);
        await settlePointer(page);
        const box = await pointerGrid(term);
        const prefix = "PREFIX94 ".padEnd(box.cols - 3, " ");
        const logicalLine = `${prefix}${word} TAIL94`;
        result.setup = await drainPointerInput(fixture, `\x1b[2J\x1b[H${logicalLine}\r\n${selected}\r\n\x1b[?1000;1006h`);
        assert.deepEqual(result.setup, { input: "", reply: "\x1b[4;1R" }, "1000: output and mode setup reached the parser");
        result.rows = await term.evaluate((t) => [0, 1, 2].map((row) => {
          const line = t.buffer.active.getLine(t.buffer.active.baseY + row);
          return { text: line?.translateToString(true), wrapped: line?.isWrapped };
        }));
        assert.deepEqual(result.rows, [
          { text: prefix + word.slice(0, 3), wrapped: false },
          { text: word.slice(3) + " TAIL94", wrapped: true },
          { text: selected, wrapped: false },
        ], "the clicked word crosses a soft wrap inside a longer logical line");
        assert.deepEqual(await term.evaluate((t) => [t.getMode(1000), t.getMode(1002), t.getMode(1003), t.getMode(1006)]),
          [true, false, false, true], "1000: press-only tracking with SGR, no motion modes");
        await settlePointer(page);
        const from = { x: box.x + box.w * 0.25, y: box.y + box.h * 2.5 };
        const to = { x: box.x + box.w * (selected.length - 0.25), y: from.y };
        const kinds = ["drag", "double-click", "shift-double-click", "triple-click", "shift-triple-click", "shift-released-drag"];
        for (const kind of kinds) {
          const gesture = result.gestures[kind] = {};
          const clicks = kind.includes("double") ? 2 : kind.includes("triple") ? 3 : 0;
          let held = false;
          try {
            await term.evaluate((t) => t.clearSelection());
            const sentinel = `SMOKE94_${kind}_SENTINEL`;
            await seedPointerClipboard(page, sentinel);
            assert.equal((await drainPointerInput(fixture)).input, "", `${kind}: PTY starts drained`);
            const index = fixture.records.length;
            if (clicks) {
              const x = box.x + box.w * 0.5;
              const y = box.y + box.h * 1.5;
              await page.mouse.move(x, y);
              if (kind.startsWith("shift")) await page.keyboard.down("Shift");
              await page.mouse.click(x, y, { count: clicks });
              await page.keyboard.up("Shift");
            } else {
              await page.mouse.move(from.x, from.y);
              if (kind.startsWith("shift")) await page.keyboard.down("Shift");
              await page.mouse.down();
              held = true;
              await page.mouse.move(to.x, to.y, { steps: 6 });
              // Release Shift while the button remains held, then move
              // again so both the motion and release see Shift up.
              await page.keyboard.up("Shift");
              await page.mouse.move(to.x - box.w * 0.1, to.y);
              gesture.heldSelection = await term.evaluate((t) => t.getSelection());
              assert.equal(gesture.heldSelection, kind === "drag" ? "" : selected,
                `${kind}: selection while the button is held`);
              await page.mouse.up();
              held = false;
            }
            await settlePointer(page);
            gesture.after = await drainPointerInput(fixture, "", index);
            gesture.reports = pointerReports(gesture.after.input);
            gesture.selection = await term.evaluate((t) => t.getSelection());
            gesture.releaseClipboard = await page.evaluate(() => navigator.clipboard.readText());
            gesture.copyClipboard = await copyPointerSelection(page, term);
            if (kind === "drag") {
              assert.deepEqual(gesture.reports, [
                { button: 0, col: 1, row: 3, end: "M" },
                { button: 0, col: selected.length, row: 3, end: "m" },
              ], "1000 drag: only a press and release, no motion reports");
            } else if (clicks && !kind.startsWith("shift")) {
              assert.deepEqual(gesture.reports, Array.from({ length: clicks }, () => ["M", "m"]).flat()
                .map((end) => ({ button: 0, col: 1, row: 2, end })),
                `1000 ${kind}: exactly ${clicks} press/release pairs`);
            } else {
              assert.equal(gesture.after.input, "", `${kind}: bypass sends no bytes`);
            }
            const expected = kind.startsWith("shift") ? (clicks === 2 ? word : clicks === 3 ? logicalLine : selected) : "";
            assert.equal(gesture.selection, expected, `${kind}: selection`);
            assert.equal(gesture.releaseClipboard, expected || sentinel, `${kind}: release clipboard`);
            assert.equal(gesture.copyClipboard, expected || sentinel, `${kind}: copy chord clipboard`);
          } catch (error) {
            gesture.error = error.message;
            result.failures.push(`${kind}: ${error.message}`);
            await ctx.shot(`94-${kind}-failure`).catch(() => {});
          } finally {
            if (held) await page.mouse.up().catch(() => {});
            await page.keyboard.up("Shift").catch(() => {});
          }
        }
        assert.deepEqual(Object.keys(result.gestures), kinds, "all press-only gesture legs ran");
        return result;
      } finally {
        result.records = fixture.records;
        await closeTerminal(TAB_G).catch((error) => result.failures.push(`terminal cleanup: ${error.message}`));
        await fixture.close();
        await term?.dispose();
        await page.evaluate(() => window.__pointerSmoke?.restore());
        writeFileSync(join(ctx.outDir, "94-pointer.json"), JSON.stringify(result, null, 2) + "\n");
      }
    }

    const details = { legacy: {} };
    const compatibilityErrors = [];
    async function compatibilityArm(name, run, { keepOpen = false } = {}) {
      try {
        details.legacy[name] = { status: "passed", ...await run() };
      } catch (error) {
        details.legacy[name] = { status: "failed", error: error.message };
        compatibilityErrors.push(new Error(`${name}: ${error.message}`, { cause: error }));
        console.error(`[94-terminal-ghostty-toggle] ${name}: ${error.message}`);
      } finally {
        if (!keepOpen) {
          await cs(["close", "--tab-name", TAB_G]).catch(() => {});
          await page.waitForFunction(() => !document.querySelector(".terminal-tab"), { timeout: 15_000 });
          // A reload must not resurrect a closed tab from a debounced save.
          await page.waitForFunction(async ({ token, windowId, name }) => {
            const headers = token ? { authorization: `Bearer ${token}` } : {};
            const response = await fetch(`/api/session?w=${encodeURIComponent(windowId)}`, { headers });
            if (response.status === 204) return true;
            if (!response.ok) throw new Error(`GET /api/session -> ${response.status}`);
            return !JSON.stringify((await response.json()).layout ?? null).includes(name);
          }, { timeout: 20_000, polling: 100 }, { token: authToken, windowId, name: TAB_G });
        }
      }
    }
    let runError = null;
    try {
      await writeTerminalPrefs(page, authToken, { mouse_capture: true, program_status: true });
      // Run the independent pointer fixture before config compatibility:
      // an old server that retains the retired key still yields its bytes.
      details.mouse1000Leg = await probePressOnlyTracking();
      for (const ghostty of [true, false]) {
        await compatibilityArm(`api-${ghostty}`, async () => {
          const row = await openLegacyConfiguredTerminal(ctx, page, cs, windowId, TAB_G, ghostty);
          await assertOnlyGhostty();
          await assertTerminalPrefs(ctx, { ghostty: null, mouse_capture: true, program_status: true });
          return { ghostty, canonicalKeyAbsent: true, backend: "ghostty", session: row.session_id };
        });
      }

      await compatibilityArm("stored-false-reload", async () => {
        // Change an unrelated field too: its live readback proves the watcher
        // consumed this exact file even when the retired key has no effect.
        await writeTerminalPrefs(page, authToken, { mouse_capture: true, program_status: true });
        const path = join(ctx.chanHome, "server.toml");
        const canonical = readFileSync(path, "utf8");
        const section = /^\[terminal\]\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m;
        const match = section.exec(canonical);
        assert.ok(match, "canonical server.toml has a terminal table");
        assert.match(match[1], /^program_status = true$/m, "fixture starts with live program status enabled");
        const body = match[1].replace(/^ghostty = (?:true|false)\r?\n/m, "")
          .replace(/^program_status = true$/m, "program_status = false");
        const seeded = canonical.replace(section, () => `[terminal]\nghostty = false\n${body}`);
        const staged = `${path}.smoke94`;
        writeFileSync(staged, seeded);
        renameSync(staged, path);
        await assertTerminalPrefs(ctx, { ghostty: false, program_status: false });
        await page.waitForFunction(async (token) => {
          const headers = token ? { authorization: `Bearer ${token}` } : {};
          const response = await fetch("/api/workspace", { headers });
          if (!response.ok) throw new Error(`GET /api/workspace -> ${response.status}`);
          return (await response.json()).preferences?.terminal?.program_status === false;
        }, { timeout: 20_000, polling: 100 }, authToken);
        // A fresh page must read the consumed config before constructing a
        // terminal, rather than relying on the old page's preference cache.
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        await ctx.waitWindowLive(windowId);
        const before = await openTerminal();
        assert.ok(before.session_id, "stored-false terminal has a PTY identity");
        await waitSaved(ctx, page, windowId, TAB_G);
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        await ctx.waitWindowLive(windowId);
        const after = await waitRestoredTerminal(page, cs, windowId, before, "ghostty");
        assert.equal(after.session_id, before.session_id, "reload keeps the same PTY on Ghostty");
        await assertOnlyGhostty();
        await cs(["write", "--tab-name", TAB_G, `printf '${MARK_PREFIX}RELOAD_%s\\n' ${MARK_ARG}\n`]);
        await waitScrollback(TAB_G, `${MARK_PREFIX}RELOAD_${MARK_ARG}`);
        assert.equal(readFileSync(path, "utf8"), seeded, "loading and reloading do not rewrite server.toml");
        const current = await readTerminalPrefs(page, authToken);
        assert.equal(Object.hasOwn(current, "ghostty"), false, "stored false is absent from the canonical API");
        await writeTerminalPrefs(page, authToken, { mouse_capture: true });
        await assertTerminalPrefs(ctx, { ghostty: null, program_status: false, mouse_capture: true });
        assert.equal(readFileSync(path, "utf8"), seeded.replace("ghostty = false\n", ""),
          "normal save drops only the retired key and preserves unrelated settings");
        await ctx.shot("ghostty-stored-false-reloaded");
        return { backend: "ghostty", before: before.session_id, after: after.session_id,
          watcherConsumedFile: true, loadDidNotRewrite: true, saveDroppedOnlyLegacyKey: true };
      });

      await writeTerminalPrefs(page, authToken, { mouse_capture: true, program_status: true });
      // Reload gives the wasm resource timing proof a fresh document even if
      // an earlier compatibility arm already initialized the module.
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await ctx.waitWindowLive(windowId);
      const ghosttyResizeStart = resizeFrames.length;
      const ghosttySocketStart = terminalSocketUrls.length;
      await compatibilityArm("api-absent", async () => {
        const row = await openLegacyConfiguredTerminal(ctx, page, cs, windowId, TAB_G, undefined);
        await assertOnlyGhostty();
        await assertTerminalPrefs(ctx, { ghostty: null, mouse_capture: true, program_status: true });
        return { canonicalKeyAbsent: true, backend: "ghostty", session: row.session_id };
      }, { keepOpen: true });
      if (compatibilityErrors.length) {
        throw new AggregateError(compatibilityErrors,
          `legacy config failed: ${compatibilityErrors.map((error) => error.message).join("; ")}`);
      }
      await page.waitForFunction(
        () => performance.getEntriesByType("resource").some((entry) => entry.name.includes("ghostty-vt") && new URL(entry.name).pathname.endsWith(".wasm")),
        { timeout: 60_000 },
      );
      await ctx.shot("ghostty-backend-loaded");
      details.loadLeg = { wasmFetched: true, xtermDomAbsent: true };
      const ghosttyFit = await terminalFitSnapshot(TAB_G, ghosttyResizeStart, ghosttySocketStart);
      details.fitLeg = { ghostty: ghosttyFit };
      if (ghosttyFit.canvasWidth === null || ghosttyFit.cols < 1) {
        throw new Error(
          `fit leg: ghostty canvas width or columns are not measurable: ` +
            JSON.stringify(ghosttyFit),
        );
      }
      const ghosttyCellWidth = ghosttyFit.canvasWidth / ghosttyFit.cols;
      const ghosttyContentWidth =
        ghosttyFit.hostWidth -
        ghosttyFit.padding.left -
        ghosttyFit.padding.right;
      const fullWidthCols = Math.max(
        2,
        Math.floor(ghosttyContentWidth / ghosttyCellWidth),
      );
      const reservedWidthCols = Math.max(
        2,
        Math.floor((ghosttyContentWidth - 15) / ghosttyCellWidth),
      );
      if (
        ghosttyFit.cols !== fullWidthCols ||
        ghosttyFit.cols <= reservedWidthCols
      ) {
        throw new Error(
          "fit leg: ghostty did not use the full content box; " +
            `cellWidth=${ghosttyCellWidth} full=${fullWidthCols} ` +
            `reserved=${reservedWidthCols} snapshot=${JSON.stringify(ghosttyFit)}`,
        );
      }
      details.fitLeg.ghosttyCellWidth = ghosttyCellWidth;
      details.fitLeg.fullWidthCols = fullWidthCols;
      details.fitLeg.reservedWidthCols = reservedWidthCols;
      details.fitLeg.strictlyBeatsReservedWidth = true;
      await ctx.shot("ghostty-fit");

      // ---- Leg 3: KEYS -- macOS host chords bypass ghostty ----
      details.keyLeg = await probeHostOwnedKeys(TAB_G);
      await ctx.shot("ghostty-host-owned-keys");

      // ---- Leg 3b: PASTE -- an empty paste and a bare Ctrl+V reach the PTY ----
      // Image-only clipboard input needs an empty bracketed paste and the
      // 0x16 byte, even though there is no text payload.
      details.pasteLeg = await probePasteParity(TAB_G);
      await ctx.shot("ghostty-paste-parity");

      // ---- Leg 4: OSC52 clipboard copy reaches the system clipboard ----
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
        const deadline = Date.now() + 30_000;
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

      // ---- Leg 5a: mouse_capture ON -- click + wheel report, drag does not select ----
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
      // With the TUI owning the pointer, a drag must not select text.
      await dragOverTopRows();
      const onSelection = await readSelectionViaCopy();
      if (onSelection !== "") {
        throw new Error(
          `mouse-on leg: drag selected text under an active mouse mode ` +
            `(${JSON.stringify(onSelection.slice(0, 120))}); expected ` +
            `no selection while a TUI owns the pointer`,
        );
      }
      details.mouseOnLeg.selection = "";
      await closeTerminal(TAB_G);

      // ---- Leg 5b: mouse_capture OFF -- the DECSET strip works under ghostty ----
      await setMouseCapture(false);
      await assertTomlMouseCapture(false);
      await openTerminal();
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

      assert.deepEqual(details.mouse1000Leg.failures, [], "all press-only gesture legs passed");
      return details;
    } catch (error) {
      runError = error;
      throw error;
    } finally {
      // Put back the terminal preferences found at entry, even when a leg
      // fails, so later checks inherit the server state they started with.
      let restoreError = null;
      try {
        await restoreTerminalPrefs(ctx, page, authToken, originalPrefs);
        await assertTerminalPrefs(ctx, {
          mouse_capture: originalPrefs.mouse_capture,
          secret_masking: originalPrefs.secret_masking,
        });
      } catch (error) {
        restoreError = error;
      }
      await cs(["close", "--tab-name", TAB_G]).catch(() => {});
      try {
        await page.waitForFunction(
          () => !document.querySelector(".terminal-tab"),
          { timeout: 10_000 },
        );
      } catch {}
      writeFileSync(join(ctx.outDir, "94-ghostty-loading.json"), `${JSON.stringify(details, null, 2)}\n`);
      await cdp.detach().catch(() => {});
      if (restoreError) {
        if (runError) {
          console.error(`[94-terminal-ghostty-toggle] restore failed: ${restoreError.message}`);
        } else {
          throw restoreError;
        }
      }
    }
  },
};
