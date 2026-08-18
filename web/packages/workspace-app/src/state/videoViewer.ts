// Fullscreen video viewer. Mirror of `pdfViewer.ts` for video-kind
// media. A dedicated `<video controls>` surface rather than the
// imageZoom overlay: video wants play/pause/scrub/fullscreen, not
// pinch-zoom, and the browser's native controls provide all of it
// with no JS bundle cost. Seeking works because `/api/fs` serves
// these paths with `Accept-Ranges` + 206.
//
// Styles are applied inline so the helper is self-contained
// (same rationale as `imageZoom.ts` / `pdfViewer.ts`): no dependency
// on a :global() block that could disappear during a refactor.

import { withTokenQuery } from "../api/transport";

/// Open the fullscreen viewer.
///
///   path  Workspace-rooted path. The video bytes come from
///         `/api/fs/<path>`; the bearer token rides as a query
///         param via `withTokenQuery` because `<video>` can't carry
///         a custom Authorization header. Same trick the inline
///         image preview uses.
///
/// No-op on empty path.
export function openVideoViewer(path: string): void {
  if (!path) return;
  const src = withTokenQuery(
    `/api/fs/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
  );

  const backdrop = document.createElement("div");
  backdrop.className = "md-video-viewer";
  backdrop.style.cssText =
    "position:fixed;inset:0;z-index:40000;" +
    "background:rgba(0,0,0,0.92);" +
    "display:flex;align-items:center;justify-content:center;";

  // Explicit close button, same rationale as the PDF viewer: the
  // media surface swallows clicks (controls, scrubber), so backdrop
  // dismissal alone would need precise edge clicks.
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.title = "Close (Esc)";
  close.style.cssText =
    "position:absolute;top:1rem;right:1rem;z-index:1;" +
    "background:rgba(255,255,255,0.9);color:#000;" +
    "border:0;border-radius:4px;padding:4px 10px;cursor:pointer;" +
    "font:600 13px system-ui,sans-serif;";

  const video = document.createElement("video");
  video.controls = true;
  video.autoplay = true;
  video.src = src;
  video.style.cssText =
    "max-width:92vw;max-height:92vh;" +
    "background:#000;box-shadow:0 8px 32px rgba(0,0,0,0.5);" +
    "border-radius:4px;outline:none;";

  backdrop.appendChild(video);
  backdrop.appendChild(close);
  document.body.appendChild(backdrop);

  const dismiss = (): void => {
    document.removeEventListener("keydown", onKey, true);
    // Detach the source before removal so the browser tears the
    // stream down immediately instead of buffering to a dead node.
    video.pause();
    video.removeAttribute("src");
    video.load();
    backdrop.remove();
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      dismiss();
    }
  };
  close.addEventListener("click", (ev) => {
    ev.stopPropagation();
    dismiss();
  });
  // Clicks on the empty backdrop (outside the video surface) dismiss,
  // matching imageZoom; clicks on the video hit its controls instead.
  backdrop.addEventListener("click", (ev) => {
    if (ev.target === backdrop) dismiss();
  });
  document.addEventListener("keydown", onKey, true);
}
