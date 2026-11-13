import assert from "node:assert/strict";
import test from "node:test";
import { rootedFailures } from "./graph-discs.mjs";

/// A read of `count` discs with room on every side and one disc on the
/// root's seat, as `readGraphDiscs` answers it.
function read(count) {
  return {
    canvas: [800, 600],
    count,
    box: [100, 100, 700, 500],
    room: { left: 100, right: 100, above: 100, below: 100 },
    rootOff: [0, 1],
  };
}

test("a disc for every counted node and every draft disc is a rooted graph", () => {
  assert.deepEqual(rootedFailures(read(12), 12, 0), []);
  assert.deepEqual(rootedFailures(read(15), 12, 3), []);
});

test("a disc past the counted nodes and the drafts fails, as one missing does", () => {
  assert.match(rootedFailures(read(13), 12, 0).join("; "), /13 discs painted for 12 counted nodes and 0 draft discs/);
  assert.match(rootedFailures(read(16), 12, 3).join("; "), /16 discs painted/);
  assert.match(rootedFailures(read(11), 12, 0).join("; "), /11 discs painted/);
});

test("the draft disc count is required", () => {
  assert.throws(() => rootedFailures(read(12), 12), /draft disc count/);
});

test("a disc past an edge or no disc on the root's seat fails", () => {
  const past = { ...read(12), room: { left: -4, right: 100, above: 100, below: 100 } };
  assert.match(rootedFailures(past, 12, 0).join("; "), /4 px past the canvas's left edge/);
  const offSeat = { ...read(12), rootOff: [9, 0] };
  assert.match(rootedFailures(offSeat, 12, 0).join("; "), /no node on the root's seat/);
});
