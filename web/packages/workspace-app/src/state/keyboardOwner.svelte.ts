// Who owns the keyboard. Owners stack the way they show, top first: the
// window's Computers launcher; a modal dialog or a window-wide survey; the
// top overlay over the panes (Search, Settings, the command deck); the
// survey over the focused pane's active terminal. `owner()` reads that
// order from state, and each owner surface tags its root with
// KEYBOARD_OWNER_ATTR so `mayFocus` can tell an element inside the owner
// from one under it. Every owner is reactive state, so a derived value or
// effect that asked while one showed asks again when it lets go.

import { modalDialogOpen, topOverlay, type OverlayId } from "./store.svelte";
import { surveyFor } from "./survey.svelte";
import { activeTerminalTab } from "./tabs.svelte";

/// The attribute each owner surface puts on its root, valued by `ownerTag`.
export const KEYBOARD_OWNER_ATTR = "data-keyboard-owner";

export type KeyboardOwnerKind = "launcher" | "modal" | "overlay" | "terminal-survey";

/// The keyboard's owner and the element it owns the keyboard within. The
/// Computers launcher is a second webview, so it has no root in this page.
export type KeyboardOwner = { kind: KeyboardOwnerKind; root: HTMLElement | null };

/// The value an owner surface tags its root with: the kind, and for an
/// overlay or a terminal's survey the overlay id or terminal tab id that
/// tells it from its siblings.
export function ownerTag(kind: "modal"): string;
export function ownerTag(kind: "overlay", id: OverlayId): string;
export function ownerTag(kind: "terminal-survey", id: string): string;
export function ownerTag(kind: Exclude<KeyboardOwnerKind, "launcher">, id?: string): string {
  return id === undefined ? kind : `${kind}:${id}`;
}

/// The attribute chan-desktop sets on the page's root while the window's
/// Computers launcher is shown over it (launcher_transition.js hostCovered).
export const LAUNCHER_SHOWN_ATTR = "data-launcher-shown";

/// Whether the window's Computers launcher is shown over this page, read
/// from the attribute itself. The launcher is a second webview holding the
/// keyboard; a focus change in this page would move the window's first
/// responder back here and leave the launcher deaf.
export function launcherShownOverWindow(): boolean {
  return document.documentElement.hasAttribute(LAUNCHER_SHOWN_ATTR);
}

/// The launcher's mark as reactive state. The desktop sets the attribute, so
/// a MutationObserver keeps this in step: a derived value or effect that
/// read it while the launcher showed reads it again when it hides.
let launcherShown = $state(
  typeof document !== "undefined" &&
    document.documentElement.hasAttribute(LAUNCHER_SHOWN_ATTR),
);
if (typeof document !== "undefined") {
  new MutationObserver(() => {
    launcherShown = document.documentElement.hasAttribute(LAUNCHER_SHOWN_ATTR);
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: [LAUNCHER_SHOWN_ATTR],
  });
}

/// How high an element paints: the largest z-index on it or an ancestor.
/// Owner surfaces are fixed layers with their own z-index, so this orders
/// two roots of one kind, such as a dialog shown over another.
function paintLevel(element: Element): number {
  let level = 0;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const z = Number.parseInt(getComputedStyle(node).zIndex, 10);
    if (Number.isFinite(z) && z > level) level = z;
  }
  return level;
}

/// The root tagged `tag` that paints on top; the later one in the document
/// when two paint at one level.
function topRoot(tag: string): HTMLElement | null {
  let top: HTMLElement | null = null;
  let topLevel = -Infinity;
  for (const root of document.querySelectorAll<HTMLElement>(`[${KEYBOARD_OWNER_ATTR}="${tag}"]`)) {
    const level = paintLevel(root);
    if (level >= topLevel) {
      top = root;
      topLevel = level;
    }
  }
  return top;
}

/// The keyboard's owner, or null when nothing above the panes and no
/// survey over the focused pane's terminal holds it. The launcher is read
/// from its state, which re-runs a reader when it hides, and from its
/// attribute, which is current before the observer runs.
export function owner(): KeyboardOwner | null {
  if (launcherShown || launcherShownOverWindow()) return { kind: "launcher", root: null };
  if (modalDialogOpen()) return { kind: "modal", root: topRoot(ownerTag("modal")) };
  const overlay = topOverlay();
  if (overlay !== null) return { kind: "overlay", root: topRoot(ownerTag("overlay", overlay)) };
  const terminal = activeTerminalTab();
  if (terminal && surveyFor(terminal.id) !== null) {
    return { kind: "terminal-survey", root: topRoot(ownerTag("terminal-survey", terminal.id)) };
  }
  return null;
}

/// Whether `element` may take the keyboard: never while the Computers
/// launcher is shown; otherwise when nothing owns the keyboard, or when
/// `element` sits inside the owner's root.
export function mayFocus(element: Element | null): boolean {
  const current = owner();
  if (current === null) return true;
  if (current.kind === "launcher") return false;
  return element !== null && current.root !== null && current.root.contains(element);
}
