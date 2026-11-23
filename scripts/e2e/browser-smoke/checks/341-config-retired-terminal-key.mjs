// The warning-period contract at the real CLI, HTTP and file boundaries.
// Each arm records its own result so a base run exposes every difference.
// A fresh server owns the once-per-process warning; earlier checks can have
// spent the shared server's warning already.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchServer, seedWorkspace, teardownServer } from "../lib/server.mjs";
import { maskTokens } from "../lib/token-mask.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForLog(read, label) {
  const deadline = Date.now() + 5_000;
  while (read().length === 0) {
    assert.ok(Date.now() < deadline, `${label}: stderr deadline expired after 5s`);
    await sleep(25);
  }
  return read().map(maskTokens);
}
const seed = (programStatus) => `[terminal]\nghostty = false\nprogram_status = ${programStatus}\n`;
const sha256 = (bytes) => bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
function readOptional(path) {
  try { return readFileSync(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function replaceFile(path, bytes) {
  if (bytes === null) return rmSync(path, { force: true });
  const staged = `${path}.smoke341`;
  writeFileSync(staged, bytes, { mode: 0o600 });
  renameSync(staged, path);
}
function configHashes(home) {
  return Object.fromEntries(["server.toml", "preferences.toml"].map((file) => [file, sha256(readOptional(join(home, file)))]));
}
function assertWarning(stderr) {
  for (const pattern of [/terminal\.ghostty/, /deprecated/i, /has no effect/i, /remove/i, /future release will reject/i]) {
    assert.match(stderr, pattern, "stderr carries the complete deprecation warning");
  }
}
async function api(serverUrl, path, options = {}) {
  const url = new URL(serverUrl);
  const token = url.searchParams.get("t");
  assert.ok(token, "test server URL has its own bearer token");
  return fetch(new URL(path, url), {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
}
async function readConfig(serverUrl, path = "/api/config") {
  const response = await api(serverUrl, path);
  assert.equal(response.status, 200, `GET ${path}`);
  return response.json();
}

export default {
  name: "config-retired-terminal-key",
  async run(ctx) {
    assert.ok(ctx.chanHome, "CLI checks require the runner's private CHAN_HOME");
    const details = { chanBin: ctx.chanBin, chanHome: ctx.chanHome, arms: {} };
    const errors = [];
    const artifact = join(ctx.outDir, "341-config-retired-terminal-key.json");
    async function arm(name, run) {
      const row = details.arms[name] = {};
      try {
        await run(row);
        row.status = "passed";
      } catch (error) {
        row.status = "failed";
        row.error = maskTokens(error.message);
        errors.push(`${name}: ${row.error}`);
      } finally {
        writeFileSync(artifact, JSON.stringify(details, null, 2) + "\n");
      }
    }

    const configPath = join(ctx.chanHome, "server.toml");
    const original = readOptional(configPath);
    async function cli(row, args) {
      // A stored false makes get's effective true distinct from the old
      // selectable engine. Restore this seed before every independent arm.
      replaceFile(configPath, seed(true));
      row.invocation = { binary: ctx.chanBin, args: ["config", ...args], CHAN_HOME: ctx.chanHome };
      row.before = configHashes(ctx.chanHome);
      try {
        const result = await ctx.exec(ctx.chanBin, row.invocation.args, {
          env: { ...process.env, CHAN_HOME: ctx.chanHome, XDG_RUNTIME_DIR: join(ctx.chanHome, "runtime") },
          timeout: 20_000,
        });
        Object.assign(row, { code: 0, stdout: result.stdout, stderr: result.stderr });
      } catch (error) {
        // A missing binary or a killed/timed-out command is not evidence
        // that the CLI refused a malformed value.
        if (!Number.isInteger(error.code) || error.signal || error.killed) throw error;
        Object.assign(row, { code: error.code, stdout: error.stdout, stderr: error.stderr });
      }
      row.after = configHashes(ctx.chanHome);
    }
    try {
      await arm("a-set-false", async (row) => {
        await cli(row, ["set", "terminal.ghostty", "false"]);
        assert.equal(row.code, 0);
        assert.equal(row.stdout, "");
        assertWarning(row.stderr);
        assert.deepEqual(row.after, row.before, "deprecated set writes no config bytes");
      });
      await arm("b-get", async (row) => {
        await cli(row, ["get", "terminal.ghostty"]);
        assert.equal(row.code, 0);
        assert.equal(row.stdout, "true\n");
        assertWarning(row.stderr);
        assert.deepEqual(row.after, row.before, "deprecated get writes no config bytes");
      });
      await arm("c-list", async (row) => {
        await cli(row, ["get"]);
        assert.equal(row.code, 0);
        assert.match(row.stdout, /^\[server\.terminal\]$/m, "the full listing includes terminal preferences");
        assert.doesNotMatch(row.stdout, /ghostty\s*=/, "the listing omits the retired key");
        assert.deepEqual(row.after, row.before, "listing writes no config bytes");
      });
      await arm("d-set-invalid", async (row) => {
        await cli(row, ["set", "terminal.ghostty", "maybe"]);
        assert.notEqual(row.code, 0);
        assert.equal(row.stdout, "");
        assert.match(row.stderr, /terminal\.ghostty/);
        assert.deepEqual(row.after, row.before, "invalid set writes no config bytes");
      });
    } finally {
      replaceFile(configPath, original);
    }

    await arm("e-patch-invalid", async (row) => {
      const workspaceDir = seedWorkspace();
      const server = launchServer(ctx.chanBin, workspaceDir, undefined, {
        env: { RUST_LOG: "warn,chan_server::extract=debug" },
      });
      row.chanHome = server.chanHome;
      row.serverPid = server.child.pid;
      const rejections = () => server.stderrLines.filter((line) => line.includes("request rejected")
        && line.includes("chan_server::extract") && line.includes("terminal.ghostty"));
      try {
        const serverUrl = await server.url;
        const config = await readConfig(serverUrl);
        const patch = (ghostty) => api(serverUrl, "/api/config", {
          method: "PATCH",
          body: JSON.stringify({ expected_revision: config.revision,
            preferences: { terminal: { ...config.preferences.terminal, ghostty } } }),
        });
        row.before = configHashes(server.chanHome);
        const response = await patch("yes");
        row.httpStatus = response.status;
        row.body = await response.text();
        row.after = configHashes(server.chanHome);
        assert.equal(row.httpStatus, 422, "a non-boolean terminal.ghostty PATCH is rejected as an invalid body");
        assert.deepEqual(JSON.parse(row.body), { error: "the request body does not match what this route accepts" });
        assert.deepEqual(row.after, row.before, "invalid PATCH writes no config bytes");
        row.rejections = await waitForLog(rejections, "extractor rejection");
        assert.equal(row.rejections.length, 1, "exactly one logged rejection names terminal.ghostty");
        const control = await patch(true);
        row.controlStatus = control.status;
        assert.equal(row.controlStatus, 200, "the same PATCH accepts a boolean terminal.ghostty");
        row.controlReadback = (await readConfig(serverUrl)).preferences.terminal;
        assert.equal(Object.hasOwn(row.controlReadback, "ghostty"), false, "the accepted retired key is absent on readback");
        assert.equal(rejections().length, 1, "the boolean control adds no rejection");
      } finally {
        row.stderrLines = server.stderrLines.map(maskTokens);
        await teardownServer(ctx.chanBin, server.child, workspaceDir, server.chanHome);
      }
    });

    await arm("f-stored-false-warning", async (row) => {
      const workspaceDir = seedWorkspace();
      const server = launchServer(ctx.chanBin, workspaceDir, undefined, {
        env: { RUST_LOG: "warn,chan_server::extract=debug" },
        prepareChanHome(home) { writeFileSync(join(home, "server.toml"), seed(true), { mode: 0o600 }); },
      });
      const path = join(server.chanHome, "server.toml");
      const warnings = () => server.stderrLines.filter((line) => /\bWARN\b/.test(line) && line.includes("terminal.ghostty"));
      row.chanHome = server.chanHome;
      row.serverPid = server.child.pid;
      try {
        const serverUrl = await server.url;
        const initial = await readConfig(serverUrl, "/api/workspace");
        assert.equal(initial.preferences.terminal.program_status, true, "startup consumed the seeded file");
        assert.equal(readFileSync(path, "utf8"), seed(true), "startup leaves the seeded file untouched");
        row.startupWarnings = await waitForLog(warnings, "startup warning");

        // A changed live field proves this process loaded the second false
        // file, independently of the warning counter under test.
        replaceFile(path, seed(false));
        const deadline = Date.now() + 20_000;
        for (;;) {
          const current = await readConfig(serverUrl, "/api/workspace");
          if (current.preferences.terminal.program_status === false) break;
          assert.ok(Date.now() < deadline, "watcher did not consume the second seeded file");
          await sleep(100);
        }
        row.reloadConsumed = true;
        assert.equal(readFileSync(path, "utf8"), seed(false), "reload leaves the seeded file untouched");
        // A later extractor log fences stderr delivery after the observed
        // config reload; elapsed time alone cannot prove the pipe caught up.
        const logIndex = server.stderrLines.length;
        const current = await readConfig(serverUrl);
        const fence = await api(serverUrl, "/api/config", {
          method: "PATCH",
          body: JSON.stringify({ expected_revision: current.revision,
            preferences: { terminal: { ghostty: "log-fence" } } }),
        });
        assert.equal(fence.status, 422, "the stderr fence rejects its invalid body");
        row.stderrFence = await waitForLog(() => server.stderrLines.slice(logIndex)
          .filter((line) => line.includes("request rejected") && line.includes("terminal.ghostty")), "reload stderr fence");
        row.warningsAfterReload = warnings().map(maskTokens);
        assert.equal(row.startupWarnings.length, 1, "startup logs exactly one terminal.ghostty warning");
        assert.equal(row.warningsAfterReload.length, 1, "reloading false does not repeat the warning");
        assertWarning(row.warningsAfterReload[0]);
      } finally {
        row.stderrLines = server.stderrLines.map(maskTokens);
        await teardownServer(ctx.chanBin, server.child, workspaceDir, server.chanHome);
      }
    });
    if (errors.length) throw new Error(errors.join("\n"));
    return details;
  },
};
