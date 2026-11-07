# The terminal tab assumes WKWebView fires no visibilitychange across a sleep

Status: raised on 2026-11-07 from the v0.125.0 release's Mac reading of the display-sleep repaint; accepted by the owner for v0.126.0 at the v0.125.0 cut; not started.

## What is there now

`web/packages/workspace-app/src/components/TerminalTab.svelte` installs `focus`, `pageshow` and `visibilitychange` listeners for the terminal's host-resume recovery and says in the comment beside them that a macOS display or system sleep fires none of the three in the desktop app's WKWebView, the window staying visible and focused through the sleep; `App.svelte` says the same above its own `visibilitychange` listener. Both therefore rely on the wall-clock gap detector (`wakeGap.ts`, a coarse interval that fires far later than scheduled when timers froze) to run the renderer recovery, the PTY socket recycle and `scheduleResume`. The owner's Mac unified log, read for the display-sleep repaint, shows WebKit logging `view visibility state changed 0 -> 1` for each chan window at each wake, the transition that normally drives `document.visibilityState` and the event; whether the page sees it was not checked, so the comment stands on an assumption. The native side repaints every webview one second after a display wake and one second after an occluded window turns visible (`desktop/src-tauri/src/wake_repaint.rs`, `REPAINT_DELAY`), and the owner reads the result on the macOS build: the transparent terminals come back by themselves, but for a second or two the window shows its title bar alone before the terminal paints. That wait has the one-second coalescing as its floor, and a page signal that fires on wake, if one does, could paint sooner.

## Desired contract

1. A reading on the owner's Mac establishes what the page sees across a display sleep and a system sleep in WKWebView: `document.visibilityState` before and after, whether `visibilitychange`, `pageshow` and `focus` fire, and when relative to the native occlusion notification and the display wake.
2. The comments in `TerminalTab.svelte` and `App.svelte` state what the reading found, and the code uses every signal the reading found: an event that fires on wake runs the recovery and the resume at once, with the gap detector kept as the fallback for the case that fires none.
3. A window turning visible after a wake paints its terminals as soon as a signal says so, so the wait with the title bar alone shrinks to what the renderer needs, and the native one-second repaint stays as the floor for a page that received no signal.

## Boundaries

- The two listeners' comments and their wiring, the gap detector's role as fallback, and the native repaint's delay if the reading shows a page signal arrives first; no change to the repaint's trigger set or to the terminal renderer.
- The reading comes first; no code moves on an assumption, which is how the present comment was written.

## Acceptance

1. The Mac reading, recorded with its log lines and the page's own event log: which of the three events fire across a display sleep and a system sleep, and when.
2. With the fix, on the owner's Mac: after a display sleep the terminals paint within the time the reading shows the first signal arrives, read three times with the clock from the wake; the one to two seconds of title bar alone on the build before it is the red.
3. The gap detector still recovers a page that receives no event, shown by a test that fires none and advances the coarse interval.
4. `make web-check` green at the tip.
