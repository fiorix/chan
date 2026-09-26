// Press a key the way a key pressed with focus inside the page arrives: from
// an element in the document, so a capture-phase listener on the document
// runs first, then the element, then the bubble-phase listeners on the
// document, where the app's window key handler sits. A key dispatched on the
// document itself reaches its capture and bubble listeners in the same
// at-target phase and cannot show that order.

export interface InPagePress {
  event: KeyboardEvent;
  /// Whether the key bubbled back up to a listener on the document.
  reachedDocument: boolean;
}

export function pressInPage(init: KeyboardEventInit): InPagePress {
  let reachedDocument = false;
  const seen = (): void => {
    reachedDocument = true;
  };
  document.addEventListener("keydown", seen);
  const inner = document.body.appendChild(document.createElement("div"));
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  try {
    inner.dispatchEvent(event);
  } finally {
    inner.remove();
    document.removeEventListener("keydown", seen);
  }
  return { event, reachedDocument };
}
