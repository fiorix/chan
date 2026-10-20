import { afterEach, expect, test, vi } from "vitest";
import TurningShell from "./TurningShell.svelte";
import { TURNING_SHELL_SOURCE, buildTurningShell, TURNING_SHELL_GRAIN_COUNT } from "./turningShell";
import { recordingWebgl2, startAnimation, stopAnimations } from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
afterEach(stopAnimations);

test("preserves the original sketch verbatim", () => {
  expect(TURNING_SHELL_SOURCE).toBe("f=0,draw=a=>{for(f||createCanvas(W=400,W,WEBGL,R=rotateY),background(0),j=0;j<PI;j+=PI/128)for(i=0;i<TAU;i+=PI/64)push(R(j)),R(f),translate(sin(T=tan(atan(i+j)))*(S=sin(J=j+f)*W),atan(cos(J))*sin(J)*W,cos(T)*S),R(i),pop(sphere(2*sin(J*PI*f),W));f+=PI/2048};");
});

test("uses the webgl2 runner and holds the same reduced-motion frame", () => {
  const { gl, calls } = recordingWebgl2();
  const { run, callbacks } = startAnimation(TurningShell, gl);
  expect(run.runner).toBe("webgl2");
  callbacks.resize(800, 600, true, 4000);
  const first = Array.from(calls.filter(({ op }) => op === "bufferData").at(-1)!.args[1] as Float32Array);
  calls.length = 0;
  callbacks.reducedMotion();
  expect(Array.from(calls.filter(({ op }) => op === "bufferData").at(-1)!.args[1] as Float32Array)).toEqual(first);
});

test("projects finite grains throughout the source motion", () => {
  expect(TURNING_SHELL_GRAIN_COUNT).toBe(16641);
  const out = new Float32Array(TURNING_SHELL_GRAIN_COUNT * 4);
  for (const clock of [0.1, 0.7, 3, 10, 100]) {
    const count = buildTurningShell(clock, out);
    expect(count).toBeGreaterThan(10000);
    expect(count).toBeLessThanOrEqual(TURNING_SHELL_GRAIN_COUNT);
    expect(out.subarray(0, count * 4).every(Number.isFinite)).toBe(true);
    for (let i = 0; i < count; i += 1) {
      expect(out[i * 4 + 2]).toBeGreaterThan(0);
      expect(out[i * 4 + 3]).toBe(1);
    }
  }
});

test("starts with zero-size grains and keeps signed source radii visible", () => {
  const out = new Float32Array(TURNING_SHELL_GRAIN_COUNT * 4);
  expect(buildTurningShell(0, out)).toBe(0);
  // At this clock the first latitude has a negative source radius.
  const clock = 1.1;
  const sourceRadius = 2 * Math.sin(clock * Math.PI * clock);
  expect(sourceRadius).toBeLessThan(0);
  buildTurningShell(clock, out);
  const reach = Math.sin(clock) * 400;
  const depth = 200 * Math.sqrt(3) - Math.cos(clock) * reach;
  const perspective = 200 * Math.sqrt(3) / depth;
  expect(out[0]).toBeCloseTo(Math.sin(clock) * reach * perspective, 3);
  expect(out[2]).toBeCloseTo(-sourceRadius * perspective, 5);
});

test("advances at two-thirds of the source tempo", () => {
  const { gl, calls } = recordingWebgl2();
  const { callbacks } = startAnimation(TurningShell, gl);
  callbacks.resize(800, 600, false, 0);
  calls.length = 0;
  callbacks.frame(1000);
  const out = new Float32Array(TURNING_SHELL_GRAIN_COUNT * 4);
  const count = buildTurningShell(Math.PI * 40 / 2048, out);
  expect(calls.filter(({ op }) => op === "bufferData").at(-1)?.args[1]).toEqual(out.subarray(0, count * 4));
});
