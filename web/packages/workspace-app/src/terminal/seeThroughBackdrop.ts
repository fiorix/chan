// See-through terminal backdrop.
//
// Below 100% terminal opacity in a transparent window only the terminals are
// see-through: the workspace backdrop (the gutters, the frames around panes
// and splits) keeps painting everywhere else. CSS cannot erase a parent's
// background under a child, so the backdrop is a layer of its own (`main`'s
// `::before`), masked by an image with a hole behind each pane showing a
// terminal. This module builds that mask and keeps it in step with the pane
// layout; the layer reads it from `--see-through-mask`.

/// The CSS custom property carrying the backdrop mask.
export const SEE_THROUGH_MASK_VAR = "--see-through-mask";

/// The corner radii of a hole, clockwise from the top-left corner. A pane
/// squares the corners it has on the window's edge, so they differ.
export type CornerRadii = [topLeft: number, topRight: number, bottomRight: number, bottomLeft: number];

/// A hole in the backdrop, in px relative to the backdrop's top-left corner.
export type BackdropHole = { x: number; y: number; width: number; height: number; radii: CornerRadii };

/// Rounded to a tenth of a pixel: enough for a crisp edge at any zoom, and a
/// stable string so an unchanged layout yields an identical mask.
function px(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function holePath({ x, y, width, height, radii }: BackdropHole): string {
  const clamp = (radius: number): number => Math.max(0, Math.min(radius, width / 2, height / 2));
  const tl = clamp(radii[0]);
  const tr = clamp(radii[1]);
  const br = clamp(radii[2]);
  const bl = clamp(radii[3]);
  const right = x + width;
  const bottom = y + height;
  // A square corner is the point the two sides meet at, with no arc.
  const arc = (r: number, toX: number, toY: number): string =>
    r === 0 ? "" : `A${px(r)} ${px(r)} 0 0 1 ${px(toX)} ${px(toY)}`;
  return (
    `M${px(x + tl)} ${px(y)}H${px(right - tr)}${arc(tr, right, y + tr)}` +
    `V${px(bottom - br)}${arc(br, right - br, bottom)}` +
    `H${px(x + bl)}${arc(bl, x, bottom - bl)}` +
    // The path's close draws the left side of a square top-left corner.
    (tl === 0 ? "" : `V${px(y + tl)}${arc(tl, x + tl, y)}`) +
    "Z"
  );
}

/// The mask for a backdrop of `width` x `height` px: opaque everywhere but
/// the holes. An SVG data URL, one even-odd path, so the holes cut out of the
/// full rectangle.
export function backdropMask(width: number, height: number, holes: BackdropHole[]): string {
  const d = [`M0 0H${px(width)}V${px(height)}H0Z`, ...holes.map(holePath)].join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px(width)}" height="${px(height)}" ` +
    `viewBox="0 0 ${px(width)} ${px(height)}" preserveAspectRatio="none">` +
    `<path fill-rule="evenodd" d="${d}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/// The holes for `backdrop`: one per pane card face showing a terminal, with
/// the face's own corner radii. A pane mid side flip gets no hole: the card
/// turns under a transform the rect does not follow, so a hole cut for its
/// resting rect would show the desktop around the turning card; the flip's
/// end drops the class, and that mutation rebuilds the mask with the hole.
export function terminalHoles(backdrop: HTMLElement): BackdropHole[] {
  const origin = backdrop.getBoundingClientRect();
  const holes: BackdropHole[] = [];
  for (const face of backdrop.querySelectorAll<HTMLElement>(".pane-card-face")) {
    if (!face.querySelector(".terminal-tab.active")) continue;
    if (face.closest(".pane.sideFlipActive")) continue;
    const rect = face.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const style = getComputedStyle(face);
    holes.push({
      x: rect.left - origin.left,
      y: rect.top - origin.top,
      width: rect.width,
      height: rect.height,
      radii: [
        Number.parseFloat(style.borderTopLeftRadius) || 0,
        Number.parseFloat(style.borderTopRightRadius) || 0,
        Number.parseFloat(style.borderBottomRightRadius) || 0,
        Number.parseFloat(style.borderBottomLeftRadius) || 0,
      ],
    });
  }
  return holes;
}

/// Keep `backdrop`'s mask in step with its panes until the returned cleanup
/// runs. Recomputes once per frame at most, on a resize of the backdrop or a
/// pane face, and on a structural change (a pane or tab added, removed or
/// switched); changes inside a terminal's renderer are ignored.
export function installSeeThroughBackdrop(backdrop: HTMLElement): () => void {
  let frame = 0;
  let last = "";
  const faces = new Set<Element>();

  const resize = new ResizeObserver(() => schedule());
  resize.observe(backdrop);

  function update(): void {
    frame = 0;
    for (const face of backdrop.querySelectorAll(".pane-card-face")) {
      if (faces.has(face)) continue;
      faces.add(face);
      resize.observe(face);
    }
    for (const face of faces) {
      if (face.isConnected) continue;
      faces.delete(face);
      resize.unobserve(face);
    }
    const origin = backdrop.getBoundingClientRect();
    const mask = backdropMask(origin.width, origin.height, terminalHoles(backdrop));
    if (mask === last) return;
    last = mask;
    backdrop.style.setProperty(SEE_THROUGH_MASK_VAR, mask);
  }

  function schedule(): void {
    if (frame === 0) frame = requestAnimationFrame(update);
  }

  const mutations = new MutationObserver((records) => {
    if (records.some((record) => !(record.target as Element).closest?.(".terminal-host"))) {
      schedule();
    }
  });
  mutations.observe(backdrop, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class"],
  });

  update();
  return () => {
    if (frame !== 0) cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
    backdrop.style.removeProperty(SEE_THROUGH_MASK_VAR);
  };
}
