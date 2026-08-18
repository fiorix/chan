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

import { withTokenQuery } from "../api/transport";

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
  const src = withTokenQuery(
    `/api/fs/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
  );

  const backdrop = document.createElement("div");
  backdrop.className = "md-pdf-viewer";
  backdrop.style.cssText =
    "position:fixed;inset:0;z-index:40000;" +
    "background:rgba(0,0,0,0.92);" +
    "display:flex;align-items:center;justify-content:center;";

  // Close button. PDFs cover the backdrop, so the "click backdrop
  // to dismiss" trick from imageZoom would need precise edge
  // clicks. An explicit close button keeps the dismissal obvious.
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.title = "Close (Esc)";
  close.style.cssText =
    "position:absolute;top:1rem;right:1rem;z-index:1;" +
    "background:rgba(255,255,255,0.9);color:#000;" +
    "border:0;border-radius:4px;padding:4px 10px;cursor:pointer;" +
    "font:600 13px system-ui,sans-serif;";

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

  backdrop.appendChild(embed);
  backdrop.appendChild(close);
  document.body.appendChild(backdrop);

  const dismiss = (): void => {
    document.removeEventListener("keydown", onKey, true);
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
  document.addEventListener("keydown", onKey, true);
}
