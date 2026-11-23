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

// A mouse pointer's gesture as an engine delivers it to an element that
// takes pointer capture, the way the Ghostty widget's canvas does.

/// jsdom implements no pointer capture. Model it on `el`: taken, read back
/// and released by pointer id. Delivery is not retargeted, so a case
/// dispatches a captured gesture's events at `el` itself, as the engine
/// would; the returned set holds the ids `el` has captured.
export function modelPointerCapture(el: Element): Set<number> {
  const captured = new Set<number>();
  Object.assign(el, {
    setPointerCapture: (id: number) => void captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => void captured.delete(id),
  });
  return captured;
}

/// The PointerEvent.buttons bit of each MouseEvent.button value.
const HELD = [1, 4, 2];

type PointerType = "pointerdown" | "pointermove" | "pointerup" | "pointercancel" | "lostpointercapture";

/// One event of the mouse pointer's gesture with `init.button` (the primary
/// unless given), dispatched at `el`: a press holds its button, a move
/// changes none (button -1) while it stays held, and the release, a cancel
/// and a capture loss hold none.
export function mousePointer(
  el: Element,
  type: PointerType,
  at: { clientX: number; clientY: number },
  init: PointerEventInit = {},
): PointerEvent {
  const button = init.button ?? 0;
  const released = type !== "pointerdown" && type !== "pointermove";
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    buttons: released ? 0 : (HELD[button] ?? 0),
    ...init,
    button: type === "pointermove" ? -1 : button,
    ...at,
  });
  el.dispatchEvent(event);
  return event;
}

/// A click of `button` at `el` as the engine delivers it: the press and the
/// release, each followed by its compatibility mouse event unless a listener
/// cancelled the pointerdown, then click for the primary button or auxclick
/// for another. Returns the pointerdown and that last event.
export function engineClick(
  el: Element,
  button: 0 | 1 | 2,
  at: { clientX: number; clientY: number } = { clientX: 0, clientY: 0 },
): { down: PointerEvent; click: MouseEvent } {
  const down = mousePointer(el, "pointerdown", at, { button });
  const compat = !down.defaultPrevented;
  const mouse = (type: string, buttons: number) =>
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button, buttons, detail: 1, ...at }));
  if (compat) mouse("mousedown", HELD[button] ?? 0);
  mousePointer(el, "pointerup", at, { button });
  if (compat) mouse("mouseup", 0);
  const click = new MouseEvent(button === 0 ? "click" : "auxclick", {
    bubbles: true, cancelable: true, button, detail: 1, ...at,
  });
  el.dispatchEvent(click);
  return { down, click };
}
