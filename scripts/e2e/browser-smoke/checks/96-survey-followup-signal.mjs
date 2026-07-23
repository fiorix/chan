// Item A: survey [F] is a pure "host will follow up later" signal.
//
// Drives the REAL `cs terminal survey` (chan shell terminal survey)
// against the harness server: opens a named terminal tab, raises three
// surveys, and answers each from the SPA overlay -- option pick, [X]
// dismiss, [F] follow up. Asserts the three distinct stdout lines the
// asking agent branches on, and that [F] writes NO followup artifact
// anywhere under the workspace (the retired followup-file machinery
// only ever wrote through the Workspace sandbox, so the workspace tree
// is the complete universe of possible write targets).

import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";

const TAB = "SmokeSurvey96";

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

    // Raise one survey (the CLI BLOCKS server-side until the overlay
    // replies), drive the overlay via act(), then await the unblocked
    // CLI for its stdout. The gone-card wait proves the reply POST
    // round-tripped before the next survey is raised (surveys at one
    // target are FIFO-serialized; never overlap two).
    async function surveyLeg(act) {
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
      await act();
      await page.waitForFunction(
        () => !document.querySelector(".survey-card"),
        { timeout: 15_000 },
      );
      return pending; // { stdout, stderr }
    }

    try {
      // Open the target tab: a survey needs a LIVE terminal session
      // matching the selector, and the session registers only once the
      // SPA's terminal WS connects -- poll the list until the name shows.
      // Clicks (not keypresses) throughout: the survey card steals focus
      // on appear but can race the freshly-spawned xterm.
      await cs(["new", "--tab-name", TAB]);
      const deadline = Date.now() + 30_000;
      for (;;) {
        const { stdout } = await cs(["list", "--json"]);
        const sessions = Object.values(JSON.parse(stdout).groups ?? {}).flat();
        if (sessions.some((s) => s.name === TAB)) break;
        if (Date.now() > deadline) {
          throw new Error(`session ${TAB} never registered`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      await ctx.shot("terminal-open");

      // Leg 1: option pick round-trips the label verbatim.
      const opt = await surveyLeg(() =>
        page.click(".survey-card .survey-option"),
      );
      if (opt.stdout.trim() !== "Alpha") {
        throw new Error(`option stdout: ${JSON.stringify(opt.stdout)}`);
      }

      // Leg 2: [X] dismiss keeps its distinct line.
      const dis = await surveyLeg(() =>
        page.click(".survey-card .survey-dismiss"),
      );
      if (dis.stdout.trim() !== "survey dismissed; no answer") {
        throw new Error(`dismiss stdout: ${JSON.stringify(dis.stdout)}`);
      }

      // Leg 3: [F] is the pure will-follow-up-later signal.
      const fol = await surveyLeg(async () => {
        await ctx.shot("survey-before-f");
        await page.click(".survey-card .survey-followup");
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
      await ctx.shot("after-followup");
      return {
        option: opt.stdout.trim(),
        dismissed: dis.stdout.trim(),
        followup: fol.stdout.trim(),
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
      try {
        await cs(["close", "--tab-name", TAB]);
      } catch {}
      try {
        await page.waitForFunction(
          () => !document.querySelector(".terminal-tab"),
          { timeout: 10_000 },
        );
      } catch {}
    }
  },
};
