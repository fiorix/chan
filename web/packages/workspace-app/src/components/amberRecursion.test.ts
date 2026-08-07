import { describe, expect, test } from "vitest";
import {
  AMBER_RECURSION_FRAGMENT_SHADER,
  AMBER_RECURSION_TWIGL_SOURCE,
  AMBER_RECURSION_WEBGL_SOURCE,
} from "./amberRecursion";

describe("Amber Recursion", () => {
  test("keeps the source attribution and an independent component", async () => {
    const renderer = (await import("./AmberRecursion.svelte?raw"))
      .default as string;
    const shader = (await import("./amberRecursion.ts?raw"))
      .default as string;

    expect(shader).toContain(
      "https://x.com/YoheiNishitsuji/status/2078117522638004265",
    );
    expect(renderer).toContain("runWebgl2Animation");
    expect(renderer).not.toContain("SpiralSpokes");
    expect(renderer).not.toContain("StellarOutburst");
  });

  test("copies the post's Twigl program verbatim", () => {
    expect(AMBER_RECURSION_TWIGL_SOURCE).toBe(
      "for(float i,g,e,s;++i<99.;o.rgb+=hsv(.09,.5,i*s/2e4)){vec3 p=vec3((FC.xy-.5*r)/r.x*.3,g-.05*sin(t));p.zx*=rotate2D(t*.5);s=1.5;for(int i;i++<9;p=vec3(2)-abs(p*e-.4/e)-sin(t)*.1)s*=e=max(1.07,4.5/dot(p*(3.-sin(t*.5)*.4),p*2.));g+=distance(p.xz,p.yx)/s;s=log(s)/g*.1;}",
    );
    expect(AMBER_RECURSION_FRAGMENT_SHADER).toContain(
      AMBER_RECURSION_WEBGL_SOURCE,
    );
  });

  test("initializes Twigl's implicit loop locals for WebGL", () => {
    expect(AMBER_RECURSION_WEBGL_SOURCE).toContain(
      "for(float i=0.,g=0.,e=0.,s=0.;",
    );
    expect(AMBER_RECURSION_WEBGL_SOURCE).toContain(
      "for(int i=0;i++<9;",
    );
  });

  test("fits and composites the source field across the pane", () => {
    expect(AMBER_RECURSION_FRAGMENT_SHADER).toContain(
      "centered * (r.x / min(r.x, r.y)) / uFieldScale",
    );
    expect(AMBER_RECURSION_FRAGMENT_SHADER).toContain(
      "float alpha = (1.0 - exp(-intensity * uExposure)) * uOpacity;",
    );
    expect(AMBER_RECURSION_FRAGMENT_SHADER).toContain(
      "o = vec4(vec3(uTone) * alpha, alpha);",
    );
  });

  test("caps the expensive shader and provides a reduced-motion frame", async () => {
    const renderer = (await import("./AmberRecursion.svelte?raw"))
      .default as string;

    expect(renderer).toContain("const MAX_RENDER_PIXELS = 130_000;");
    expect(renderer).toContain("const STATIC_TIME_SECONDS = 3.25;");
    expect(renderer).toContain("const TIME_SCALE = 0.25;");
    expect(renderer).toContain("--amber-recursion-field-scale: 1;");
    expect(renderer).toContain("--amber-recursion-tone: 0.855;");
    expect(renderer).toContain("--amber-recursion-opacity: 0.41;");
    expect(renderer).toContain("background-color: rgb(28, 28, 30);");
    expect(renderer).toMatch(/reducedMotion: \(\) => draw\(STATIC_TIME_SECONDS\)/);
  });
});
