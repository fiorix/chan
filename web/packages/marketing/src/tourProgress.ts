/**
 * Where a tour stands, as a fractional beat index: exactly `i` when the focus
 * line crosses the centre of beat `i`, and linear between neighbours, so beats
 * of unequal height still take one unit each.
 */
export function beatPosition(centers: readonly number[], focusY: number): number {
  const last = centers.length - 1;
  if (last < 1 || focusY <= centers[0]) return 0;
  if (focusY >= centers[last]) return last;
  let next = 1;
  while (centers[next] < focusY) next += 1;
  const from = centers[next - 1];
  return next - 1 + (focusY - from) / Math.max(1, centers[next] - from);
}

/**
 * Eased progress of the move from beat `from` to the one after it. The pose
 * of `from` holds for `holdStart` of a unit past its centre and the next
 * pose is reached `holdEnd` before its own, so the scene rests while a beat's
 * copy is being read and moves in between.
 */
export function moveProgress(position: number, from: number, holdStart = 0.2, holdEnd = holdStart): number {
  const raw = Math.max(0, Math.min(1, (position - from - holdStart) / (1 - holdStart - holdEnd)));
  return raw * raw * (3 - 2 * raw);
}

/**
 * Beat centres for a tour whose first beat opens the page: that beat is
 * current while the page is at its top, wherever its copy sits on the first
 * screen, so its centre is never above the focus line.
 */
export function anchorOpeningBeat(centers: readonly number[], firstTop: number, focus: number): { centers: number[]; opensPage: boolean } {
  const opensPage = centers.length > 1 && firstTop < focus && Math.max(centers[0], focus) < centers[1];
  return { centers: opensPage ? [Math.max(centers[0], focus), ...centers.slice(1)] : [...centers], opensPage };
}

/** The beat a position reads as: the nearest one. */
export function beatIndex(position: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.round(position)));
}
