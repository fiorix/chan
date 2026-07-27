// `cs terminal write --submit` against a shell session: the requested
// hands-free submit cannot be encoded, and the command says so with its
// EXIT STATUS, not only in prose.
//
// The encoding is decided synchronously at enqueue: the server derives each
// target's agent from that session's spawn command and CHAN_AGENT, and a
// plain login shell derives none. Delivery stays asynchronous and still
// reports success, so this check pins exactly one thing: a refusal the
// server already knows about must not exit 0.
//
// Everything here rides the real control socket against the real server, so
// it covers the whole path the unit tests can only cover in halves: the
// typed control response, its wire round trip, and the client's exit-code
// mapping.

const WINDOW_ID = "cs-submit-refusal-smoke";
const TAB_NAME = "submitrefusal";
const SUBMIT_REFUSED_EXIT = 69;

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

/// Run a cs command expected to FAIL, returning its exit code and streams.
/// A command that unexpectedly succeeds is the finding, so surface it.
async function cliFailure(ctx, args) {
  try {
    const ok = await cli(ctx, args);
    throw new Error(
      `cs ${args.join(" ")} unexpectedly exited 0\n${rendered(ok.stdout)}${rendered(ok.stderr)}`,
    );
  } catch (error) {
    if (error.message?.includes("unexpectedly exited 0")) throw error;
    return {
      code: error.code ?? error.exitCode,
      stdout: rendered(error.stdout),
      stderr: rendered(error.stderr),
      message: rendered(error.message),
    };
  }
}

export default {
  name: "cs submit refusal exits non-zero",
  async run(ctx) {
    const ownUrl = new URL(ctx.serverUrl);
    ownUrl.searchParams.set("w", WINDOW_ID);
    const page = await ctx.browser.newPage();

    try {
      await page.goto(ownUrl.href, {
        waitUntil: "networkidle2",
        timeout: 60_000,
      });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      await page.bringToFront();

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

      // The refusal: a submit was requested and cannot be encoded.
      const refused = await cliFailure(ctx, [
        "terminal",
        "write",
        "--tab-name",
        TAB_NAME,
        "--submit",
        "codex",
        "probe",
      ]);
      if (refused.code !== SUBMIT_REFUSED_EXIT) {
        throw new Error(
          `expected exit ${SUBMIT_REFUSED_EXIT}, got ${refused.code}\n` +
            `${refused.stdout}${refused.stderr}${refused.message}`,
        );
      }
      // The acknowledgement still reaches a human: the bytes WERE queued, and
      // the message names the target and why it got no chord.
      const said = `${refused.stdout}${refused.stderr}${refused.message}`;
      for (const needle of ["queued", TAB_NAME, "shell session"]) {
        if (!said.includes(needle)) {
          throw new Error(`refusal message lost ${JSON.stringify(needle)}: ${said}`);
        }
      }

      // Contrast: the same write with no --submit asks for no encoding, so
      // there is nothing to refuse and it stays a plain success.
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
