// Mount an app-root dialog on its own and drive it the way a user does: a key
// on the focused element, a click on the dim backdrop or inside the panel.
// Pair `mountDialog` with `unmountDialogs` in `afterEach`.

import { mount, tick, unmount, type Component } from "svelte";

const mounted: Array<Record<string, unknown>> = [];

/// Mount `component` into a fresh node on the body and return that node.
export function mountDialog<Props extends Record<string, unknown>>(
  component: Component<Props>,
  props?: Props,
): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(component, { target, props: props ?? ({} as Props) }) as Record<string, unknown>);
  return target;
}

export function unmountDialogs(): void {
  for (const c of mounted.splice(0)) unmount(c);
  document.body.replaceChildren();
}

/// The open dialog under `target`, or null while it is closed.
export function dialogIn(target: HTMLElement): HTMLElement | null {
  return target.querySelector<HTMLElement>('[role="dialog"]');
}

/// The name a screen reader announces for `dialog`: the text of the elements
/// its `aria-labelledby` points at, or null when it names none.
export function dialogName(dialog: HTMLElement): string | null {
  const ids = dialog.getAttribute("aria-labelledby");
  if (!ids) return null;
  return ids
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ")
    .trim();
}

/// Click the dim area around the panel.
export function clickBackdrop(target: HTMLElement): void {
  dialogIn(target)!.parentElement!.click();
}

/// Press `key` on `el` as the browser delivers it: a bubbling, cancelable
/// keydown. The event comes back so a test can read `defaultPrevented`.
export function press(el: Element, key: string): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
}

/// Let an open render and the focus work it queues finish.
export async function settle(): Promise<void> {
  await tick();
  await new Promise((r) => setTimeout(r, 0));
}
