import { afterEach, expect, test, vi } from "vitest";
import SwayingBranches from "./SwayingBranches.svelte";
import { SWAYING_BRANCHES_SOURCE, buildSwayingBranches } from "./swayingBranches";
import { recordingContext2d, startAnimation, stopAnimations } from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
afterEach(stopAnimations);

test("preserves the original sketch verbatim", () => {
  expect(SWAYING_BRANCHES_SOURCE).toBe("float t,r;\nvoid setup(){size(720,720);stroke(-1);}\nvoid draw(){\nclear();\nt+=.01;\nfor(r=0;r<6;r++)\nf(360,360,PI/3*r,99);\n}\nvoid f(float x,float y,float r,float d){if(d>5){line(x,y,x+=cos(r)*d,y+=sin(r)*d);f(x,y,cos(t)+r+PI/2,d*.7);f(x,y,sin(t)+r-PI/7,d*.72);}}");
});

test("uses the 2d runner and holds the same reduced-motion frame", () => {
  const { ctx, ops: calls } = recordingContext2d();
  const { run, callbacks } = startAnimation(SwayingBranches, ctx);
  expect(run.runner).toBe("2d");
  callbacks.resize(800, 600, true, 4000);
  const first = calls.slice();
  calls.length = 0;
  callbacks.reducedMotion();
  expect(calls).toEqual(first);
});

test("fans the source tree into six identical rotated arms", () => {
  const lines = buildSwayingBranches(0);
  const perArm = lines.length / 6;
  expect(Number.isInteger(perArm)).toBe(true);
  expect(perArm).toBeGreaterThan(500);
  expect(lines[0]).toEqual({ x: 0, y: 0, endX: 99, endY: 0 });
  expect(lines[1].x).toBe(99);
  expect(lines[1].y).toBe(0);
  expect(lines[1].endX).toBeCloseTo(99 - Math.sin(1) * 69.3);
  expect(lines[1].endY).toBeCloseTo(Math.cos(1) * 69.3);
  for (let arm = 0; arm < 6; arm += 1) {
    const c = Math.cos(arm * Math.PI / 3);
    const s = Math.sin(arm * Math.PI / 3);
    for (let i = 0; i < perArm; i += 1) {
      const a = lines[i];
      const b = lines[arm * perArm + i];
      expect(b.endX).toBeCloseTo(a.endX * c - a.endY * s, 8);
      expect(b.endY).toBeCloseTo(a.endX * s + a.endY * c, 8);
      const length = Math.hypot(b.endX - b.x, b.endY - b.y);
      expect(length).toBeGreaterThan(5);
      expect(length).toBeLessThanOrEqual(99.00001);
    }
  }
  expect(buildSwayingBranches(1)).not.toEqual(lines);
});

test("runs at half the source tempo by default", () => {
  const { ctx, ops } = recordingContext2d();
  const { callbacks } = startAnimation(SwayingBranches, ctx);
  callbacks.resize(800, 600, false, 0);
  ops.length = 0;
  callbacks.frame(1000);
  const lines = ops.filter(({ op }) => op === "lineTo");
  const expected = buildSwayingBranches(0.01 + 0.3);
  expect(lines.map(({ args }) => args)).toEqual(expected.map(({ endX, endY }) => [endX, endY]));
});
