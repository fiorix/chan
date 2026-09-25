import { afterEach, describe, expect, test, vi } from "vitest";
import TurbulentOculus from "./TurbulentOculus.svelte";
import {
  TURBULENT_OCULUS_FRAGMENT_SHADER,
  TURBULENT_OCULUS_TWIGL_SOURCE,
} from "./turbulentOculus";
import { startAnimation, stopAnimations } from "../__tests__/canvas";

const renderer = vi.hoisted(() => ({ draw: vi.fn(), destroy: vi.fn() }));

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./turbulentOculus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./turbulentOculus")>()),
  createTurbulentOculusRenderer: () => renderer,
}));

afterEach(() => {
  stopAnimations();
  renderer.draw.mockClear();
});

describe("Turbulent Oculus", () => {
  test("renders its own shader through the WebGL2 runner", () => {
    const { run, callbacks } = startAnimation(TurbulentOculus, {});
    callbacks.resize(800, 600, false, 0);

    expect(run.runner).toBe("webgl2");
    expect(renderer.draw).toHaveBeenCalled();
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

  test("caps the expensive shader at 160,000 pixels and 24 frames a second", () => {
    const { run } = startAnimation(TurbulentOculus, {});

    expect(run.options).toMatchObject({
      frameRate: 24,
      maxDpr: 1,
      maxPixels: 160000,
    });
  });

  test("runs its shader clock at animation time", () => {
    const { callbacks } = startAnimation(TurbulentOculus, {});
    callbacks.resize(800, 600, false, 0);
    renderer.draw.mockClear();
    callbacks.frame(4000);

    expect(renderer.draw.mock.calls[0]?.[0]).toBeCloseTo(4.0, 9);
  });

  test("holds one still frame at 4.5 seconds under reduced motion", () => {
    const { callbacks } = startAnimation(TurbulentOculus, {});
    renderer.draw.mockClear();
    callbacks.resize(800, 600, true, 4000);
    callbacks.reducedMotion();

    expect(renderer.draw.mock.calls.map(([time]) => time)).toEqual([4.5, 4.5]);
  });

  test("draws with the field its theme tokens name", () => {
    const { run, callbacks } = startAnimation(TurbulentOculus, {});
    const host = run.canvas.parentElement!;
    host.style.setProperty("--turbulent-oculus-tone", "0.5");
    host.style.setProperty("--turbulent-oculus-opacity", "0.25");
    renderer.draw.mockClear();
    callbacks.resize(800, 600, false, 0);

    expect(renderer.draw).toHaveBeenLastCalledWith(0, 0.5, 0.25);
  });

});
