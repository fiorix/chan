// `cs terminal write --submit` against a shell session applies the requested
// agent chord and reports that the target itself derives no agent.
//
// The encoding is selected by --submit at enqueue and delivery stays
// asynchronous. A plain login shell derives none, yet its bracketed-paste
// mode accepts the codex chord and executes the submitted line.
//
// Everything here rides the real control socket against the real server, so
// it covers the whole path the unit tests can only cover in halves: the
// typed control response, its wire round trip, and the shell's execution.

const WINDOW_ID = "cs-submit-shell-chord-smoke";
const TAB_NAME = "submitrefusal";
const MARKER = "SMOKE121_SUBMIT_OK";

function rendered(value) {
  return typeof value === "string" ? value : String(value ?? "");
}

async function cli(ctx, args) {
  return ctx.exec(ctx.chanBin, ["shell", ...args], {
    cwd: ctx.workspaceDir,
    env: {
      ...process.env,
      CHAN_CONTROL_SOCKET: ctx.controlSocket,
      CHAN_WINDOW_ID: WINDOW_ID,
      CHAN_WORKSPACE_PATH: ctx.workspaceDir,
    },
    timeout: 120_000,
  });
}

export default {
  name: "cs submit applies named chord to shell",
  async run(ctx) {
    const ownUrl = new URL(ctx.serverUrl);
    ownUrl.searchParams.set("w", WINDOW_ID);
    const page = await ctx.browser.newPage();

    try {
      await page.goto(ownUrl.href, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      await page.bringToFront();
      // The pane is mounted; the server does not necessarily know this window
      // yet, and every `cs terminal` call below addresses it by id.
      await ctx.waitWindowLive(WINDOW_ID);

      // A plain terminal tab: its spawn command is the login shell, so the
      // server derives no submit agent for it.
      // `terminal new` is fire and forget: it queues a window command and the
      // SPA spawns the PTY, so the session appears in the registry a moment
      // after the CLI returns.
      const opened = await cli(ctx, ["terminal", "new", "--tab-name", TAB_NAME]);
      let target = null;
      let listed = { stdout: "" };
      for (let attempt = 0; attempt < 40 && !target; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        listed = await cli(ctx, ["terminal", "list", "--json"]);
        const rows = Object.values(JSON.parse(listed.stdout).groups ?? {}).flat();
        target = rows.find((row) => row.name === TAB_NAME) ?? null;
      }
      if (!target) {
        throw new Error(
          `terminal ${TAB_NAME} never appeared after 20s\n` +
            `new said: ${rendered(opened.stdout)}${rendered(opened.stderr)}\n` +
            `list said: ${listed.stdout}`,
        );
      }
      if (target.agent != null) {
        throw new Error(
          `precondition failed: ${TAB_NAME} derived agent ${target.agent}, ` +
            "so it is not the shell case this check exists for",
        );
      }

      const submitted = await cli(ctx, [
        "terminal",
        "write",
        "--tab-name",
        TAB_NAME,
        "--submit",
        "codex",
        "printf '%s%s\\n' 'SMOKE121_' 'SUBMIT_OK'",
      ]);
      const deadline = Date.now() + 20_000;
      let scrollback = "";
      while (Date.now() < deadline) {
        const read = await cli(ctx, ["terminal", "scrollback", "--tab-name", TAB_NAME]);
        scrollback = rendered(read.stdout);
        if (scrollback.includes(MARKER)) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!scrollback.includes(MARKER)) {
        throw new Error(`submitted shell marker missing: ${MARKER}`);
      }
      const said = `${rendered(submitted.stdout)}${rendered(submitted.stderr)}`;
      for (const needle of ["queued", TAB_NAME, "derives no agent: the codex chord was applied as requested"]) {
        if (!said.includes(needle)) {
          throw new Error(`submit acknowledgement lost ${JSON.stringify(needle)}: ${said}`);
        }
      }

      // Without --submit the write is still queued, with no chord applied.
      const plain = await cli(ctx, [
        "terminal",
        "write",
        "--tab-name",
        TAB_NAME,
        "probe",
      ]);
      const plainSaid = `${rendered(plain.stdout)}${rendered(plain.stderr)}`;
      if (!plainSaid.includes("queued")) {
        throw new Error(`plain write lost its acknowledgement: ${plainSaid}`);
      }

      await cli(ctx, ["terminal", "close", "--tab-name", TAB_NAME]);
    } finally {
      await page.close();
    }
  },
};
