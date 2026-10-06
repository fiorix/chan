# Desktop observations

Drivers that put a question to the real desktop app and read the answer from the app itself: a real `chan-desktop` under a virtual X display, real processes around it, and the page the user would see as the instrument. They exist for behavior that depends on the desktop's own engine or on its native windows, which a headless Chromium run cannot show.

They speak for one engine, the WebKitGTK the Linux desktop ships on. WKWebView on macOS and WebView2 on Windows are different engines, and a result here says nothing about them.

Like the rest of `scripts/e2e/`, these are owner-run and are not part of `make pre-push` or CI. The rules in [`../README.md`](../README.md) apply: a throwaway home and workspace for every run, bounded waits, evidence kept on failure, and only the run's own processes torn down.

## Drivers

- **`hide-flush.sh`** asks whether a hide the desktop makes without asking the page (`cs window hide`) keeps a text edit that is still inside its recovery debounce. It types a marker into a note and hides the window before the debounce can fire. It does this on tabs that are not attached to a document session, by setting the page's opt-out (`chan.docsync` = `"0"`) before any note is opened. An attached tab also sends each edit to the server's document session shortly after it is typed, and once it is there the server keeps it whatever the page does next. How soon that is, the driver does not measure; a kept edit on such a tab says nothing about the unload, so the driver would pass there whether or not the fault exists.
- **`hide-stroke.sh`** asks the same of a drawing: a pen stroke that is still inside its board's 200 ms wait, which has reached neither the file nor the server when the page goes.
- **`devserver-restart.sh`** asks whether a restart of a raw devserver closes the native windows a directly connected desktop has open on it. It stops a foreground `chan devserver run` with SIGTERM and with SIGKILL, starts it again each time, and reads which native windows lived through each. It watches the windows that appear after the desktop connects to the devserver, three in all, and leaves the desktop's own windows out. `OBS_ARMS` sets the order of the two arms.

`lib.sh` is their shared setup. `inspect.mjs` and `hide-flush-step.mjs` are the page-level instrument and the timed step the two hide drivers share.

## How the answer is read

- **The page.** The desktop is started with `WEBKIT_INSPECTOR_HTTP_SERVER`, the engine's remote inspector, and `inspect.mjs` evaluates JavaScript in the product's own pages through it. A hide driver reads, before the hide, whether the editor or board holds the whole input and whether any of it is already in `localStorage`; after the page is gone it reads the origin's storage through the launcher's page, which outlives it; and after the reopen it reads the new page.
- **A `pagehide` witness.** Before the input, the timed step adds one listener to the page that writes a key to `localStorage` when `pagehide` fires. It changes nothing the page's own handlers do, and it says from storage that outlives the page that the event came.
- **X window ids.** A native window keeps its X id for as long as it lives. A window that survives a restart keeps its id; one that was closed and rebuilt comes back under a new one. Each id is asked of X directly, so a window that is gone is told from one that is only hidden.
- **Files.** The note or board on disk, read before and after.

## What makes a run count

Each hide driver refuses to judge a hide whose input it cannot show was pending. A hide arm counts only when, in that run, the page said before the hide that it held the whole input and that storage held none of it, the file did not hold it, and the native window was gone inside the wait the input was held by (500 ms from the first keystroke for text, 200 ms from the last pointer event for a stroke). Anything else ends the run as inconclusive.

The control arms say whether the instrument can see both outcomes:

- `rest` ends nothing and times how long an input left alone takes to reach the file. For a stroke it must be at least the 200 ms wait the bound assumes, or the run is inconclusive. For text it is recorded and gates nothing: that is the save's delay, not the recovery write's, and it does not say whether a tab is attached. The late kill is the control that shows a text edit was still pending.
- `settled` hides long after the input, so it must be kept.
- `kill` ends the page's web process in place of the hide, so no unload handler can run: the input must be lost and the witness silent. An input kept there means the readers cannot see a loss.
- `kill-late` holds the kill until after the hide arms' pages have ended and still inside the wait. A page killed with no unload keeps only what it had already stored or sent, so an input lost there was still pending that long, and a hide arm counts only if its page ended no later.
- `uninspected` repeats the subject with no inspector attached to the page and no witness planted during the timed step. The inspector is still used on that page before the step, to wait for it to load and for the note or board to be on screen, and the inspector's server is enabled in the desktop process in every arm. The arm has no reading of the page before the hide, so it corroborates the subject arm and does not count by itself.

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
