// The layer the full-window viewers (image, diagram, slides, and the shared
// PDF, video and audio overlay) paint at: over the reconnect, session-ended
// and close-prompt covers, as a viewer the user opened stays in front of them,
// and under the screen lock and the auth and preflight pages, so a locked
// screen shows none of a document left open. The viewer stays open under the
// lock with its place kept, and takes keys again when it lifts.
//
// A fullscreen element paints in the browser's top layer, over every z-index,
// so the lock leaves fullscreen as it comes up and asks for it back as it
// lifts. The unlock's key or click is the activation the browser wants; where
// it refuses, the viewer stays open in the window. Fullscreen also keeps focus
// inside its element, so the lock's own focus can land nowhere until it ends:
// the lock takes the keyboard once it has. A viewer asks for fullscreen again
// on its own updates, which run under the lock, so anything that enters it
// while the lock is up is taken out again.

import { untrack } from "svelte";
import { COVER_ROOT_ATTR } from "./paintLevel";
import { screensaver } from "./screensaver.svelte";

export const VIEWER_LAYER = 38000;

/// What the lock took out of fullscreen or held back from it, to put back
/// when it lifts.
let left: Element | null = null;

/// Note that `element` asked for fullscreen under the lock, so the lock's
/// lift gives it fullscreen instead of the request that was withheld. The
/// read is untracked: a viewer's update runs inside its host's effect, which
/// would otherwise rerun as the lock lifts and ask a second time.
export function holdFullscreenFor(element: Element): void {
  if (untrack(() => screensaver.locked)) left = element;
}

/// `element` no longer wants fullscreen, so the lock's lift leaves it out.
export function forgetFullscreen(element: Element): void {
  if (left === element) left = null;
}

function keyboardToLock(): void {
  if (!screensaver.locked) return;
  const root = document.querySelector<HTMLElement>(`[${COVER_ROOT_ATTR}="screensaver"]`);
  if (!root) return;
  const active = document.activeElement;
  if (active !== root && root.contains(active)) return;
  // On a woken card the PIN field is where typing goes: the backdrop under
  // it only wakes the card.
  (root.querySelector<HTMLElement>("input:not(:disabled)") ?? root).focus({ preventScroll: true });
}

function leaveFullscreen(): void {
  const element = document.fullscreenElement;
  if (!element) return;
  left = element;
  void document.exitFullscreen?.().then(keyboardToLock).catch(() => {});
}

if (typeof document !== "undefined") {
  document.addEventListener("fullscreenchange", () => {
    if (screensaver.locked) leaveFullscreen();
  });
  $effect.root(() => {
    $effect(() => {
      if (screensaver.locked) {
        leaveFullscreen();
      } else if (left) {
        const element = left;
        left = null;
        if (element.isConnected) void element.requestFullscreen?.().catch(() => {});
      }
    });
  });
}
