// Fullscreen pan/zoom viewer for a rendered diagram (a mermaid SVG).
// Imperative DOM helper, self-contained with inline styles, mirroring
// imageZoom.ts's backdrop/Escape scaffolding so the two viewers feel of
// a piece. The diagram mounts on a light panel inside the layer. Zoom
// (wheel + on-screen buttons + keyboard +/-/=, 0) resizes the SVG so the
// browser re-rasterizes the vector crisply at each level; pan (drag +
// arrows/WASD) rides on a layer translate. Escape or a plain backdrop
// click dismisses; the overlay cleans itself up.

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.2; // per button press / keypress
// Four wheel notches cover one button/key step. Using the fourth root keeps
// zoom-in and zoom-out reciprocal while making wheel zoom exactly 4x gentler.
const WHEEL_ZOOM_STEP = ZOOM_STEP ** 0.25;
const PAN_STEP = 48; // px per arrow / WASD press

/// Open the diagram viewer for a rendered SVG string (mermaid's already
/// sanitized render output). Expects a LIGHT-themed render: the viewer
/// presents it on a light panel regardless of the editor's theme. No-op on
/// empty input.
export function openDiagramZoom(svg: string): void {
  if (!svg) return;

  const backdrop = document.createElement("div");
  backdrop.className = "md-diagram-zoom";
  backdrop.style.cssText =
    "position:fixed;inset:0;z-index:40000;overflow:hidden;" +
    "background:rgba(0,0,0,0.92);cursor:grab;";

  // The layer is anchored at the backdrop centre (top/left 50%); the -50%
  // in the transform recentres it on its own box, and the pan translate
  // rides on top. It grows with the SVG, so the recentre keeps it on the
  // backdrop centre at every zoom level. No will-change here: a promoted
  // compositor layer rasterizes once into a texture (and can sit below
  // device resolution on HiDPI), the very softness this viewer avoids;
  // will-change is added only during a drag, for smooth panning.
  const layer = document.createElement("div");
  layer.className = "md-diagram-zoom-layer";
  layer.style.cssText = "position:absolute;top:50%;left:50%;";
  // Back the diagram with a light neutral panel: the viewer is handed a
  // light-themed render, whose pale strokes and text would vanish on the
  // dim backdrop. The panel is the content surface; the backdrop stays
  // dark. padding gives the diagram breathing room inside the surface.
  const panel = document.createElement("div");
  panel.className = "md-diagram-zoom-panel";
  panel.style.cssText =
    "background:#fff;border-radius:12px;padding:24px;box-sizing:border-box;" +
    "box-shadow:0 10px 48px rgba(0,0,0,0.5);";
  panel.innerHTML = svg;
  const svgEl = panel.querySelector("svg");
  // The zoom scale multiplies this base (scale 1) width; it is captured from
  // the fitted layout after insertion, falling back to the viewBox width
  // when layout is unavailable (jsdom under test).
  let baseWidth = 0;
  let vbWidth = NaN;
  if (svgEl) {
    svgEl.style.display = "block";
    svgEl.style.maxWidth = "calc(90vw - 48px)";
    svgEl.style.maxHeight = "calc(90vh - 48px)";
    // mermaid emits width="100%" and NO height, so `width:auto` collapses
    // the SVG to 0x0 inside the shrink-to-fit panel (which then shrinks to
    // just its padding). Give it an intrinsic pixel width from the viewBox
    // so it renders; height auto keeps the aspect ratio and the max-w/h caps
    // fit it to the viewport. That fitted size is what the viewer measures
    // below for its base width. An excalidraw export carries its own pixel
    // dimensions (its width is the viewBox width times its export scale), but
    // reading the viewBox width here opens the overlay at full size and
    // sharpness regardless of that scale; a viewBox-less SVG falls through to
    // auto.
    const viewBox = svgEl.getAttribute("viewBox");
    vbWidth = viewBox ? Number(viewBox.split(/[\s,]+/)[2]) : NaN;
    if (Number.isFinite(vbWidth) && vbWidth > 0) {
      svgEl.style.width = `${vbWidth}px`;
      svgEl.style.height = "auto";
    } else {
      svgEl.style.width = "auto";
      svgEl.style.height = "auto";
    }
  }
  layer.appendChild(panel);
  backdrop.appendChild(layer);

  let scale = 1;
  let tx = 0;
  let ty = 0;
  // Zoom resizes the SVG (the browser re-rasterizes the vector crisply at
  // the new size); pan stays a layer translate (translate never blurs).
  const apply = (): void => {
    if (svgEl && baseWidth > 0) svgEl.style.width = `${baseWidth * scale}px`;
    layer.style.transform =
      `translate(-50%, -50%) translate(${tx}px, ${ty}px)`;
  };
  const clamp = (s: number): number =>
    Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  const zoom = (factor: number): void => {
    scale = clamp(scale * factor);
    apply();
  };
  const pan = (dx: number, dy: number): void => {
    tx += dx;
    ty += dy;
    apply();
  };
  const reset = (): void => {
    scale = 1;
    tx = 0;
    ty = 0;
    apply();
  };

  // Wheel zoom toward the pointer: keep the point under the cursor fixed.
  // The layer's box centre is (viewport centre + pan), which the resize
  // leaves put (the -50% recentres the grown box), and the content scales by
  // next/scale about that centre, so the transform model's anchor shift
  // still holds: nudge the pan by the cursor offset times the size delta.
  backdrop.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = layer.getBoundingClientRect();
      const px = e.clientX - (rect.left + rect.width / 2);
      const py = e.clientY - (rect.top + rect.height / 2);
      const next = clamp(
        scale * (e.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP),
      );
      const ratio = next / scale;
      tx -= px * (ratio - 1);
      ty -= py * (ratio - 1);
      scale = next;
      apply();
    },
    { passive: false },
  );

  // Drag to pan. `moved` tells a pan-drag apart from a click-to-close.
  let dragging = false;
  let moved = false;
  let lastX = 0;
  let lastY = 0;
  const onMove = (e: MouseEvent): void => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
    lastX = e.clientX;
    lastY = e.clientY;
    pan(dx, dy);
  };
  const onUp = (): void => {
    dragging = false;
    backdrop.style.cursor = "grab";
    // Drop the compositor promotion so the static frame paints at full
    // device resolution, not from the drag texture.
    layer.style.willChange = "auto";
  };
  backdrop.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    lastX = e.clientX;
    lastY = e.clientY;
    backdrop.style.cursor = "grabbing";
    // Promote to a compositor layer for the drag so the pan translate stays
    // smooth; onUp drops it back to a crisp static paint.
    layer.style.willChange = "transform";
  });
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("mouseup", onUp, true);

  const controls = document.createElement("div");
  controls.className = "md-diagram-zoom-controls";
  controls.style.cssText =
    "position:fixed;bottom:18px;left:50%;transform:translateX(-50%);" +
    "display:flex;gap:8px;";
  controls.append(
    ctrlButton("−", "Zoom out", () => zoom(1 / ZOOM_STEP)),
    ctrlButton("Reset", "Reset view", reset),
    ctrlButton("+", "Zoom in", () => zoom(ZOOM_STEP)),
  );
  backdrop.appendChild(controls);

  const dismiss = (): void => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mouseup", onUp, true);
    backdrop.remove();
  };
  // Shortcuts are captured on the document so none leak to the editor's
  // keymap while the overlay is open.
  const onKey = (e: KeyboardEvent): void => {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        dismiss();
        break;
      case "+":
      case "=":
        e.preventDefault();
        zoom(ZOOM_STEP);
        break;
      case "-":
        e.preventDefault();
        zoom(1 / ZOOM_STEP);
        break;
      case "0":
        e.preventDefault();
        reset();
        break;
      case "ArrowLeft":
      case "a":
      case "A":
        e.preventDefault();
        pan(PAN_STEP, 0);
        break;
      case "ArrowRight":
      case "d":
      case "D":
        e.preventDefault();
        pan(-PAN_STEP, 0);
        break;
      case "ArrowUp":
      case "w":
      case "W":
        e.preventDefault();
        pan(0, PAN_STEP);
        break;
      case "ArrowDown":
      case "s":
      case "S":
        e.preventDefault();
        pan(0, -PAN_STEP);
        break;
    }
  };
  // A click on the empty backdrop dismisses; a release that ended a
  // pan-drag does not.
  backdrop.addEventListener("click", (e) => {
    if (moved) {
      moved = false;
      return;
    }
    if (e.target === backdrop || e.target === layer) dismiss();
  });

  document.body.appendChild(backdrop);
  // With the overlay laid out, capture the SVG's fitted width and pin the
  // SVG to explicit pixels: zoom then re-rasterizes the vector at each size
  // rather than GPU-stretching a cached texture. Dropping the fit caps lets
  // the SVG grow past the viewport under zoom; pan reaches the rest. Fall
  // back to the viewBox width when layout is unavailable (jsdom under test).
  if (svgEl) {
    const fitted = svgEl.getBoundingClientRect().width;
    if (fitted > 0) {
      baseWidth = fitted;
    } else if (Number.isFinite(vbWidth) && vbWidth > 0) {
      baseWidth = vbWidth;
    }
    svgEl.style.maxWidth = "none";
    svgEl.style.maxHeight = "none";
  }
  apply();
  document.addEventListener("keydown", onKey, true);
}

function ctrlButton(
  glyph: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "md-diagram-zoom-btn";
  btn.setAttribute("aria-label", label);
  btn.textContent = glyph;
  btn.style.cssText =
    "min-width:34px;height:34px;padding:0 10px;border:none;" +
    "border-radius:8px;background:rgba(255,255,255,0.16);color:#fff;" +
    "cursor:pointer;font:14px/1 ui-monospace,Menlo,monospace;";
  // Don't start a backdrop pan-drag (or a dismiss) from the button.
  btn.addEventListener("mousedown", (e) => e.stopPropagation());
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return btn;
}
