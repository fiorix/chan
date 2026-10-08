import { describe, expect, test } from "vitest";
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
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
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
      "cosmic-bell",
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
      "sixfold-vortex",
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
    ).toBe("cosmic-bell");
  });

  test("picks the initial animation from the full catalog", () => {
    expect(randomEmptyPaneAnimation(undefined, () => 0)).toBe(
      "sixfold-vortex",
    );
    expect(randomEmptyPaneAnimation(undefined, () => 0.999)).toBe(
      "cosmic-bell",
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
      "chaotic-halo",
    );
    expect(stepEmptyPaneAnimation("chaotic-halo", 1, choices)).toBe(
      "radial-ribbons",
    );
    // From outside the choices, the nearest choice in that direction.
    expect(stepEmptyPaneAnimation("polar-drift", 1, choices)).toBe(
      "concentric-pulse",
    );
    expect(stepEmptyPaneAnimation("polar-drift", -1, choices)).toBe(
      "radial-ribbons",
    );
    expect(stepEmptyPaneAnimation("eightfold-coil", 1, choices)).toBe(
      "radial-ribbons",
    );
    expect(stepEmptyPaneAnimation("sixfold-vortex", 1, [])).toBe(
      "sixfold-vortex",
    );

    expect(randomEmptyPaneAnimation(undefined, () => 0, choices)).toBe(
      "radial-ribbons",
    );
    expect(randomEmptyPaneAnimation(undefined, () => 0.999, choices)).toBe(
      "chaotic-halo",
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
      "cosmic-bell",
    );
    expect(initialEmptyPaneAnimation(storage, () => 0)).toBe(
      "cosmic-bell",
    );

    persistEmptyPaneAnimation("polar-drift", storage);
    expect(initialEmptyPaneAnimation(storage, () => 0.999)).toBe(
      "polar-drift",
    );
  });
});
