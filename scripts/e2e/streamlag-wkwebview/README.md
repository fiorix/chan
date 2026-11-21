# WKWebView stalled-page measurement

For the owner's Mac, or an agent on it with the owner at the screen. It answers one question: when a chan window's WKWebView main thread is blocked, does the server's WebSocket send to that page stay pending, or do sends keep completing because the engine buffers them?

The fix built for a terminal losing output under a fast stream paces the PTY from that send backpressure. If sends never block in WKWebView, the server cannot see a stalled view fall behind, and that design cannot pace it. Either answer is a valid result.

## What this does and does not touch

- The build runs on a throwaway home at `/private/tmp/chan-wkstall`, with its own runtime directory, a private port and the update check off. `mac.sh` checks that your real `~/.chan` is unchanged at each stage.
- **Your installed Chan must be closed for the whole run.** Quitting it ends the terminal sessions it holds, so wait for a moment when that is fine.
- A terminal in the build is still your real shell on your real machine. Type only the commands below in it.
- Start the build only through `mac.sh start`. A double click, the Dock, Spotlight or `open` would start it on your real home.
- Add no devserver or gateway to the build. A chan devserver already running on this Mac as a service can write to `~/.chan` and trip the real-home check; if `mac.sh` stops on that, report it rather than working around it.
- The run needs about 15 minutes besides the build, and at least 40 GiB free. A guard stops the flood if the WebKit and desktop processes grow by more than 6 GiB, if free disk falls below 15 GiB, or if the trace passes 25 GiB.
- Close Safari during the run: it uses the same WebKit process names, so its memory would show up in the readings.

## Steps

Use Terminal.app, not a terminal inside Chan, and keep one window for all steps.

**1. Fetch and build.** `git status --short` must print nothing. Note the branch that `git branch --show-current` prints, so you can return to it.

```bash
[ -z "${CHAN:-}" ] && [ -z "${CHAN_HOME:-}" ] && echo "plain shell"
git status --short
git branch --show-current
git fetch origin v0133/streamlag-wkwebview-measure
git checkout --detach FETCH_HEAD
git rev-parse HEAD
make -C desktop build
```

**2. Quit the installed Chan** (Cmd+Q). This prints nothing when it has gone:

```bash
pgrep -l chan-desktop
```

**3. Prepare and start the build.** Expect `prepared: ...`, `real home untouched` and `started on the throwaway home; sampler running`. On any line starting with `STOP`, follow it and do not go on.

```bash
K=scripts/e2e/streamlag-wkwebview
bash $K/mac.sh prepare
bash $K/mac.sh start
bash $K/mac.sh open
```

A window titled for the `notes` workspace opens. If macOS asks for folder access, allow it.

**4. Start the flood.** In the `notes` window, open a terminal tab (Cmd+T) and run this. The tab fills with `the quick brown fox`. Leave it running and keep this tab showing.

```bash
perl /private/tmp/chan-wkstall/flood.pl
```

**5. Open the Web Inspector** on that window with Cmd+Option+I, and select its Console tab. Keep the inspector docked in the window, so the terminal stays visible.

**6. Put the stall script on the clipboard.** In Terminal.app:

```bash
bash $K/mac.sh copy
```

**7. Run it.** Click the Inspector's console prompt, paste with Cmd+V and press Return. It prints `stall run started`, then `stall N/5 done` five times, over about 5 minutes. **The window freezes for 30 s at a time; that is the measurement.** Do not click in it, and keep it visible and on screen, with the Mac awake. If it prints `STALL_FAILED`, report the line and stop.

**8. Copy the result.** When the console prints `STALLS_DONE`, run this at its prompt:

```js
copy(JSON.stringify(__stalls))
```

If `copy` is not available, select the JSON after `STALLS_DONE` in the console and press Cmd+C instead. Copy nothing else before step 10.

**9. Stop the build, in this order.** Click into the terminal tab and press Ctrl+C. Close that tab (Cmd+W, confirm if asked), wait three seconds, then quit the build with Cmd+Q and confirm. This prints nothing when it has gone:

```bash
pgrep -l chan-desktop
```

**10. Read the result.** It prints `real home untouched`, a `VERDICT` line and one line per stall, and saves a summary under `dev/streamlag-wkwebview/`, which git ignores.

```bash
bash $K/mac.sh finish
```

**11. Clean up** only after you have the `finish` output. This removes the throwaway home and the trace. Then return to your branch and reopen your installed Chan.

```bash
bash $K/mac.sh cleanup
git checkout -
```

## Reading the verdict

- `blocks`: all five stalls held a send pending. Send backpressure can see a stalled WKWebView.
- `never blocks`: all five stalls kept delivering with no send pending for 1 s or more. Look at the RSS growth to see where the engine buffered.
- `mixed`: the stalls disagree. Do not act on it; report the lines.
- `not established`: a check failed, shown on a `problem:` line or at the end of a stall's line. This is not evidence either way, with one exception: a guard stop for memory growth means the engine or the server kept buffering past 6 GiB, so report it as that.

The load is about 16 MiB/s in 64 KiB writes rather than a bare `yes`, to keep the trace small. Its rate far exceeds what socket buffers can hold over 30 s, so a blocking engine still shows a held send.

## What to send back

Paste the whole output of step 10, the macOS version, and anything that differed from these steps.
