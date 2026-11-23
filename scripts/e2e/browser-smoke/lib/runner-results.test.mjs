import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

// Run the production entry point with inert browser/server dependencies. No
// chan process, browser, network, build or package installation is involved.
function run(t, { body = "return { observed: true };", before = "", only = "001-", mode = "", startup = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "smoke-verdict-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const suite = join(root, "scripts/e2e/browser-smoke");
  const put = (name, text) => {
    const path = join(suite, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  mkdirSync(join(suite, "lib"), { recursive: true });
  copyFileSync(new URL("../run.mjs", import.meta.url), join(suite, "run.mjs"));
  copyFileSync(new URL("./token-mask.mjs", import.meta.url), join(suite, "lib/token-mask.mjs"));
  const packages = { "": { dependencies: { "puppeteer-core": "1.0.0" } }, "node_modules/puppeteer-core": { version: "1.0.0" } };
  put("package-lock.json", JSON.stringify({ packages }));
  put("node_modules/.package-lock.json", JSON.stringify({ packages }));
  put("node_modules/puppeteer-core/package.json", JSON.stringify({ name: "puppeteer-core", version: "1.0.0", type: "module", main: "index.mjs" }));
  put("node_modules/puppeteer-core/index.mjs", `
    ${startup}
    const mode = process.env.CONTROL_MODE;
    const page = { on() {}, async goto() {}, async waitForSelector() {}, async screenshot() {} };
    const context = {
      async newPage() { return page; }, async overridePermissions() {}, async pages() { return [page]; },
      async close() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        console.log("CONTROL_CLEANUP");
        if (mode === "cleanup") throw new Error("CONTROL_CLEANUP_ERROR");
      },
    };
    const browser = {
      connected: true, async newPage() { return page; },
      defaultBrowserContext() { return { async pages() { return []; } }; },
      async createBrowserContext() { return context; },
      async close() {}, process() { return { kill() {} }; },
    };
    page.browser = () => browser;
    export default { async launch() { return browser; } };
  `);
  put("lib/server.mjs", `
    export function defaultChrome() { return process.execPath; }
    export function findControlSocket() { return null; }
    export function seedWorkspace() {
      if (process.env.CONTROL_MODE === "seed") throw new Error("CONTROL_SEED_ERROR");
      return "fixture-workspace";
    }
    export function launchServer() {
      return { child: { pid: 1, kill() {} }, url: Promise.resolve("http://127.0.0.1:1/?t=fixture"), chanHome: "fixture-home" };
    }
    export async function teardownServer() { console.log("CONTROL_TEARDOWN"); }
  `);
  put("lib/pdf.mjs", "export const assertPdf = () => {}; export const assertNoDuplicateBands = () => {};");
  put("lib/delay-proxy.mjs", "export const startDelayProxy = () => {};");
  put("lib/failure-record.mjs", `
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    export class FailureRecord {
      constructor(name, out) { this.path = join(out, name + ".timeline.json"); }
      startResources() {} mark() {} async observePage() {}
      write() {
        if (process.env.CONTROL_MODE === "timeline") throw new Error("CONTROL_TIMELINE_ERROR");
        writeFileSync(this.path, "{}");
        console.log("CONTROL_TIMELINE");
        return this.path;
      }
    }
  `);
  put("checks/001-control.mjs", `${before}\nexport default { name: "control", async run(ctx) { ${body} } };`);
  mkdirSync(join(root, "runtime"), { mode: 0o700 });
  const child = spawnSync(process.execPath, [join(suite, "run.mjs")], {
    cwd: root, encoding: "utf8", timeout: 5000,
    env: { PATH: dirname(process.execPath), HOME: root, TMPDIR: root,
      CHAN_BIN: process.execPath, CHROME_BIN: process.execPath,
      SMOKE_SKIP_BUILD: "1", SMOKE_ONLY: only, SMOKE_OUT_DIR: join(root, "out"),
      XDG_RUNTIME_DIR: join(root, "runtime"), CONTROL_MODE: mode },
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  const results = JSON.parse(readFileSync(join(root, "out/results.json"), "utf8"));
  assert.equal(results.exitCode, child.status);
  const log = child.stdout + child.stderr;
  if (child.status !== 0) {
    assert.equal(results.ok, false);
    assert.doesNotMatch(log, /ALL GREEN|\[smoke\]   PASS/);
  }
  return { results, log, rc: child.status };
}

test("PASS follows both page cleanup and timeline persistence", (t) => {
  const { results: r, log, rc } = run(t);
  assert.equal(rc, 0);
  assert.equal(r.status, "passed");
  assert.equal(r.ok, true);
  assert.deepEqual(r.selectedChecks, ["001-control.mjs"]);
  assert.equal(r.checks[0].status, "passed");
  assert.ok(log.indexOf("CONTROL_CLEANUP") < log.indexOf("[smoke]   PASS"));
  assert.ok(log.indexOf("CONTROL_TIMELINE") < log.indexOf("[smoke]   PASS"));
  assert.match(log, /ALL GREEN/);
});

test("an assertion red preserves its stack and exits 1", (t) => {
  const { results: r, log, rc } = run(t, { body: 'throw new Error("CONTROL_RED");' });
  assert.equal(rc, 1);
  assert.equal(r.status, "failed");
  assert.equal(r.failed, 1);
  assert.match(r.checks[0].error, /Error: CONTROL_RED\n\s+at/);
  assert.match(log, /\[smoke\]   FAIL:.*CONTROL_RED/);
});

test("a skip is incomplete and exits 2", (t) => {
  const { results: r, log, rc } = run(t, { body: 'ctx.skip("CONTROL_SKIP");' });
  assert.equal(rc, 2);
  assert.equal(r.status, "skipped");
  assert.equal(r.skipped, 1);
  assert.equal(r.failed, 0);
  assert.equal(r.checks[0].reason, "CONTROL_SKIP");
  assert.match(log, /\[smoke\]   SKIP: CONTROL_SKIP/);
  assert.match(log, /INCOMPLETE/);
});

for (const body of ['ctx.skip("CONTROL_SKIP");', 'return null;']) {
  for (const mode of ["cleanup", "timeline"]) {
    test(`${mode} failure overrides ${body.startsWith("ctx.skip") ? "skip" : "pass"}`, (t) => {
      const { results: r, log, rc } = run(t, { body, mode });
      assert.equal(rc, 2);
      assert.equal(r.status, "error");
      assert.equal(r.errors, 1);
      assert.equal(r.skipped, 0);
      assert.equal(r.checks[0].errors[0].phase, mode);
      assert.match(r.checks[0].error, new RegExp(`CONTROL_${mode.toUpperCase()}_ERROR`));
      assert.match(log, /\[smoke\]   ERROR:/);
      assert.doesNotMatch(log, /\[smoke\]   SKIP:/);
      if (body.startsWith("ctx.skip")) assert.equal(r.checks[0].skipReason, "CONTROL_SKIP");
    });
  }
}

for (const only of ["missing-", "001-,missing-", " , "]) {
  test(`unmatched selection ${JSON.stringify(only)} fails before setup`, (t) => {
    const { results: r, log, rc } = run(t, { only });
    assert.equal(rc, 2);
    assert.equal(r.status, "selection-error");
    assert.deepEqual(r.checks, []);
    assert.match(log, /SELECTION ERROR/);
    assert.doesNotMatch(log, /seeding workspace|puppeteer-core=/);
  });
}

for (const [name, options, phase] of [
  ["check import", { before: 'import "./CONTROL_MISSING_MODULE.mjs";' }, "import"],
  ["broken fixture", { body: 'await import("node:fs").then(fs => fs.readFileSync("CONTROL_MISSING_FIXTURE"));' }, "check"],
  ["timeout", { body: 'throw Object.assign(new Error("CONTROL_TIMEOUT"), { name: "TimeoutError" });' }, "check"],
  ["crashed browser", { body: 'ctx.page.browser().connected = false; throw new Error("CONTROL_CRASH");' }, "check"],
  ["dependency import", { startup: 'import "./CONTROL_MISSING_DRIVER.mjs";' }, "startup"],
  ["seed fixture", { mode: "seed" }, "startup"],
]) {
  test(`${name} is an environment error, not an assertion red`, (t) => {
    const { results: r, log, rc } = run(t, options);
    assert.equal(rc, 2);
    assert.equal(r.status, "error");
    assert.equal(r.failed, 0);
    assert.match(r.fatal ?? r.checks[0].error, /CONTROL_/);
    assert.equal(r.errorPhase ?? r.checks[0].errors[0].phase, phase);
    assert.match(log, /ERROR/);
    assert.doesNotMatch(log, /FAILURE\(S\)/);
  });
}
