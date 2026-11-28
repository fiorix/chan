import assert from "node:assert/strict";
import test from "node:test";
import { indexPillCovers, waitIndexPillClear } from "./index-pill.mjs";

// The pill's box as check 173's failure screenshot shows it at 1440x1000,
// and a close button in the header of the Details card beneath it.
const CLOSE = { left: 1396, top: 52, right: 1420, bottom: 76 };
const PILL = { left: 1116, top: 48, right: 1428, bottom: 76, index: true, text: "rebuilding search index search paused" };

test("an index pill over any part of the control covers it", () => {
  assert.equal(indexPillCovers({ control: CLOSE, pill: PILL }), true);
  const corner = { ...PILL, left: CLOSE.right - 1, bottom: CLOSE.top + 1 };
  assert.equal(indexPillCovers({ control: CLOSE, pill: corner }), true);
});

test("a pill that does not overlap the control, or only touches it, leaves it clear", () => {
  for (const pill of [
    { ...PILL, right: CLOSE.left },
    { ...PILL, left: CLOSE.right, right: CLOSE.right + 300 },
    { ...PILL, bottom: CLOSE.top },
    { ...PILL, top: CLOSE.bottom, bottom: CLOSE.bottom + 28 },
  ]) {
    assert.equal(indexPillCovers({ control: CLOSE, pill }), false, JSON.stringify(pill));
  }
});

test("only the pill's index section is waited for", () => {
  assert.equal(indexPillCovers({ control: CLOSE, pill: { ...PILL, index: false, text: "Transfers (1)" } }), false);
  assert.equal(indexPillCovers({ control: CLOSE, pill: null }), false);
  assert.equal(indexPillCovers({ control: null, pill: PILL }), false);
});

function stubPage(readings) {
  let reads = 0;
  return {
    get reads() { return reads; },
    async evaluate() { return readings[Math.min(reads++, readings.length - 1)]; },
  };
}

test("the wait reads again until the index pill leaves the control", async () => {
  const clear = { control: CLOSE, pill: null };
  const page = stubPage([{ control: CLOSE, pill: PILL }, { control: CLOSE, pill: PILL }, clear]);
  assert.deepEqual(await waitIndexPillClear(page, "[aria-label=\"Close Details\"]", { interval: 1 }), clear);
  assert.equal(page.reads, 3);
  const already = stubPage([clear]);
  await waitIndexPillClear(already, "[aria-label=\"Close Details\"]", { interval: 1 });
  assert.equal(already.reads, 1);
});

test("a pill still over the control at the bound is an environment error naming it", async () => {
  const page = stubPage([{ control: CLOSE, pill: PILL }]);
  await assert.rejects(
    waitIndexPillClear(page, "[aria-label=\"Close Details\"]", { timeout: 20, interval: 1 }),
    (error) => {
      assert.equal(error.smokeEnvironment, true);
      assert.match(error.message, /rebuilding search index search paused/);
      assert.match(error.message, /Close Details/);
      return true;
    },
  );
});
