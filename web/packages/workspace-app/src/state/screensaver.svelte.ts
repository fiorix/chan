// Screensaver state machine. Singleton `screensaver` state + inactivity
// timer.
//
// Distinct from `idle.svelte.ts` (which fades the floating pills after
// 5s of UI-pointer-quiet): the screensaver tracker uses a longer window
// (default 5 min, configurable per-workspace via the chan-workspace
// `screensaver_timeout_secs` field), and watches a wider event set
// (keydown + scroll + pointer events). The idle tracker deliberately
// ignores those.
//
// Lifecycle:
//
// 1. App boot calls `loadScreensaverState()` once. Fetches the
//    per-workspace enabled/timeout/pin_set view from
//    `/api/screensaver/state`; populates the singleton; arms the
//    inactivity timer if enabled.
// 2. User events (keydown, click, mousedown, touchstart, scroll, wheel)
//    reset the timer via `noteScreensaverActivity()`.
// 3. On timeout fire, the timer flips `locked=true`. The overlay
//    component (mounted in App.svelte) watches the flag and renders the
//    full-window cover when locked.
// 4. The user types a PIN; `unlockWithPin(pin)` hashes via `hashPin`
//    + posts to `/verify`. On success, `locked=false`; the activity
//    timer rearms.
//
// Pause for modals: caller-side. Any active modal can call
// `pauseScreensaverTimer()` while open to keep the screensaver from
// firing mid-config.

import { api } from "../api/client";
import {
  hashPin,
  SCREENSAVER_DEFAULT_THEME,
  SCREENSAVER_DEFAULT_TIMEOUT_SECS,
  type ScreensaverTheme,
} from "./screensaver";

export interface ScreensaverState {
  /// Workspace-level enabled flag (server-side; sourced from
  /// `Workspace::screensaver_enabled`). When false, the timer
  /// is disarmed + the overlay never fires.
  enabled: boolean;
  /// Workspace-level inactivity timeout in seconds.
  timeout_secs: number;
  /// Visual theme rendered behind the unlock card.
  theme: ScreensaverTheme;
  /// Whether a PIN hash is stored on the workspace. The PIN
  /// itself never crosses the wire; this flag tells the
  /// SPA whether to show a PIN-setup prompt vs a regular
  /// unlock prompt.
  pin_set: boolean;
  /// Current lock state. True ⇒ overlay covers the SPA.
  locked: boolean;
  /// Have we loaded the server-side state yet? Pre-load
  /// the SPA shouldn't decide anything based on the other
  /// fields.
  loaded: boolean;
}

export const screensaver = $state<ScreensaverState>({
  enabled: false,
  timeout_secs: SCREENSAVER_DEFAULT_TIMEOUT_SECS,
  theme: SCREENSAVER_DEFAULT_THEME,
  pin_set: false,
  locked: false,
  loaded: false,
});

let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
let pauseCount = 0;

/// Fetch + cache the per-workspace screensaver state. Called on
/// app boot AND after any patch (enabled/timeout/pin
/// changes) so the singleton stays consistent with the
/// server.
export async function loadScreensaverState(): Promise<void> {
  try {
    const s = await api.screensaverState();
    screensaver.enabled = s.enabled;
    screensaver.timeout_secs = s.timeout_secs;
    screensaver.theme = s.theme;
    screensaver.pin_set = s.pin_set;
    screensaver.loaded = true;
    armInactivityTimer();
  } catch {
    // Server unavailable / pre-auth boot. Leave the
    // singleton in its default disarmed state; the next
    // bootstrap pass will retry.
    screensaver.loaded = false;
  }
}

/// Activity notification. Reset the timer if it's armed.
/// Called from the global event listeners installed by
/// `installScreensaverTracker()`.
export function noteScreensaverActivity(): void {
  if (screensaver.locked) return;
  if (!screensaver.enabled) return;
  armInactivityTimer();
}

/// Manual lock - chord-driven OR menu-driven. Bypasses the
/// inactivity timer.
export function lockNow(): void {
  if (!screensaver.loaded) return;
  screensaver.locked = true;
  cancelInactivityTimer();
}

/// Verify a candidate PIN against the server-side stored
/// hash. Returns true on success + flips `locked=false`;
/// returns false on mismatch (caller surfaces shake / error
/// feedback).
///
/// When no PIN is set on the workspace (`pin_set=false`) the screensaver
/// still arms but the lockout is a no-op. We verify against the server
/// anyway - the endpoint returns `verified: false` for the no-PIN case,
/// so this branch is consistent. The Settings UI guards against enabling
/// the screensaver without a PIN at the configuration step.
export async function unlockWithPin(
  pin: string,
  workspaceSalt: string,
): Promise<boolean> {
  if (!pin) return false;
  try {
    const hash = await hashPin(pin, workspaceSalt);
    const result = await api.screensaverVerify(hash);
    if (result.verified) {
      screensaver.locked = false;
      armInactivityTimer();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/// Dismiss the lock without going through the PIN verify endpoint.
/// Called by the overlay's any-input handler when the workspace has no
/// PIN set - the helper text promises "any input unlocks", and there is
/// nothing to verify. The `pin_set === false` branch is the gate;
/// callers MUST check before invoking. Server-side state is untouched
/// (there is no server-side "locked" view - lock state is purely
/// client-side).
export function unlockWithoutPin(): void {
  if (screensaver.pin_set) return;
  screensaver.locked = false;
  armInactivityTimer();
}

/// Caller-side pause for modals / dialogs. Returns a
/// release fn; the timer rearms when every pauser has
/// released.
export function pauseScreensaverTimer(): () => void {
  pauseCount += 1;
  cancelInactivityTimer();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pauseCount = Math.max(0, pauseCount - 1);
    if (pauseCount === 0) armInactivityTimer();
  };
}

function armInactivityTimer(): void {
  cancelInactivityTimer();
  if (!screensaver.enabled) return;
  if (screensaver.locked) return;
  if (pauseCount > 0) return;
  const ms = Math.max(1, screensaver.timeout_secs) * 1000;
  inactivityTimer = setTimeout(() => {
    inactivityTimer = null;
    screensaver.locked = true;
  }, ms);
}

function cancelInactivityTimer(): void {
  if (inactivityTimer === null) return;
  clearTimeout(inactivityTimer);
  inactivityTimer = null;
}

/// Install the global activity listeners. Returns a teardown
/// fn the caller (typically `App.svelte::onMount`) stores
/// for `onDestroy`. Listeners use `passive: true` so the
/// trackers don't add latency to user input.
export function installScreensaverTracker(): () => void {
  if (typeof window === "undefined") return () => {};
  const reset = (): void => noteScreensaverActivity();
  const events = [
    "keydown",
    "mousedown",
    "touchstart",
    "click",
    "scroll",
    "wheel",
    "pointermove",
  ] as const;
  for (const ev of events) {
    window.addEventListener(ev, reset, { passive: true, capture: ev === "scroll" });
  }
  return () => {
    for (const ev of events) {
      window.removeEventListener(ev, reset, { capture: ev === "scroll" });
    }
    cancelInactivityTimer();
  };
}
