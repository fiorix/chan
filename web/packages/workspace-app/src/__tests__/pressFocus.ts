// A person's press as an engine runs it, focus included. jsdom
// dispatches the mouse events a case sends and runs no default of its own,
// so a press there moves no focus unless the case moves it. The engines
// modelled are Chrome and WebKitGTK. WebKit for macOS focuses no button on
// a press, so a case that leans on a pressed button taking the keyboard
// says so.

import { tick } from "svelte";

/// What a press focuses: the elements an engine focuses on a press, an
/// element with a tabindex of its own among them.
const PRESS_FOCUSABLE = "a[href], area[href], button, input, select, textarea, summary, [tabindex]";

/// The element a press on `el` focuses: its nearest ancestor that matches
/// and can take focus. A disabled control cannot, so the press walks on
/// past it to the next match, as the modelled engines do.
function pressFocusTarget(el: HTMLElement): HTMLElement | null {
  let match = el.closest<HTMLElement>(PRESS_FOCUSABLE);
  while (match?.matches(":disabled")) match = match.parentElement?.closest<HTMLElement>(PRESS_FOCUSABLE) ?? null;
  return match;
}

/// A press of `button` on `el`, the primary by default or the secondary:
/// the mousedown's listeners run with the microtasks they queue, then the
/// press's default, unless a listener cancelled the mousedown, focuses
/// `pressFocusTarget(el)`, or, with none, blurs the focused element, so the
/// keyboard falls to `<body>`. Chrome and WebKitGTK both end a primary
/// press on an element with no focusable ancestor there, and a secondary
/// press moves focus the same way, as the tab strip's press handler in
/// `Pane.svelte` records. The secondary press's contextmenu is not sent.
/// Returns the mousedown.
export async function press(el: HTMLElement, button: 0 | 2 = 0): Promise<MouseEvent> {
  const down = new MouseEvent("mousedown", {
    bubbles: true, cancelable: true, button, buttons: button === 2 ? 2 : 1, detail: 1,
  });
  el.dispatchEvent(down);
  await tick();
  await tick();
  if (!down.defaultPrevented) {
    const focusable = pressFocusTarget(el);
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
