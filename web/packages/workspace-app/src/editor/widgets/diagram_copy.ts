// Copy-to-clipboard for rendered diagram faces: fenced mermaid /
// mermaid-to-excalidraw blocks (diagram.ts) and inline `.excalidraw`
// embeds (image.ts). The payload is a PNG rasterized client-side from the
// rendered SVG markup. PNG is rasterized and written as an image; SVG is
// copied as vector markup (the portable representation supported by both
// the desktop text clipboard and browsers). Both ride
// `writeClipboardPayload`, which owns the desktop/web fork.

import { writeClipboardPayload } from "../../api/clipboard";

/// Lucide Copy + Check icons inlined as SVG strings - the diagram and
/// image widgets are raw DOM, not Svelte, so they can't reuse
/// lucide-svelte components. Compact 12px icons with stroke weights tuned
/// for the widgets' small action rows.
export const COPY_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
export const CHECK_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

export type DiagramCopyFormat = "svg" | "png";

/// Largest rasterized diagram we will draw to a canvas, mirroring the
/// paste-side `MAX_IMAGE_PIXELS` bound in api/clipboard.ts: a pathological
/// diagram must not allocate an unbounded `width*height*4` canvas.
const MAX_DIAGRAM_PIXELS = 64 * 1024 * 1024;

/// Decode SVG markup into an `<img>` via a `data:` URL (the GraphCanvas
/// icon technique; a data URL needs no revoke bookkeeping). An `<img>`-
/// hosted SVG loads no external resources, which is fine here: both
/// renderers inline their styles into the markup.
function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  const img = new Image();
  const loaded = new Promise<HTMLImageElement>((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("SVG decode failed"));
  });
  img.src = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  return loaded;
}

/// Pixel size to rasterize at. The viewBox is authoritative for diagram
/// SVGs (mermaid emits a percentage width attribute, whose `<img>`
/// intrinsic size is unreliable); the decoded intrinsic size is the
/// fallback for markup without one.
function svgPixelSize(
  svg: string,
  img: HTMLImageElement,
): { width: number; height: number } | null {
  const viewBox =
    /viewBox\s*=\s*["']\s*[\d.eE+-]+[\s,]+[\d.eE+-]+[\s,]+([\d.eE+-]+)[\s,]+([\d.eE+-]+)/.exec(
      svg,
    );
  if (viewBox) {
    const width = Number(viewBox[1]);
    const height = Number(viewBox[2]);
    if (width > 0 && height > 0) return { width, height };
  }
  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
    return { width: img.naturalWidth, height: img.naturalHeight };
  }
  return null;
}

/// Rasterize rendered-diagram SVG markup to PNG bytes.
export async function svgToPngBytes(svg: string): Promise<Uint8Array> {
  const img = await loadSvgImage(svg);
  const size = svgPixelSize(svg, img);
  if (!size) throw new Error("diagram has no measurable size");
  if (size.width * size.height > MAX_DIAGRAM_PIXELS) {
    throw new Error("diagram too large to copy to the clipboard");
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(size.width);
  canvas.height = Math.ceil(size.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas context");
  // White ground: the SVG carries no page behind it, and a transparent
  // PNG pastes illegibly into targets that composite on dark.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/png",
    );
  });
  return new Uint8Array(await blob.arrayBuffer());
}

/// Rasterize + write to the clipboard.
export async function copyDiagramPng(svg: string): Promise<void> {
  await writeClipboardPayload("image/png", await svgToPngBytes(svg));
}

/// Copy the vector markup itself. System clipboards do not have a portable
/// SVG-image representation (and arboard's image path is raster-only), so
/// text is the lossless cross-surface form: it can be pasted into an `.svg`
/// file or any editor without silently turning it back into a bitmap.
export async function copyDiagramSvg(svg: string): Promise<void> {
  await writeClipboardPayload(
    "text/plain;charset=utf-8",
    new TextEncoder().encode(svg),
  );
}

/// One format-labelled copy button for a rendered diagram face. Starts hidden;
/// the caller reveals it (`style.display = ""`) once a render succeeds -
/// the same gating as the View button, so an errored diagram is never
/// offered. `svg` resolves the markup to rasterize at click time (a dark
/// editor re-renders the light face there, matching View's discipline:
/// the dark render's pale strokes are illegible on most paste targets).
/// Transient Check feedback on success; failure surfaces briefly via the
/// title attr - there is no toast surface to land it in.
export function diagramCopyButton(
  className: string,
  svg: () => Promise<string | null> | string | null,
  format: DiagramCopyFormat = "png",
  showFormat = false,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  const label = format.toUpperCase();
  btn.title =
    format === "svg"
      ? "copy SVG markup to clipboard"
      : "copy PNG image to clipboard";
  btn.setAttribute("aria-label", btn.title);
  const showIdle = () => {
    if (showFormat) btn.textContent = label;
    else btn.innerHTML = COPY_ICON_SVG;
  };
  showIdle();
  btn.style.display = "none";
  // Swallow the press so copying never drops the caret into the source
  // (which would de-render a diagram block); the action runs on click,
  // like the diagram View button.
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void Promise.resolve(svg())
      .then((markup) => {
        if (!markup) throw new Error("no rendered diagram");
        return format === "svg"
          ? copyDiagramSvg(markup)
          : copyDiagramPng(markup);
      })
      .then(
        () => {
          btn.innerHTML = CHECK_ICON_SVG;
          setTimeout(() => {
            showIdle();
          }, 1200);
        },
        () => {
          const prev = btn.title;
          btn.title = "copy failed";
          setTimeout(() => {
            btn.title = prev;
          }, 1200);
        },
      );
  });
  return btn;
}
