// The desktop's terminal background opacity, followed live in a chan-desktop
// window.
//
// `terminal.background_opacity` is chan-desktop's own setting: the value in
// the desktop's `server.toml` governs every terminal tab of every window the
// desktop builds, whichever tenant the window shows, so a devserver's own
// preference plays no part in a desktop window. The page subscribes to the
// desktop's change event first and then asks once, so a change between the
// two is not lost, and follows the event for every later change: a Settings
// write in any window, `chan config set`, a hand edit of the file. A browser
// tab has no desktop behind it and never asks; its value stays `null`, which
// `effectiveBackgroundOpacity` paints opaque.

import {
  isTauriDesktop,
  onTauriEvent,
  readTerminalBackgroundOpacity,
  writeTerminalBackgroundOpacity,
} from "../api/desktop";
import { clampBackgroundOpacity } from "./backgroundOpacity";

/// The event chan-desktop emits to every window on a change of its setting.
/// Its payload is `{ percent }`.
export const TERMINAL_BACKGROUND_OPACITY_EVENT = "terminal-background-opacity";

const desktop = $state<{ percent: number | null }>({ percent: null });
let started: Promise<void> | null = null;
let unlisten: (() => void) | null = null;

/// The desktop's value in a chan-desktop window; `null` in a browser tab and
/// before the desktop's first answer. Both paint opaque.
export function desktopTerminalOpacity(): number | null {
  return desktop.percent;
}

/// Apply a value the desktop answered or emitted, clamped to the slider
/// bounds like a stored value. Anything that is not a finite number reads as
/// 100: opaque is what the desktop itself answers for a file it cannot read
/// and what a browser tab paints, so a malformed payload leaves no terminal
/// see-through at a value nobody set.
export function applyDesktopTerminalOpacity(value: unknown): number {
  const percent = clampBackgroundOpacity(value);
  desktop.percent = percent;
  return percent;
}

/// Follow the desktop's setting for the life of the page. Idempotent, and a
/// no-op outside chan-desktop. The subscription is in place before the read
/// is sent so no change is lost between the two; an event that lands while
/// the read is in flight is the newer value, so the read's answer then
/// yields to it.
export function startDesktopTerminalOpacity(): Promise<void> {
  if (started) return started;
  if (!isTauriDesktop()) {
    started = Promise.resolve();
    return started;
  }
  started = (async () => {
    let eventSeen = false;
    unlisten = await onTauriEvent<{ percent?: unknown } | null>(
      TERMINAL_BACKGROUND_OPACITY_EVENT,
      (payload) => {
        eventSeen = true;
        applyDesktopTerminalOpacity(payload?.percent);
      },
    );
    try {
      const answer = await readTerminalBackgroundOpacity();
      if (!eventSeen) applyDesktopTerminalOpacity(answer);
    } catch (err) {
      // A desktop build without the command: the terminals stay opaque, as
      // in a browser tab, rather than paint a value nobody answered.
      console.warn("startDesktopTerminalOpacity: terminal_background_opacity IPC failed", err);
    }
  })();
  return started;
}

/// Write the desktop's setting through the host and apply what it wrote.
/// Rejects on an IPC or ACL refusal so the Settings field can show it.
export async function setDesktopTerminalOpacity(percent: number): Promise<number> {
  // The host takes a whole number, so the page rounds and clamps first
  // rather than have a fractional slider value refused there.
  const written = await writeTerminalBackgroundOpacity(clampBackgroundOpacity(percent));
  return applyDesktopTerminalOpacity(written);
}

/// Forget the desktop's value and the subscription, so a test starts from a
/// page that has not asked yet.
export function resetDesktopTerminalOpacityForTests(): void {
  unlisten?.();
  unlisten = null;
  started = null;
  desktop.percent = null;
}
