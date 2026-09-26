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

/// The dim backdrop under the open dialog: a button of its own beside the
/// panel, never an element around it. Null when there is none.
export function backdropIn(target: HTMLElement): HTMLButtonElement | null {
  return dialogIn(target)?.parentElement?.querySelector<HTMLButtonElement>(":scope > button") ?? null;
}

/// Click the dim area around the panel.
export function clickBackdrop(target: HTMLElement): void {
  const backdrop = backdropIn(target);
  if (!backdrop) throw new Error("no backdrop button beside the dialog");
  backdrop.click();
}

/// Press `key` on `el` as the browser delivers it: a bubbling, cancelable
/// keydown. The event comes back so a test can read `defaultPrevented`.
export function press(el: Element, key: string): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
}

/// Press the pointer on `el` as Chromium does: a bubbling, cancelable
/// mousedown whose default action focuses the pressed control unless a
/// handler prevents it. jsdom runs no default action for a mousedown, so
/// this applies that one. The event comes back so a test can read
/// `defaultPrevented`.
export function pointerPress(el: HTMLElement): MouseEvent {
  const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  if (!e.defaultPrevented) el.focus();
  return e;
}

/// Record the keys that reach the document, where App's global shortcut
/// handler listens. Stop recording with the returned `stop`.
export function recordDocumentKeys(): { keys: string[]; stop: () => void } {
  const keys: string[] = [];
  const listen = (e: KeyboardEvent): void => {
    keys.push(e.key);
  };
  document.addEventListener("keydown", listen);
  return { keys, stop: () => document.removeEventListener("keydown", listen) };
}

/// A focused button on the body, standing in for the surface (an editor, a
/// terminal) that held focus when the dialog opened.
export function focusOrigin(): HTMLButtonElement {
  const origin = document.createElement("button");
  origin.textContent = "origin";
  document.body.append(origin);
  origin.focus();
  return origin;
}

/// Let an open render and the focus work it queues finish.
export async function settle(): Promise<void> {
  await tick();
  await new Promise((r) => setTimeout(r, 0));
}
