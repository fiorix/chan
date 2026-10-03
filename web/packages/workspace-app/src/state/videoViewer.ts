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

import { fileUrl } from "../api/client";
import { openViewerOverlay } from "./viewerOverlay";

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
  const src = fileUrl(path);

  const video = document.createElement("video");
  video.controls = true;
  video.autoplay = true;
  video.src = src;
  video.style.cssText =
    "max-width:92vw;max-height:92vh;" +
    "background:#000;box-shadow:0 8px 32px rgba(0,0,0,0.5);" +
    "border-radius:4px;outline:none;";

  openViewerOverlay({
    className: "md-video-viewer",
    layout: "display:flex;align-items:center;justify-content:center;",
    surface: [video],
    // Clicks on the empty backdrop (outside the video surface) dismiss,
    // matching imageZoom; clicks on the video hit its controls instead.
    dismissOnBackdropClick: true,
    teardown: () => {
      // Detach the source before removal so the browser tears the
      // stream down immediately instead of buffering to a dead node.
      video.pause();
      video.removeAttribute("src");
      video.load();
    },
  });
}
