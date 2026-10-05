import { afterEach, describe, expect, test, vi } from "vitest";
import TenfoldDahlia from "./TenfoldDahlia.svelte";
import { TENFOLD_DAHLIA_TWIGL_SOURCE, TENFOLD_DAHLIA_WEBGL_SOURCE } from "./tenfoldDahlia";
import { recordingWebgl2, shaderSources, startAnimation, stopAnimations, uniformsSet } from "../__tests__/canvas";

const renderer = vi.hoisted(() => ({ draw: vi.fn(), destroy: vi.fn() }));

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./tenfoldDahlia", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tenfoldDahlia")>()),
  createTenfoldDahliaRenderer: () => renderer,
}));

afterEach(() => {
  stopAnimations();
  renderer.draw.mockClear();
});

describe("Tenfold Dahlia", () => {
  test("renders its own shader through the WebGL2 runner", () => {
    const { run, callbacks } = startAnimation(TenfoldDahlia, {});
    callbacks.resize(800, 600, false, 0);

    expect(run.runner).toBe("webgl2");
    expect(renderer.draw).toHaveBeenCalled();
  });

  test("copies the post's Twigl program verbatim", () => {
    expect(TENFOLD_DAHLIA_TWIGL_SOURCE).toBe(
      "float i,e,R,s;vec3 q,p,d=vec3((FC.xy-.5*r)/r.y,.8);for(q.z--;i++<99.;){o.rgb+=hsv(.1,-e,e/1.5e1);p=q+=d*max(e,.004)*R*.22;p=vec3(log2(R=length(p))-t*.3,e=asin(-p.z/R-.01)-.9,atan(p.x,p.y)*2.5-t*.3);for(s=2.;s<1e3/(i*.3);s+=s)e+=abs(dot(sin(p.yzx*s),cos(p.yzx*s)))/s;}",
    );
  });

  test("spells out the zeroed locals and the left-to-right assignments in its WebGL form", () => {
    expect(TENFOLD_DAHLIA_WEBGL_SOURCE).toContain(
      "float i=0.,e=0.,R=0.,s=0.;vec3 q=vec3(0.),p=vec3(0.),d=",
    );
    expect(TENFOLD_DAHLIA_WEBGL_SOURCE).toContain(
      "R=length(p);e=asin(-p.z/R-.01)-.9;p=vec3(log2(R)-t*.3,e,",
    );
    expect(TENFOLD_DAHLIA_WEBGL_SOURCE).not.toContain("float i,e,R,s;");
    expect(TENFOLD_DAHLIA_WEBGL_SOURCE).not.toContain("R=length(p))");
    expect(TENFOLD_DAHLIA_WEBGL_SOURCE).not.toContain(",e=asin(");
  });

  test("keeps atan off the point where both of its arguments are zero in its WebGL form", () => {
    expect(TENFOLD_DAHLIA_WEBGL_SOURCE).toContain(
      "atan(p.x,p.xy==vec2(0.)?1.:p.y)*2.5-t*.3);",
    );
    expect(TENFOLD_DAHLIA_WEBGL_SOURCE).not.toContain("atan(p.x,p.y)");
  });

  test("compiles its WebGL form and draws it over the pane at the field, tone, opacity and exposure it is given", async () => {
    const { createTenfoldDahliaRenderer } =
      await vi.importActual<typeof import("./tenfoldDahlia")>("./tenfoldDahlia");
    const { gl, calls } = recordingWebgl2();

    createTenfoldDahliaRenderer(gl).draw(1, 2, 0.5, 0.25, 3);

    expect(shaderSources(calls)).toContainEqual(expect.stringContaining(TENFOLD_DAHLIA_WEBGL_SOURCE));
    expect(uniformsSet(calls, "uFieldScale")).toEqual([[2]]);
    expect(uniformsSet(calls, "uTone")).toEqual([[0.5]]);
    expect(uniformsSet(calls, "uOpacity")).toEqual([[0.25]]);
    expect(uniformsSet(calls, "uExposure")).toEqual([[3]]);
    expect(calls).toContainEqual({ op: "drawArrays", args: ["TRIANGLES", 0, 3] });
  });

  test("caps the expensive shader at 130,000 pixels and 20 frames a second", () => {
    const { run } = startAnimation(TenfoldDahlia, {});

    expect(run.options).toMatchObject({
      frameRate: 20,
      maxDpr: 1,
      maxPixels: 130000,
    });
  });

  test("runs its shader clock at a quarter of animation time", () => {
    const { callbacks } = startAnimation(TenfoldDahlia, {});
    callbacks.resize(800, 600, false, 0);
    renderer.draw.mockClear();
    callbacks.frame(4000);

    expect(renderer.draw.mock.calls[0]?.[0]).toBeCloseTo(1.0, 9);
  });

  test("holds one still frame at the start of the loop under reduced motion", () => {
    const { callbacks } = startAnimation(TenfoldDahlia, {});
    renderer.draw.mockClear();
    callbacks.resize(800, 600, true, 4000);
    callbacks.reducedMotion();

    expect(renderer.draw.mock.calls.map(([time]) => time)).toEqual([0, 0]);
  });

  test("draws with the field its theme tokens name", () => {
    const { run, callbacks } = startAnimation(TenfoldDahlia, {});
    const host = run.canvas.parentElement!;
    host.style.setProperty("--tenfold-dahlia-field-scale", "2");
    host.style.setProperty("--tenfold-dahlia-tone", "0.5");
    host.style.setProperty("--tenfold-dahlia-opacity", "0.25");
    host.style.setProperty("--tenfold-dahlia-exposure", "3");
    renderer.draw.mockClear();
    callbacks.resize(800, 600, false, 0);

    expect(renderer.draw).toHaveBeenLastCalledWith(0, 2, 0.5, 0.25, 3);
  });

});
