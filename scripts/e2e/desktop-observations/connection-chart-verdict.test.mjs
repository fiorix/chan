import assert from "node:assert/strict";
import test from "node:test";
import { judgeInset, judgeMotion } from "./connection-chart-verdict.mjs";

// Offline verdict test for connection-chart-native.mjs: made traces of a
// line that steps at each arrival, as the chart did, of one that scrolls,
// and of one that holds, read every 50 ms over three arrivals 3 s apart with
// a 9 px step. No desktop, no page.
const STEP = 9;
const PERIOD = 50;

/// A trace of `ms` with an arrival every 3 s from 500 ms on; the marker is
/// drawn at `x(t, arrivals so far)`.
function trace(ms, x) {
  const out = [];
  for (let t = 0; t <= ms; t += PERIOD) {
    const seen = t < 500 ? 0 : 1 + Math.floor((t - 500) / 3000);
    out.push({ t, sig: seen, marker: x(t, seen) });
  }
  return out;
}

// As the chart drew before: the marker sits still and moves a step left at
// each arrival.
const stepping = trace(10_000, (_t, seen) => 300 - seen * STEP);
// As it scrolls: a step per 3 s, continuous across arrivals.
const scrolling = trace(10_000, (t) => 300 - t * STEP / 3000);

const failed = (verdict) => verdict.lines.filter((l) => !l.pass).map((l) => l.name);

test("a stepping line fails the motion verdict at its arrivals and between them", () => {
  const verdict = judgeMotion(stepping, false);
  assert.equal(verdict.setup, true);
  assert.deepEqual(failed(verdict), ["the line moves left between arrivals", "an arrival makes no jump"]);
});

test("a scrolling line passes the motion verdict", () => {
  const verdict = judgeMotion(scrolling, false);
  assert.equal(verdict.setup, true);
  assert.deepEqual(failed(verdict), []);
});

test("a line that moves right fails the motion verdict", () => {
  const verdict = judgeMotion(trace(10_000, (t) => 300 - t * STEP / 3000 + (t === 2000 ? 3 : 0)), false);
  assert.ok(failed(verdict).includes("the line never moves right"));
});

test("a stepping line passes the reduced-motion verdict, and a scrolling one fails it", () => {
  assert.deepEqual(failed(judgeMotion(stepping, true)), []);
  assert.deepEqual(failed(judgeMotion(scrolling, true)),
    ["the line holds between arrivals", "the line steps left at an arrival"]);
});

test("a trace with no marked reading across an arrival carries no verdict", () => {
  const unmarked = trace(10_000, () => null);
  const verdict = judgeMotion(unmarked, false);
  assert.equal(verdict.setup, false);
  assert.equal(verdict.lines.length, 2);
});

test("a trace too sparse inside an interval carries no verdict", () => {
  const sparse = scrolling.filter((_r, i) => i % 10 === 0);
  assert.equal(judgeMotion(sparse, false).setup, false);
});

test("the insets compare the baseline's ends with the card's edges", () => {
  const card = { left: 100, right: 600 };
  assert.equal(judgeInset({ card, health: null, baseline: { left: 141.3, right: 583.5 } })[0].pass, false);
  assert.equal(judgeInset({ card, health: null, baseline: { left: 116.4, right: 583.5 } })[0].pass, true);
});
