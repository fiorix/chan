// Shared positioning helper for inline editor popovers (calendar
// picker, wiki picker, image picker).
//
// Default placement is below the trigger element with a 4px gap;
// when the popover would overflow the viewport bottom we flip it
// above the trigger instead. Horizontal placement clamps to the
// viewport so a trigger near the right edge doesn't push the
// popover off-screen either.
//
// Why an absolute, manually-positioned popover instead of
// `<dialog>` or a Tauri tooltip: the popover anchors to a
// host element in the editor, which neither of those offer. The
// helper consolidates viewport placement so each picker shares it.

/// Position `popover` relative to `host`, preferring below.
///
/// Call AFTER `popover` is appended to `document.body` and has
/// rendered its initial children: we need the popover's measured
/// size to decide flip direction. The function does not itself
/// append to the body.
///
/// `popover` must already have `position: absolute` set.
export function positionPopover(host: HTMLElement, popover: HTMLElement): void {
  // Force layout to read accurate offset dimensions; on first
  // call the popover may have empty content + we still want a
  // reasonable estimate.
  const popH = popover.offsetHeight || 200;
  const popW = popover.offsetWidth || 320;

  const hostRect = host.getBoundingClientRect();
  const viewportH =
    typeof window !== "undefined" && window.visualViewport
      ? window.visualViewport.height
      : window.innerHeight;
  const viewportW = window.innerWidth;
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const gap = 8;
  // Horizontal inset from viewport edges. The vertical math uses
  // `gap` against the caret line, but horizontally we want a larger
  // breathing room so a bubble near the left/right edge sits well
  // away from the window border rather than flush against it.
  const margin = 24;

  // Vertical: prefer below the host, but if the popover would
  // overflow the viewport AND there's more room above, flip up.
  // `host` is the caret-line anchor (full line height), so
  // hostRect.bottom == line bottom and hostRect.top == line top -   // the popover always sits cleanly outside the line being edited.
  const spaceBelow = viewportH - hostRect.bottom;
  const spaceAbove = hostRect.top;
  let top: number;
  if (spaceBelow >= popH + gap || spaceBelow >= spaceAbove) {
    top = hostRect.bottom + scrollY + gap;
  } else {
    top = hostRect.top + scrollY - popH - gap;
  }

  // Horizontal: anchor to the host's left edge, but clamp so the
  // popover stays inside [margin, viewportW - margin]. A trigger
  // near the right edge gets pulled left rather than overflowing.
  let left = hostRect.left + scrollX;
  const minLeft = scrollX + margin;
  const maxLeft = scrollX + viewportW - popW - margin;
  if (left > maxLeft) left = Math.max(minLeft, maxLeft);
  if (left < minLeft) left = minLeft;

  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;
}

/// Reposition on viewport resize (mobile keyboard, window resize,
/// orientation change). Returns a cleanup function the caller
/// should run on dismissal.
///
/// We listen on the visualViewport when available so the picker
/// stays visible above the iOS soft keyboard; otherwise fall back
/// to the standard window resize event.
export function watchViewport(
  host: HTMLElement,
  popover: HTMLElement,
): () => void {
  const onChange = () => positionPopover(host, popover);
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  if (vv) {
    vv.addEventListener("resize", onChange);
    vv.addEventListener("scroll", onChange);
  }
  window.addEventListener("resize", onChange);
  return () => {
    if (vv) {
      vv.removeEventListener("resize", onChange);
      vv.removeEventListener("scroll", onChange);
    }
    window.removeEventListener("resize", onChange);
  };
}
