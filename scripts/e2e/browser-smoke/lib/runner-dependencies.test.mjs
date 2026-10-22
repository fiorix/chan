import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const runner = readFileSync(new URL("../run.mjs", import.meta.url), "utf8");
const start = runner.indexOf("// Self-install harness deps");
const end = runner.indexOf('const { default: puppeteer }', start);
assert.ok(start >= 0 && end > start, "runner dependency prelude is present");
const prelude = new Function("HERE", "existsSync", "readFileSync", "join", "execFileSync", "console", runner.slice(start, end));
const versions = { "puppeteer-core": "25.15.0", "pdf-lib": "1.17.1", ws: "8.21.0" };
const resolved = { ...versions, "devtools-protocol": "0.0.128" };

function fixture(state) {
  const root = mkdtempSync(join(tmpdir(), "chan-smoke-install-"));
  const suite = join(root, "suite");
  const stub = join(root, "bin");
  const calls = join(root, "npm-calls");
  mkdirSync(suite);
  mkdirSync(stub);
  const packages = { "": { dependencies: Object.fromEntries(Object.keys(versions).map((name) => [name, "^" + versions[name]])) } };
  for (const [name, version] of Object.entries(resolved)) packages[`node_modules/${name}`] = { version };
  writeFileSync(join(suite, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));
  if (state !== "absent") {
    mkdirSync(join(suite, "node_modules"));
    const installed = { packages: {} };
    for (const [name, version] of Object.entries(resolved)) {
      const staleRecord = (state === "stale-puppeteer" && name === "puppeteer-core") || (state === "stale-ws" && name === "ws") || (state === "stale-transitive-record" && name === "devtools-protocol") || (state === "stale-record-current-package" && name === "puppeteer-core");
      const stalePackage = (state === "stale-puppeteer" && name === "puppeteer-core") || (state === "stale-ws" && name === "ws") || (state === "current-record-stale-package" && name === "puppeteer-core");
      installed.packages[`node_modules/${name}`] = { version: staleRecord ? "24.0.0" : version };
      mkdirSync(join(suite, "node_modules", name), { recursive: true });
      writeFileSync(join(suite, "node_modules", name, "package.json"), JSON.stringify({ version: stalePackage ? "24.0.0" : version }));
    }
    if (state !== "missing-record") writeFileSync(join(suite, "node_modules", ".package-lock.json"), JSON.stringify(installed));
  }
  const npm = join(stub, "npm");
  writeFileSync(npm, `#!/bin/sh
printf '%s\\n' "$*" >> "$BSINST_CALLS"
[ "$#" -eq 3 ] && [ "$1" = ci ] && [ "$2" = --no-audit ] && [ "$3" = --no-fund ] || exit 71
mkdir -p "$BSINST_SUITE/node_modules/puppeteer-core"
printf '{"version":"25.15.0"}\\n' > "$BSINST_SUITE/node_modules/puppeteer-core/package.json"
`);
  chmodSync(npm, 0o755);
  return { root, suite, stub, calls };
}

function exercise(state) {
  const built = fixture(state);
  const previous = { PATH: process.env.PATH, BSINST_CALLS: process.env.BSINST_CALLS, BSINST_SUITE: process.env.BSINST_SUITE };
  const lines = [];
  try {
    process.env.PATH = `${built.stub}:${previous.PATH}`;
    process.env.BSINST_CALLS = built.calls;
    process.env.BSINST_SUITE = built.suite;
    assert.doesNotThrow(() => prelude(built.suite, existsSync, readFileSync, join, execFileSync, { log: (line) => lines.push(line) }));
    return { calls: existsSync(built.calls) ? readFileSync(built.calls, "utf8").trim().split("\n") : [], lines };
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(built.root, { recursive: true, force: true });
  }
}

test("stale Puppeteer record calls strict npm ci once", () => {
  assert.deepEqual(exercise("stale-puppeteer").calls, ["ci --no-audit --no-fund"]);
});

test("a matching installed record skips npm", () => {
  assert.deepEqual(exercise("matching").calls, []);
});

test("absent node_modules calls strict npm ci once", () => {
  assert.deepEqual(exercise("absent").calls, ["ci --no-audit --no-fund"]);
});

test("other stale direct dependencies call strict npm ci once", () => {
  assert.deepEqual(exercise("stale-ws").calls, ["ci --no-audit --no-fund"]);
});

test("the run header names the installed Puppeteer version", () => {
  assert.ok(exercise("matching").lines.includes("[smoke] puppeteer-core=25.15.0"));
});


test("a stale transitive record calls strict npm ci once", () => {
  assert.deepEqual(exercise("stale-transitive-record").calls, ["ci --no-audit --no-fund"]);
});

test("a stale record with a current package calls strict npm ci once", () => {
  assert.deepEqual(exercise("stale-record-current-package").calls, ["ci --no-audit --no-fund"]);
});

test("a current record with a stale package calls strict npm ci once", () => {
  assert.deepEqual(exercise("current-record-stale-package").calls, ["ci --no-audit --no-fund"]);
});

test("node_modules without a hidden record calls strict npm ci once", () => {
  assert.deepEqual(exercise("missing-record").calls, ["ci --no-audit --no-fund"]);
});
