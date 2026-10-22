// The mouse events of one primary-button press, as a person's click sends
// them: the press on an element, motion with the button still down, and the
// release. Each event bubbles from where it is dispatched to the document,
// where CodeMirror's mouse selection and the editor's pointer hold listen.

/// A plain primary press on `el`, the first click of a sequence.
export function mouseDown(el: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: 1,
    detail: 1,
    ...init,
  });
  el.dispatchEvent(event);
  return event;
}

/// Motion over `el` with the primary button held.
export function mouseMoveHeld(el: Element, init: MouseEventInit = {}): void {
  el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, buttons: 1, ...init }));
}

/// The release of the primary button over `el`, or over the document when
/// `el` has left it.
export function mouseUp(el?: Element): void {
  const target = el?.isConnected ? el : document;
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
}
