import { afterEach, describe, expect, test, vi } from "vitest";
import StellarOutburst from "./StellarOutburst.svelte";
import { STELLAR_OUTBURST_TWIGL_SOURCE } from "./stellarOutburst";
import { recordingWebgl2, shaderSources, startAnimation, stopAnimations, uniformsSet } from "../__tests__/canvas";

const renderer = vi.hoisted(() => ({ draw: vi.fn(), destroy: vi.fn() }));

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./stellarOutburst", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stellarOutburst")>()),
  createStellarOutburstRenderer: () => renderer,
}));

afterEach(() => {
  stopAnimations();
  renderer.draw.mockClear();
});

describe("Stellar Outburst", () => {
  test("renders its own shader through the WebGL2 runner", () => {
    const { run, callbacks } = startAnimation(StellarOutburst, {});
    callbacks.resize(800, 600, false, 0);

    expect(run.runner).toBe("webgl2");
    expect(renderer.draw).toHaveBeenCalled();
  });

  test("copies the post's Twigl program verbatim", () => {
    expect(STELLAR_OUTBURST_TWIGL_SOURCE).toBe(
      "vec2 p=(FC.xy*2.-r)/r.y;for(float i=0.,f,d,u,s,w,l;i++<1e3;){f=fract(t*.2+ceil(i/80.)*.4);d=f*5.;u=fract(i*.1)*2.-1.;s=sqrt(1.3-u*u);w=sin(i)+4.;l=length(p-vec2(s*cos(i),u)*d/w)*w;o.rgb+=hsv(.1,.3,1.7-f)*(clamp(-l,.0,1.)+exp(-l*79.));}o.rgb+=.02/(1e-2+dot(p,p));",
    );
  });

  test("compiles that program and draws it over the pane at the field, tone and opacity it is given", async () => {
    const { createStellarOutburstRenderer } =
      await vi.importActual<typeof import("./stellarOutburst")>("./stellarOutburst");
    const { gl, calls } = recordingWebgl2();

    createStellarOutburstRenderer(gl).draw(1, 2, 0.5, 0.25);

    expect(shaderSources(calls)).toContainEqual(expect.stringContaining(STELLAR_OUTBURST_TWIGL_SOURCE));
    expect(uniformsSet(calls, "uFieldScale")).toEqual([[2]]);
    expect(uniformsSet(calls, "uTone")).toEqual([[0.5]]);
    expect(uniformsSet(calls, "uOpacity")).toEqual([[0.25]]);
    expect(calls).toContainEqual({ op: "drawArrays", args: ["TRIANGLES", 0, 3] });
  });

  test("caps the expensive shader at 130,000 pixels and 20 frames a second", () => {
    const { run } = startAnimation(StellarOutburst, {});

    expect(run.options).toMatchObject({
      frameRate: 20,
      maxDpr: 1,
      maxPixels: 130000,
    });
  });

  test("runs its shader clock at a quarter of animation time", () => {
    const { callbacks } = startAnimation(StellarOutburst, {});
    callbacks.resize(800, 600, false, 0);
    renderer.draw.mockClear();
    callbacks.frame(4000);

    expect(renderer.draw.mock.calls[0]?.[0]).toBeCloseTo(1.0, 9);
  });

  test("holds one still frame at 3.75 seconds under reduced motion", () => {
    const { callbacks } = startAnimation(StellarOutburst, {});
    renderer.draw.mockClear();
    callbacks.resize(800, 600, true, 4000);
    callbacks.reducedMotion();

    expect(renderer.draw.mock.calls.map(([time]) => time)).toEqual([3.75, 3.75]);
  });

  test("draws with the field its theme tokens name", () => {
    const { run, callbacks } = startAnimation(StellarOutburst, {});
    const host = run.canvas.parentElement!;
    host.style.setProperty("--stellar-outburst-field-scale", "2");
    host.style.setProperty("--stellar-outburst-tone", "0.5");
    host.style.setProperty("--stellar-outburst-opacity", "0.25");
    renderer.draw.mockClear();
    callbacks.resize(800, 600, false, 0);

    expect(renderer.draw).toHaveBeenLastCalledWith(0, 2, 0.5, 0.25);
  });

});
