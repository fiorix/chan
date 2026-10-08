# Desktop observations

Drivers that put a question to the real desktop app and read the answer from the app itself: a real `chan-desktop` under a virtual X display, real processes around it, and the page the user would see as the instrument. They exist for behavior that depends on the desktop's own engine or on its native windows, which a headless Chromium run cannot show.

They speak for one engine, the WebKitGTK the Linux desktop ships on. WKWebView on macOS and WebView2 on Windows are different engines, and a result here says nothing about them.

Like the rest of `scripts/e2e/`, these are owner-run and are not part of `make pre-push` or CI. The rules in [`../README.md`](../README.md) apply: a throwaway home and workspace for every run, bounded waits, evidence kept on failure, and only the run's own processes torn down.

## Drivers

- **`hide-flush.sh`** asks whether a hide the desktop makes without asking the page (`cs window hide`) keeps a text edit that is still inside its recovery debounce. It types a marker into a note and hides the window before the debounce can fire. It does this on tabs that are not attached to a document session, by setting the page's opt-out (`chan.docsync` = `"0"`) before any note is opened. An attached tab also sends each edit to the server's document session shortly after it is typed, and once it is there the server keeps it whatever the page does next. How soon that is, the driver does not measure; a kept edit on such a tab says nothing about the unload, so the driver would pass there whether or not the fault exists.
- **`hide-stroke.sh`** asks the same of a drawing: a pen stroke that is still inside its board's 200 ms wait, which has reached neither the file nor the server when the page goes.
- **`devserver-restart.sh`** asks whether a restart of a raw devserver closes the native windows a directly connected desktop has open on it. It stops a foreground `chan devserver run` with SIGTERM and with SIGKILL, starts it again each time, and reads which native windows lived through each. It watches the windows that appear after the desktop connects to the devserver, three in all, and leaves the desktop's own windows out. `OBS_ARMS` sets the order of the two arms.
- **`focus-open.sh`** asks what a browser's Focus, Show, Open or deck action leaves on one window record after a native desktop window is hidden. It compares browser pages, native X window ids and the record's holders, with separate arms for hides made by the desktop and by the devserver. A no-desktop terminal arm checks that browser Open still works.
- **`pdf-export.sh`** asks whether the real desktop's visible drawing pictures appear in its exported PDF, and whether `chan shell export` and the window's own Export to PDF give the same seeded deck. Its seed generator, PDF reader and window pixel reader live beside it. A representative seed does not reproduce another user's deck or window arrangement.

`lib.sh` is their shared setup. `inspect.mjs` and `hide-flush-step.mjs` are the page-level instrument and the timed step the two hide drivers share.

The Focus/Open fixture also needs Chrome and `puppeteer-core`; the PDF fixture needs the browser smoke's `pdf-lib`. Install the smoke's dependencies in the owning guest and set `OBS_SMOKE_DIR` to that directory when running a copied driver subtree. Set `CHROME_BIN` to the guest's Chrome for Focus/Open. The fixture outputs describe Linux WebKitGTK and a direct devserver connection only.

## How the answer is read

- **The page.** The desktop is started with `WEBKIT_INSPECTOR_HTTP_SERVER`, the engine's remote inspector, and `inspect.mjs` evaluates JavaScript in the product's own pages through it. A hide driver reads, before the hide, whether the editor or board holds the whole input and whether any of it is already in `localStorage`; after the page is gone it reads the origin's storage through the launcher's page, which outlives it; and after the reopen it reads the new page.
- **A `pagehide` witness.** Before the input, the timed step adds one listener to the page that writes a key to `localStorage` when `pagehide` fires. It changes nothing the page's own handlers do, and it says from storage that outlives the page that the event came.
- **X window ids.** A native window keeps its X id for as long as it lives. A window that survives a restart keeps its id; one that was closed and rebuilt comes back under a new one. Each id is asked of X directly, so a window that is gone is told from one that is only hidden. "Gone" is "X did not answer for the id", so the restart driver first asks X for one of the desktop's own windows and ends inconclusive when X answers for none.
- **Files.** The note or board on disk, read before and after.

## What makes a run count

Each hide driver refuses to judge a hide whose input it cannot show was pending. A hide arm counts only when, in that run, the page said before the hide that it held the whole input and that storage held none of it, the file did not hold it, and the native window was gone inside the wait the input was held by (500 ms from the first keystroke for text, 200 ms from the last pointer event for a stroke). Anything else ends the run as inconclusive.

The control arms say whether the instrument can see both outcomes:

- `rest` ends nothing and times how long an input left alone takes to reach the file. For a stroke it must be at least the 200 ms wait the bound assumes, or the run is inconclusive. For text it is recorded and gates nothing: that is the save's delay, not the recovery write's, and it does not say whether a tab is attached. The late kill is the control that shows a text edit was still pending.
- `settled` hides long after the input, so it must be kept.
- `kill` ends the page's web process in place of the hide, so no unload handler can run: the input must be lost and the witness silent. An input kept there means the readers cannot see a loss.
- `kill-late` holds the kill late and still inside the wait. A page killed with no unload keeps only what it had already stored or sent, so an input lost there was still pending that long. An input a hide arm kept is a pending input preserved only if that arm's page ended no later than the late kill.
- `uninspected` repeats the subject with no inspector attached to the page and no witness planted during the timed step. The inspector is still used on that page before the step, to wait for it to load and for the note or board to be on screen, and the inspector's server is enabled in the desktop process in every arm. The arm has no reading of the page before the hide, so it corroborates the subject arm and does not count by itself.

A hide driver ends 0 only when both hide arms kept their input and each page ended no later than the late kill. When the subject arm is inside the late kill and the uninspected arm is beyond it, the run is inconclusive as a whole, exit 3, and prints a PASS for the subject arm alone with both times: cite that line, not the exit code. Every run prints one line per hide arm, whatever its status. The subject arm's line says PASS only when the uninspected arm kept its input too: when the arm with no inspector lost what the instrumented arm kept, the run is inconclusive and that loss is the observation to follow up. An input that both hide arms lost is the fault wherever the late kill fell; the lines say what was lost and when each page ended, and claim no more of the timing than that. Arms that disagree, or a control that is missing, end the run inconclusive.

"Kept" is the input in the recovery buffer, the editor or the file. The recovery banner says that changes were found, not which; it is reported and decides nothing.

In `devserver-restart.sh` the two arms are each other's control: the same reading says "kept" in one and "closed" in the other.

## Exit codes

- `0`: the contract held.
- `1`: the fault was observed.
- `2`: the environment cannot run the driver.
- `3`: inconclusive. A control arm or a precondition failed, or the driver itself met an error it does not expect.

A `2` or a `3` is not a pass. A driver exits `1` through one function, `obs_fault`, and the library's exit trap turns any other exit with status 1 into `3`: a failing command the driver did not expect, or the shell's own exit for an unset variable. A hide driver's verdict script reports a fault with a status of its own, 10, so that the script crashing, which exits 1 like any failed program, ends the run as `3` too. That holds from the line where a driver sources `lib.sh`. A failure before it, such as a driver that cannot find the library, exits with the shell's own code.

## Running

Build the web bundles, `chan` and `chan-desktop` first (`make web`, then `cargo build -p chan-desktop -p chan`), and name the binaries if they are not under `target/debug`:

```bash
CHAN_DESKTOP_BIN=target/debug/chan-desktop CHAN_BIN=target/debug/chan \
    scripts/e2e/desktop-observations/hide-stroke.sh
```

Each driver starts its own `Xvfb` and window manager; no display is needed. They need `Xvfb`, `openbox`, `xdotool`, `xprop`, ImageMagick's `import`, `python3`, `curl` and, for the hide drivers, Node 22 or newer for its built-in `WebSocket`. A run takes one to two minutes. Its work directory, with the desktop's log, the per-arm records and screenshots, is printed at the start and is left in place after every run, whatever its exit code.

The hide drivers are sensitive to CPU contention: under load the native window can outlast the wait, and the run then ends inconclusive, not wrong. Record the load beside a result.

Every line a driver logs goes through a masker for launch, tenant and devserver tokens. A work directory is not masked: it holds the credentials of the throwaway processes the run started, in their logs and stores. Keep it out of reports and shared places, copy out what a report needs through the masker, and remove it only once nothing still relies on it as evidence.

While a run lasts, the engine's remote inspector listens on a loopback port of the machine, and anything that can reach that port can evaluate script in the run's throwaway desktop. That is of no account in a private guest; do not run the drivers on a host other users share.

## Controlled startup observations

`restart-startup.sh` separates an incomplete startup feed from ordinary shutdown. Its arms are `off-control`, `discard-control`, `graceful-delayed`, `kill-delayed`, `graceful-fast` and `kill-fast`. Run the two removal controls first, then delayed arms, then the matched fast arms. Each invocation creates one disposable direct devserver, desktop, workspace and X display. The engine is Linux WebKitGTK.

The two `.patch` files are diagnostic artifacts, applied only in a separate observer checkout. `restart-restore-gate.patch` pauses restore after serving starts, with one fresh private Unix socket and a 32-hex nonce, for at most 30 seconds. It resumes restore on expiry, but an expired arm is inconclusive. `restart-observer.patch` records the snapshot actually consumed by reconcile and joins a selected pass to close dispatch and native destruction. It does not change which windows reconcile desires. Review both patches and recheck their application to the candidate before observations; their applied Rust sources do not belong in the product branch.

Build the ordinary candidate first. In an isolated clone at that candidate, apply both patches, format and commit the diagnostic snapshot locally, and give it a separate Cargo target directory. Build the web bundles, CLI and native desktop there. Run fmt, clippy, the full `chan-server` and `chan-desktop` suites, and the native package gate against that frozen observer snapshot. The gate's constructed Rust tests live in `restart_restore_diagnostic`. Run the Python preflights in the guest before any real arm:

```bash
TMPDIR=/home/ubuntu/tmp python3 scripts/e2e/desktop-observations/restart-preflight.py \
    --output /home/ubuntu/evidence/restart-preflight-01
```

The preflight output directory must be absent. Its manufactured closure deliberately returns reader status 10, and the preflight succeeds only when it sees that expected status. Other constructed cases exercise survival, missing witnesses, malformed feed frames, wrong pass identity, stop loss, gate expiry, intentional off/discard and inconsistent clocks, and for the admission mode a retained window beside a proved refusal, each missing witness, a set published inside the hold, a client that never asked, and a replaced window. These inputs establish instrument behavior; they are never native observations.

Name the clean fixture checkout, clean diagnostic checkout, both full commit ids and the exact binary hashes for a real arm. Use a short, fresh output path on guest disk so the Unix socket fits Linux's path limit. For example, after assigning those identities from the build record:

```bash
export TMPDIR=/home/ubuntu/tmp
export RESTART_RUN_KIND=rehearsal
export RESTART_SOURCE_REPO=/home/ubuntu/fixtures
export RESTART_SOURCE_SHA='<full fixture commit>'
export RESTART_OBSERVER_REPO=/home/ubuntu/observer
export RESTART_OBSERVER_SHA='<full diagnostic commit>'
export CHAN_BIN=/home/ubuntu/target/observer/debug/chan
export CHAN_DESKTOP_BIN=/home/ubuntu/target/observer/debug/chan-desktop
export RESTART_CLI_SHA256='<built CLI sha256>'
export RESTART_NATIVE_SHA256='<built native sha256>'
RESTART_OUTPUT_PARENT=/home/ubuntu/r/a1 \
    bash scripts/e2e/desktop-observations/restart-startup.sh off-control
```

The driver bounds the whole arm to 300 seconds, the restore/reconnect phase to 120 seconds, and the gate to 30 seconds. The outer bound governs the sum of the nested waits. Rehearse both delayed paths with `RESTART_RUN_KIND=rehearsal` before the counted window; use `counted` only for a granted window. The label is retained in every driver verdict. A delayed arm releases only after a Starting row, a validated omitted feed and an actual consumed omission have been recorded, followed by an X checkpoint. The independent feed and watcher must both omit the selected id; equality of their full id sets is recorded as corroboration, not required. A source prediction, an elapsed pause or a parallel WebSocket recorder alone cannot prove exposure. Event times are guest epoch nanoseconds, checked against a wall/monotonic bracket; a clock discontinuity over 50 ms invalidates the join. The gate selects a scheduling point before restore, not a claim about how often a slow filesystem produces it.

A startup closure needs the old X id alive after stop, a consumed unsuppressed omission while that native window exists, one pass joining close/dispatch/destroy, and a later X loss with the desktop, launcher and terminal controls alive. The same persisted record must return after restore. Survival requires the original X id and a real editor page after exposure, with no close attempt. Page readiness is sampled without aborting the reader when the page stays closed; a proved closure does not require its page to return. An unjoined X loss, missing exposure, missing page evidence for survival or any contradictory evidence stays inconclusive. The summary distinguishes these outcomes and records replacement-title matches separately. The reader returns 10 for observed closure; the driver maps it to fault status 1. The ordinary 0/2/3 driver meanings above still apply.

A devserver that withholds its window set while it starts is read in the second mode, `RESTART_MODE=admission`, which the two delayed arms and the two controls take; a fast arm is refused in it. The default, `baseline`, is everything above. In the admission mode a delayed arm releases its gate on a proved refusal instead of an omission: after the gate's arrival, a Starting row, a 503 answer to the recorder's own upgrade request (the feed recorder writes each upgrade answer's numeric status), and a round the desktop's own feed loop read as declined. The observer patch prints that loop's rounds and what each did to the devserver's unreachable mark as `RESTART_OBS feed_round` lines, and the first frame's clear as `feed_first_frame`; they belong to the connection, carry no window label, and are exported to a file of their own. The reader then asks three things in order. First the baseline's joined closure, which still returns 10, so an input recorded before this mode existed reads as the closure it holds. Then whether a validated set was published inside the hold, which returns 11 whatever the desktop did with it; the driver maps 11 to fault status 1 as it maps 10. Then retention: the original X id shown at every checkpoint and at the end, no window of the same title beside it, no close attempt, the same persisted record returned, and a real editor page after the release, beside all three witnesses of the refusal inside the hold and a full set after it. A desktop that never asked inside the hold has no declined round and cannot pass by keeping its window. Retention also needs the desktop to have read the complete set and kept the window: its feed loop comes back on its two-second retry cadence, later than the page, so after the page the driver waits (bounded, not fatal) for the first frame of the desktop's own feed and, after that frame, a pass over a set that holds the window with no close decided, then samples X once more as the `consumed` checkpoint; without that frame, that pass and that later sample the arm reads `no-proved-retention`, since a window still there before the desktop has read any set proves nothing. A pass ahead of that frame does not count: the watch loop also makes one when its view changes or a retry falls due, over the set the desktop was sent before the restart. A passing summary also counts the unreachable marks and restored announcements the feed loop made after the old server's exit, in all and inside the hold, with the hold's length, so a mark that a refusal should never cause is reported and not inferred.

Keep the complete private run directory, including token-bearing raw API responses, out of shared reports. Report candidate and diagnostic commits, patch/driver/binary hashes, controls, gate timing, native outcome, and memory/swap peaks with each arm. A swapped or otherwise contended arm cannot stand as the quiet-window reading. A gateway arm requires the separate real gateway fixture and native TLS/account/roster/feed proof; this direct driver does not provide it.
