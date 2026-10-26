// The Computers carousel's ring geometry: cards stand around a vertical axis,
// each turned `index * step` degrees and pushed `radius` out from it, and the
// ring turns to bring one card to the front. Pure functions so the layout is
// testable without a DOM.

/** Below this many cards the ring is an arc: the cards keep the step a ring of
 * this many would have, so two or three cards sit side by side instead of
 * spreading half a circle apart with one hidden behind the other. */
export const MIN_SLOTS = 6;

/** Cards turned further than this from the front are hidden: only the card in
 * front and its nearest neighbours show, so no card's back (mirrored, since
 * WebKitGTK ignores `backface-visibility`) or edge-on sliver reaches the eye. */
export const HIDE_BEYOND_DEG = 75;

export interface RingLayout {
  /** Positions on the circle: the card count, or MIN_SLOTS for an arc. */
  slots: number;
  /** Degrees between neighbouring cards. */
  step: number;
  /** Every position holds a card, so the ring can keep turning past its seam. */
  fullRing: boolean;
}

export function ringLayout(count: number): RingLayout {
  const slots = Math.max(count, MIN_SLOTS);
  return { slots, step: 360 / slots, fullRing: count >= MIN_SLOTS };
}

/** The card width for a stage this wide: room for a neighbour's edge on each
 * side, bounded so a card stays readable on a narrow window and does not
 * sprawl on a wide one. */
export function cardWidth(stageWidth: number): number {
  return Math.round(Math.min(560, Math.max(300, stageWidth - 224)));
}

/** The distance from the axis that keeps neighbouring cards `gap` apart at
 * their nearest edges. */
export function ringRadius(width: number, slots: number, gap = 28): number {
  return Math.round((width / 2 + gap) / Math.tan(Math.PI / slots));
}

export function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** A card's angle from the front, in (-180, 180], with the ring turned to
 * `position` steps. */
export function relativeAngle(index: number, position: number, step: number): number {
  const a = mod((index - position) * step, 360);
  return a > 180 ? a - 360 : a;
}

/** Cards darken with their angle from the front, as in a lit ring. They stay
 * opaque, so overlapping neighbours sort by depth instead of showing through
 * one another, and never fall below a third so a neighbour stays legible. */
export function slotBrightness(angle: number): number {
  return Math.max(0.35, 1 - Math.abs(angle) / 160);
}

/** The steps that bring card `to` to the front from card `from`: the short way
 * round on a full ring, the direct way along an arc. */
export function shortestDelta(from: number, to: number, count: number, fullRing: boolean): number {
  const direct = to - from;
  if (!fullRing || count === 0) return direct;
  const forward = mod(direct, count);
  return forward > count / 2 ? forward - count : forward;
}
