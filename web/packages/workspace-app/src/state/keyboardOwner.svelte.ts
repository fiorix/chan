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

import { canTakeFocus } from "@chan/web-shared/modal-focus";
import { setConfirmRestoreGate } from "./confirm.svelte";
import { paintLevel } from "./paintLevel";
import { COVER_ROOT_ATTR, appInputBlocked, modalDialogOpen, raisedCoverKeys, topCoverRoot, topOverlay, type OverlayId } from "./store.svelte";
import { surveyFor } from "./survey.svelte";
import { activeTerminalTab, bumpTabFocusPulse } from "./tabs.svelte";

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
export function launcherCovers(): boolean {
  void launcherShown;
  return launcherShownOverWindow();
}

/// The keyboard's owner, or null when nothing above the panes and no
/// survey over the focused pane's terminal holds it.
export function owner(): KeyboardOwner | null {
  if (launcherCovers()) return { kind: "launcher", tag: null };
  return pageOwner();
}

/// Whether something rendered over the panes owns the keyboard: a modal
/// dialog, a window-wide survey or an overlay (Search, the command deck,
/// Settings). Ctrl+D and the pane flip read it and stand down rather than
/// close or turn a tab the user cannot see. It reads the page's owners
/// alone, the Computers launcher left out; the covers over the window are
/// `appInputBlocked`'s.
export function keyboardOwnedAbovePanes(): boolean {
  const kind = pageOwner()?.kind;
  return kind === "modal" || kind === "overlay";
}

/// The owner the page itself shows, in the order the page's owners show.
function pageOwner(): KeyboardOwner | null {
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

/// Whether `root` paints over every cover raised over the window, as the
/// close prompt paints over the reconnect and session-ended covers. A
/// raised cover whose root is not in the page holds the keyboard all the
/// same, and a cover painting at `root`'s level counts as painting over it.
function paintsOverCovers(root: Element): boolean {
  const level = paintLevel(root);
  for (const cover of raisedCoverKeys()) {
    const roots = document.querySelectorAll(`[${COVER_ROOT_ATTR}="${cover}"]`);
    if (roots.length === 0) return false;
    for (const coverRoot of roots) if (paintLevel(coverRoot) >= level) return false;
  }
  return true;
}

/// Whether `element` may take the keyboard: when `element` sits inside the
/// owner's root, looked up as this asks, or when nothing owns it and
/// `element` is in no owner surface's root, since a surface takes the
/// keyboard only while it owns it (a survey card over a terminal that is not
/// the focused pane's active one). The Computers launcher has no root in the
/// page, so nothing may take it then. A cover over the window
/// (`FULL_WINDOW_COVERS`: the reconnect, session-ended, missing-token and
/// preflight covers and the screen lock) holds it while it shows, but from
/// an owner whose root paints over every raised cover: the covers rank by
/// paint, as the dialogs do.
export function mayFocus(element: Element | null): boolean {
  const current = owner();
  const covered = appInputBlocked();
  if (current === null) {
    return !covered && (element === null || element.closest(`[${KEYBOARD_OWNER_ATTR}]`) === null);
  }
  const root = ownerRoot(current);
  return element !== null && root !== null && root.contains(element) && (!covered || paintsOverCovers(root));
}

// The confirm dialog's restore asks too; its module imports nothing.
setConfirmRestoreGate(mayFocus);

/// Whether an owner above the overlays holds the keyboard: a modal dialog, a
/// window-wide survey, or a cover over the window (the reconnect,
/// session-ended, missing-token and preflight covers and the screen lock).
/// The command deck leaves its keys and focus to one. A survey over a
/// terminal ranks below the deck and does not count; nor does the Computers
/// launcher, whose keys never reach the page, so a deck under it still runs
/// what the page itself sends it.
export function ownerAboveOverlays(): boolean {
  return modalDialogOpen() || appInputBlocked();
}

/// How each owner surface takes the keyboard when it is handed back to it,
/// by the root it tags.
const takers = new WeakMap<Element, () => void>();

/// Register how the owner surface tagged at `root`, or the cover over the
/// window rooted there, takes the keyboard when it is handed back to it;
/// the answer unregisters it.
export function registerKeyboardTaker(root: HTMLElement, take: () => void): () => void {
  takers.set(root, take);
  return () => {
    if (takers.get(root) === take) takers.delete(root);
  };
}

/// Hand the keyboard to its owner, as the owner's surface takes it. False
/// with no owner, under a cover the owner's root does not paint over, for
/// the Computers launcher, which has no root in the page, and for a root
/// whose surface registered no way to take it.
export function handKeyboardToOwner(): boolean {
  const root = ownerRoot();
  if (root === null || (appInputBlocked() && !paintsOverCovers(root))) return false;
  const take = takers.get(root);
  take?.();
  return take !== undefined;
}

/// Hand the keyboard to the cover over the window that paints on top, as
/// its surface takes it: the session-ended cover onto its button, the
/// reconnect cover onto its card. False with no cover up, while a raised
/// cover has no root in the page, and when the top cover registered no way
/// to take it, as the screen lock, the missing-token and the preflight
/// covers do not: each takes the keyboard itself as it shows.
export function handKeyboardToTopCover(): boolean {
  const raised = raisedCoverKeys();
  if (raised.length === 0) return false;
  if (raised.some((cover) => document.querySelector(`[${COVER_ROOT_ATTR}="${cover}"]`) === null)) return false;
  const root = topCoverRoot();
  const take = root ? takers.get(root) : undefined;
  take?.();
  return take !== undefined;
}

// When a cover over the window lifts with the keyboard at large (the
// cover's own field went with it), the keyboard goes to its owner as the
// owner's surface takes it, where the owner paints over every cover still
// up: a dialog under the screen lock takes its field back on unlock, and
// the close prompt over the reconnect cover takes Cancel back when the lock
// over both lifts. With no owner to take it and a cover still up, the cover
// on top takes it: the reconnect card as the lock over it lifts. With
// nothing owning it and no cover left, the tab-focus pulse hands it to the
// focused pane's active tab, unless the reconnect cover is among the covers
// lifting: that cover pulses the tab itself, for a terminal or an editor it
// saw holding the keyboard, and only then.
if (typeof document !== "undefined") {
  $effect.root(() => {
    let raised = raisedCoverKeys();
    $effect(() => {
      const now = raisedCoverKeys();
      const lifted = raised.filter((cover) => !now.includes(cover));
      if (lifted.length > 0) {
        const reconnect = lifted.includes("reconnect");
        queueMicrotask(() => {
          if (canTakeFocus(document.activeElement)) return;
          if (owner() !== null && handKeyboardToOwner()) return;
          if (appInputBlocked()) handKeyboardToTopCover();
          else if (owner() === null && !reconnect) bumpTabFocusPulse();
        });
      }
      raised = now;
    });
  });
}
