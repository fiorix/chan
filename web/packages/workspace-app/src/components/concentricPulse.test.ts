import { afterEach, describe, expect, test, vi } from "vitest";
import ConcentricPulse from "./ConcentricPulse.svelte";
import {
  buildConcentricPulseRings,
  concentricPulseGap,
} from "./concentricPulse";
import {
  recordingContext2d,
  startAnimation,
  stopAnimations,
} from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./concentricPulse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./concentricPulse")>();
  return {
    ...actual,
    buildConcentricPulseRings: vi.fn(actual.buildConcentricPulseRings),
  };
});

afterEach(stopAnimations);

/// The phase of every draw from here on.
function drawnPhases(): () => number[] {
  const build = vi.mocked(buildConcentricPulseRings);
  build.mockClear();
  return () => build.mock.calls.map(([phase]) => phase);
}

describe("Concentric Pulse", () => {
  test("pulses 0.1885 radians per second of animation time", () => {
    const { callbacks } = startAnimation(ConcentricPulse, recordingContext2d().ctx);
    callbacks.resize(400, 300, false, 0);
    const phases = drawnPhases();
    callbacks.frame(1000);
    callbacks.frame(3000);

    expect(phases()).toEqual([expect.closeTo(0.1885, 9), expect.closeTo(0.5655, 9)]);
  });

  test("holds one still frame under reduced motion", () => {
    const { callbacks } = startAnimation(ConcentricPulse, recordingContext2d().ctx);
    const phases = drawnPhases();
    callbacks.resize(400, 300, true, 1000);
    callbacks.reducedMotion();

    const [first, second] = phases();
    expect(second).toBe(first);
  });

  test("strokes the rings in the colour and opacity its theme tokens name", () => {
    const { ctx, ops } = recordingContext2d();
    const { run, callbacks } = startAnimation(ConcentricPulse, ctx);
    const host = run.canvas.parentElement!;
    host.style.setProperty("--concentric-pulse-line-rgb", "1, 2, 3");
    host.style.setProperty("--concentric-pulse-alpha-base", "0.25");
    host.style.setProperty("--concentric-pulse-alpha-range", "0.5");
    // Phase 0 is the top of the breath, where the full range adds on.
    callbacks.resize(400, 300, false, 0);

    expect(ops).toContainEqual({ op: "set strokeStyle", args: ["rgb(1, 2, 3)"] });
    expect(ops).toContainEqual({ op: "set globalAlpha", args: [0.75] });
  });

  test("breathes between the source sketch's sparse and dense gaps", () => {
    expect(concentricPulseGap(0)).toBe(99);
    expect(concentricPulseGap(Math.PI)).toBe(1);
    expect(buildConcentricPulseRings(0)).toHaveLength(6);
    expect(buildConcentricPulseRings(Math.PI)).toHaveLength(560);
  });

  test("uses the source sketch's radius-dependent polygon vertices", () => {
    const rings = buildConcentricPulseRings(0);

    expect(rings[0]).toEqual({
      radius: 10,
      vertices: [{ x: 10, y: 0 }],
    });
    expect(rings[1].radius).toBe(109);
    expect(rings[1].vertices).toHaveLength(6);
  });
});
