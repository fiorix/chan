import { describe, expect, test } from "vitest";
import {
  STELLAR_OUTBURST_FRAGMENT_SHADER,
  STELLAR_OUTBURST_TWIGL_SOURCE,
} from "./stellarOutburst";

describe("Stellar Outburst", () => {
  test("keeps the source attribution and an independent component", async () => {
    const renderer = (await import("./StellarOutburst.svelte?raw"))
      .default as string;
    const shader = (await import("./stellarOutburst.ts?raw"))
      .default as string;

    expect(shader).toContain(
      "https://x.com/YoheiNishitsuji/status/2081001408665715188",
    );
    expect(renderer).toContain("runWebgl2Animation");
    expect(renderer).not.toContain("SpiralSpokes");
    expect(renderer).not.toContain("TurbulentOculus");
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

  test("caps the expensive shader and provides a reduced-motion frame", async () => {
    const renderer = (await import("./StellarOutburst.svelte?raw"))
      .default as string;

    expect(renderer).toContain("const MAX_RENDER_PIXELS = 130_000;");
    expect(renderer).toContain("const STATIC_TIME_SECONDS = 3.75;");
    expect(renderer).toContain("const TIME_SCALE = 0.25;");
    expect(renderer).toContain("--stellar-outburst-field-scale");
    expect(renderer).toContain("--stellar-outburst-tone: 0.855;");
    expect(renderer).toContain("--stellar-outburst-opacity: 0.352;");
    expect(renderer).toContain("background-color: rgb(28, 28, 30);");
    expect(renderer).toMatch(/reducedMotion: \(\) => draw\(STATIC_TIME_SECONDS\)/);
  });
});
