import { describe, expect, test } from "vitest";
import {
  TURBULENT_OCULUS_FRAGMENT_SHADER,
  TURBULENT_OCULUS_TWIGL_SOURCE,
} from "./turbulentOculus";

describe("Turbulent Oculus", () => {
  test("keeps the source attribution and an independent component", async () => {
    const renderer = (await import("./TurbulentOculus.svelte?raw"))
      .default as string;
    const shader = (await import("./turbulentOculus.ts?raw"))
      .default as string;

    expect(shader).toContain(
      "https://x.com/YoheiNishitsuji/status/2081184095376441620",
    );
    expect(renderer).toContain("runWebgl2Animation");
    expect(renderer).not.toContain("SpiralSpokes");
  });

  test("copies the post's Twigl program verbatim", () => {
    expect(TURBULENT_OCULUS_TWIGL_SOURCE).toBe(
      "for(float i=0.,z=0.,d=0.,s=0.;i++<3e2;){vec3 q=z*normalize(vec3(FC.xy*2.-r,r.y));q.zx=abs(q.zx*.8);q.yx*=rotate2D(q.z*.01);for(s=.5;s<22.;s/=.5)q+=cos(q.yzx*s+t)/s;z+=d=.01+abs((length(q.yx)-23.))/6.;o+=.2/d;}o=tanh(o/9e2);",
    );
    expect(TURBULENT_OCULUS_FRAGMENT_SHADER).toContain(
      TURBULENT_OCULUS_TWIGL_SOURCE,
    );
    expect(TURBULENT_OCULUS_FRAGMENT_SHADER).toContain(
      "return mat2(cos(r), sin(r), -sin(r), cos(r));",
    );
  });

  test("masks a pupil rather than a hole at the center", () => {
    // The mask is a radius, not a darkening: inside it the pattern is cut
    // away and the pane's background shows through, so the constant IS how
    // much of the middle is missing. It shipped at 2.0 and read as a hole.
    expect(TURBULENT_OCULUS_FRAGMENT_SHADER).toContain(
      "const float BASE_CENTER_MASS_RADIUS = 0.08;",
    );
    expect(TURBULENT_OCULUS_FRAGMENT_SHADER).toContain(
      "const float CENTER_MASS_SCALE = 0.4;",
    );
    expect(TURBULENT_OCULUS_FRAGMENT_SHADER).toContain(
      "float alpha = o.r * centerReveal * uOpacity;",
    );
  });

  test("caps the expensive shader and provides a reduced-motion frame", async () => {
    const renderer = (await import("./TurbulentOculus.svelte?raw"))
      .default as string;

    expect(renderer).toContain("const MAX_RENDER_PIXELS = 160_000;");
    expect(renderer).toContain("const STATIC_TIME_SECONDS = 4.5;");
    expect(renderer).toMatch(/reducedMotion: \(\) => draw\(STATIC_TIME_SECONDS\)/);
  });
});
