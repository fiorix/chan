import { afterEach, expect, test, vi } from "vitest";
import StackedSpire from "./StackedSpire.svelte";
import { buildStackedSpire, STACKED_SPIRE_SOURCE } from "./stackedSpire";
import { recordingWebgl2, startAnimation, stopAnimations, uniformsSet } from "../__tests__/canvas";
vi.mock("./canvasAnimation", async (importOriginal) => (await import("../__tests__/canvas")).recordedRunners(await importOriginal()));
afterEach(stopAnimations);

test("preserves the original sketch verbatim", () => {
  expect(STACKED_SPIRE_SOURCE).toBe("f=0,draw=o=>{for(f||createCanvas(W=400,W,WEBGL,X=rotateX),background(0),stroke(W,120),X(3),rotateY(f/66),fill(W,99),lights(),box(p=150,1,p),i=0;i<p;i+=10)push(),box(x=i+f%10,300-2*x,x),X(PI/2),rotate(PI/4),stroke(W,(p-i)/3),pop(torus(2*x+99,1,4,2));f+=.3};");
});

test("uses a depth buffer and draws its mesh scene", () => {
  const { gl, calls } = recordingWebgl2();
  const { run, callbacks } = startAnimation(StackedSpire, gl);
  expect(run.runner).toBe("webgl2");
  expect(run.options.contextAttributes).toMatchObject({ depth: true });
  callbacks.resize(800, 600, false, 0);
  expect(calls.filter(({ op }) => op === "drawArrays").length).toBeGreaterThan(20);
});

test("keeps the plate and fifteen paired boxes and four-sided rings", () => {
  const scene = buildStackedSpire(2);
  expect(scene).toHaveLength(31);
  expect(scene[0].size).toEqual([150, 1, 150]);
  expect(scene[1].size).toEqual([2, 296, 2]);
  expect(scene[2].size).toEqual([103, 1, 1]);
  expect(scene[29].size).toEqual([142, 16, 142]);
  expect(scene[30].size).toEqual([383, 1, 1]);
  expect(scene[2].edgeAlpha).toBeCloseTo(50 / 255);
  expect(scene[30].edgeAlpha).toBeCloseTo(10 / 3 / 255);
  expect(buildStackedSpire(2, false).every(shape => shape.edgeAlpha === 0)).toBe(true);
});

test("moves the boxes at half the source speed", () => {
  const { gl, calls } = recordingWebgl2();
  const { callbacks } = startAnimation(StackedSpire, gl);
  callbacks.resize(800, 600, false, 0);
  calls.length = 0;
  callbacks.frame(500);
  expect(uniformsSet(calls, "uSize")[1]).toEqual([4.5, 291, 4.5]);
});
