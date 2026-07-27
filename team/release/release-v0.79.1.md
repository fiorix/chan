# release-v0.79.1

v0.79.1 is a fix release. Every item came from the release owner running v0.79.0 on real machines and hitting something that did not work, which makes this cycle unusual: the scope was set by field reports rather than by a roadmap, and the diagnosis work was larger than the implementation work.

Five of the six fixes are regressions or defects the v0.79.0 gate could not see, because they live on platforms the Linux gate never compiles or in behavior no unit test observes. That shape drove the whole cycle: most of the effort went into making each defect visible before fixing it.

This cycle is cut directly to GA with no RC pin, following v0.70.1 and v0.70.3. The `0.79.1` commit stays untagged until that exact commit passes the local pre-push gate, a `release.yml` dispatch with `publish=false`, the cache-only downstream rehearsal, and artifact inspection.

## What shipped

**A Linux `cs copy` survives its own `cs paste`.** The cached clipboard handle that keeps chan the selection owner on X11 and wlr data-control was being discarded whenever an operation returned `Err`, and `ContentNotAvailable` was classified as an error one layer too high, outside the cached operation. Automatic paste probes image first, so a text copy was destroyed by the image probe that preceded its own text read: the handle dropped, the selection went with it, and the following read reconnected to nothing. All three native reads now classify an absent representation inside `on_clipboard`, so only a genuine connection failure discards the handle. macOS and Windows are unaffected by construction, since off Linux each operation still takes a fresh handle.

**The ghostty backend leaves the macOS chords alone.** `ghostty-web` calls `preventDefault()` on both exits of its key handler, including the one that means "the host consumed this", so there was no way to express "let this keystroke through". Unclaimed Command chords took the encoder path and got `preventDefault` plus `stopPropagation` plus bytes written to the PTY, and a suppressed default is decisive on macOS because WKWebView then reports the key as handled and AppKit never sees its key equivalent. `Cmd+Backquote` and `Cmd+Shift+N` were dead. A capture-phase listener on the terminal host now stops ghostty's own bubble-phase handler for chords the host owns, without touching the default. The policy is a pure predicate: on macOS, a Command chord that is neither a chan shortcut nor a terminal clipboard chord belongs to the host.

**Ghostty terminals use their full width.** The upstream fitter subtracts a hard-coded 15 pixel scrollbar reservation, while its scrollbar is an auto-hiding overlay painted into the canvas that occupies no layout space, so every ghostty terminal lost roughly two columns to a gutter nothing drew in. chan now computes its own grid from the renderer metrics and the host box. Measured live at 174 columns where the reserved arithmetic gives 173.

**The ghostty settings hint describes what actually happens.** It claimed the toggle downloads the WASM engine on first enable. Nothing is downloaded: the asset is a Vite-emitted file embedded in the binary through rust-embed and served by the same chan server the SPA is already talking to. It also loads on the first ghostty terminal spawn rather than at toggle time, and a failed load falls back to xterm.js silently, which is the part a user hitting a problem most needs to know.

**Windows `cs` runs the `cs` client.** The alias was resolved from `argv[0]` alone. Windows is the only platform whose shims cannot hand a child a chosen `argv[0]`, so both of its shims pass the name in `$ARGV0` instead, and the bundled console `chan.exe` ignored it. The parser now reads that name through a cfg-gated reader: the Windows arm consults the variable, every other target answers `None`. Confining it to Windows is load-bearing rather than tidiness, because a packaged Linux AppImage exports `$ARGV0` and every process it starts inherits it, so an unconditional read would let a stray value turn `chan` into `cs` or the reverse. This defect dates to the introduction of the bundled console binary, not to v0.79.0.

**A new terminal's PTY starts at the size it will actually be.** The mount path scheduled its first fit on an animation frame and then dialed the socket immediately, so the PTY was created at the terminal constructor's 80x24 and corrected only after attach. In a 1590x957 host the socket opened at `cols=80&rows=24` against a grid that settled at 174x62, and a shell read 80 columns at its first prompt and wrapped 160 characters into two lines. The mount path now fits synchronously before dialing. A host that cannot be measured still connects at the defaults and converges through the resize observer.

**A `cs terminal write --submit` that could not submit reports failure.** The submit encoding is decided synchronously at enqueue, from the target session's own spawn command and `CHAN_AGENT`, so a shell session with no derived agent is a known refusal by the time the command returns. It was reported only as an English clause in the acknowledgement while the exit status said success, so an unattended poke parked in a compose box and the sender believed it had landed. The server now answers a typed `SubmitRefused`, the client carries it as a typed error, and the dispatch edge prints the same acknowledgement and exits 69. Delivery stays asynchronous and still reports success; a corrected chord still exits 0.

**The command launcher offers New window and Close window.** Both are desktop-only and both remain available in standalone terminal windows, where the host mints another terminal. Close window shares the existing shortcut id so its chord renders; New window stays chordless because the native host owns `Cmd+Shift+N` and a competing SPA binding would double-fire.

## Team and process

Solo host session with a single recycled agent, one lane at a time, each in its own worktree off `main`, with the brief for each lane written to the gitignored `dev/v0.79.1/` tree before spawn. Every lane's brief carried its owned paths, its tests, its required mutation proofs, its own-gate, and its report format.

Two process choices are worth keeping. The first is that one lane was an independent review: the agent that had not written the clipboard and ghostty work reviewed it, reproduced every mutation proof itself rather than trusting the author's report, and ran the browser smoke in two suite positions. It found a real gap. The second is that the last lane spawned through Team Work rather than a bare terminal, which made `cs terminal write --submit` actually submit to it: the earlier hand-started agents derived no submit agent, so every poke parked unsubmitted and needed a manual carriage return.

The host cleaned up after itself at the end of the cycle: four merged worktrees removed, leftover test containers stopped, and build caches pruned, taking the machine from 11G free to 88G.

## Validation

- The full `make pre-push` gate ran green on the exact pushed commit, including the Linux desktop package and a release devserver boot smoke against the built AppImage.
- A Windows-target clippy pass found real breakage the Linux gate cannot see: a `#[cfg(test)]` helper that does not compile on Windows, and a closure parameter unused there because its only use sits inside a `cfg(unix)` block, tripping `-D warnings`. Both were mechanical and fixed. Without that pass they would have surfaced as a red Windows job mid-release.
- Every fix carries a mutation proof, and the review lane independently reproduced all four of the clipboard and ghostty ones rather than accepting them.
- The terminal grid fix is asserted end to end: browser smoke 94 compares the initial socket grid against the measured grid on both backends, and reverting the ordering fails it with socket 80x24 against a measured 174x62.
- The submit refusal is asserted end to end by a new browser check against a real server, a real window, and a real shell PTY, because the unit tests can only cover the typed response and the exit mapping in separate halves.
- The consequence of the terminal grid defect was established before the fix rather than assumed: a shell at a fresh terminal's first prompt saw 80 columns and wrapped 160 characters into two 80-column lines.

## Retrospective

**Highlights.** The cycle's best work was making defects visible before fixing them. The terminal grid lane was told to prove the user-visible consequence first and could have come back empty; it came back with a shell wrapping at the wrong width, which turned a plausible race into a confirmed bug. The review lane's finding was the sharpest result of the cycle: the clipboard regression test pinned only the text read, so restoring just the image read's classification recreated the exact failure while the test stayed green. The production code was correct and the guard was not, which is a distinction only an adversarial reader finds.

**Lowlights.** Two of the host's briefs were wrong in ways the agents had to catch. One asserted that a terminal already had a settled size before dialing, which was false and was the defect. Another demanded a typed control response while listing owned paths that made it impossible, since the response type and its decoder were both outside the list; the agent stopped and asked instead of widening its scope silently, which cost a round trip but was the correct call. The host also botched a mutation proof while verifying the ghostty work, replacing the wrong occurrence of an identical code block, and came within one check of filing a false finding against correct work.

**Honest feedback.** Reviewer error showed up again this cycle, as it did in v0.79.0, and in the same direction: the instructions were wrong more often than the implementations. The mitigation that worked was telling each lane to verify the brief's own claims against the code before acting, and to stop rather than reconcile a contradiction on its own. Both lanes that hit a bad instruction did exactly that.

## Follow-ups

- The browser-smoke harness writes `results.json` after `teardownServer`, so a teardown that throws takes the results file, the summary line, and the exit code with it. Any full run including the destructive root-loss check can lose its verdict this way. The trap is documented in the run contract; the code fix is outstanding.
- `metadata_archive_inspect_returns_manifest_without_payload` in `chan-workspace` reds under the full parallel gate and passes focused and repeatedly as a crate suite. It is not v0.79.1 fallout: the crate and its only internal dependency are byte-identical to the previous release and no manifest or lockfile moved.
- Browser check 110 skipped rather than passed on the release run, because its graph tag reference precondition was unavailable. Skipped is not verified.
- Workspace-lifecycle scenarios WL-01, WL-11, and WL-12 have no single named executable backing, which the scenario pack states itself. WL-08 and WL-09 passed their named checks without the separate shutdown-preservation pass.
- A hand-started agent inside a shell session can never be poked hands-free, because the submit encoding derives from spawn facts only. A way to declare a live session's agent server-side would close that class, but it reopens the contract that made the encoding server-derived, so it needs a decision rather than an implementation.
- The macOS chord behavior, the Windows shim runtime, and the real X11 and Wayland clipboard paths are all reasoned and compile-checked rather than exercised on their platforms. That is the standing gap for every clipboard and desktop change in this and the previous two releases.
