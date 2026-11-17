import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Offline verdict test for detailsclear-native.mjs: the driver's page
// expressions evaluated against a stubbed inspector, at a passing state, at
// the base's behaviour, and against a dead inspector. No browser, no chan,
// no guest, no network beyond loopback. The base run takes about a minute:
// every node-side wait runs to its bound before the verdict, which is the
// behaviour under test.
const driverUrl = new URL("./detailsclear-native.mjs", import.meta.url);
const driverSource = readFileSync(driverUrl, "utf8");

test("the driver sends no awaitPromise and waits nowhere in the page", () => {
  assert.doesNotMatch(driverSource, /awaitPromise:\s*true/, "no awaitPromise in Runtime.evaluate");
  assert.doesNotMatch(driverSource, /setTimeout\s*\(\s*tick/, "no in-page poll loops");
});

const STUB = `
function inspectorEval(endpoint, titleSub, expression, timeoutMs) {
  return (async () => {
    const e = expression;
    const has = (s) => e.includes(s);
    const scenario = process.env.P6PROOF_SCENARIO;
    if (scenario === "dead") throw new Error("inspector socket failed");
    if (has("chan:command")) return "toggled";
    if (has("listbox")) return true;
    if (has("browser_side_panes")) return "docked";
    if (has("checkVisibility")) return "dock";
    if (has("tab-b.md") && has(".click()")) return "clicked";
    if (has("tab-b.md") && has("aria-selected")) {
      globalThis.__tabSelReads = (globalThis.__tabSelReads || 0) + 1;
      if (globalThis.__tabSelReads === 1) return "selected";
      return scenario === "correct" ? "false" : "true";
    }
    if (has("tab-b.md")) return "/TESTWS/tab-b.md";
    if (has("row-icon")) return "focused";
    if (has("aria-selected") && has("dock-a.md")) return scenario === "correct" ? "true" : "false";
    if (has("aria-activedescendant")) return "targeted";
    if (has("dock-a.md")) return "/TESTWS/dock-a.md";
    if (has("combobox")) return "open";
    if (has("deck-result-title")) return "picked";
    if (has('role="dialog"')) return "closed";
    if (has("kind-chip")) return scenario === "correct" ? "workspace" : "absent";
    throw new Error("unstubbed expression: " + e.slice(0, 80));
  })();
}
`;

function stagedDriver() {
  const start = driverSource.indexOf("function inspectorEval(");
  const end = driverSource.indexOf("}\n\nconst run =");
  assert.ok(start >= 0 && end > start, "inspectorEval bounds found; test tracks the driver shape");
  const withStub = `${driverSource.slice(0, start)}${STUB}\n${driverSource.slice(end + 2)}`
    .replace(/const xdo = \(args[^)]*\) => spawnSync\([^;]*;/,
      "const xdo = (args) => ({ status: 0, stdout: '', stderr: '' });");
  assert.ok(!withStub.includes("awaitPromise: true"), "stubbed driver sends no awaitPromise");
  const dir = join(tmpdir(), `p6proof-detailsclear-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "driver-under-test.mjs");
  writeFileSync(file, withStub);
  return { dir, file };
}

function runDriver(scenario) {
  const { dir, file } = stagedDriver();
  const ws = join(dir, "ws");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "dock-a.md"), "dock file\n");
  writeFileSync(join(ws, "tab-b.md"), "tab file\n");
  const out = join(dir, "out");
  let stdout = "";
  let code = -1;
  try {
    stdout = execFileSync(process.execPath, [file, "--inspector", "127.0.0.1:1", "--out", out,
      "--xid", "0x1", "--workspace", ws, "--sha", "b".repeat(40), "--engine-version", "proof"],
      { encoding: "utf8", timeout: 300_000, env: { ...process.env, P6PROOF_SCENARIO: scenario } });
    code = 0;
  } catch (err) {
    code = err.status ?? -1;
    stdout = String((err.stdout ?? "") + (err.stderr ?? ""));
  }
  const lines = stdout.split("\n").filter((l) => l.includes("detailsclear-native:"));
  let json = null;
  try { json = JSON.parse(readFileSync(join(out, "detailsclear-native.json"), "utf8")); } catch {}
  rmSync(dir, { recursive: true, force: true });
  return { code, lines, json };
}

test("correct behaviour exits 0 with sixteen ok lines and PASS", () => {
  const { code, lines, json } = runDriver("correct");
  assert.equal(code, 0);
  assert.equal(lines.filter((l) => l.includes(" ok ")).length, 16);
  assert.ok(lines.some((l) => l.endsWith("PASS")));
  assert.equal(json?.ok, true);
  assert.equal(json?.exitCode, 0);
});

test("base behaviour exits 10 with the three property FAIL lines", () => {
  const { code, lines, json } = runDriver("base");
  assert.equal(code, 10);
  for (const want of [
    "FAIL tab inspector shows the workspace absent",
    'FAIL dock keeps its selection "false"',
    'FAIL tab selection cleared "true"',
  ]) {
    assert.ok(lines.some((l) => l.includes(want)), `missing '${want}'`);
  }
  assert.equal(json?.exitCode, 10);
  assert.equal(json?.ok, false);
});

test("a dead inspector exits 3", () => {
  const { code } = runDriver("dead");
  assert.equal(code, 3);
});
