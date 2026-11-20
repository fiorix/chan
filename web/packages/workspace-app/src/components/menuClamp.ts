// Shared clamping helper for popovers / context menus.
//
// All right-click and hamburger menus across the app need the same
// "show near (x, y) but keep the whole thing on-screen" behaviour.
// Doing this inline was inconsistent: some menus only clamped using
// an estimated height (drifting off-screen when the actual menu was
// taller); others didn't clamp at all (the FileTree row menu used
// raw `left: {x}px; top: {y}px`).
//
// This module owns the math in one place. Callers either invoke
// `clampToViewport(rect, ...)` directly (when they already have a
// position to massage) or use the `clampMenu` Svelte action to
// auto-place the element on mount.

export interface ClampOpts {
  /// Cursor / desired-top-left position in viewport coords.
  x: number;
  y: number;
  /// Where the menu's bottom edge goes when it flips up; `y` when absent. A
  /// menu opened below a band (a terminal link's row) flips to above it,
  /// never over it.
  flipY?: number;
  /// Inset from the viewport edges so the menu never butts up flush.
  margin?: number;
}

/// Given a target rect (already rendered with width/height), return
/// the {left, top} position that keeps it within the viewport while
/// staying as close to (x, y) as possible. Picks above / left flips
/// when the menu would otherwise overflow the bottom / right edges.
export function clampToViewport(
  width: number,
  height: number,
  { x, y, flipY = y, margin = 8 }: ClampOpts,
): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.visualViewport?.height ?? window.innerHeight;
  let left = x;
  let top = y;
  if (left + width > vw - margin) {
    // Flip left: anchor right edge near the cursor.
    left = Math.max(margin, x - width);
  }
  if (left + width > vw - margin) {
    // Still doesn't fit (menu wider than viewport minus margins);
    // pin to the right edge with the margin honoured.
    left = Math.max(margin, vw - margin - width);
  }
  if (top + height > vh - margin) {
    // Flip up: anchor bottom edge near the cursor.
    top = Math.max(margin, flipY - height);
  }
  if (top + height > vh - margin) {
    top = Math.max(margin, vh - margin - height);
  }
  // The flips above only pull the menu back from the right and bottom
  // edges. A displaced anchor (e.g. a trigger rect measured while a pane
  // flip or hover-scale is mid-transform) can sit past the top or left
  // edge, where nothing above catches it, so floor both here.
  left = Math.max(margin, left);
  top = Math.max(margin, top);
  return { left, top };
}

/// Initial X anchor for a trigger-opened menu. Menus on the normal
/// right-side chrome align their right edge to the trigger. When
/// Hybrid is flipped, the trigger sits on the left edge, so aligning
/// right would start the first frame off-screen before the clamp
/// refinement runs. In that case, open to the right of the trigger.
export function triggerMenuX(
  trigger: Pick<DOMRect, "left" | "right">,
  menuWidth: number,
  margin = 8,
): number {
  const alignRight = trigger.right - menuWidth;
  if (alignRight < margin) return trigger.left;
  return alignRight;
}

/// Svelte action: place the element near (x, y), clamping into the
/// viewport using the element's ACTUAL rendered size. Re-runs when
/// the params change so the menu re-clamps if the caller moves it.
/// Sets `position: fixed` plus left / top inline styles; the caller
/// only needs to add styling.
export function clampMenu(
  node: HTMLElement,
  params: ClampOpts,
): { update(p: ClampOpts): void } {
  let current = params;
  function place(): void {
    // Make the element measurable without paint-flicker. The caller
    // pre-renders it with position:fixed; we just measure + adjust.
    const r = node.getBoundingClientRect();
    const { left, top } = clampToViewport(r.width, r.height, current);
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }
  // Pre-set so the first paint lands near the target; the rAF then
  // refines using the measured size.
  node.style.position = "fixed";
  node.style.left = `${current.x}px`;
  node.style.top = `${current.y}px`;
  requestAnimationFrame(place);
  return {
    update(p: ClampOpts): void {
      current = p;
      requestAnimationFrame(place);
    },
  };
}
