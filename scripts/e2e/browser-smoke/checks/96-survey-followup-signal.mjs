// Item A: survey [F] is a pure "host will follow up later" signal.
//
// Drives the REAL `cs terminal survey` (chan shell terminal survey)
// against the harness server: opens target + away terminal tabs, raises
// three surveys, switches away/back for each, and answers from the SPA
// overlay -- option pick, [X] dismiss, [F] follow up. A one-byte shell read
// proves the survey key never reaches the PTY, then its cleanup byte proves
// focus returned to the terminal. Also asserts the three distinct stdout
// lines the asking agent branches on, and that [F] writes NO followup
// artifact anywhere under the workspace (the retired followup-file
// machinery only ever wrote through the Workspace sandbox, so the workspace
// tree is the complete universe of possible write targets).

import { join } from "node:path";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";

const TAB = "SmokeSurvey96";
const AWAY_TAB = "SmokeSurvey96Away";

async function settle(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
}

async function clickTab(page, label) {
  const tabs = await page.$$(".tabs > .tab");
  for (const tab of tabs) {
    const text = await tab.$eval(".path", (path) => path.textContent?.trim() ?? "");
    if (text === label) {
      await tab.click();
      await settle(page);
      return;
    }
  }
  throw new Error(`tab not found: ${label}`);
}

/// Recursive scan for followup-file artifacts: any `followups/` dir or
/// any `followup-*.md` file anywhere under root.
function followupArtifacts(root) {
  const hits = [];
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name === "followups") hits.push(p);
        walk(p);
      } else if (/^followup-.*\.md$/.test(name)) {
        hits.push(p);
      }
    }
  };
  walk(root);
  return hits;
}

export default {
  name: "survey-followup-signal",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    // Same window-id precedence as 70-cs-paste: the URL `?w=` param may
    // have been rewritten by an earlier check.
    const windowId = await page.evaluate(
      () =>
        new URL(location.href).searchParams.get("w")?.trim() ||
        window.sessionStorage.getItem("chan.session.window")?.trim() ||
        "",
    );
    if (!windowId) throw new Error("could not resolve the page's window id");
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

    async function waitForTerminal(name) {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const { stdout } = await cs(["list", "--json"]);
        const sessions = Object.values(JSON.parse(stdout).groups ?? {}).flat();
        if (sessions.some((session) => session.name === name)) return;
        if (Date.now() > deadline) {
          throw new Error(`session ${name} never registered`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    async function waitForTargetFocus() {
      await page.waitForFunction(
        (name) => {
          const activeTab =
            document.querySelector(".tabs > .tab.active .path")?.textContent?.trim() ?? "";
          const host = document.querySelector(".terminal-tab.active .terminal-host");
          return activeTab === name && host?.contains(document.activeElement) === true;
        },
        { timeout: 5_000 },
        TAB,
      );
    }

    async function armPtySentinel(label) {
      const ready = join(ctx.workspaceDir, `.survey-${label}-ready`);
      const capture = join(ctx.workspaceDir, `.survey-${label}-key`);
      rmSync(ready, { force: true });
      rmSync(capture, { force: true });
      await waitForTargetFocus();
      const command =
        `printf ready > '${ready}'; stty -echo; ` +
        `IFS= read -r -n 1 smoke_key; printf %s "$smoke_key" > '${capture}'; stty echo`;
      await page.keyboard.type(command);
      await page.keyboard.press("Enter");
      await ctx.pollFile(ready, 5_000);
      return { ready, capture };
    }

    // Raise one survey (the CLI BLOCKS server-side until the overlay
    // replies), switch away and back, drive the re-focused overlay via act(),
    // then await the unblocked CLI. The armed one-byte read is a direct PTY
    // assertion: the survey key must not satisfy it, while a cleanup byte
    // after resolution must.
    async function surveyLeg(label, act) {
      const sentinel = await armPtySentinel(label);
      const pending = cs([
        "survey",
        "--tab-name",
        TAB,
        "--timeout",
        "60",
        "--option",
        "Alpha",
        "--option",
        "Beta",
        "smoke: pick, dismiss, or follow up",
      ]);
      pending.catch(() => {}); // no unhandled rejection while we drive the UI
      await page.waitForSelector(".survey-card", {
        visible: true,
        timeout: 30_000,
      });
      await page.waitForFunction(
        () => document.activeElement === document.querySelector(".survey-card"),
        { timeout: 5_000 },
      );
      await clickTab(page, AWAY_TAB);
      await page.waitForFunction(
        (name) =>
          document.querySelector(".tabs > .tab.active .path")?.textContent?.trim() === name &&
          document.querySelector(".survey-card") === null,
        { timeout: 5_000 },
        AWAY_TAB,
      );
      await clickTab(page, TAB);
      await page.waitForSelector(".survey-card", {
        visible: true,
        timeout: 5_000,
      });
      await page.waitForFunction(
        () => document.activeElement === document.querySelector(".survey-card"),
        { timeout: 5_000 },
      );
      await act();
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (existsSync(sentinel.capture)) {
        throw new Error(
          `survey ${label} key reached PTY: ${JSON.stringify(
            readFileSync(sentinel.capture, "utf8"),
          )}`,
        );
      }
      await page.waitForFunction(
        () => !document.querySelector(".survey-card"),
        { timeout: 15_000 },
      );
      await page.waitForFunction(
        () => {
          const host = document.querySelector(".terminal-tab.active .terminal-host");
          return host?.contains(document.activeElement) === true;
        },
        { timeout: 5_000 },
      );
      if (existsSync(sentinel.capture)) {
        throw new Error(`survey ${label} altered the PTY before focus restoration`);
      }
      await page.keyboard.press("z");
      const cleanupByte = (await ctx.pollFile(sentinel.capture, 5_000)).toString();
      if (cleanupByte !== "z") {
        throw new Error(
          `survey ${label} PTY cleanup byte: ${JSON.stringify(cleanupByte)}`,
        );
      }
      rmSync(sentinel.ready, { force: true });
      rmSync(sentinel.capture, { force: true });
      return { ...(await pending), ptyCleanup: cleanupByte };
    }

    async function assertLauncherChordAfterSurvey() {
      // macOS Option changes `event.key` for Ctrl+Alt+K (usually to `˚`).
      // Dispatch that exact browser shape from the real xterm textarea: the
      // terminal escape registry must match physical `code` like App does.
      await page.evaluate(() => {
        const focused = document.activeElement;
        if (!(focused instanceof HTMLElement)) {
          throw new Error("terminal has no focused element");
        }
        focused.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "˚",
            code: "KeyK",
            ctrlKey: true,
            altKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await page.waitForSelector(".launcher .search", { timeout: 5_000 });
      await page.keyboard.press("Escape");
      await page.waitForSelector(".launcher", { hidden: true, timeout: 5_000 });

      // Keep one trusted Linux/Windows-shaped chord in the same path too.
      await page.keyboard.down("Control");
      await page.keyboard.down("Alt");
      await page.keyboard.press("KeyK");
      await page.keyboard.up("Alt");
      await page.keyboard.up("Control");
      await page.waitForSelector(".launcher .search", { timeout: 5_000 });
      await page.keyboard.press("Escape");
      await page.waitForSelector(".launcher", { hidden: true, timeout: 5_000 });
      await page.waitForFunction(
        () => {
          const host = document.querySelector(".terminal-tab.active .terminal-host");
          return host?.contains(document.activeElement) === true;
        },
        { timeout: 5_000 },
      );
    }

    async function assertSplitChordAfterSurvey() {
      const before = await page.$$(".pane");
      await page.evaluate(() => {
        const focused = document.activeElement;
        if (!(focused instanceof HTMLElement)) {
          throw new Error("terminal has no focused element");
        }
        focused.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "/",
            code: "Slash",
            ctrlKey: true,
            altKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await page.waitForFunction(
        (count) => document.querySelectorAll(".pane").length === count + 1,
        { timeout: 5_000 },
        before.length,
      );
    }

    try {
      // Open target + away tabs. A survey needs a LIVE target session matching
      // the selector, and each session registers only once the SPA's terminal
      // WS connects.
      await cs(["new", "--tab-name", TAB]);
      await waitForTerminal(TAB);
      await cs(["new", "--tab-name", AWAY_TAB]);
      await waitForTerminal(AWAY_TAB);
      await clickTab(page, TAB);
      await waitForTargetFocus();
      await ctx.shot("terminal-open");

      // Leg 1: option pick round-trips the label verbatim.
      const opt = await surveyLeg("option", () => page.keyboard.press("1"));
      if (opt.stdout.trim() !== "Alpha") {
        throw new Error(`option stdout: ${JSON.stringify(opt.stdout)}`);
      }
      await assertLauncherChordAfterSurvey();

      // Leg 2: [X] dismiss keeps its distinct line.
      const dis = await surveyLeg("dismiss", () => page.keyboard.press("x"));
      if (dis.stdout.trim() !== "survey dismissed; no answer") {
        throw new Error(`dismiss stdout: ${JSON.stringify(dis.stdout)}`);
      }

      // Leg 3: [F] is the pure will-follow-up-later signal.
      const fol = await surveyLeg("followup", async () => {
        await ctx.shot("survey-before-f");
        await page.keyboard.press("f");
      });
      if (fol.stdout.trim() !== "host will follow up later") {
        throw new Error(`[F] stdout: ${JSON.stringify(fol.stdout)}`);
      }
      if (/follow up file/i.test(`${fol.stdout}${fol.stderr}`)) {
        throw new Error(
          `[F] still mentions a file: ${fol.stdout}${fol.stderr}`,
        );
      }

      // No followup artifact anywhere under the workspace.
      const hits = followupArtifacts(ctx.workspaceDir);
      if (hits.length) {
        throw new Error(`followup artifacts written: ${hits.join(", ")}`);
      }
      // Run the layout-mutating shortcut last; the harness tears the
      // throwaway layout down immediately after this check.
      await assertSplitChordAfterSurvey();
      await ctx.shot("after-followup");
      return {
        option: opt.stdout.trim(),
        dismissed: dis.stdout.trim(),
        followup: fol.stdout.trim(),
        ptyCleanup: [opt.ptyCleanup, dis.ptyCleanup, fol.ptyCleanup],
      };
    } finally {
      // Cleanup so nothing leaks into later checks: resolve any live
      // survey card (which also unblocks a parked cs process), then
      // close the tab -- reason "explicit" auto-removes the SPA tab, no
      // confirm dialog on this path.
      try {
        if (await page.$(".survey-card")) {
          await page.click(".survey-card .survey-dismiss");
        }
      } catch {}
      for (const tab of [TAB, AWAY_TAB]) {
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
    }
  },
};
