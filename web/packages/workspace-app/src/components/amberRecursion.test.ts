import { afterEach, describe, expect, test, vi } from "vitest";
import AmberRecursion from "./AmberRecursion.svelte";
import { AMBER_RECURSION_TWIGL_SOURCE, AMBER_RECURSION_WEBGL_SOURCE } from "./amberRecursion";
import { recordingWebgl2, shaderSources, startAnimation, stopAnimations, uniformsSet } from "../__tests__/canvas";

const renderer = vi.hoisted(() => ({ draw: vi.fn(), destroy: vi.fn() }));

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./amberRecursion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./amberRecursion")>()),
  createAmberRecursionRenderer: () => renderer,
}));

afterEach(() => {
  stopAnimations();
  renderer.draw.mockClear();
});

describe("Amber Recursion", () => {
  test("renders its own shader through the WebGL2 runner", () => {
    const { run, callbacks } = startAnimation(AmberRecursion, {});
    callbacks.resize(800, 600, false, 0);

    expect(run.runner).toBe("webgl2");
    expect(renderer.draw).toHaveBeenCalled();
  });

  test("copies the post's Twigl program verbatim", () => {
    expect(AMBER_RECURSION_TWIGL_SOURCE).toBe(
      "for(float i,g,e,s;++i<99.;o.rgb+=hsv(.09,.5,i*s/2e4)){vec3 p=vec3((FC.xy-.5*r)/r.x*.3,g-.05*sin(t));p.zx*=rotate2D(t*.5);s=1.5;for(int i;i++<9;p=vec3(2)-abs(p*e-.4/e)-sin(t)*.1)s*=e=max(1.07,4.5/dot(p*(3.-sin(t*.5)*.4),p*2.));g+=distance(p.xz,p.yx)/s;s=log(s)/g*.1;}",
    );
  });

  test("compiles its WebGL form and draws it over the pane at the field, tone, opacity and exposure it is given", async () => {
    const { createAmberRecursionRenderer } =
      await vi.importActual<typeof import("./amberRecursion")>("./amberRecursion");
    const { gl, calls } = recordingWebgl2();

    createAmberRecursionRenderer(gl).draw(1, 2, 0.5, 0.25, 3);

    expect(shaderSources(calls)).toContainEqual(expect.stringContaining(AMBER_RECURSION_WEBGL_SOURCE));
    expect(uniformsSet(calls, "uFieldScale")).toEqual([[2]]);
    expect(uniformsSet(calls, "uTone")).toEqual([[0.5]]);
    expect(uniformsSet(calls, "uOpacity")).toEqual([[0.25]]);
    expect(uniformsSet(calls, "uExposure")).toEqual([[3]]);
    expect(calls).toContainEqual({ op: "drawArrays", args: ["TRIANGLES", 0, 3] });
  });

  test("caps the expensive shader at 130,000 pixels and 20 frames a second", () => {
    const { run } = startAnimation(AmberRecursion, {});

    expect(run.options).toMatchObject({
      frameRate: 20,
      maxDpr: 1,
      maxPixels: 130000,
    });
  });

  test("runs its shader clock at a quarter of animation time", () => {
    const { callbacks } = startAnimation(AmberRecursion, {});
    callbacks.resize(800, 600, false, 0);
    renderer.draw.mockClear();
    callbacks.frame(4000);

    expect(renderer.draw.mock.calls[0]?.[0]).toBeCloseTo(1.0, 9);
  });

  test("holds one still frame at 3.25 seconds under reduced motion", () => {
    const { callbacks } = startAnimation(AmberRecursion, {});
    renderer.draw.mockClear();
    callbacks.resize(800, 600, true, 4000);
    callbacks.reducedMotion();

    expect(renderer.draw.mock.calls.map(([time]) => time)).toEqual([3.25, 3.25]);
  });

  test("draws with the field its theme tokens name", () => {
    const { run, callbacks } = startAnimation(AmberRecursion, {});
    const host = run.canvas.parentElement!;
    host.style.setProperty("--amber-recursion-field-scale", "2");
    host.style.setProperty("--amber-recursion-tone", "0.5");
    host.style.setProperty("--amber-recursion-opacity", "0.25");
    host.style.setProperty("--amber-recursion-exposure", "3");
    renderer.draw.mockClear();
    callbacks.resize(800, 600, false, 0);

    expect(renderer.draw).toHaveBeenLastCalledWith(0, 2, 0.5, 0.25, 3);
  });

});
