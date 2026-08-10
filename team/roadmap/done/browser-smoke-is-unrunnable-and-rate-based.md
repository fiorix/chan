# The browser smokes cannot run in any container the project builds in, and wait on a rate

Closed: shipped in [v0.88.0](../../release/release-v0.88.0.md).

Status: REGISTERED 2026-08-09, from running the six editor checks against merged `main` at the owner's request, after noticing the CAS change had reached `main` with no editor exercised in a browser at any point in the round.
SHIPPED in v0.88.0, incompletely: the suite runs from a clean container through `make browser-smoke-deps`, and 23 network-idle waits across 19 checks now wait on the property each check consumes, including a window-registration barrier the rate wait had been supplying unnamed. Four of the five acceptance lines are met. The fifth is not: `56-external-edit-matrix` reached nine of ten consecutive runs on a loaded host, stopped by two defects this work uncovered rather than introduced, both registered separately at their own severity, an intermittent stale read on the editor's external-edit convergence path, carried forward as [an-external-edit-intermittently-never-reaches-a-dirty-editor](../v0.89.0/an-external-edit-intermittently-never-reaches-a-dirty-editor.md), and an editor that intermittently never mounts. Explicitly NOT covered: the four network-idle sites in `gateway-zone-browser.mjs`, where the wait may be correct because those pages may hold no live transports; the suite's remaining fixed wall-clock bounds on genuine property waits; and the WebKitGTK blind spot that no Chrome-driven check can see, which running this suite does not close.

## What

Two separate defects, found together because the first hides the second.

**The suite cannot run where the project builds.** `scripts/e2e/browser-smoke` needs Chrome. The `chan-ann-ubuntu` rootfs every lane container is built from carries the Rust and Node toolchains and no browser dependencies: a downloaded Chrome fails to start on `libnspr4.so`, `libnss3.so`, `libnssutil3.so`, `libsmime3.so`, and `libasound.so.2`. The host carries no toolchain at all by policy, so there is no machine in the normal workflow where these checks run. `make pre-push` does not invoke them either; the gate ends at `web-check`, `web-marketing-check`, `shortcuts-check`, `host-build-check`.

The result is a suite that exists, is good, and is opt-in by accident. Six of its checks cover the editor's external-edit convergence path, and that path took four consecutive releases of hardening (`editor-external-restore-echo-swallow` v0.76.0, `editor-filesystem-edit-convergence` v0.78.0, `editor-widget-tests-are-nondeterministic` v0.86.0, `mtime-cas-silently-overwrites-external-edits` v0.87.0) with 18 commits touching `flushed_mtime_ns` in one month, and no lane journal in this round mentions `browser-smoke` once.

**The checks wait on a rate.** `56-external-edit-matrix` opens each step's window with:

```js
await p.goto(`${serverUrl}&w=...`, { waitUntil: "networkidle2", timeout: 60_000 });
```

`networkidle2` demands the network go quiet in an application holding live WebSockets. `waitUntil: "networkidle2"` appears in **19** of the suite's checks.

The suite's own README already rules this out: *"A check asserts a property, not a rate. A wall-clock threshold with no slack fails on a loaded host."* The rule is written down and the checks do not follow it.

## Evidence, 2026-08-09

Six checks against `main` at `3ecc6e87`, in the gate container with Chrome dependencies installed by hand:

| check | result |
| --- | --- |
| `50-editor-collab` | PASS 4.5s |
| `55-external-edit-reopen` | PASS 14.2s |
| `56-external-edit-matrix` | FAIL, navigation timeout 60s |
| `57-external-restore-converge` | PASS 5.8s |
| `63-external-shrink-convergence` | PASS 11.1s |
| `64-conflict-banner-reload` | PASS 2.6s |

`56` re-run alone twice on the same binary and workspace: **1 pass, 1 fail**, so 1 pass in 3 overall. The failure moves between steps: once after `D-rapid-edits`, once after `A-atomic-save`. The passing isolated run completed all six steps `A` through `F` with every content assertion correct.

**No content assertion has ever failed.** Only the navigation wait times out.

Ruled out, rather than assumed: a request loop keeping the page busy. The failing run logs exactly the same two 404s as the passing run, `POST /api/library/command-capabilities` and a missing `SourceCodePro-Regular.otf.woff2`, once each. Nothing polls. Host load average was 3.57 across the runs.

## Why this belongs with the timing sweep

This is instance ten of the class [load-sensitive-tests-keep-recurring-after-three-sweeps](../done/load-sensitive-tests-keep-recurring-after-three-sweeps.md) enumerates, and the first outside the Rust suites. It is also the clearest statement of that item's thesis: the sweep's own amendment established that classification finds sites while running under pressure finds tests, and this one was found the same way, by running it under load rather than by reading it.

The two 404s are separately worth a look and are deliberately not made this item's problem. `POST /api/library/command-capabilities` returning 404 on a plain workspace window may be correct or may be a surface that moved; nobody has asked.

## The suite also has a blind spot by construction, 2026-08-09

Found while checking whether `v087-webkit-flip-faces` inherited the environment half of this item. It does, and its harness says why the environment problem is the smaller one.

`scripts/e2e/webview-flip-render.py`, added by that branch, states the case in its own docstring: the desktop webview is WebKitGTK, WebKitGTK ignores `backface-visibility` on every element, and Chrome honours it. So a card whose hidden face is hidden only by that property **renders correctly under `browser-smoke/` and covers the entire window in the shipped app**. Chrome-driven checks cannot see that class of defect at all.

That reframes this item. The environment gap means the Chrome checks do not run; this means running them would not have been sufficient anyway for anything the two engines disagree about. Two different holes, and closing the first does not close the second.

The new harness needs python-gobject with the WebKit2 4.1 typelib and an X or Wayland display. This host has python3 and neither: `gi.require_version("WebKit2", "4.1")` raises, `DISPLAY` and `WAYLAND_DISPLAY` are unset, and there is no `xvfb-run`. So it is unrunnable here for the same reason the Chrome checks are, one stack over.

It handles that better than this item's subject does, and the handling is worth copying: it exits **2** for an unavailable GUI stack, distinct from 0 and 1, and its docstring says plainly that *a skip is not a pass; report it as a skip*. An environment that cannot run a check should say so in a way a caller can act on, rather than being silently absent from the run.

## What the environment turned out to be, 2026-08-10

Three findings from closing the environment half that the item did not predict.

**A filter matching nothing printed `ALL GREEN` after running zero checks.** `SMOKE_ONLY=999` built the web bundle and the binary, selected no check, and reported the suite green. That is this item's own thesis in miniature and worse than the environment gap it was found beside: a suite that cannot tell "nothing ran" from "everything passed" is opt-in by accident a second time. The runner now resolves the selection before it builds anything and exits 2 on an empty one.

**The dependency set has a member that is not Chrome's.** `libnss3` carries four of the five missing sonames and pulls `libnspr4`; `libasound2t64` carries the fifth. Ahead of both sits `unzip`, which is the *downloader's* dependency: `@puppeteer/browsers` extracts with it, and without it the install fails leaving a browser directory holding no executable. The next attempt then reports "the executable is missing" rather than the real cause, so the failure moves one layer away from where it happened. Clearing an incomplete download is the fix. No font package is needed; the stock rootfs carries DejaVu.

**The provisioner shipped with the same class of bug it exists to remove.** Its ALSA package probe ran `apt-cache` before `apt-get update`. A container built from the stock rootfs carries no package lists, so `apt-cache` answered "no such package" for every candidate and the target died with `no ALSA runtime package found`. It passed in the author's own container only because `apt-get update` had been run there by hand during investigation. A genuinely clean container caught it and invalidated the first commit. An environment difference that a dirty box hides is exactly what this item is about, and it reappeared inside the fix.

**The three-value convention is not memorable, and that is a finding about the convention rather than about anyone.** `provision.sh` exits 1 for "tried and failed" and 2 for "this environment cannot be provisioned"; `make` exits 2 for any recipe failure and so erases the distinction at the documented entry point. That pair was written down backwards more than once, in prose, on the day it shipped, by readers who had the correct output pasted directly above their own sentence. Nothing was miswritten in code and no wrong exit code was ever committed. The lesson is that 0/1/2 carries no mnemonic: which of 1 and 2 means "broken" and which means "absent" has to be read off the source or measured, never recalled, and a caller that wraps the script in `make` cannot observe it at all. Anything relying on that distinction states it in place and, where it matters, measures it.

The set costs about 404 MB per container, 398 MB of it Chrome. It is installed by a target rather than baked into the shared rootfs, so a container that never runs the suite pays none of it; baking it in would have grown every container whether or not it opened a browser. Paying the 398 MB once for a whole storage pool instead of once per container is possible by bind-mounting a host-side puppeteer cache, and is blocked by needing `npx` on a host that carries no Node toolchain by policy. Recorded as a known option with its blocker, not proposed.

## What the waits turned out to be, 2026-08-10

Counted precisely before any of them was touched: `waitUntil: "networkidle2"` appears **23 times across 19 checks** in `browser-smoke/`. Both numbers matter, because "19" above is checks and reads as occurrences.

At 21 of the 23 sites a `waitForSelector` on something real already followed the rate wait on the very next line: `.pane` for a workspace window, the machine toggle for the launcher, `#launcher-demo.mounted` for the marketing manual page, `[aria-label="Connect shared-lab"]` for native trust. `98-workspace-root-loss` goes further and polls `/api/index/status` for a doc count, with a comment refusing to trust "a transient idle".

**That reads as "the rate wait is redundant", and it is wrong.** Two readers agreed on it, wrote it down, and the suite falsified it.

A `waitForSelector` on the next line proves *a* property held, not *the* property the check depends on. `.pane` is the client rendering its own state. Twelve of these checks then drive the window **from outside the page** with `cs` or `chan shell --window <id>`, and those commands reach a window through the server's session registry (`send_window_command_if_live` in `crates/chan-server/src/control_socket.rs`, which refuses with `is not connected` when `dispatch_if_live` returns `None`), which a window joins when its session socket registers. The two events are unordered. `networkidle2` had been waiting for the network to go quiet, which implies that registration completed, so it was supplying a barrier **nobody had named** and that no assertion in the suite covered. Removing it costs those checks an intermittent `window "..." is not connected` refusal.

The affected checks are `55`, `56`, `57`, `58`, `59`, `63`, `64`, `98`, `107`, `120`, `121` and `123`. The repair is that barrier made explicit as `ctx.waitWindowLive(windowId)`: polling `chan shell pane list --window <id> --json`, a read-only round trip through the same liveness path, so it succeeds exactly when the property holds rather than standing in for it. Shared code because it is one property; per-site in the sense the contract means, because it is the property those particular checks consume.

So this item's "19 sites, each needing a real readiness signal rather than a blanket substitution" was accurate as written, and the first attempt graded it down to a mechanical swap. When auditing a wait, the question is what the next twenty lines consume, not whether an assertion follows.

**What caught it is the acceptance line, not review.** The regression survived a full 42-check suite run in which `56` passed, survived an interleaved A/B across six other checks, and survived two readers agreeing the reasoning was sound. Ten consecutive runs on a loaded host surfaced it on the third attempt. That is the argument for the ten-consecutive bar, and it is the item's own thesis, that a check which cannot distinguish two states reports the convenient one, landing on the item's own repair.

`107-terminal-rename-inventory` was the one site where the rate wait was doing visible work: it passed `"networkidle2"` explicitly for two co-viewing pages, under a comment asking for "initial empty-layout reconciliation" to finish before either view creates a terminal. The property the comment describes is directly assertable, so it now holds until both pages render the same pane ids. Its `openWindow` helper carried a `waitUntil` parameter and that parameter is gone; removing the affordance is what stops the rate growing back.

Four more occurrences live in `scripts/e2e/gateway-zone-browser.mjs`. They are deliberately not fixed here and are registered separately, because the identity SPA's OAuth pages may genuinely have no live transports, which would make `networkidle2` correct there. That is a behavioural question about a different surface, not a mechanical repeat.

## Contract

- The browser smokes are runnable in the project's own container workflow, without hand-installing browser dependencies.
- A check waits on a property the application asserts, not on the network going quiet.
- Whether the suite is part of the gate is a deliberate decision that is written down, rather than the accident of an environment that cannot run it.

## Acceptance

- A documented, repeatable path runs `scripts/e2e/browser-smoke` from a clean container: either the rootfs carries the browser dependency set, or a target installs it.
- `56-external-edit-matrix` passes 10 consecutive runs on a loaded host. The load condition is stated with the run, since a green on an idle box is what let this sit unnoticed.
- The 19 `networkidle2` waits are replaced by, or justified against, a property the page can assert. A wait that stays is justified in place with what bounds it.
- The gate's relationship to this suite is stated in `.agents/skills/gate/SKILL.md`, whichever way it is decided.
- A check whose environment is unavailable reports a distinguishable skip rather than being absent from the run, following `webview-flip-render.py`'s exit-2 convention and its rule that a skip is not a pass.

## Rough size

Small for the environment half, one rootfs or target change. Medium for the waits: 19 sites, each needing a real readiness signal rather than a blanket substitution, which is the same trap the timing sweep's classification section describes.

## Reconciliation at close

Read end to end, four of this item's own assertions no longer hold. Each was true when written; the work is what falsified them, and they are corrected here rather than edited away, because what changed is part of the finding.

**"No content assertion has ever failed. Only the navigation wait times out."** False now, and the reversal is the item's most important result. Once the rate waits were gone, the navigation timeouts went with them and a *content* assertion began failing instead: `C-dirty-tab` reads the API as the old version while the file on disk holds the new one, 3 runs in 11 on the tree at close, never converging inside a 60s ceiling when it fails and converging in 516-535ms when it does. That is an intermittent stale read on the editor's external-edit convergence path, it is not this item's to repair, and it is registered separately at its own severity. The sentence above was an accurate summary of a suite whose failures were all masked by one wait.

**"Small for the environment half."** Wrong, and wrong in a way worth recording. That half produced six defects: a package probe that ran before `apt-get update` and only worked on a dirty box; a dependency list correct for one base and silently assumed for every other; a `rm -rf /var/lib/apt/lists/*` that sabotages the next `apt-get` in a live container; release-pinned package names assumed rather than probed; a `make` wrapper that erases the 0/1/2 convention this item exists to establish; and a `HOME` that is empty rather than unset under `sdme exec`, which made the runner report "no Chrome found" and exit 2 in the exact invocation the acceptance line names. A false skip is worse than a false failure, because it sends a caller to fix an environment that is already correct.

**"Medium for the waits: 19 sites, each needing a real readiness signal rather than a blanket substitution."** This was right, and the first attempt graded it down to a mechanical swap on the reasoning that 21 of 23 sites already asserted a property on the next line. Twelve of them consumed a second property nothing asserted. The original sizing understood the item better than its first reader did.

**"`waitUntil: networkidle2` appears in 19 of the suite's checks."** Accurate, and it reads as occurrences. It is 23 occurrences across 19 checks; both numbers are in the later section so a re-run reproduces.

### The ten-run series, measured

Ten consecutive runs of `56-external-edit-matrix`, on merged `main`, invoked the way a container invokes it:

```
run  1  PASS   46s   load 15.20 -> 15.18      run  6  PASS   39s   load 13.52 -> 10.04
run  2  PASS   50s   load 15.18 -> 18.09      run  7  PASS   48s   load 10.04 -> 10.97
run  3  PASS   42s   load 18.09 -> 15.62      run  8  PASS   44s   load 10.97 -> 20.77
run  4  FAIL  113s   load 15.62 -> 16.49      run  9  PASS   81s   load 20.77 -> 33.17
run  5  PASS   75s   load 16.49 -> 13.52      run 10  PASS   47s   load 33.17 -> 37.28
                                              TOTAL  pass=9 fail=1 of 10
```

Load band 10.04 to 37.28 on eight cores, sampled either side of every run. **The line is unmet: nine of ten, not ten consecutive.**

Three things in that series are worth more than the verdict.

**The failure was not the stale read.** `C-dirty-tab` converged in all ten runs, at loads spanning the same band where it had failed 3 times in 11 earlier the same day. Run 4 failed on `E-subdir` with a different signature entirely: `editor: "no-editor"`, meaning the editor DOM never mounted, while `api` and `disk` both read the new content. The server was correct and the frontend never showed a document. That is a third intermittent failure in this one check, distinct from both the navigation timeouts this item started with and the stale read it uncovered, and it is registered rather than diagnosed here.

**Zero `window ... is not connected` across all ten runs.** That refusal appeared once the rate waits were removed and disappeared once the registration barrier was named, which is what closes that regression.

**A prediction that was right for the wrong reason.** Before the series, this item's author expected it to fail on `C` at roughly 3 in 11. It failed once in ten, on a different scenario, with `C` clean throughout. The forecast outcome was correct and the forecast mechanism was wrong, which is worth recording next to the number: at these rates a ten-run series is a coarse instrument, and reading a single failure as confirmation of an expected cause would have been wrong here.

One acceptance line is unmet and is not being quietly dropped. `56-external-edit-matrix` reached nine of ten, and the intermittent failures that stop it -- a stale read on the external-edit convergence path, and an editor that intermittently does not mount -- are both outside this item and both registered separately. It is reported unmet with those findings attached as the cause. The line was still worth holding: ten consecutive runs on a loaded host is what exposed the missing window-registration barrier, after a single green in a full 42-check suite had concealed it.

The stale read was reviewed and deliberately left out of scope, and **the precondition that decision rests on belongs here, because this item holds the evidence for it.** It was accepted as not-data-loss because the external edit survives and the conflict banner appears from the external write onward, before any save is attempted, offering both `Reload from disk` and `Keep mine`. The banner is therefore load-bearing to the ruling, not incidental to it.

> If a later change makes the save a no-op **while that banner is absent**, this ruling does not carry over. What was accepted is a pending decision the user can see and act on, not a save that does nothing.

A ruling whose precondition is unwritten becomes a precedent for the case it excluded, which is the same accretion this item's reconciliation section documents, arriving one layer up in a decision rather than in a description.
