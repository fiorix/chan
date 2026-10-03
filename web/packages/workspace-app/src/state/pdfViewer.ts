// Fullscreen PDF viewer. Mirror of `imageZoom.ts` for
// media-kind PDFs. Uses an `<embed>` tag
// so the browser's built-in PDF viewer (Chrome's PDFium, Firefox's
// pdf.js, Safari) renders the document with no JS bundle cost.
// pdfjs-dist as a fallback is tracked as a follow-up if a browser
// without a native viewer ever needs it.
//
// Styles are applied inline so the helper is self-contained
// (same rationale as `imageZoom.ts`): no dependency on a
// :global() block that could disappear during a refactor.

import { fileUrl } from "../api/client";
import { openViewerOverlay } from "./viewerOverlay";

/// Open the fullscreen viewer.
///
///   path  Workspace-rooted path. The PDF bytes come from
///         `/api/fs/<path>`; the bearer token rides as a query
///         param via `withTokenQuery` because `<embed>` can't carry
///         a custom Authorization header. Same trick the inline
///         image preview uses.
///
/// No-op on empty path.
export function openPdfViewer(path: string): void {
  if (!path) return;
  const src = fileUrl(path);

  // The PDF surface itself. `<embed type="application/pdf">` is
  // what hooks into Chrome/Firefox/Safari's native viewer; `<iframe>`
  // would work too but `<embed>` is the canonical tag.
  const embed = document.createElement("embed");
  embed.type = "application/pdf";
  embed.src = src;
  embed.style.cssText =
    "width:92vw;height:92vh;" +
    "background:#fff;box-shadow:0 8px 32px rgba(0,0,0,0.5);" +
    "border-radius:4px;";

  // No dismissal by a backdrop click: the document covers the backdrop, so
  // the trick from imageZoom would need precise edge clicks.
  openViewerOverlay({
    className: "md-pdf-viewer",
    layout: "display:flex;align-items:center;justify-content:center;",
    surface: [embed],
  });
}
