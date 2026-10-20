import { afterEach, expect, test, vi } from "vitest";
import ContractingSpiral from "./ContractingSpiral.svelte";
import { CONTRACTING_SPIRAL_SOURCE, buildContractingSpiral, contractingSpiralState, CONTRACTING_SPIRAL_PERIOD } from "./contractingSpiral";
import { recordingContext2d, startAnimation, stopAnimations } from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
afterEach(stopAnimations);

test("preserves the original sketch verbatim", () => {
  expect(CONTRACTING_SPIRAL_SOURCE).toBe("float t=5,r;\nvoid setup(){size(800,800);}\nvoid draw(){\nbackground(0);noFill();\nstroke(-1,t*99);\nfor(r=0;r<TAU*99;r+=PI/2.6)circle(r*t*sin(r)+400,r*t*cos(r)+400,r);\nt/=1.002;}");
});

test("uses the 2d runner and holds the same reduced-motion frame", () => {
  const { ctx, ops: calls } = recordingContext2d();
  const { run, callbacks } = startAnimation(ContractingSpiral, ctx);
  expect(run.runner).toBe("2d");
  callbacks.resize(800, 600, true, 4000);
  const first = calls.slice();
  calls.length = 0;
  callbacks.reducedMotion();
  expect(calls).toEqual(first);
});

test("reverses at twenty seconds without changing the contraction speed", () => {
  const turn = 20 * 60;
  const endContraction = 5 / 1.002 ** turn;
  expect(CONTRACTING_SPIRAL_PERIOD).toBeCloseTo(turn);
  expect(contractingSpiralState(0)).toEqual({ contraction: 5, alpha: 1 });
  expect(contractingSpiralState(600).contraction).toBeCloseTo(5 / 1.002 ** 600);
  expect(contractingSpiralState(turn).contraction).toBeCloseTo(endContraction);
  expect(contractingSpiralState(turn).alpha).toBeCloseTo(endContraction * 99 / 255);
  expect(contractingSpiralState(turn - 100).contraction).toBeCloseTo(contractingSpiralState(turn + 100).contraction);
  expect(contractingSpiralState(turn + 100).contraction).toBeGreaterThan(endContraction);
  expect(contractingSpiralState(turn * 2).contraction).toBe(5);
});

test("keeps circle diameters while their centers contract", () => {
  const initial = buildContractingSpiral(5);
  const smaller = buildContractingSpiral(1);
  expect(initial).toHaveLength(515);
  expect(initial[0]).toEqual({ x: 0, y: 0, radius: 0 });
  expect(initial[1].radius).toBeCloseTo(Math.PI / 5.2);
  for (let i = 0; i < initial.length; i += 1) {
    expect(initial[i].radius).toBe(smaller[i].radius);
    expect(initial[i].x).toBeCloseTo(smaller[i].x * 5);
    expect(initial[i].y).toBeCloseTo(smaller[i].y * 5);
  }
});
