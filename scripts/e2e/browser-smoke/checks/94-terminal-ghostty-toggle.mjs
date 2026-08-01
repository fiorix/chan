// terminal.ghostty toggle: the ghostty-web backend end-to-end.
//
// One extended sequence against the REAL settings round-trip, PTY, launcher,
// context menu, and wasm terminal, mirroring 97's existing harness:
//
//   DISCOVER -- start on xterm and read CHAN_TERMINAL from the child,
//               inspect the live context-menu header, toggle through a
//               ghostty search in the Command Launcher, prove the stored
//               preference changed, then prove the running child keeps
//               xterm until a direct control-socket restart reports ghostty.
//   FALLBACK -- fail the first ghostty-vt request, prove the child still
//               reports configured ghostty while the live menu says xterm,
//               then remove the failure so the next terminal retries.
//   ON       -- flip terminal.ghostty=true via the same GET-mutate-PATCH
//               /api/config chain the settings UI uses, prove it
//               persisted into the SANDBOXED ${chanHome}/server.toml,
//               open a NEW terminal (the setting is read at spawn time)
//               and assert the ghostty backend actually loaded: its
//               .wasm asset was fetched, the host holds ghostty's canvas
//               and NO xterm DOM exists.
//   FIT      -- measure the live host and fitted grid under both backends.
//               Their cell widths differ, so derive ghostty's cell width
//               from its canvas and prove it uses the full content box.
//   KEYS     -- present the page as macOS, focus ghostty's textarea,
//               dispatch Cmd+` and Cmd+Shift+N, and prove both retain
//               their native default while sending no bytes to the PTY.
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
//
// The workspace-less tenant's config-live-flip/lifetime contract is covered
// at the server seam by
// `terminal_router_tests::hosted_terminal_registry_resolves_backend_on_each_spawn`.
// That regression builds the real `build_terminal_app` path once under an
// isolated CHAN_HOME and proves existing/new/restarted child environments.
// Keeping that server-side contract at the deterministic Rust seam avoids
// coupling it to a second page's menu/readiness choreography; the workspace
// browser coverage below remains intact.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const TAB_G = "SmokeGhostty98";
const TAB_X = "SmokeGhostty98X";
const TAB_LIFETIME = "SmokeGhostty98Lifetime";
const TAB_FALLBACK = "SmokeGhostty98Fallback";
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
      const deadline = Date.now() + 15_000;
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
      // 60s, not a fitted value: the ghostty leg's wasm load is the
      // slowest mount in the suite, and this wait failing is the only
      // signal that the load is genuinely stuck.
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

    /// Wait for the browser's PTY resize frame to settle, then capture the
    /// host content box and backend canvas. The restore leg compares the same
    /// measured box instead of assuming the viewport alone proves equal layout.
    async function terminalFitSnapshot(backend, tabName, frameStart, socketStart) {
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
            `${backend} fit probe: no stable PTY resize frame after index ${frameStart}`,
          );
        }
        await sleep(100);
      }
      const layout = await page.evaluate((backend) => {
        const host = document.querySelector(".terminal-tab .terminal-host");
        const canvas = host?.querySelector("canvas");
        if (!(host instanceof HTMLElement)) {
          throw new Error(`${backend} fit probe: terminal host missing`);
        }
        const style = window.getComputedStyle(host);
        return {
          backend,
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
      }, backend);
      const socketUrl = terminalSocketUrls
        .slice(socketStart)
        .find(
          (url) => new URL(url).searchParams.get("tab_name") === tabName,
        );
      if (!socketUrl) {
        throw new Error(`${backend} fit probe: terminal socket URL missing`);
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
          `${backend} fit probe: initial socket grid did not match the measured grid; ` +
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

    let envProbe = 0;
    async function assertTerminalEnv(tab, expected) {
      envProbe += 1;
      const marker = `${MARK_PREFIX}CHAN_TERMINAL_${envProbe}_`;
      await cs([
        "write",
        "--tab-name",
        tab,
        `printf '${marker}%s\\n' "$CHAN_TERMINAL"\n`,
      ]);
      await waitScrollback(tab, `${marker}${expected}`);
      const out = (await cs(["scrollback", "--tab-name", tab])).stdout;
      if (!out.includes(`${marker}${expected}`)) {
        throw new Error(
          `${tab} did not report CHAN_TERMINAL=${expected} from its PTY; ` +
            `scrollback tail=${JSON.stringify(out.slice(-1000))}`,
        );
      }
    }

    async function assertContextBackend(expected, targetPage = page) {
      const host = await targetPage.$(".terminal-tab.active .terminal-host");
      if (!host) throw new Error("terminal host missing for context-menu probe");
      const box = await host.boundingBox();
      if (!box) throw new Error("terminal host has no context-menu bounding box");
      await targetPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
        button: "right",
      });
      const selector = `[data-terminal-backend="${expected}"]`;
      await targetPage.waitForSelector(selector, { visible: true, timeout: 10_000 });
      const text = await targetPage.$eval(
        selector,
        (node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "",
      );
      if (text !== `Terminal engine ${expected}`) {
        throw new Error(
          `context menu reported ${JSON.stringify(text)}, expected live ${expected}`,
        );
      }
      // The menu is portaled outside the terminal shell. Focus its explicit
      // tabindex target so Escape originates inside the page and reaches the
      // existing window-level menu handler instead of xterm retaining focus.
      const menu = await targetPage.$(".terminal-tab-menu-bubble");
      if (!menu) throw new Error("terminal context menu disappeared before dismissal");
      await menu.focus();
      await targetPage.keyboard.press("Escape");
      await targetPage.waitForSelector(".terminal-tab-menu-bubble", {
        hidden: true,
        timeout: 10_000,
      });
    }

    async function launcherBackendRow(expected, run) {
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("chan:command", {
            detail: { name: "app.launcher.toggle" },
          }),
        );
      });
      await page.waitForSelector(".launcher .search", { timeout: 10_000 });
      await page.$eval(".launcher .search", (input) => {
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.type(".launcher .search", "ghostty");
      await page.waitForFunction(
        (backend) => {
          const selected = document.querySelector(
            '.launcher .results .row[aria-selected="true"]',
          );
          const title = selected
            ?.querySelector(".title")
            ?.textContent?.replace(/\s+/g, " ")
            .trim();
          const category = selected
            ?.querySelector(".description")
            ?.textContent?.trim();
          return (
            category === "Terminal" &&
            title?.includes(`Terminal engine: ${backend}`) &&
            title.includes("newly opened terminals only")
          );
        },
        { timeout: 10_000 },
        expected,
      );
      const title = await page.$eval(
        '.launcher .results .row[aria-selected="true"] .title',
        (node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "",
      );
      await page.keyboard.press(run ? "Enter" : "Escape");
      await page.waitForSelector(".launcher", { hidden: true, timeout: 10_000 });
      return title;
    }

    async function openWithFailedGhosttyLoad(name) {
      let failures = 0;
      const failPausedRequest = ({ requestId }) => {
        failures += 1;
        void cdp
          .send("Fetch.failRequest", { requestId, errorReason: "Failed" })
          .catch(() => {});
      };
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      await cdp.send("Fetch.enable", {
        patterns: [{ urlPattern: "*ghostty-vt*", requestStage: "Request" }],
      });
      cdp.on("Fetch.requestPaused", failPausedRequest);
      try {
        await openTerminal(name, ".terminal.xterm .xterm-screen");
      } finally {
        cdp.off("Fetch.requestPaused", failPausedRequest);
        await cdp.send("Fetch.disable").catch(() => {});
        await cdp
          .send("Network.setCacheDisabled", { cacheDisabled: false })
          .catch(() => {});
      }
      if (failures === 0) {
        throw new Error("forced ghostty fallback intercepted no ghostty-vt request");
      }
      return failures;
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
      // ---- Leg 0: discovery, launcher, and spawn-time lifetime ----
      await setGhostty(false);
      await assertTomlGhostty(false);
      await sleep(2_000);
      await openTerminal(TAB_LIFETIME, ".terminal.xterm .xterm-screen");
      await assertTerminalEnv(TAB_LIFETIME, "xterm");
      await assertContextBackend("xterm");

      const beforeToggleTitle = await launcherBackendRow("xterm", true);
      await assertTomlGhostty(true);
      // The SPA learns of the flip via the config_changed WS frame ->
      // debounced (250ms) workspace refresh; give it a moment so the
      // NEW terminal's spawn-time read sees the fresh value.
      await sleep(2_000);
      const afterToggleTitle = await launcherBackendRow("ghostty", false);
      // The already-running child keeps its original environment. A direct
      // control-socket restart samples the live preference without a server
      // restart and retains the same session id/tab.
      await assertTerminalEnv(TAB_LIFETIME, "xterm");
      await cs(["restart", "--tab-name", TAB_LIFETIME]);
      await assertTerminalEnv(TAB_LIFETIME, "ghostty");
      // Restarting the PTY does not remount the renderer, so the live engine
      // remains xterm even though the new child reports configured ghostty.
      await assertContextBackend("xterm");
      details.discoveryLeg = {
        initialEnv: "xterm",
        existingAfterFlip: "xterm",
        restartedEnv: "ghostty",
        beforeToggleTitle,
        afterToggleTitle,
      };
      await closeTerminal(TAB_LIFETIME);

      // ---- Leg 0b: configured ghostty falls back live to xterm ----
      const failedRequests = await openWithFailedGhosttyLoad(TAB_FALLBACK);
      await assertTerminalEnv(TAB_FALLBACK, "ghostty");
      await assertContextBackend("xterm");
      details.fallbackLeg = {
        configuredEnv: "ghostty",
        liveBackend: "xterm",
        failedRequests,
      };
      await closeTerminal(TAB_FALLBACK);
      await sleep(250);

      // ---- Leg 1: ON -- the ghostty backend loads for new terminals ----
      // Chrome caps the resource timing buffer at 250 entries and
      // earlier checks in a suite fill it, which silently drops the
      // ghostty-vt entry the wasm wait below looks for. Clear it so
      // this leg's fetch is always recorded.
      await page.evaluate(() => performance.clearResourceTimings());
      const ghosttyResizeStart = resizeFrames.length;
      const ghosttySocketStart = terminalSocketUrls.length;
      await openTerminal(TAB_G, ".terminal-host canvas");
      await assertTerminalEnv(TAB_G, "ghostty");
      // The ghostty canvas context-menu assertion did not pass on this host.
      // Ordinary xterm and forced fallback cover real-browser context menus;
      // the component regression pins this row to the post-fallback backend.
      // The lazy loader fetched the wasm asset (vite emits it hashed as
      // ghostty-vt-*.wasm) -- the definitive proof the backend is real,
      // not a silent xterm fallback.
      await page.waitForFunction(
        () =>
          performance
            .getEntriesByType("resource")
            .some((e) => e.name.includes("ghostty-vt")),
        { timeout: 60_000 },
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
      const ghosttyFit = await terminalFitSnapshot(
        "ghostty",
        TAB_G,
        ghosttyResizeStart,
        ghosttySocketStart,
      );
      details.fitLeg = { ghostty: ghosttyFit };

      // ---- Leg 2: FIT -- capture the Ghostty grid for restore parity ----
      await ctx.shot("ghostty-fit");

      // ---- Leg 3: KEYS -- macOS host chords bypass ghostty ----
      details.keyLeg = await probeHostOwnedKeys(TAB_G);
      await ctx.shot("ghostty-host-owned-keys");

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

      // ---- Leg 5b: mouse_capture OFF -- the DECSET strip works under ghostty ----
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

      // ---- Leg 6: RESTORE -- new terminals pick xterm again ----
      await setGhostty(false);
      await assertTomlGhostty(false);
      await sleep(2_000);
      const xtermResizeStart = resizeFrames.length;
      const xtermSocketStart = terminalSocketUrls.length;
      await openTerminal(TAB_X, ".terminal.xterm .xterm-screen");
      await assertTerminalEnv(TAB_X, "xterm");
      await assertContextBackend("xterm");
      const xtermFit = await terminalFitSnapshot(
        "xterm",
        TAB_X,
        xtermResizeStart,
        xtermSocketStart,
      );
      details.fitLeg.xterm = xtermFit;
      if (
        ghosttyFit.hostWidth !== xtermFit.hostWidth ||
        ghosttyFit.hostHeight !== xtermFit.hostHeight ||
        JSON.stringify(ghosttyFit.padding) !== JSON.stringify(xtermFit.padding)
      ) {
        throw new Error(
          "fit leg: backend host boxes differ; " +
            `ghostty=${JSON.stringify(ghosttyFit)} ` +
            `xterm=${JSON.stringify(xtermFit)}`,
        );
      }
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
          `[94-terminal-ghostty-toggle] WARNING: failed to restore mouse_capture=true: ${e.message}`,
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
          `[94-terminal-ghostty-toggle] WARNING: failed to restore ghostty=false: ${e.message}`,
        );
      }
      for (const tab of [TAB_G, TAB_X, TAB_LIFETIME, TAB_FALLBACK]) {
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
