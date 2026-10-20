import { afterEach, expect, test, vi } from "vitest";
import TangentShell from "./TangentShell.svelte";
import { TANGENT_SHELL_SOURCE, buildTangentShell, TANGENT_SHELL_GRAIN_COUNT } from "./tangentShell";
import { recordingWebgl2, startAnimation, stopAnimations } from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
afterEach(stopAnimations);

test("preserves the original sketch verbatim", () => {
  expect(TANGENT_SHELL_SOURCE).toBe("f=0,draw=s=>{for(f||createCanvas(W=400,W,WEBGL),background(0),rotateX(f),u=0;u<3*TAU;u+=PI/32)for(U=u+f/99,v=PI;v>PI/64;v-=PI/64)V=v-f%(PI/1024),r=220*sin(v+f),push(),translate(sin(U)*sin(V)*r,cos(V)*r,cos(U)*sin(V)*r),sphere(tan(u+v)/6,W),pop();f+=PI/256};");
});

test("uses the webgl2 runner and holds the same reduced-motion frame", () => {
  const { gl, calls } = recordingWebgl2();
  const { run, callbacks } = startAnimation(TangentShell, gl);
  expect(run.runner).toBe("webgl2");
  callbacks.resize(800, 600, true, 4000);
  const first = Array.from(calls.filter(({ op }) => op === "bufferData").at(-1)!.args[1] as Float32Array);
  calls.length = 0;
  callbacks.reducedMotion();
  expect(Array.from(calls.filter(({ op }) => op === "bufferData").at(-1)!.args[1] as Float32Array)).toEqual(first);
});

test("projects finite grains throughout the source motion", () => {
  expect(TANGENT_SHELL_GRAIN_COUNT).toBe(12352);
  const out = new Float32Array(TANGENT_SHELL_GRAIN_COUNT * 4);
  for (const clock of [0.1, 0.7, 3, 10, 100]) {
    const count = buildTangentShell(clock, out);
    expect(count).toBeGreaterThan(10000);
    expect(count).toBeLessThanOrEqual(TANGENT_SHELL_GRAIN_COUNT);
    expect(out.subarray(0, count * 4).every(Number.isFinite)).toBe(true);
    for (let i = 0; i < count; i += 1) {
      expect(out[i * 4 + 2]).toBeGreaterThan(0);
      expect(out[i * 4 + 3]).toBe(1);
    }
  }
});

test("caps tangent poles without moving grain centers", () => {
  const small = new Float32Array(TANGENT_SHELL_GRAIN_COUNT * 4);
  const large = new Float32Array(small.length);
  const count = buildTangentShell(0.7, small, 2);
  expect(buildTangentShell(0.7, large, 8)).toBe(count);
  let changed = 0;
  for (let i = 0; i < count; i += 1) {
    expect(small[i * 4]).toBe(large[i * 4]);
    expect(small[i * 4 + 1]).toBe(large[i * 4 + 1]);
    expect(small[i * 4 + 2]).toBeLessThanOrEqual(large[i * 4 + 2]);
    // The shell's radius never exceeds 220 source units.
    expect(large[i * 4 + 2]).toBeLessThanOrEqual(8 * (200 * Math.sqrt(3)) / (200 * Math.sqrt(3) - 220));
    if (large[i * 4 + 2] > small[i * 4 + 2]) changed += 1;
  }
  expect(changed).toBeGreaterThan(100);
  expect(buildTangentShell(0.7, small, 0)).toBe(0);
});

test("advances at one-third of the source tempo", () => {
  const { gl, calls } = recordingWebgl2();
  const { callbacks } = startAnimation(TangentShell, gl);
  callbacks.resize(800, 600, false, 0);
  calls.length = 0;
  callbacks.frame(1000);
  const out = new Float32Array(TANGENT_SHELL_GRAIN_COUNT * 4);
  const count = buildTangentShell(Math.PI * 20 / 256, out, 6);
  expect(calls.filter(({ op }) => op === "bufferData").at(-1)?.args[1]).toEqual(out.subarray(0, count * 4));
});
