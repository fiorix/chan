// Which screen the launcher's main area shows: Computers (the machine/library
// tree) or Gateways. The flip trigger is forward-only -- a monotonic counter
// the ScreenFlip shell watches, so every change plays the same turn. Leaving a
// screen drops select mode so no stale selection, highlight, or bulk bar
// survives on the other side.

import { setSelectMode } from "./selection.svelte";

export type LauncherScreen = "computers" | "gateways";

interface ScreenState {
  current: LauncherScreen;
  /** Monotonic flip trigger for the ScreenFlip shell. */
  flips: number;
}

const STORAGE_KEY = "chan.launcher-screen.v1";

function restoreScreen(): LauncherScreen {
  try {
    if (window.sessionStorage.getItem(STORAGE_KEY) === "gateways") return "gateways";
  } catch { /* Storage may be unavailable. */ }
  return "computers";
}

export const screen = $state<ScreenState>({ current: restoreScreen(), flips: 0 });

export function showScreen(next: LauncherScreen): void {
  if (screen.current === next) return;
  screen.current = next;
  screen.flips += 1;
  setSelectMode(false);
  try { window.sessionStorage.setItem(STORAGE_KEY, next); } catch { /* The flip still works. */ }
}

export function toggleScreen(): void {
  showScreen(screen.current === "computers" ? "gateways" : "computers");
}
