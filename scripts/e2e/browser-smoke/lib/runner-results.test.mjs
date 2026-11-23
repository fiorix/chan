import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

// Run the production entry point with inert browser/server dependencies. No
// chan process, browser, network, build or package installation is involved.
function run(t, { body = "return { observed: true };", bodies = [body], before = "", only = "00", mode = "", startup = "", args = [] } = {}) {
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
      async close() { if (mode === "fatal-and-teardown") throw new Error("CONTROL_BROWSER_TEARDOWN"); }, process() { return { kill() {} }; },
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
    export async function teardownServer() {
      console.log("CONTROL_TEARDOWN");
      if (process.env.CONTROL_MODE === "teardown") throw new Error("CONTROL_TEARDOWN_ERROR");
    }
  `);
  put("lib/pdf.mjs", "export const assertPdf = () => {}; export const assertNoDuplicateBands = () => {};");
  put("lib/delay-proxy.mjs", "export const startDelayProxy = () => {};");
  put("lib/failure-record.mjs", `
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    export class FailureRecord {
      constructor(name, out) { this.path = join(out, name + ".timeline.json"); }
      startResources() { if (process.env.CONTROL_MODE === "fatal-and-teardown") throw new Error("CONTROL_FIRST_FATAL"); } mark() {} async observePage() {}
      write() {
        if (process.env.CONTROL_MODE === "timeline") throw new Error("CONTROL_TIMELINE_ERROR");
        writeFileSync(this.path, "{}");
        console.log("CONTROL_TIMELINE");
        return this.path;
      }
    }
  `);
  for (const [index, checkBody] of bodies.entries()) {
    put(`checks/${String(index + 1).padStart(3, "0")}-control.mjs`,
      `${before}\nexport default { name: "control-${index + 1}", async run(ctx) { ${checkBody} } };`);
  }
  mkdirSync(join(root, "runtime"), { mode: 0o700 });
  const child = spawnSync(process.execPath, [join(suite, "run.mjs"), ...args], {
    cwd: root, encoding: "utf8", timeout: 5000,
    env: { PATH: dirname(process.execPath), HOME: root, TMPDIR: root,
      CHAN_BIN: process.execPath, CHROME_BIN: process.execPath,
      SMOKE_SKIP_BUILD: "1", SMOKE_ONLY: only, SMOKE_OUT_DIR: join(root, "out"),
      XDG_RUNTIME_DIR: join(root, "runtime"), CONTROL_MODE: mode },
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  const log = child.stdout + child.stderr;
  if (args.includes("--deps-only")) {
    assert.equal(existsSync(join(root, "out/results.json")), false);
    return { log, rc: child.status };
  }
  const results = JSON.parse(readFileSync(join(root, "out/results.json"), "utf8"));
  assert.equal(results.exitCode, child.status);
  if (child.status !== 0) {
    assert.equal(results.ok, false);
    assert.doesNotMatch(log, /ALL GREEN/);
  }
  assert.equal((log.match(/\[smoke\]   PASS:/g) ?? []).length,
    results.checks.filter((check) => check.status === "passed").length);
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
  ["explicit environment tag", { body: 'throw Object.assign(new Error("CONTROL_ENVIRONMENT"), { smokeEnvironment: true });' }, "check"],
  ["crashed browser", { body: 'ctx.page.browser().connected = false; throw new Error("CONTROL_CRASH");' }, "check"],
  ["dependency import", { startup: 'import "./CONTROL_MISSING_DRIVER.mjs";' }, "startup"],
  ["seed fixture", { mode: "seed" }, "startup"],
  ["server teardown", { mode: "teardown" }, "server cleanup"],
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

for (const [name, body] of [
  ["broken fixture", 'await import("node:fs").then(fs => fs.readFileSync("CONTROL_MISSING_FIXTURE"));'],
  ["timeout", 'throw Object.assign(new Error("CONTROL_TIMEOUT"), { name: "TimeoutError" });'],
  ["access", 'throw Object.assign(new Error("CONTROL_ACCESS"), { code: "EACCES" });'],
]) {
  test(`${name} thrown in a check body is FAIL`, (t) => {
    const { results: r, log, rc } = run(t, { body });
    assert.equal(rc, 1);
    assert.equal(r.failed, 1);
    assert.equal(r.errors, 0);
    assert.equal(r.checks[0].errors[0].phase, "check");
    assert.match(log, /\[smoke\]   FAIL:/);
  });
}

const checkBodies = {
  fail: 'throw new Error("CONTROL_RED");',
  pass: 'return { observed: true };',
  skip: 'ctx.skip("CONTROL_SKIP");',
  error: 'throw Object.assign(new Error("CONTROL_ENVIRONMENT"), { smokeEnvironment: true });',
};
for (const names of [["fail", "pass"], ["pass", "fail"], ["fail", "skip"], ["fail", "error"]]) {
  test(`aggregate retains every row in ${names.join(", ")}`, (t) => {
    const { results: r, log, rc } = run(t, { bodies: names.map((name) => checkBodies[name]) });
    const statuses = { fail: "failed", pass: "passed", skip: "skipped", error: "error" };
    assert.deepEqual(r.checks.map((c) => c.status), names.map((name) => statuses[name]));
    assert.equal(rc, names.includes("error") ? 2 : 1);
    assert.equal(r.failed, 1);
    assert.equal(r.passed, names.includes("pass") ? 1 : 0);
    assert.equal(r.skipped, names.includes("skip") ? 1 : 0);
    assert.equal(r.errors, names.includes("error") ? 1 : 0);
    assert.match(log, new RegExp(`${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped, ${r.errors} errors`));
  });
}

test("a check-1 timer that throws during check 2 revokes aggregate success", (t) => {
  const { results: r, log, rc } = run(t, { bodies: [
    `setTimeout(function crashDuringSecond() {
      if (!globalThis.secondCheckStarted) return setTimeout(crashDuringSecond, 5);
      throw new Error("CONTROL_LATE_CRASH");
    }, 5); return null;`,
    'globalThis.secondCheckStarted = true; await new Promise((resolve) => setTimeout(resolve, 1000));',
  ] });
  assert.equal(rc, 2);
  assert.equal(r.status, "error");
  assert.deepEqual(r.checks.map((c) => c.status), ["passed", "error"]);
  assert.match(r.fatal, /CONTROL_LATE_CRASH/);
  assert.equal(r.errorPhase, "uncaught exception");
  assert.match(log, /ERROR/);
});

test("completed rows are persisted as running before the next body", (t) => {
  const { results: r, rc } = run(t, { bodies: [checkBodies.fail, `
    const fs = await import("node:fs");
    const partial = JSON.parse(fs.readFileSync(ctx.outDir + "/results.json", "utf8"));
    const assert = (await import("node:assert/strict")).default;
    assert.equal(partial.status, "running");
    assert.equal(partial.ok, false);
    assert.equal(partial.exitCode, null);
    assert.equal(partial.finishedAt, undefined);
    assert.equal(partial.checks.length, 1);
    assert.equal(partial.checks[0].status, "failed");
    return { partialRead: true };
  `] });
  assert.equal(rc, 1);
  assert.deepEqual(r.checks.map((c) => c.status), ["failed", "passed"]);
  assert.equal(r.checks[1].details.partialRead, true);
});

for (const body of [
  'return { value: 1n };',
  'const cycle = {}; cycle.self = cycle; return cycle;',
  'throw Object.assign(new Error("CONTROL_RED"), { smokeDetails: { value: 1n } });',
]) {
  test(`nonserializable details fail only their row: ${body}`, (t) => {
    const { results: r, rc } = run(t, { bodies: [body, checkBodies.pass] });
    assert.equal(rc, 1);
    assert.deepEqual(r.checks.map((c) => c.status), ["failed", "passed"]);
    assert.match(r.checks[0].error, /TypeError/);
    assert.equal(r.fatal, undefined);
  });
}

test("details are snapshotted before later checks can mutate them", (t) => {
  const { results: r, rc } = run(t, { bodies: [
    'globalThis.details = { value: "original" }; return globalThis.details;',
    'globalThis.details.value = 1n; return null;',
  ] });
  assert.equal(rc, 0);
  assert.deepEqual(r.checks[0].details, { value: "original" });
});

test("the first fatal cause survives a later teardown error", (t) => {
  const { results: r, log, rc } = run(t, {
    mode: "fatal-and-teardown",
  });
  assert.equal(rc, 2);
  assert.equal(r.errorPhase, "runtime");
  assert.match(r.fatal, /CONTROL_FIRST_FATAL/);
  assert.match(log, /CONTROL_BROWSER_TEARDOWN/);
});

test("an import failure does not count as a body that ran", (t) => {
  const { results: r, log } = run(t, { before: 'import "./CONTROL_MISSING_MODULE.mjs";' });
  assert.equal(r.ran, 0);
  assert.equal(r.checks[0].ran, false);
  assert.match(log, /0 ran/);
});

test("dependency-only failure emits one cause without a results-path TypeError", (t) => {
  const { log, rc } = run(t, { args: ["--deps-only"], startup: 'import "./CONTROL_MISSING_DRIVER.mjs";' });
  assert.equal(rc, 2);
  assert.match(log, /CONTROL_MISSING_DRIVER/);
  assert.doesNotMatch(log, /ERROR \(results\)|TypeError|ALL GREEN/);
});
