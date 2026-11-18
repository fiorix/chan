// Who owns the keyboard. Owners stack the way they show, top first: the
// window's Computers launcher; a modal dialog or a window-wide survey; the
// top overlay over the panes (Search, Settings, the command deck); the
// survey over the focused pane's active terminal. `owner()` reads that
// order from state, and each owner surface tags its root with
// KEYBOARD_OWNER_ATTR so `mayFocus` can tell an element inside the owner
// from one under it. The owner is read from reactive state, so a derived
// value or effect that asked while one showed asks again when it lets go;
// its root is looked up in the page when `ownerRoot` or `mayFocus` asks,
// never kept, so no reader holds a root from before its surface mounted.

import { setConfirmRestoreGate } from "./confirm.svelte";
import { appInputBlocked, modalDialogOpen, topOverlay, type OverlayId } from "./store.svelte";
import { surveyFor, type SurveySlot } from "./survey.svelte";
import { activeTerminalTab } from "./tabs.svelte";

/// The attribute each owner surface puts on its root, valued by `ownerTag`.
export const KEYBOARD_OWNER_ATTR = "data-keyboard-owner";

export type KeyboardOwnerKind = "launcher" | "modal" | "overlay" | "terminal-survey";

/// The keyboard's owner: its kind, and the tag its root carries in the page.
/// The Computers launcher is a second webview, so it has no root here and no
/// tag.
export type KeyboardOwner = { kind: KeyboardOwnerKind; tag: string | null };

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
  for (const root of document.querySelectorAll<HTMLElement>(`[${KEYBOARD_OWNER_ATTR}]`)) {
    if (root.getAttribute(KEYBOARD_OWNER_ATTR) !== tag) continue;
    const level = paintLevel(root);
    if (level >= topLevel) {
      top = root;
      topLevel = level;
    }
  }
  return top;
}

/// Whether the Computers launcher covers the page. The state is read so a
/// reader runs again when it changes; the answer comes from the attribute,
/// which is current both when the launcher covers the page and when it
/// uncovers, before the observer has run.
function launcherCovers(): boolean {
  void launcherShown;
  return launcherShownOverWindow();
}

/// The keyboard's owner, or null when nothing above the panes and no
/// survey over the focused pane's terminal holds it.
export function owner(): KeyboardOwner | null {
  if (launcherCovers()) return { kind: "launcher", tag: null };
  if (modalDialogOpen()) return { kind: "modal", tag: ownerTag("modal") };
  const overlay = topOverlay();
  if (overlay !== null) return { kind: "overlay", tag: ownerTag("overlay", overlay) };
  const terminal = activeTerminalTab();
  if (terminal && surveyFor(terminal.id) !== null) {
    return { kind: "terminal-survey", tag: ownerTag("terminal-survey", terminal.id) };
  }
  return null;
}

/// The element the owner holds the keyboard within, looked up in the page
/// now: of the roots carrying its tag, the one that paints on top. Null for
/// the Computers launcher, for no owner, and for an owner whose surface has
/// not mounted.
export function ownerRoot(current: KeyboardOwner | null = owner()): HTMLElement | null {
  return current?.tag ? topRoot(current.tag) : null;
}

/// Whether `element` may take the keyboard: when nothing owns it, or when
/// `element` sits inside the owner's root, looked up as this asks. The
/// Computers launcher has no root in the page, so nothing may take it then,
/// and nothing may while a cover over the window (the screen lock, the
/// reconnect or session-ended cover) holds it.
export function mayFocus(element: Element | null): boolean {
  if (appInputBlocked()) return false;
  const current = owner();
  if (current === null) return true;
  const root = ownerRoot(current);
  return element !== null && root !== null && root.contains(element);
}

// The confirm dialog's restore asks too; its module imports nothing.
setConfirmRestoreGate(mayFocus);

/// Whether an owner above the overlays holds the keyboard: a modal dialog, a
/// window-wide survey, or a cover over the window (the screen lock, the
/// reconnect or session-ended cover). The command deck leaves its keys and
/// focus to one. A survey over a terminal ranks below the deck and does not
/// count; nor does the Computers launcher, whose keys never reach the page,
/// so a deck under it still runs what the page itself sends it.
export function ownerAboveOverlays(): boolean {
  return modalDialogOpen() || appInputBlocked();
}

/// How each owner surface takes the keyboard when it is handed back to it,
/// by the root it tags.
const takers = new WeakMap<Element, () => void>();

/// Register how the owner surface tagged at `root` takes the keyboard when
/// it is handed back to it; the answer unregisters it.
export function registerKeyboardTaker(root: HTMLElement, take: () => void): () => void {
  takers.set(root, take);
  return () => {
    if (takers.get(root) === take) takers.delete(root);
  };
}

/// Hand the keyboard to its owner, as the owner's surface takes it. False
/// with no owner, under a cover, for the Computers launcher, which has no
/// root in the page, and for a root whose surface registered no way to
/// take it.
export function handKeyboardToOwner(): boolean {
  if (appInputBlocked()) return false;
  const root = ownerRoot();
  const take = root ? takers.get(root) : undefined;
  take?.();
  return take !== undefined;
}

/// The per-terminal rule the focus movers read: true while a modal
/// dialog, a survey over the terminal in `slot`, a window-wide survey, the
/// Computers launcher or an overlay over the panes holds the keyboard. It
/// counts a survey over that terminal in any pane, and no survey over
/// another terminal. `except` names an overlay that does not count against
/// its own return: the command deck's focus return reads the rule after it
/// closed.
export function legacyKeyboardOwned(slot: SurveySlot, except?: OverlayId): boolean {
  if (modalDialogOpen()) return true;
  if (surveyFor(slot) !== null) return true;
  if (launcherShown) return true;
  const top = topOverlay();
  return top !== null && top !== except;
}
