import { afterEach, describe, expect, test, vi } from "vitest";
import NinefoldLotus from "./NinefoldLotus.svelte";
import {
  buildNinefoldLotusDots,
  NINEFOLD_LOTUS_DOT_COUNT,
  ninefoldLotusBlurWeights,
  ninefoldLotusStampOpacity,
  type NinefoldLotusFrame,
} from "./ninefoldLotus";
import { recordingWebgl2, startAnimation, stopAnimations, uniformsSet } from "../__tests__/canvas";

const renderer = vi.hoisted(() => ({
  reset: vi.fn(),
  draw: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./ninefoldLotus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ninefoldLotus")>()),
  createNinefoldLotusRenderer: () => renderer,
}));

afterEach(() => {
  stopAnimations();
  renderer.reset.mockClear();
  renderer.draw.mockClear();
});

function frames(): NinefoldLotusFrame[] {
  return renderer.draw.mock.calls.map(([frame]) => frame as NinefoldLotusFrame);
}

function dots(frame: number): number[][] {
  const out = new Float32Array(NINEFOLD_LOTUS_DOT_COUNT * 4);
  const count = buildNinefoldLotusDots(frame, out);
  return Array.from({ length: count }, (_, index) =>
    Array.from(out.subarray(index * 4, index * 4 + 4)),
  );
}

/// `expected` is the sketch's x, y and opacity for the dot.
function expectDot(actual: number[], expected: readonly number[]): void {
  // Positions to a hundredth of a unit, relative for a dot flung far out.
  const slack = 0.01 + Math.hypot(expected[0]!, expected[1]!) * 1e-5;
  expect(Math.abs(actual[0]! - expected[0]!)).toBeLessThan(slack);
  expect(Math.abs(actual[1]! - expected[1]!)).toBeLessThan(slack);
  // The sketch's circle is two units across.
  expect(actual[2]).toBe(1);
  expect(actual[3]).toBeCloseTo(expected[2]!, 3);
}

function variance(weights: number[]): number {
  return weights.reduce(
    (sum, weight, tap) => sum + (tap === 0 ? 0 : 2 * weight * tap * tap),
    0,
  );
}

function total(weights: number[]): number {
  return weights.reduce(
    (sum, weight, tap) => sum + (tap === 0 ? weight : 2 * weight),
    0,
  );
}

describe("buildNinefoldLotusDots", () => {
  test("puts a dot every two units of arc on eleven rings", () => {
    expect(NINEFOLD_LOTUS_DOT_COUNT).toBe(6225);
  });

  // Expected values come from running the sketch's loop literally over
  // p5.js's own noise(), after noiseSeed(1): x, y and opacity.
  test("places each dot where the sketch draws it, in the sketch's order", () => {
    const first = dots(1);
    expect(first).toHaveLength(6225);
    expectDot(first[0]!, [0, -647.2306, 0.006]);
    expectDot(first[700]!, [-4616.4882, 2344.8138, 0.006]);
    expectDot(first[3000]!, [287.4939, -42.2151, 0.1548]);
    expectDot(first[6224]!, [-0.4953, -29.9833, 1]);

    const later = dots(1000);
    expect(later).toHaveLength(6225);
    expectDot(later[0]!, [0, -381.5666, 0.4459]);
    expectDot(later[700]!, [-398.5143, 202.414, 0.4459]);
    expectDot(later[3000]!, [233.8736, -34.3416, 1]);
    expectDot(later[6224]!, [-0.4718, -28.5602, 1]);
  });

  test("leaves out the dots of a ring that has swelled out of sight", () => {
    const shown = dots(230);

    expect(shown).toHaveLength(5753);
    expectDot(shown[0]!, [0, -312.6394, 1]);
    expectDot(shown[700]!, [-282.8425, 143.6618, 1]);
    expectDot(shown[3000]!, [304.9506, -44.7784, 0.2377]);
    expectDot(shown[5752]!, [-0.6175, -37.3777, 0.4714]);
    expect(shown.every(([, , , alpha]) => alpha! >= 1 / 510)).toBe(true);
  });

});

describe("ninefoldLotusBlurWeights", () => {
  test("spreads by exactly the asked deviation with three taps when that is under a pixel", () => {
    const weights = ninefoldLotusBlurWeights(0.6);

    expect(weights).toHaveLength(2);
    expect(total(weights)).toBeCloseTo(1, 12);
    expect(variance(weights)).toBeCloseTo(0.36, 12);
  });

  test("is a normalized Gaussian out to two and a half deviations when wider", () => {
    const weights = ninefoldLotusBlurWeights(2);

    expect(weights).toHaveLength(6);
    expect(total(weights)).toBeCloseTo(1, 12);
    expect(weights[1]! / weights[0]!).toBeCloseTo(Math.exp(-1 / 8), 12);
    // Cutting the tails off loses a little of the spread.
    expect(Math.sqrt(variance(weights))).toBeGreaterThan(1.8);
    expect(Math.sqrt(variance(weights))).toBeLessThan(2);
  });

  test("reaches no further than twelve taps a side and passes a zero spread through", () => {
    expect(ninefoldLotusBlurWeights(40)).toHaveLength(13);
    expect(ninefoldLotusBlurWeights(0)).toEqual([1]);
  });
});

describe("ninefoldLotusStampOpacity", () => {
  // The point shader covers a pixel at `distance` from a dot's center by
  // clamp(radius - distance + 0.5, 0, 1), scaled by min(1, 2 radius).
  function drawnInk(radius: number): number {
    let ink = 0;
    const step = 0.0005;
    for (let distance = step / 2; distance < radius + 0.5; distance += step) {
      const coverage = Math.min(1, Math.max(0, radius - distance + 0.5));
      ink += coverage * 2 * Math.PI * distance * step;
    }
    return ink * Math.min(1, 2 * radius);
  }

  test("scales what the point shader draws down to the dot's true area", () => {
    for (const radius of [0.1, 0.25, 0.5, 0.8, 2]) {
      expect(drawnInk(radius) * ninefoldLotusStampOpacity(radius)).toBeCloseTo(
        Math.PI * radius * radius,
        3,
      );
    }
    expect(ninefoldLotusStampOpacity(0)).toBe(0);
  });
});

describe("Ninefold Lotus", () => {
  test("renders through the WebGL2 runner at the display's density, from an empty glow", () => {
    const { run, callbacks } = startAnimation(NinefoldLotus, {});
    callbacks.resize(800, 600, false, 0);

    expect(run.runner).toBe("webgl2");
    expect(run.options).toMatchObject({ maxDpr: 2 });
    expect(run.options.maxPixels).toBeUndefined();
    expect(renderer.reset).toHaveBeenCalledOnce();
    expect(frames()).toHaveLength(1);
  });

  test("runs every source frame once, 30 of them a second, and paints only when there is one", () => {
    const { callbacks } = startAnimation(NinefoldLotus, {});
    callbacks.resize(800, 600, false, 0);
    renderer.draw.mockClear();
    callbacks.frame(100);
    callbacks.frame(110);
    callbacks.frame(170);

    // Frame 3 at 100 ms, still frame 3 at 110 ms, frame 5 at 170 ms.
    expect(frames().map((frame) => frame.frames)).toEqual([[1, 2, 3], [4, 5]]);
  });

  test("runs at most six source frames after a stall, ending on the present", () => {
    const { callbacks } = startAnimation(NinefoldLotus, {});
    callbacks.resize(800, 600, false, 0);
    renderer.draw.mockClear();
    callbacks.frame(2000);

    expect(frames()[0]!.frames).toEqual([55, 56, 57, 58, 59, 60]);
  });

  test("picks up at the present frame when it resumes", () => {
    const { callbacks } = startAnimation(NinefoldLotus, {});
    callbacks.resize(800, 600, false, 0);
    callbacks.frame(100);
    callbacks.start!();
    renderer.draw.mockClear();
    callbacks.frame(9000);

    expect(frames()[0]!.frames).toEqual([270]);
  });

  test("holds one still with its glow under reduced motion", () => {
    const { callbacks } = startAnimation(NinefoldLotus, {});
    renderer.draw.mockClear();
    renderer.reset.mockClear();
    callbacks.reducedMotion();

    const [still] = frames();
    expect(renderer.reset).toHaveBeenCalledOnce();
    expect(still!.frames).toHaveLength(48);
    expect(still!.frames[0]).toBe(183);
    expect(still!.frames.at(-1)).toBe(230);

    // The same still at any animation time.
    renderer.draw.mockClear();
    callbacks.resize(800, 600, true, 4000);
    expect(frames().at(-1)?.frames.at(-1)).toBe(230);
  });

  test("draws with the field its theme tokens name", () => {
    const { run, callbacks } = startAnimation(NinefoldLotus, {});
    const host = run.canvas.parentElement!;
    host.style.setProperty("--ninefold-lotus-field-scale", "2");
    host.style.setProperty("--ninefold-lotus-tone", "0.5");
    host.style.setProperty("--ninefold-lotus-opacity", "0.25");
    callbacks.resize(800, 600, false, 0);

    expect(frames().at(-1)).toMatchObject({
      fieldScale: 2,
      tone: 0.5,
      opacity: 0.25,
    });
  });

  test("keeps the glow at a quarter of the canvas each way", async () => {
    const { createNinefoldLotusRenderer } =
      await vi.importActual<typeof import("./ninefoldLotus")>("./ninefoldLotus");
    const { gl, calls } = recordingWebgl2();

    createNinefoldLotusRenderer(gl).draw({ frames: [1000], fieldScale: 1, tone: 1, opacity: 1 });

    // The recording context's drawing buffer is 100 by 100.
    expect(
      calls.filter(({ op }) => op === "texImage2D").map(({ args }) => [args[3], args[4]]),
    ).toEqual([[25, 25], [25, 25]]);
    expect(calls).toContainEqual({ op: "viewport", args: [0, 0, 25, 25] });
    expect(calls).toContainEqual({ op: "viewport", args: [0, 0, 100, 100] });
  });

  test("for each source frame fades and blurs the glow both ways, then adds the frame's dots to it; the last frame's dots are drawn sharp over the glow", async () => {
    const { createNinefoldLotusRenderer } =
      await vi.importActual<typeof import("./ninefoldLotus")>("./ninefoldLotus");
    const { gl, calls } = recordingWebgl2();

    createNinefoldLotusRenderer(gl).draw({
      frames: [999, 1000],
      fieldScale: 7.2,
      tone: 0.5,
      opacity: 0.25,
    });

    const draws = calls
      .filter(({ op }) => op === "drawArrays")
      .map(({ args }) => args[0]);
    expect(draws).toEqual([
      // Frame 999: fade and blur.
      "TRIANGLES", "TRIANGLES",
      // Frame 1000: 999's dots into the glow, then fade and blur.
      "POINTS", "TRIANGLES", "TRIANGLES",
      // The canvas: the glow, then 1000's dots.
      "TRIANGLES", "POINTS",
      // 1000's dots into the glow.
      "POINTS",
    ]);
    // The fade belongs to one direction of the blur, not both.
    expect(uniformsSet(calls, "uDirection")).toEqual([[1, 0], [0, 1], [1, 0], [0, 1]]);
    expect(uniformsSet(calls, "uFade")).toEqual([[0.03], [0], [0.03], [0]]);
    // A field scale of 7.2 is one pixel a source unit on this buffer, so a
    // quarter of one on the glow: its dots go in at that scale, in full
    // tone and corrected to their true area, the canvas's at the theme's.
    expect(uniformsSet(calls, "uScale").map(([scale]) => scale)).toEqual([
      expect.closeTo(0.25, 9),
      expect.closeTo(1, 9),
      expect.closeTo(0.25, 9),
    ]);
    expect(uniformsSet(calls, "uTone")).toEqual([[1], [0.5], [0.5], [1]]);
    const stamp = ninefoldLotusStampOpacity(0.25);
    expect(uniformsSet(calls, "uOpacity")).toEqual([[stamp], [0.25], [0.25], [stamp]]);
    // The blur spreads by the sketch's 3.154 units a frame: 0.79 of a glow
    // pixel here, so the Gaussian, two taps a side.
    expect(uniformsSet(calls, "uReach")).toEqual([[2], [2]]);
    // The glow and the blur's scratch surface, made once.
    expect(calls.filter(({ op }) => op === "createFramebuffer")).toHaveLength(2);
  });

  test("draws nothing when it is given no source frame", async () => {
    const { createNinefoldLotusRenderer } =
      await vi.importActual<typeof import("./ninefoldLotus")>("./ninefoldLotus");
    const { gl, calls } = recordingWebgl2();
    const lotus = createNinefoldLotusRenderer(gl);
    calls.length = 0;

    lotus.draw({ frames: [], fieldScale: 1, tone: 1, opacity: 1 });

    expect(calls.filter(({ op }) => op === "drawArrays" || op === "clear")).toEqual([]);
  });

  test("keeps the glow in half floats where the driver can render to them, and in bytes where it cannot", async () => {
    const { createNinefoldLotusRenderer } =
      await vi.importActual<typeof import("./ninefoldLotus")>("./ninefoldLotus");
    const frame = { frames: [1], fieldScale: 1, tone: 1, opacity: 1 };

    const able = recordingWebgl2({ getExtension: () => ({}) });
    createNinefoldLotusRenderer(able.gl).draw(frame);
    expect(
      able.calls.filter(({ op }) => op === "texImage2D").map(({ args }) => [args[2], args[7]]),
    ).toEqual([["R16F", "HALF_FLOAT"], ["R16F", "HALF_FLOAT"]]);
    expect(uniformsSet(able.calls, "uLeast")).toEqual([[0]]);

    const unable = recordingWebgl2({ getExtension: () => null });
    createNinefoldLotusRenderer(unable.gl).draw(frame);
    expect(
      unable.calls.filter(({ op }) => op === "texImage2D").map(({ args }) => [args[2], args[7]]),
    ).toEqual([["R8", "UNSIGNED_BYTE"], ["R8", "UNSIGNED_BYTE"]]);
    expect(uniformsSet(unable.calls, "uLeast")).toEqual([[1 / 255]]);
  });
});
