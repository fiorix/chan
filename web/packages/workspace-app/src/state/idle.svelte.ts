// Window-level idle tracker. After `currentIdleMs` without a "user is doing
// something" event, `idle.active` flips to true and WikiStatusBar
// fades out so it does not cover content while the user is reading.
// Any of the watched events flips it back to false and restarts the
// timer.
//
// Reset triggers: mousedown, click, touchstart, plus a
// `selectionchange` listener that only fires when a real, non-empty
// text selection lands (used by the search action). Keyboard input
// (`keydown`) is NOT a reset trigger: typing or arrow-key caret
// motion should leave the status bar hidden. Mouse motion / wheel /
// scroll are NOT reset triggers either: cursor-following scroll while the user types
// would otherwise pop the bar back on every line wrap, and ambient
// mouse twitches over the writing surface are not real intent. The
// bar stays hidden until the user clicks or selects text.
//
// Boot behavior: idle.active starts false, so the bar is visible
// when the app loads / a new tab opens; the very first arm() starts
// the fade timer, so if the user never interacts the bar fades on
// its own after the active idle interval.
//
// Pin mechanism: while a consumer holds a pin, `idle.active` stays false
// and the timer is suspended until the returned release function runs.

const IDLE_MS_DEFAULT = 5000;
/// Idle window in read-only mode. Half the write-mode default so
/// the status bar gets out of the way faster while the user is
/// reading.
const IDLE_MS_READMODE = 2500;

export const idle = $state<{ active: boolean }>({ active: false });

/// Window-level read-mode flag. True only when *every* visible
/// file tab is read-only (user-toggled or filesystem-locked); a
/// mixed write/read layout keeps this false so the status bar
/// stays full-color. Driven by a single $effect in App.svelte
/// that derives the value from layout state, so there's exactly
/// one writer to this signal regardless of pane count.
export const readMode = $state<{ active: boolean }>({ active: false });

let currentIdleMs = IDLE_MS_DEFAULT;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let pinCount = 0;

function arm(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  // Don't run the timer while something's pinned: the consumer
  // wants the bar visible until it releases.
  if (pinCount > 0) return;
  idleTimer = setTimeout(() => {
    idle.active = true;
  }, currentIdleMs);
}

/// Flip the global read-mode flag. Re-arms the idle timer at the
/// new window so the status bar auto-hides faster while reading.
export function setReadMode(active: boolean): void {
  if (readMode.active === active) return;
  readMode.active = active;
  currentIdleMs = active ? IDLE_MS_READMODE : IDLE_MS_DEFAULT;
  // Re-arm so the new window kicks in immediately rather than
  // waiting for the next user activity event.
  arm();
}

function onActivity(): void {
  if (idle.active) idle.active = false;
  arm();
}

/// Hold the status bar visible until the returned release
/// function is called.
/// Refcounted: nested or overlapping pins all need to release
/// before the idle timer rearms.
export function pinAccessory(): () => void {
  pinCount += 1;
  if (idle.active) idle.active = false;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pinCount = Math.max(0, pinCount - 1);
    if (pinCount === 0) arm();
  };
}

/// Selection-change listener: only counts as activity when the user
/// actually has a non-empty selection. A bare caret move (no
/// selection) is treated as keyboard activity and intentionally
/// ignored so the bar stays hidden while the user is typing.
function onSelectionChange(): void {
  if (typeof window === "undefined") return;
  const sel = window.getSelection();
  if (!sel) return;
  if (sel.isCollapsed) return;
  const text = sel.toString();
  if (text.length === 0) return;
  onActivity();
}

/// Install once at app startup. Returns a teardown for symmetry, but
/// the listener is intended to live for the entire app lifetime.
export function installIdleTracker(): () => void {
  if (typeof window === "undefined") return () => {};
  const events = ["mousedown", "click", "touchstart"] as const;
  for (const ev of events) {
    window.addEventListener(ev, onActivity, { passive: true, capture: true });
  }
  document.addEventListener("selectionchange", onSelectionChange, {
    passive: true,
  });
  arm();
  return () => {
    for (const ev of events) {
      window.removeEventListener(
        ev,
        onActivity,
        { capture: true } as EventListenerOptions,
      );
    }
    document.removeEventListener("selectionchange", onSelectionChange);
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
}
