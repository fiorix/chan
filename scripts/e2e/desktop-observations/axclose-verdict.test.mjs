import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./axclose.mjs", import.meta.url), "utf8");
const start = source.indexOf("  const states = ");
const end = source.indexOf("  result.finished = ", start);
assert.ok(start >= 0 && end > start, "native controller verdict block is present");
// Evaluate the controller's own decision without starting its native lifecycle.
const verdict = new Function("result", `${source.slice(start, end)}\nreturn code;`);
const fault = JSON.parse(readFileSync(new URL("./fixtures/axclose/fault.json", import.meta.url), "utf8"));
const held = JSON.parse(readFileSync(new URL("./fixtures/axclose/held.json", import.meta.url), "utf8"));

test("recorded selection faults outrank unavailable close controls", () => {
  assert.deepEqual(fault.arms.map((arm) => arm.status), ["fault", "fault", "fault", "unavailable", "unavailable", "unavailable"]);
  assert.equal(verdict(fault), 10);
});

test("an observed fault outranks an incomplete arm or cleanup", () => {
  const result = structuredClone(fault);
  result.arms[3].status = "incomplete";
  assert.equal(verdict(result), 10);
  result.arms[3].status = "unavailable";
  result.errors.push({ status: "incomplete", message: "instrumented cleanup failure" });
  assert.equal(verdict(result), 10);
});

test("an observed fault outranks missing arms", () => {
  assert.equal(verdict({ ...fault, arms: fault.arms.slice(0, 1) }), 10);
});

test("recorded held actions pass only with every arm complete", () => {
  assert.equal(held.arms.length, 6);
  assert.ok(held.arms.every((arm) => arm.status === "held"));
  assert.equal(verdict(held), 0);
  assert.equal(verdict({ ...held, arms: held.arms.slice(0, 5) }), 3);
});

test("unavailable and incomplete actions stay distinct when no fault was observed", () => {
  const result = structuredClone(held);
  result.arms[0].status = "unavailable";
  assert.equal(verdict(result), 2);
  result.arms[1].status = "incomplete";
  assert.equal(verdict(result), 3);
});

const lifecycle = readFileSync(new URL("./axclose.sh", import.meta.url), "utf8");
const mapping = lifecycle.slice(lifecycle.indexOf('[ "$CONTROLLER_STATUS" != 2 ]'));
assert.ok(mapping.startsWith('[ "$CONTROLLER_STATUS" != 2 ]'), "native controller status mapping is present");
const library = readFileSync(new URL("./lib.sh", import.meta.url), "utf8");
function shellFunction(name) {
  const match = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m").exec(library);
  assert.ok(match, `desktop observation function ${name} is present`);
  return match[0];
}
const shell = [
  'obs_log() { printf "%s\\n" "$*"; }',
  'obs_refuse() { obs_log "cannot run: $*"; exit 2; }',
  shellFunction("obs_fault"), shellFunction("obs_inconclusive"), shellFunction("obs_judge"), mapping,
].join("\n");

test("native lifecycle maps each controller verdict without losing observed faults", () => {
  for (const [controller, expected, message] of [[verdict(fault), 1, /FAULT:/], [0, 0, /^$/], [2, 2, /cannot run:/], [3, 3, /INCONCLUSIVE:/]]) {
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", shell], {
      env: { PATH: process.env.PATH, CONTROLLER_STATUS: String(controller) }, encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, expected, `controller exit ${controller} must map to lifecycle exit ${expected}`);
    assert.match(result.stdout, message);
  }
});
