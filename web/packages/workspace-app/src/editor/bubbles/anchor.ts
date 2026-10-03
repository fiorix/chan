// Caret-anchored host element for openBubbleShell.
//
// openBubbleShell from editor/bubble.ts takes an `host: HTMLElement` to
// position the popover under. CM6 doesn't expose a caret DOM node we
// can use directly (the caret is a CSS-painted line over `.cm-content`,
// not its own element), so we build a 1x1 invisible div positioned at
// `view.coordsAtPos(pos)` and pass that as the anchor.
//
// The anchor element lives in document.body so it doesn't get
// reflowed by editor scrolling. The caller is responsible for
// repositioning it on viewport changes (the bubble shell already does
// this via watchViewport, and our own update() lets bubbles re-anchor
// after the trigger range shifts).
//
// API:
//   const anchor = createCaretAnchor(view, pos);
//   const shell = openBubbleShell({ host: anchor.el, className: ... });
//   // ... when the underlying pos changes:
//   anchor.update(view, newPos);
//   shell.reposition();
//   // on dismiss:
//   anchor.dismiss();

import type { EditorView } from "@codemirror/view";

export interface CaretAnchor {
  el: HTMLElement;
  update(view: EditorView, pos: number): void;
  dismiss(): void;
}

export function createCaretAnchor(
  view: EditorView,
  pos: number,
): CaretAnchor {
  const el = document.createElement("div");
  el.style.position = "absolute";
  el.style.width = "1px";
  el.style.pointerEvents = "none";
  el.style.zIndex = "-1";
  document.body.appendChild(el);
  reposition(view, el, pos);
  return {
    el,
    update(v, p) {
      reposition(v, el, p);
    },
    dismiss() {
      el.remove();
    },
  };
}

function reposition(view: EditorView, el: HTMLElement, pos: number): void {
  const coords = view.coordsAtPos(pos);
  if (!coords) return;
  // Anchor spans the full caret-line height so positionPopover's
  // flip-above branch lands the popover above the line's TOP, not
  // straddling the line. With an anchor 1px tall at `coords.bottom`
  // the flip math would place the popover with its bottom edge AT
  // the line bottom, overlaying the text the user is typing.
  el.style.left = `${Math.round(coords.left + window.scrollX)}px`;
  el.style.top = `${Math.round(coords.top + window.scrollY)}px`;
  el.style.height = `${Math.max(1, Math.round(coords.bottom - coords.top))}px`;
}
