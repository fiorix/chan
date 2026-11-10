# The terminal tab assumes WKWebView fires no visibilitychange across a sleep

Status: closed by the owner on 2026-11-10 without the reading and without the fix: "the wake-visibility is fine on the mac for now.. if something strange happens i'll report; for now we treat as acceptance and can go to ga". On his Mac the terminals come back after a sleep as the code stands. No code has moved: the comments in `TerminalTab.svelte` and `App.svelte` still state the assumption this item questions, acceptance 1 to 4 below were not run, and the reading procedure stays here for the day he reports something. Carried to v0.127.0 at the v0.126.0 cut on 2026-11-08: the reading procedure, probe and log query shipped in [v0.126.0](../../release/release-v0.126.0.md) through the owner's `docs/wakevis-reading`; the owner's run of the reading and the fix are pending; no code has moved.

Record before the release: raised on 2026-11-07 from the v0.125.0 release's Mac reading of the display-sleep repaint; accepted by the owner for v0.126.0 at the v0.125.0 cut; the reading's procedure, probe and log query are written (Reading procedure, below) and wait on the owner's run; no code has moved.

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

## Reading procedure

The reading answers acceptance 1 on the installed Chan 0.125.0 with nothing to build, in about 20 minutes. Two instruments run side by side and line up by wall clock: a page probe pasted into the window's Web Inspector, which logs what the page sees, and a unified-log query, which logs what WebKit, the window server, powerd and loginwindow did in the same seconds.

### The page probe

The probe is `scripts/e2e/wkwebview-wake-probe.js`, a file rather than a block here: `pbcopy` takes it byte for byte with no fence to trim, `node --check` reads it, the headless check below ran those same bytes, and acceptance 2 can time the fix with the same probe. It records every `visibilitychange` (with `document.visibilityState`), `pageshow` and `pagehide` (with `persisted`), window `focus` and `blur`, `freeze` and `resume` if WebKit fires them, each run of the desktop's wake repaint in the page (a `MutationObserver` sees `wake_repaint.js` append its `#chan-wake-repaint` element), and every tick of a one-second interval that lands more than 2.5 s after the one before it, with whether that gap is over the 6 s line `wakeGap.ts` calls a wake. Each row carries `Date.now()` as local time and as UTC, `performance.now()`, `document.visibilityState` and `document.hasFocus()`. The log lives in memory and in `sessionStorage` under `chan.wakevis.probe`, so a sleep, a closed inspector or a reload keeps it, and a second paste stops the first copy and keeps its rows. It only listens: no handler cancels an event, it requests no animation frame and so asks for no rendering update, and it touches no app state.

Console commands: `wakevis.mark("label")` adds a row and returns its number; `wakevis.table(n)` prints the rows from row n; `copy(wakevis.text(n))` copies them as tab-separated text; `copy(wakevis.logArgs(n))` copies the `--start` and `--end` pair for `log show` that runs from a minute before row n to now.

Headless check, Chrome for Testing 126 (headless shell) over the DevTools protocol, the probe and `wake_repaint.js` evaluated as the console and the desktop evaluate them, 18 of 18: three pastes leave one listener set and keep every row; an element's focus is not logged as the window's; `wake_repaint.js` logs one `native-repaint` row and its element still goes; `Page.setWebLifecycleState` frozen for 4 s logs `visibilitychange` (hidden), `freeze`, `resume` and a late tick of 4.9 s ("over 6 s: no"), and frozen for 7 s a late tick of 8.0 s ("yes"); a reload keeps the log in `sessionStorage` together with the reload's own `pagehide` (`persisted=false`), and a paste after it restores every row; `stop()` leaves nothing listening; `table()` reaches `console.table` and `text()` gives a header and one line per row; no page exception. Chrome is not WebKit: this shows the probe's mechanics, not what WKWebView fires.

### Opening the inspector on 0.125.0

The release build carries WebKit's inspector: `desktop/src-tauri/Cargo.toml` enables the `tauri` crate's `devtools` feature, with which wry 0.57 sets the WKWebView's `isInspectable` (macOS 13.3 and later) and the `developerExtrasEnabled` preference, chan sets no `devtools(false)` on any webview, and the installed `/Applications/Chan.app` 0.125.0 binary carries both selectors. Neither path was opened while preparing the reading, since no Chan app was touched.

- In Chan: right-click the pane's tab strip on its empty stretch, or the body of a pane side with no tab, and choose Open Inspector; or press Cmd+Opt+I with the window focused; or run Open Inspector from the command launcher. If the inspector opens docked inside the window, detach it into its own window first: docked, it shrinks the page and the terminal refits.
- In Safari: Settings, Advanced, "Show features for web developers"; then Develop, the Mac's name, Chan, the window's page. The inspector then lives in Safari, so it does not resize the window or add a page of its own to chan-desktop's log.

Close the inspector before every sleep and reopen it after the wake: whether an attached inspector keeps WebKit from suspending the page is not established, and the probe logs without it.

### The native log

One predicate serves both `log show` and `log stream`. In bash, set it once:

```bash
P='(process == "chan-desktop" AND subsystem == "com.apple.WebKit" AND (
    (category == "ViewState" AND eventMessage CONTAINS "view visibility state changed")
    OR (category == "Process" AND eventMessage CONTAINS "runJavaScriptInFrameInScriptWorld: frameID")
    OR (category == "ProcessSuspension" AND (eventMessage CONTAINS "sendPrepareToSuspend:"
        OR eventMessage CONTAINS "didChangeThrottleState(Suspended)" OR eventMessage CONTAINS "ProcessDidResume IPC"))))
  OR (process == "WindowServer" AND eventMessage CONTAINS "Display:Power" AND eventMessage CONTAINS "Broadcast:")
  OR (process == "powerd" AND (eventMessage BEGINSWITH "Display state:"
      OR (category == "sleepWake" AND (eventMessage BEGINSWITH "Entering Sleep" OR eventMessage CONTAINS "Wake from"))))
  OR (process == "loginwindow" AND (eventMessage CONTAINS "startScreenLock:] | entered" OR eventMessage CONTAINS "screen unlocked"))
  OR (process == "kernel" AND (eventMessage CONTAINS "PMRD" OR eventMessage CONTAINS[c] "wake reason"))'

# Live, through the whole sitting (the only way to keep kernel lines):
log stream --style compact --predicate "$P" > stream.log 2>&1 &

# After the fact, for one case; both bounds are local time, whole seconds:
log show --style compact --predicate "$P" --start "2026-11-08 14:44:50" --end "2026-11-08 14:56:00"
```

What each clause catches:

- WebKit `ViewState` in chan-desktop: `view visibility state changed 1 -> 0` and `0 -> 1` per page, which WebKit logs from the same window occlusion change the desktop's repaint observes. Each line names the page (`pageProxyID`, `webPageID`) and its WebContent `PID`.
- WebKit `Process`: `WebPage::runJavaScriptInFrameInScriptWorld: frameID=0` per page whenever the app evaluates a script in it: the wake repaint, but also any Tauri event delivery. The line whose time matches a `native-repaint` row of the probe names this window's `webPageID`.
- WebKit `ProcessSuspension`: `sendPrepareToSuspend:` when WebKit asks a web process to suspend, `didChangeThrottleState(Suspended)` when it is suspended, and `sending ProcessDidResume IPC because ...` with the reason when it resumes or a pending suspend is called off.
- WindowServer `[ Display:Power ] Broadcast:` `Will Dim`, `Did Dim`, `Will Sleep`, `Did Sleep`, `Will Wake`, `Did Wake`: the display's power transitions.
- powerd `Display state: Off` and `On`; `Entering Sleep state due to '...'`, `Wake from ...` and `DarkWake from ...`: display and system sleep and wake, with reasons.
- loginwindow `-[LWScreenLock startScreenLock:] | entered kLWLockFromDisplayDim (5)` and `DiskArb - screen unlocked`: the lock screen going up and coming down.
- kernel `PMRD` and `wake reason`: not verified. On the owner's Mac the kernel's lines stay only in its in-memory buffer, about a minute deep, so `log show` returns none for a past sleep and only a `log stream` running through the sleep can catch them; no system sleep fell inside that minute while the query was prepared. powerd's lines carry the same sleep and wake and stay in the store: the maintenance sleep of 2026-11-05 reads `Entering Sleep state due to 'Maintenance Sleep'` at 16:14:21.897 and `Wake from Deep Idle [CDNVA] : due to smc.sysState.Wake(0x70070000) lid ...` at 16:16:32.238.

Both commands print local time to the millisecond, the clock of the probe's `local` column; the owner's Mac keeps UTC in November, so the probe's `utc` column reads the same. `--start` and `--end` refuse a fraction of a second. Neither needs `sudo`.

chan-desktop's own wake-repaint lines, `wake repaint due` at DEBUG with its trigger and `repainting every shown window back in view` at INFO with the webview count (`desktop/src-tauri/src/wake_repaint.rs`), go to stderr through `tracing` and never reach the unified log, and a Dock or Finder launch discards stderr. The WebKit `runJavaScriptInFrameInScriptWorld` lines and the probe's `native-repaint` rows place the repaint without them. To have the trigger lines as well, quit Chan, start it from Terminal.app, and minimize Terminal so it covers nothing; `tracing` stamps these lines in UTC:

```bash
NO_COLOR=1 CHAN_LOG=warn,chan_desktop=info,chan_desktop::wake_repaint=debug \
  /Applications/Chan.app/Contents/MacOS/chan-desktop 2>> ~/wakevis/desktop.log
```

### What the owner's Mac log already shows

Read-only, the predicate over the display sleep at 14:45 on 2026-11-08 (an idle dim, then sleep), with Chan 0.125.0 installed and running since 2026-11-07 13:02 (pid 82326); lines trimmed and merged by hand:

```
14:44:54.039 WindowServer  Broadcast: Will Dim
14:45:04.521 WindowServer  Broadcast: Will Sleep
14:45:04.522 loginwindow   startScreenLock: entered kLWLockFromDisplayDim (5)
14:45:04.531 chan-desktop  ViewState webPageID=4463 PID=3936  visibility 1 -> 0
14:45:04.531 chan-desktop  ViewState webPageID=3131 PID=67355 visibility 1 -> 0
14:45:04.563 powerd        Display state: Off
14:49:04.536 chan-desktop  PID=3936, PID=67355 sendPrepareToSuspend
14:49:08.259 chan-desktop  PID=3936, PID=67355 didChangeThrottleState(Suspended)
14:55:10.635 WindowServer  Broadcast: Will Wake
14:55:10.692 powerd        Display state: On
14:55:11.676 chan-desktop  ProcessDidResume IPC because the process was suspended
                           (PID=8705, 3936, 67355)
14:55:11.691 chan-desktop  runJavaScriptInFrameInScriptWorld, webPageID 4463, 3131, 1461
14:55:11.693 chan-desktop  PID=3936, PID=67355 sendPrepareToSuspend
14:55:12.686 chan-desktop  ViewState webPageID=4463, 3131 visibility 0 -> 1
14:55:12.686 chan-desktop  ProcessDidResume IPC because the WebProcess is still
                           processing request to suspend (PID=3936, 67355)
14:55:12.687 loginwindow   DiskArb - screen unlocked
14:55:13.688 chan-desktop  runJavaScriptInFrameInScriptWorld, webPageID 4463, 3131, 1461
```

What it means for the procedure:

- A display sleep on the owner's Mac locks the screen at once. Both shown pages' views turn not visible 10 ms after `Will Sleep`, the lock going up between the two, and turn visible again at the unlock, 2.0 s after the display woke rather than at the display wake. WebKit's own view state does not stay visible through this sleep; whether `document.visibilityState` follows it is what the probe reads.
- WebKit asked both web processes to suspend 240 s after their views turned not visible, and they were suspended 3.7 s later. A display sleep shorter than that never suspends the page, so the display sleep below lasts 5 minutes.
- The desktop's first repaint ran 1.0 s after the display wake, with the lock screen still up. WebKit resumed the suspended processes for that script alone and asked them to suspend again 2 ms after it; they were still in that request when the views turned visible at the unlock, where WebKit called it off and kept them running. The second repaint ran 1.0 s after the views turned visible. So the page comes back at the unlock from a pending suspend, and whether a `visibilitychange` reaches it there, and how long before the second repaint, is what the probe reads.

### Steps

Setup, about 3 minutes:

1. Leave one Chan window shown, with a terminal tab focused, and close or hide the other Chan windows, so the log's view lines are this window's and its launcher panel's. Note the lock setting: System Settings, Lock Screen, "Require password after screen saver begins or display is turned off".
2. In that terminal: `mkdir -p ~/wakevis && cd ~/wakevis`, paste the `P='...'` block above, and start the stream: `log stream --style compact --predicate "$P" > stream.log 2>&1 &`.
3. From a chan checkout that has the probe: `pbcopy < scripts/e2e/wkwebview-wake-probe.js`.
4. Open the inspector, detach it if it docked, open its Console, paste, Return. It prints `wakevis: recording, 1 rows`.

(a) Display sleep, about 8 minutes:

1. In the console: `wakevis.mark("a")`. Note the number it returns; it is n below.
2. Close the inspector and click into the terminal.
3. Type `pmset displaysleepnow` and press Return. Note the time.
4. Leave the Mac alone for 5 minutes.
5. Wake it with Shift, which types nothing if no lock screen takes it, unlock, and watch the window: note by eye whether the title bar shows alone and for about how long. Touch nothing for 15 s.
6. Open the inspector and run `wakevis.table(n)`. Then `copy(wakevis.text(n))`, and in the terminal `pbpaste > a-page.tsv`. Then `copy(wakevis.logArgs(n))`, and in the terminal type `log show --style compact --predicate "$P" `, paste, type ` > a-native.log` and press Return.

(b) System sleep, about 5 minutes: as (a), with `wakevis.mark("b")`; in step 3 `pmset sleepnow` (or Apple menu, Sleep); 2 minutes in step 4; files `b-page.tsv` and `b-native.log`.

(c) Occlusion alone, about 2 minutes, optional: as (a), with `wakevis.mark("c")`; in step 3 switch minitile to another workspace, or cover the window completely with another window, instead of sleeping; 30 s in step 4, then come back; files `c-page.tsv` and `c-native.log`. A cover of 5 minutes also reaches the suspension.

To finish, `kill %1` stops the stream. The files in `~/wakevis` are the record. In each page table the reading runs from the case's `mark` row to the `blur` logged when the inspector reopened; that `blur` and the rows after it come from the collection.

### What to record

For acceptance 1, per case, from the page table and the native log:

1. Which of `visibilitychange`, `pageshow` and `focus` fired after the wake, and which of `visibilitychange`, `pagehide`, `blur` and `freeze` fired going in; `document.visibilityState` before the sleep and after the wake (the `vis` column).
2. When each fired, as an offset from the display wake (`Will Wake`; for (c), the uncover), from the native occlusion notification (this page's `view visibility state changed 0 -> 1`), and from the unlock (`screen unlocked`).
3. The first `late-tick` after the wake: when, its wall and perf gaps (a perf gap well under the wall gap means the monotonic clock stopped, as in a system sleep), and whether it is over 6 s, the gap past which 0.125.0's own detector (`wakeGap.ts`, ticking every 2 s) runs the recovery and the resume.
4. The `native-repaint` rows against the two triggers, the display wake plus 1 s and the view turning visible plus 1 s.
5. By eye, how long the title bar showed alone.

| Reading | (a) display | (b) system | (c) cover |
| --- | --- | --- | --- |
| lock setting | | | |
| down: Will Sleep, Entering Sleep or cover | | | |
| view 1 -> 0, this page | | | |
| web process suspended | | | |
| up: Will Wake, Wake from or uncover | | | |
| screen unlocked | | | |
| view 0 -> 1, this page | | | |
| vis before, after | | | |
| visibilitychange hidden, visible | | | |
| pagehide, pageshow | | | |
| blur, focus | | | |
| freeze, resume | | | |
| first late-tick: time, gaps, over 6 s | | | |
| native-repaint rows | | | |
| first page signal minus up | | | |
| first page signal minus view 0 -> 1 | | | |
| title bar alone, by eye | | | |

The filled table, the page rows and the log lines it rests on go in a section of their own after this one.
