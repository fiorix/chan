import { describe, expect, test } from "vitest";
import {
  EMPTY_PANE_ANIMATIONS,
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
      "penguin-grid",
      "exponential-thread",
      "exponential-echo",
      "quadratic-bloom",
      "orbital-rosette",
      "dotted-waves",
      "spiral-spokes",
      "mutual-force-starburst",
      "recursive-arc-bloom",
      "chaotic-halo",
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
  });

  test("steps forward and backward with wraparound", () => {
    expect(stepEmptyPaneAnimation("sixfold-vortex", 1)).toBe(
      "radial-ribbons",
    );
    expect(stepEmptyPaneAnimation("sixfold-vortex", -1)).toBe(
      "chaotic-halo",
    );
    expect(stepEmptyPaneAnimation("dotted-waves", 1)).toBe(
      "spiral-spokes",
    );
    expect(stepEmptyPaneAnimation("chaotic-halo", 1)).toBe(
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
    ).toBe("chaotic-halo");
  });

  test("picks the initial animation from the full catalog", () => {
    expect(randomEmptyPaneAnimation(undefined, () => 0)).toBe(
      "sixfold-vortex",
    );
    expect(randomEmptyPaneAnimation(undefined, () => 0.999)).toBe(
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
      "chaotic-halo",
    );
    expect(initialEmptyPaneAnimation(storage, () => 0)).toBe(
      "chaotic-halo",
    );

    persistEmptyPaneAnimation("polar-drift", storage);
    expect(initialEmptyPaneAnimation(storage, () => 0.999)).toBe(
      "polar-drift",
    );
  });
});
