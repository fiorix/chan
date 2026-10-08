// The CSS tokens the animation tuner exposes as sliders, per animation. An
// animation reads each one from its canvas's parent on every frame, so the
// names here are the custom properties its component declares.

import type { EmptyPaneAnimationId } from "../components/emptyPaneAnimations";

/// One token and the range its slider spans.
export interface Tunable {
  name: string;
  min: number;
  max: number;
  step: number;
}

const RANGES = {
  "field-scale": { min: 0.5, max: 3, step: 0.05 },
  tone: { min: 0, max: 1, step: 0.005 },
  opacity: { min: 0, max: 1, step: 0.005 },
  exposure: { min: 0.1, max: 6, step: 0.05 },
} as const;

function tokens(
  id: EmptyPaneAnimationId,
  ...kinds: Array<keyof typeof RANGES>
): Tunable[] {
  return kinds.map((kind) => ({ name: `--${id}-${kind}`, ...RANGES[kind] }));
}

/// An animation with no entry declares no tunables.
export const ANIMATION_TUNABLES: Partial<
  Record<EmptyPaneAnimationId, Tunable[]>
> = {
  "turbulent-oculus": tokens("turbulent-oculus", "tone", "opacity"),
  "stellar-outburst": tokens(
    "stellar-outburst",
    "tone",
    "opacity",
    "field-scale",
  ),
  "amber-recursion": tokens(
    "amber-recursion",
    "field-scale",
    "tone",
    "opacity",
    "exposure",
  ),
  "tenfold-dahlia": tokens(
    "tenfold-dahlia",
    "field-scale",
    "tone",
    "opacity",
    "exposure",
  ),
  "beaded-torus": tokens("beaded-torus", "field-scale", "tone", "opacity"),
  "spiral-fountain": tokens(
    "spiral-fountain",
    "field-scale",
    "tone",
    "opacity",
  ),
  "twisting-swarm": tokens(
    "twisting-swarm",
    "field-scale",
    "tone",
    "opacity",
  ),
  "branching-wreath": tokens(
    "branching-wreath",
    "field-scale",
    "tone",
    "opacity",
  ),
  "drifting-galaxy": tokens(
    "drifting-galaxy",
    "field-scale",
    "tone",
    "opacity",
  ),
  "ninefold-lotus": tokens(
    "ninefold-lotus",
    "field-scale",
    "tone",
    "opacity",
  ),
};
