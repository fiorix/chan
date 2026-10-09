import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { parseProgramCell, ringProgress, statusPrintf } from "./program-status.mjs";

const oldList = `## default\n\n| name | session | status | queue |\n| --- | --- | --- | --- |\n| other | s0 | alive | 0 |\n| subject | s1 | alive | 0 |\n`;
const newList = `## default\n\n| name | session | status | program | queue |\n| --- | --- | --- | --- | --- |\n| other | s0 | alive | idle | 0 |\n| subject | s1 | alive | working 40% | 0 |\n`;

test("the list reader selects the named session and distinguishes an absent column", () => {
  assert.equal(parseProgramCell(newList, "s1"), "working 40%");
  assert.equal(parseProgramCell(oldList, "s1"), null);
  assert.throws(() => parseProgramCell(newList, "missing"), /session missing absent/);
});

test("the report driver emits the specification's OSC bytes, not an emitter's output", () => {
  const command = statusPrintf("state=working:progress=40");
  assert.deepEqual(execFileSync("bash", ["-c", command]),
    Buffer.from("\x1b]7501;state=working:progress=40\x1b\\"));
  assert.throws(() => statusPrintf("state=working'`"), /fixed specification body/);
});

test("the ring reader uses the drawn stroke and not its label", () => {
  assert.equal(ringProgress({ activity: "ring", pathLength: "100", ring: "40 100", activityLabel: "working, 99%" }), 40);
  assert.equal(ringProgress({ activity: "spinner", pathLength: "100", ring: "40 100" }), null);
  assert.equal(ringProgress({ activity: "ring", pathLength: "99", ring: "40 100" }), null);
});
