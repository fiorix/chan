import { afterEach, expect, test, vi } from "vitest";
import TorusLantern from "./TorusLantern.svelte";
import { buildTorusLantern, TORUS_LANTERN_SOURCE } from "./torusLantern";
import { recordingWebgl2, startAnimation, stopAnimations, uniformsSet } from "../__tests__/canvas";
vi.mock("./canvasAnimation", async (importOriginal) => (await import("../__tests__/canvas")).recordedRunners(await importOriginal()));
afterEach(stopAnimations);

test("preserves the original sketch verbatim", () => {
  expect(TORUS_LANTERN_SOURCE).toBe("function draw(){for(f||createCanvas(W=400,W,WEBGL,T=translate),T(60*sin(f),-20,z=170),push(f+=.01),T(X=99*sin(-f),0,Z=99*cos(f)),pop(sphere(4,W)),pointLight([W],X,0,z+Z),i=0;i<TAU;i+=PI/32)push(),rotateY(i+f),T(120,0),rotateX(.8),pop(torus(80,4,W))}f=0;");
});

test("uses a depth buffer and draws its mesh scene", () => {
  const { gl, calls } = recordingWebgl2();
  const { run, callbacks } = startAnimation(TorusLantern, gl);
  expect(run.runner).toBe("webgl2");
  expect(run.options.contextAttributes).toMatchObject({ depth: true });
  callbacks.resize(800, 600, false, 0);
  expect(calls.filter(({ op }) => op === "drawArrays").length).toBeGreaterThan(20);
});

test("keeps the marker unlit and positions the point light in world space", () => {
  const { scene, light } = buildTorusLantern(0);
  expect(scene).toHaveLength(66);
  expect(scene[0].mesh.kind).toBe("sphere");
  expect(scene[0].light).toBe(0);
  expect(scene[0].size).toEqual([4, 4, 4]);
  expect(light).toEqual([99 * Math.sin(-0.01), 0, 170 + 99 * Math.cos(0.01)]);
  expect(scene.slice(1).every(shape => shape.light === 2 && shape.mesh.kind === "torus")).toBe(true);
  expect(scene[1].size).toEqual([80, 4, 4]);
});

test("clears every frame and uses one quarter of the source tempo", () => {
  const { gl: recorded, calls } = recordingWebgl2();
  const gl = new Proxy(recorded, {
    get(target, key) {
      if (key === "COLOR_BUFFER_BIT") return 0x4000;
      if (key === "DEPTH_BUFFER_BIT") return 0x0100;
      return Reflect.get(target, key);
    },
  });
  const { run, callbacks } = startAnimation(TorusLantern, gl);
  expect(run.options.contextAttributes).toMatchObject({ preserveDrawingBuffer: false });
  callbacks.resize(800, 600, false, 0);
  callbacks.frame(1000);
  callbacks.frame(2000);
  expect(calls.filter(({ op }) => op === "clear").map(({ args }) => args[0])).toEqual([0x4100, 0x4100, 0x4100]);
  const light = uniformsSet(calls, "uPointLight").at(-1)!;
  expect(light[0]).toBeCloseTo(99 * Math.sin(-0.31));
  expect(light[1]).toBe(0);
  expect(light[2]).toBeCloseTo(170 + 99 * Math.cos(0.31));
});
