import { describe, expect, test } from "vitest";
import * as animationCatalog from "./emptyPaneAnimations";
import {
  EMPTY_PANE_ANIMATIONS,
  emptyPaneAnimationChoices,
  emptyPaneAnimationName,
  emptyPaneAnimationSpeedLabel,
  initialEmptyPaneAnimation,
  persistEmptyPaneAnimation,
  randomEmptyPaneAnimation,
  stepEmptyPaneAnimation,
  stepEmptyPaneAnimationSpeed,
} from "./emptyPaneAnimations";

describe("empty pane animation catalog", () => {
  test("has stable unique ids and names", () => {
    const ids = EMPTY_PANE_ANIMATIONS.map((animation) => animation.id);
    const names = EMPTY_PANE_ANIMATIONS.map((animation) => animation.name);

    expect(ids).toEqual([
      "sixfold-vortex",
      "radial-ribbons",
      "polar-drift",
      "concentric-pulse",
      "exponential-thread",
      "exponential-echo",
      "quadratic-bloom",
      "orbital-rosette",
      "dotted-waves",
      "spiral-spokes",
      "mutual-force-starburst",
      "recursive-arc-bloom",
      "chaotic-halo",
      "threefold-veil",
      "striated-current",
      "lorenz-constellation",
      "twin-veil-dance",
      "rippled-duet",
      "fourteenfold-bloom",
      "hexagonal-bloom",
      "turbulent-oculus",
      "stellar-outburst",
      "amber-recursion",
      "tenfold-dahlia",
      "beaded-torus",
      "spiral-fountain",
      "twisting-swarm",
      "branching-wreath",
      "drifting-galaxy",
      "ninefold-lotus",
      "eightfold-coil",
      "cosmic-bell",
      "segmented-torus",
      "swaying-branches",
      "contracting-spiral",
      "turning-shell",
      "tangent-shell",
      "stacked-spire",
      "torus-lantern",
      "bitwise-spheres",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
  });

  test("classifies every animation by its canvas runner", () => {
    for (const animation of EMPTY_PANE_ANIMATIONS) {
      expect(["2d", "webgl2"]).toContain(animation.runner);
    }
    expect(
      EMPTY_PANE_ANIMATIONS.find((animation) => animation.id === "cosmic-bell")
        ?.runner,
    ).toBe("webgl2");
    expect(
      EMPTY_PANE_ANIMATIONS.find((animation) => animation.id === "segmented-torus")
        ?.runner,
    ).toBe("webgl2");
  });

  test("resolves the display names used by the animation flash", () => {
    expect(emptyPaneAnimationName("orbital-rosette")).toBe(
      "Orbital Rosette",
    );
    expect(emptyPaneAnimationName("dotted-waves")).toBe("Dotted Waves");
    expect(emptyPaneAnimationName("mutual-force-starburst")).toBe(
      "Mutual Force Starburst",
    );
    expect(emptyPaneAnimationName("exponential-echo")).toBe(
      "Exponential Echo",
    );
    expect(emptyPaneAnimationName("threefold-veil")).toBe(
      "Threefold Veil",
    );
    expect(emptyPaneAnimationName("lorenz-constellation")).toBe(
      "Lorenz Constellation",
    );
    expect(emptyPaneAnimationName("fourteenfold-bloom")).toBe(
      "Fourteenfold Bloom",
    );
  });

  test("steps forward and backward with wraparound", () => {
    expect(stepEmptyPaneAnimation("sixfold-vortex", 1)).toBe(
      "radial-ribbons",
    );
    expect(stepEmptyPaneAnimation("sixfold-vortex", -1)).toBe(
      "bitwise-spheres",
    );
    expect(stepEmptyPaneAnimation("dotted-waves", 1)).toBe(
      "spiral-spokes",
    );
    expect(stepEmptyPaneAnimation("chaotic-halo", 1)).toBe(
      "threefold-veil",
    );
    expect(stepEmptyPaneAnimation("threefold-veil", 1)).toBe(
      "striated-current",
    );
    expect(stepEmptyPaneAnimation("fourteenfold-bloom", 1)).toBe(
      "hexagonal-bloom",
    );
    expect(stepEmptyPaneAnimation("hexagonal-bloom", 1)).toBe(
      "turbulent-oculus",
    );
    expect(stepEmptyPaneAnimation("turbulent-oculus", 1)).toBe(
      "stellar-outburst",
    );
    expect(stepEmptyPaneAnimation("stellar-outburst", 1)).toBe(
      "amber-recursion",
    );
    expect(stepEmptyPaneAnimation("amber-recursion", 1)).toBe(
      "tenfold-dahlia",
    );
    expect(stepEmptyPaneAnimation("tenfold-dahlia", 1)).toBe(
      "beaded-torus",
    );
    expect(stepEmptyPaneAnimation("beaded-torus", 1)).toBe(
      "spiral-fountain",
    );
    expect(stepEmptyPaneAnimation("spiral-fountain", 1)).toBe(
      "twisting-swarm",
    );
    expect(stepEmptyPaneAnimation("twisting-swarm", 1)).toBe(
      "branching-wreath",
    );
    expect(stepEmptyPaneAnimation("branching-wreath", 1)).toBe(
      "drifting-galaxy",
    );
    expect(stepEmptyPaneAnimation("drifting-galaxy", 1)).toBe(
      "ninefold-lotus",
    );
    expect(stepEmptyPaneAnimation("ninefold-lotus", 1)).toBe(
      "eightfold-coil",
    );
    expect(stepEmptyPaneAnimation("eightfold-coil", 1)).toBe(
      "cosmic-bell",
    );
    expect(stepEmptyPaneAnimation("cosmic-bell", 1)).toBe(
      "segmented-torus",
    );
    expect(stepEmptyPaneAnimation("segmented-torus", 1)).toBe(
      "swaying-branches",
    );
  });

  test("steps the speed ladder with clamped ends", () => {
    expect(stepEmptyPaneAnimationSpeed(1, 1)).toBe(1.4);
    expect(stepEmptyPaneAnimationSpeed(1, -1)).toBe(0.7);
    expect(stepEmptyPaneAnimationSpeed(4, 1)).toBe(4);
    expect(stepEmptyPaneAnimationSpeed(0.25, -1)).toBe(0.25);
    expect(stepEmptyPaneAnimationSpeed(7, 1)).toBe(1.4);
    expect(emptyPaneAnimationSpeedLabel(1.4)).toBe("Speed 1.4x");
    expect(emptyPaneAnimationSpeedLabel(1)).toBe("Speed 1x");
  });

  test("picks a random animation other than the current one", () => {
    expect(randomEmptyPaneAnimation("sixfold-vortex", () => 0)).toBe(
      "radial-ribbons",
    );
    expect(
      randomEmptyPaneAnimation("sixfold-vortex", () => 0.999),
    ).toBe("bitwise-spheres");
  });

  test("picks the initial animation from the full catalog", () => {
    expect(randomEmptyPaneAnimation(undefined, () => 0)).toBe(
      "sixfold-vortex",
    );
    expect(randomEmptyPaneAnimation(undefined, () => 0.999)).toBe(
      "bitwise-spheres",
    );
  });

  test("offers the 2D-canvas animations alone on a software renderer or no context", () => {
    const twoD = EMPTY_PANE_ANIMATIONS.filter(
      (animation) => animation.runner === "2d",
    );
    expect(twoD.length).toBeGreaterThan(0);
    for (const kind of ["software", "none"] as const) {
      expect(emptyPaneAnimationChoices(kind), kind).toEqual(twoD);
    }
    for (const kind of ["hardware", "unidentified"] as const) {
      expect(emptyPaneAnimationChoices(kind), kind).toBe(EMPTY_PANE_ANIMATIONS);
    }
  });

  test("steps, draws and restores within the choices it is given", () => {
    const choices = emptyPaneAnimationChoices("software");

    expect(stepEmptyPaneAnimation("radial-ribbons", 1, choices)).toBe(
      "concentric-pulse",
    );
    expect(stepEmptyPaneAnimation("radial-ribbons", -1, choices)).toBe(
      "contracting-spiral",
    );
    expect(stepEmptyPaneAnimation("chaotic-halo", 1, choices)).toBe(
      "swaying-branches",
    );
    // From outside the choices, the nearest choice in that direction.
    expect(stepEmptyPaneAnimation("polar-drift", 1, choices)).toBe(
      "concentric-pulse",
    );
    expect(stepEmptyPaneAnimation("polar-drift", -1, choices)).toBe(
      "radial-ribbons",
    );
    expect(stepEmptyPaneAnimation("eightfold-coil", 1, choices)).toBe(
      "swaying-branches",
    );
    expect(stepEmptyPaneAnimation("sixfold-vortex", 1, [])).toBe(
      "sixfold-vortex",
    );

    expect(randomEmptyPaneAnimation(undefined, () => 0, choices)).toBe(
      "radial-ribbons",
    );
    expect(randomEmptyPaneAnimation(undefined, () => 0.999, choices)).toBe(
      "contracting-spiral",
    );
    expect(randomEmptyPaneAnimation("radial-ribbons", () => 0, choices)).toBe(
      "concentric-pulse",
    );
    expect(randomEmptyPaneAnimation("polar-drift", () => 0, [])).toBe(
      "sixfold-vortex",
    );

    const values = new Map<string, string>([
      ["chan.empty-pane-animation", "polar-drift"],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(initialEmptyPaneAnimation(storage, () => 0, choices)).toBe(
      "radial-ribbons",
    );
    expect(values.get("chan.empty-pane-animation")).toBe("radial-ribbons");
    persistEmptyPaneAnimation("chaotic-halo", storage);
    expect(initialEmptyPaneAnimation(storage, () => 0, choices)).toBe(
      "chaotic-halo",
    );
  });

  test("keeps the initial and selected animation across page reloads", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(initialEmptyPaneAnimation(storage, () => 0.999)).toBe(
      "bitwise-spheres",
    );
    expect(initialEmptyPaneAnimation(storage, () => 0)).toBe(
      "bitwise-spheres",
    );

    persistEmptyPaneAnimation("polar-drift", storage);
    expect(initialEmptyPaneAnimation(storage, () => 0.999)).toBe(
      "polar-drift",
    );
  });
});

describe("GPU frame probe judge", () => {
  type Probe = {
    windowMs: number;
    callbackCount: number;
    frames: Array<{ timestampMs: number; costMs: number }>;
  };
  const judgeCandidate = (animationCatalog as Record<string, unknown>)[
    "judgeGpuProbe"
  ];
  const judge = judgeCandidate as (probe: Probe) => "keep" | "swap";
  const probe = (count: number, costMs: number, windowMs = 1000): Probe => ({
    windowMs,
    callbackCount: count,
    frames: Array.from({ length: count }, (_, index) => ({
      timestampMs: ((index + 1) * windowMs) / count,
      costMs,
    })),
  });

  test("swaps each measured slow rate", () => {
    expect(judgeCandidate, "probe judge is exported").toBeTypeOf("function");
    for (const rate of [2.7, 6.3, 8.8, 10.8, 12.8]) {
      expect(judge(probe(rate * 10, 4, 10000)), `${rate} fps`).toBe("swap");
    }
  });

  test("keeps a fast cheap probe and swaps a fast costly probe", () => {
    expect(judgeCandidate, "probe judge is exported").toBeTypeOf("function");
    expect(judge(probe(24, 4))).toBe("keep");
    expect(judge(probe(24, 30))).toBe("swap");
  });

  test("keeps at each bound and swaps just beyond it", () => {
    const rateBound = animationCatalog.GPU_MIN_CALLBACK_FPS;
    const costBound = animationCatalog.GPU_MAX_MEDIAN_FRAME_COST_MS;
    expect(rateBound, "measured callback bound").toBe(16);
    expect(costBound, "current cost bound").toBe(20);
    const fastCount = (rateBound + 1) * 10;
    expect(judge(probe(rateBound * 10, 4, 10000)), "rate at bound").toBe("keep");
    expect(judge(probe(rateBound * 10 - 1, 4, 10000)), "rate below bound").toBe("swap");
    expect(judge(probe(fastCount, costBound, 10000)), "cost at bound").toBe("keep");
    expect(judge(probe(fastCount, costBound + 0.01, 10000)), "cost above bound").toBe("swap");
  });

  test("keeps an empty probe", () => {
    expect(judgeCandidate, "probe judge is exported").toBeTypeOf("function");
    expect(judge({ windowMs: 1500, callbackCount: 0, frames: [] })).toBe("keep");
  });
});
