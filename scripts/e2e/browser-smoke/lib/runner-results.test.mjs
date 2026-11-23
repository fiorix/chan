import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Execute the runner's actual verdict handler without starting its server
// or Chrome. Error details must survive serialization into results.json.
const runner = readFileSync(new URL("../run.mjs", import.meta.url), "utf8");
const start = runner.indexOf("    } catch (e) {\n      if (e.smokeSkip) {");
const end = runner.indexOf("    } finally {", start);
assert.ok(start >= 0 && end > start, "runner check-result handler is present");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const handle = new AsyncFunction("e", "currentCheck", "console", "maskTokens", "ctx",
  `let failed = 0; ${runner.slice(start + "    } catch (e) {".length, end)}; return failed;`);

async function verdict(error) {
  const currentCheck = { ok: false, skipped: false };
  const messages = [], shots = [];
  const failed = await handle(error, currentCheck, {
    log: (line) => messages.push(line), error: (line) => messages.push(line),
  }, (text) => text, { shot: async (name) => shots.push(name) });
  return { check: JSON.parse(JSON.stringify(currentCheck)), failed, messages, shots };
}

test("a skipped check retains passed arms and unavailable traces in its serialized result", async () => {
  const smokeDetails = {
    legs: { connected: { status: "passed" }, reparent: { status: "unavailable", events: [{ type: "lostpointercapture" }] } },
    failures: ["reparent (unavailable): native loss reached the canvas"],
  };
  const result = await verdict(Object.assign(new Error("native loss reached the canvas"), { smokeSkip: true, smokeDetails }));
  assert.deepEqual(result.check, { ok: false, skipped: true, reason: "native loss reached the canvas", details: smokeDetails });
  assert.equal(result.failed, 0);
  assert.deepEqual(result.shots, []);
  assert.deepEqual(result.messages, ["[smoke]   SKIP: native loss reached the canvas"]);
});

test("a product failure retains its evidence and counts as failure", async () => {
  const smokeDetails = { legs: { connected: { status: "failed" } } };
  const result = await verdict(Object.assign(new Error("copy was lost"), { smokeDetails }));
  assert.equal(result.check.ok, false);
  assert.equal(result.check.skipped, false);
  assert.match(result.check.error, /copy was lost/);
  assert.deepEqual(result.check.details, smokeDetails);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.shots, ["failure"]);
  assert.deepEqual(result.messages, ["[smoke]   FAIL: copy was lost"]);
});

test("a plain skip does not fabricate evidence or a pass", async () => {
  const result = await verdict(Object.assign(new Error("device absent"), { smokeSkip: true }));
  assert.deepEqual(result.check, { ok: false, skipped: true, reason: "device absent" });
  assert.equal(result.failed, 0);
  assert.deepEqual(result.messages, ["[smoke]   SKIP: device absent"]);
});
