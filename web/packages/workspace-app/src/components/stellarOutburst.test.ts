import { afterEach, describe, expect, test, vi } from "vitest";
import StellarOutburst from "./StellarOutburst.svelte";
import {
  STELLAR_OUTBURST_FRAGMENT_SHADER,
  STELLAR_OUTBURST_TWIGL_SOURCE,
} from "./stellarOutburst";
import { startAnimation, stopAnimations } from "../__tests__/canvas";

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
    expect(STELLAR_OUTBURST_FRAGMENT_SHADER).toContain(
      STELLAR_OUTBURST_TWIGL_SOURCE,
    );
    expect(STELLAR_OUTBURST_FRAGMENT_SHADER).toContain(
      "vec3 hsv(float h, float s, float v)",
    );
  });

  test("adapts the original black-backed shader for the pane", () => {
    expect(STELLAR_OUTBURST_FRAGMENT_SHADER).toContain(
      "float alpha = (1.0 - exp(-intensity)) * uOpacity;",
    );
    expect(STELLAR_OUTBURST_FRAGMENT_SHADER).toContain(
      "vec3 neutralHue = mix(vec3(1.0), sourceHue, 0.08);",
    );
    expect(STELLAR_OUTBURST_FRAGMENT_SHADER).toContain(
      "o = vec4(neutralHue * uTone * alpha, alpha);",
    );
  });

  test("expands the field across the pane", () => {
    expect(STELLAR_OUTBURST_FRAGMENT_SHADER).toContain(
      "(gl_FragCoord.xy - r * 0.5) / uFieldScale",
    );
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
