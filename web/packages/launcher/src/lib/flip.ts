// The screen flip: the launcher's main area turns over like a workspace pane
// when it swaps between the Computers and Gateways screens. The axis algorithm
// and the -180deg turn are a copy of the workspace-app Pane.svelte side flip,
// and nothing ties the two: flip.test.ts tests this copy's behaviour and the
// pane's tests test the pane's, so a change to one does not reach the other.

export type FlipAxis = "horizontal" | "vertical";

export interface FlipTransforms {
  /** The keyframe start: the card turned away, mid-flip. */
  start: string;
  /** The static transform of the back face (hidden behind the content). */
  back: string;
}

/** The flip animates on the axis that matches the element's shape: wide areas
 * turn horizontally, tall areas turn vertically, and a square one chooses
 * either axis so both orientations stay possible. */
export function flipAxisForElement(el: HTMLElement | null): FlipAxis {
  const rect = el?.getBoundingClientRect();
  const width = Math.round(rect?.width ?? 0);
  const height = Math.round(rect?.height ?? 0);
  if (height > width) return "vertical";
  if (width > height) return "horizontal";
  return Math.random() < 0.5 ? "vertical" : "horizontal";
}

/** The CSS transforms for one flip on the given axis: the animation starts at
 * the half-turn and settles at rest; the back face sits at the same half-turn
 * so it only shows mid-flip. */
export function flipTransforms(axis: FlipAxis): FlipTransforms {
  const rotate = axis === "vertical" ? "rotateY" : "rotateX";
  return {
    start: `${rotate}(-180deg)`,
    back: `${rotate}(-180deg)`,
  };
}

/** The flip animation length. The ScreenFlip fallback timer that clears the
 * animation class must outlast it: jsdom and reduced-motion environments never
 * fire animationend. */
export const FLIP_DURATION_MS = 520;
