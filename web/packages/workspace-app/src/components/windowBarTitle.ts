// Where the window tab bar's title sits, and how it gets there.
//
// The title is one element. With no tabs in the window it stays where the
// bar renders it, after the pane tree button. With tabs it moves to the bar's
// end: into the element the strip in the bar offers, left of the strip's
// actions, or, when no strip shows there, into the bar's own end place. A
// change of place slides the title from where it was to where it now is, by
// playing back the distance between the two as a transform that eases to
// none, so the layout itself changes at once and nothing else moves with it.

import type { Attachment } from "svelte/attachments";
import { portalTo } from "./portal";

export type WindowTitlePlace = "start" | "end";

/// Marks the bar's own end place for the title.
export const WINDOW_TITLE_END_ATTR = "data-window-title-end";

const SLIDE_EASING = "cubic-bezier(0.2, 0, 0, 1)";

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/// Build the title element's attachment for one bar. The attachment runs
/// again whenever the place or the strip's element changes, and remembers
/// across runs where the title last was. `slideMs` of 0 cuts.
export function windowTitleMover(): (
  place: WindowTitlePlace,
  slot: HTMLElement | null,
  slideMs: number,
) => Attachment<HTMLElement> {
  let last: { place: WindowTitlePlace; left: number; width: number } | null = null;
  return (place, slot, slideMs) => (node) => {
    const target =
      place === "end"
        ? (slot ?? node.parentElement?.querySelector<HTMLElement>(`[${WINDOW_TITLE_END_ATTR}]`) ?? null)
        : null;
    const restore = portalTo(target)(node);
    // Only a change of place slides: the same place in another pane's strip
    // is a cut.
    if (last && last.place !== place && slideMs > 0) slide(node, last, slideMs);
    return () => {
      const at = node.getBoundingClientRect();
      last = { place, left: at.left, width: at.width };
      if (typeof restore === "function") restore();
    };
  };
}

function slide(node: HTMLElement, from: { left: number; width: number }, ms: number): void {
  if (typeof node.animate !== "function" || reducedMotion()) return;
  const to = node.getBoundingClientRect();
  // A title that was not drawn, or is not now, has nowhere to slide from or to.
  if (from.width === 0 || to.width === 0) return;
  const dx = from.left - to.left;
  if (Math.abs(dx) < 1) return;
  node.animate([{ transform: `translateX(${dx}px)` }, { transform: "translateX(0)" }], {
    duration: ms,
    easing: SLIDE_EASING,
  });
}
