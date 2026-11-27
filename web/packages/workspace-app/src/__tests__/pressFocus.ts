// A person's primary press as an engine runs it, focus included. jsdom
// dispatches the mouse events a case sends and runs no default of its own,
// so a press there moves no focus unless the case moves it.

import { tick } from "svelte";

/// What a press focuses: the elements an engine focuses on a press, an
/// element with a tabindex of its own among them.
const PRESS_FOCUSABLE = "a[href], area[href], button, input, select, textarea, summary, [tabindex]";

/// A primary press on `el`: the mousedown's listeners run with the
/// microtasks they queue, then the press's default, unless a listener
/// cancelled the mousedown, focuses the pressed element's nearest focusable
/// ancestor, or, with none, blurs the focused element, so the keyboard falls
/// to `<body>`. Chrome and WebKitGTK both end a press on an element with no
/// focusable ancestor there. Returns the mousedown.
export async function press(el: HTMLElement): Promise<MouseEvent> {
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1 });
  el.dispatchEvent(down);
  await tick();
  await tick();
  if (!down.defaultPrevented) {
    const focusable = el.closest<HTMLElement>(PRESS_FOCUSABLE);
    if (focusable) focusable.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  }
  return down;
}

/// The release that ends a press on `el`, and the click it makes.
export function release(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
}
