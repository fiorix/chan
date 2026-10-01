// The fullscreen overlay a media viewer (PDF, video, audio) opens over the
// page: a dark backdrop that holds the viewer's surface, a Close button, and
// the Escape key.
//
// Styles are applied inline so the helper is self-contained: no dependency
// on a :global() block that could disappear during a refactor.

import { consumeKey } from "./shortcuts";

const BACKDROP_STYLE = "position:fixed;inset:0;z-index:40000;" + "background:rgba(0,0,0,0.92);";

const CLOSE_STYLE =
  "position:absolute;top:1rem;right:1rem;z-index:1;" +
  "background:rgba(255,255,255,0.9);color:#000;" +
  "border:0;border-radius:4px;padding:4px 10px;cursor:pointer;" +
  "font:600 13px system-ui,sans-serif;";

export interface ViewerOverlayOptions {
  /// The backdrop's class name.
  className: string;
  /// The backdrop's layout declarations, appended to the fixed, full-screen,
  /// dark base every viewer shares.
  layout: string;
  /// The viewer's own elements, in the order they sit in the backdrop. Close
  /// follows them.
  surface: HTMLElement[];
  /// A click on the backdrop itself, outside the surface, dismisses.
  dismissOnBackdropClick?: boolean;
  /// Runs at dismissal, before the backdrop leaves the page.
  teardown?: () => void;
}

/// Open the overlay on `document.body`.
///
/// It answers an unmodified Escape, which goes no further; a chord with Ctrl,
/// Cmd or Alt held is the app's and travels on. Close dismisses too, and so
/// does a click on the empty backdrop when `dismissOnBackdropClick` is set.
/// Dismissal stops listening for keys, runs `teardown`, then removes the
/// backdrop.
export function openViewerOverlay(options: ViewerOverlayOptions): void {
  const { className, layout, surface, dismissOnBackdropClick = false, teardown } = options;

  const backdrop = document.createElement("div");
  backdrop.className = className;
  backdrop.style.cssText = BACKDROP_STYLE + layout;

  // An explicit Close button: the surface covers most of the backdrop and
  // swallows clicks (a document, a player's controls), so dismissal by a
  // backdrop click alone would need precise edge clicks.
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.title = "Close (Esc)";
  close.style.cssText = CLOSE_STYLE;

  for (const element of surface) backdrop.appendChild(element);
  backdrop.appendChild(close);
  document.body.appendChild(backdrop);

  const dismiss = (): void => {
    document.removeEventListener("keydown", onKey, true);
    teardown?.();
    backdrop.remove();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || e.ctrlKey || e.metaKey || e.altKey) return;
    consumeKey(e);
    dismiss();
  };
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    dismiss();
  });
  if (dismissOnBackdropClick) {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) dismiss();
    });
  }
  document.addEventListener("keydown", onKey, true);
}
