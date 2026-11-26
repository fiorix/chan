import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The reader's command line over four full-screen runs, as a person or a job
// runs it on a saved run.json: each verdict ends the process with its own
// exit code, and the drivers' README promises the same codes.
const reader = fileURLToPath(new URL("./terminal-size-reader.mjs", import.meta.url));
const runs = [
  ["unread", "inconclusive", 3],
  ["clean", "bounded-search-no-fault", 0],
  ["fault", "fault-observed", 10],
  ["hidden", "bounded-search-no-fault", 0],
];

for (const [name, verdict, code] of runs) {
  test(`the reader's command line reads the ${name} full-screen run as ${verdict}, exit ${code}`, () => {
    const fixture = fileURLToPath(new URL(`./fixtures/terminal-size-reader/run-${name}.json`, import.meta.url));
    const result = spawnSync(process.execPath, [reader, fixture], { encoding: "utf8" });
    assert.equal(result.error, undefined, "the reader ran");
    assert.equal(JSON.parse(result.stdout).verdict, verdict, `the ${name} run's verdict`);
    assert.equal(result.status, code, `the ${name} run's exit code`);
  });
}
