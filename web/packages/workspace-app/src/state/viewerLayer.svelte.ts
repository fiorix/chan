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
// the lock takes the keyboard once it has.

import { COVER_ROOT_ATTR } from "./paintLevel";
import { screensaver } from "./screensaver.svelte";

export const VIEWER_LAYER = 38000;

function keyboardToLock(): void {
  if (!screensaver.locked) return;
  const root = document.querySelector<HTMLElement>(`[${COVER_ROOT_ATTR}="screensaver"]`);
  if (root && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
}

if (typeof document !== "undefined") {
  $effect.root(() => {
    let left: Element | null = null;
    $effect(() => {
      if (screensaver.locked) {
        left = document.fullscreenElement;
        if (left) void document.exitFullscreen?.().then(keyboardToLock).catch(() => {});
      } else if (left) {
        const element = left;
        left = null;
        if (element.isConnected) void element.requestFullscreen?.().catch(() => {});
      }
    });
  });
}
