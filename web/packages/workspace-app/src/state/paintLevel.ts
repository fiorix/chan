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
