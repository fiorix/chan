/// How high an element paints: the largest z-index on it or an ancestor.
/// The surfaces that rank by paint, the keyboard's owners and the covers
/// over the window, are fixed layers with their own z-index, so this orders
/// two of them, such as a dialog shown over another or the screen lock over
/// the reconnect cover.
export function paintLevel(element: Element): number {
  let level = 0;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const z = Number.parseInt(getComputedStyle(node).zIndex, 10);
    if (Number.isFinite(z) && z > level) level = z;
  }
  return level;
}

/// The attribute each cover puts on its root element, carrying its own name
/// from `FULL_WINDOW_COVERS`. The window key guard reads it to tell a key
/// typed into a cover's own text field (the lock's PIN) from one aimed at the
/// app behind the cover, and the parity test looks for it on every raised
/// cover, so a cover that forgets it is caught there rather than found as a
/// field that takes no typing.
export const COVER_ROOT_ATTR = "data-cover";

/// Whether a full-window cover paints over `element`. A cover's root is in the
/// page only while it shows. The surfaces that are not the keyboard's owners
/// (a viewer, an editor popover, an image's selection ring) listen on the
/// document whatever has focus, so each asks this before it answers a key or
/// takes focus: what a cover hides takes neither. A cover at the element's own
/// level counts as over it, as the keyboard's owner ranks the two, and no
/// cover is over what is inside it. This reads the page, so those modules
/// need not import the store.
export function coverPaintsOver(element: Element): boolean {
  // Asked on every key: with no cover up, no style is read.
  const covers = document.querySelectorAll(`[${COVER_ROOT_ATTR}]`);
  if (covers.length === 0) return false;
  const level = paintLevel(element);
  for (const root of covers) {
    if (!root.contains(element) && paintLevel(root) >= level) return true;
  }
  return false;
}
