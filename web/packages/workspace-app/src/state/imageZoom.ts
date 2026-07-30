// Fullscreen image viewer. Imperative DOM helper so any surface
// (editor zoom button, inspector image entries, file browser) can open
// the same overlay. Click the backdrop or press Escape to dismiss; the
// overlay cleans itself up.
//
// With a `set` of sibling images the viewer also shows prev/next
// controls (and ArrowLeft/Right keys) so the user can page through the
// set without leaving the overlay. The set is the editor document's
// images (in document order) or the file browser directory's images (in
// tree order); the caller decides. A single-image open keeps the old
// no-controls behaviour.
//
// Styles are applied inline so the helper is self-contained - the
// previous "CSS lives in Wysiwyg.svelte" arrangement broke during the
// CM6 cutover when the `:global(.md-image-zoom)` block was dropped.

import { resolveImageSrc } from "../editor/extensions/image";

export interface ZoomImage {
  /// Markdown-style image src (workspace-rooted, source-relative, or a
  /// URL).
  src: string;
  /// Document the src was authored in, for resolving source-relative
  /// refs. null when src is already workspace-rooted.
  fromPath: string | null;
}

/// Open the fullscreen viewer.
///
///   src       The image to show first (see ZoomImage.src).
///   fromPath  Resolution base for `src` (see ZoomImage.fromPath).
///   set       Optional ordered sibling set INCLUDING the opened image.
///             When given (and it resolves to >1 image) the viewer shows
///             prev/next controls + arrow-key nav, wrapping at the ends.
///
/// No-op when the opened src is empty / unresolvable.
export function openImageZoom(
  src: string,
  fromPath: string | null = null,
  set?: ZoomImage[],
): void {
  if (!src) return;

  // Resolve the set up front, dropping anything that won't load, and
  // find where the opened image sits in the survivors.
  const source: ZoomImage[] = set && set.length > 0 ? set : [{ src, fromPath }];
  const items = source
    .map((it) => ({ ...it, url: resolveImageSrc(it.src, it.fromPath) }))
    .filter((it): it is ZoomImage & { url: string } => !!it.url);
  if (items.length === 0) return;
  let index = items.findIndex(
    (it) => it.src === src && it.fromPath === fromPath,
  );
  if (index < 0) index = 0;

  const backdrop = document.createElement("div");
  backdrop.className = "md-image-zoom";
  backdrop.style.cssText =
    "position:fixed;inset:0;z-index:40000;" +
    "background:rgba(0,0,0,0.92);" +
    "display:flex;align-items:center;justify-content:center;" +
    "cursor:zoom-out;";

  const img = document.createElement("img");
  img.alt = "";
  img.draggable = false;
  img.style.cssText =
    "max-width:92vw;max-height:92vh;width:auto;height:auto;" +
    "object-fit:contain;box-shadow:0 8px 32px rgba(0,0,0,0.5);";
  backdrop.appendChild(img);

  const multi = items.length > 1;
  let counter: HTMLElement | null = null;
  const show = (): void => {
    img.src = items[index]!.url;
    if (counter) counter.textContent = `${index + 1} / ${items.length}`;
  };

  const step = (delta: number): void => {
    // Wrap at the ends so neither button ever dead-ends.
    index = (index + delta + items.length) % items.length;
    show();
  };

  if (multi) {
    backdrop.appendChild(navButton("prev", "‹", () => step(-1)));
    backdrop.appendChild(navButton("next", "›", () => step(1)));
    counter = document.createElement("div");
    counter.className = "md-image-zoom-counter";
    counter.style.cssText =
      "position:fixed;bottom:18px;left:50%;transform:translateX(-50%);" +
      "color:#ddd;font:13px/1.4 ui-monospace,Menlo,monospace;" +
      "background:rgba(0,0,0,0.5);padding:2px 10px;border-radius:10px;" +
      "pointer-events:none;";
    backdrop.appendChild(counter);
  }
  show();
  // Mount inside the fullscreen element when one is active: the slide
  // player element-fullscreens its backdrop on the web, and the browser
  // top layer hides body-appended siblings, so a body mount would open
  // this viewer invisibly behind the presentation.
  (document.fullscreenElement ?? document.body).appendChild(backdrop);

  const dismiss = (): void => {
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      dismiss();
    } else if (multi && ev.key === "ArrowRight") {
      ev.preventDefault();
      step(1);
    } else if (multi && ev.key === "ArrowLeft") {
      ev.preventDefault();
      step(-1);
    }
  };
  // Stop at the viewer boundary: under the slide player's web
  // fullscreen this backdrop is a CHILD of the slide backdrop, whose
  // own click handler dismisses the presentation - a click meant for
  // this viewer must not fall through and close both.
  backdrop.addEventListener("click", (e) => {
    e.stopPropagation();
    dismiss();
  });
  document.addEventListener("keydown", onKey, true);
}

function navButton(
  kind: "prev" | "next",
  glyph: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `md-image-zoom-nav md-image-zoom-${kind}`;
  btn.setAttribute("aria-label", kind === "prev" ? "Previous image" : "Next image");
  btn.textContent = glyph;
  const side = kind === "prev" ? "left:12px;" : "right:12px;";
  btn.style.cssText =
    "position:fixed;top:50%;transform:translateY(-50%);" +
    side +
    "width:48px;height:64px;border:none;border-radius:8px;" +
    "background:rgba(0,0,0,0.45);color:#fff;cursor:pointer;" +
    "font-size:34px;line-height:1;display:flex;align-items:center;" +
    "justify-content:center;";
  // Stop the click from bubbling to the backdrop (which dismisses).
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return btn;
}
