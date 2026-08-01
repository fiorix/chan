# release-v0.82.0

v0.82.0 is a safety release. Every technical item removes a defect that exists at today's limits rather than adding capability on top of them: the whole-file read class is gone from every HTTP read path, `cs tunnel` delivers the bytes it already read before closing, a failed assertion no longer aborts the test binary, the terminal engine is visible and switchable, and the legacy devserver window endpoint is retired. The empty-pane animation gallery and a headless Nix package landed alongside.

The round was reshaped mid-flight. Large-transfer support was registered as a configurable write limit; reading the tree inverted that, and the capability half moved to v0.83.0. See the retrospective.

## What shipped

**Every HTTP read path is bounded.** Four paths loaded an entire file into one allocation: the image and PDF arm, the fallback catching every unlisted binary, each archive member, and the in-workspace copy, which had no size gate at all. All four now stream through the bounded reader that already backed `?download=1`. A 3 GiB file with an unrecognized extension serves with 1.7 MiB of resident growth, one extra thread, and one extra descriptor. Incremental indexing stats a file and declines above the threshold before taking the workspace mutation lock, so a large file landing in a watched workspace no longer stalls unrelated renames. The editor open limit and the indexing threshold are one server-reported value. Response framing is fixed from the open-handle stat, so a file that grows mid-transfer is truncated to the declared length and one that shrinks fails the body rather than completing short.

**`cs tunnel` no longer truncates responses.** Bytes already read from either TCP endpoint reach the peer before the data WebSocket closes, on all three cancellation paths rather than the single one the original report diagnosed. The registered item's central claim was wrong: there is no 512 KiB pressure point. A 131,072-byte response failed 10 of 10 attempts with **zero bytes received**, far below the queued channel capacity, so a body smaller than capacity was discarded whole. A 2 GiB pull that previously lost up to 524,288 bytes per attempt now completes byte-identical. Local TCP EOF still ends both directions under the existing no-half-close policy; chunks queued toward the destination after that boundary are deliberately not drained, and that boundary is now written down.

**A panic under a session lock no longer aborts the process.** The scene and document session locks and the survey turn guard recover a poisoned guard instead of expecting it, matching the policy already used across the 88 existing recovery sites in the workspace. The abort was neither rare nor coupled to the race the item blamed: an assertion failing under a held guard poisons the lock that a drop path then re-locks, and that shape repeated across both session modules. In the test binary this converts a process abort into a single named failing test.

**The terminal engine is visible and switchable.** Every spawned PTY exports `CHAN_TERMINAL`, recording the configured backend at spawn, in workspace and terminal-only tenants alike. The context menu opens with a non-interactive engine row reading the post-load backend, so a session whose ghostty kit failed to load and fell back reports xterm. A Command Launcher entry states the current value and toggles the preference for newly opened terminals. Separately, the replay-origin filter was discarding complete bracketed-paste payloads because they begin with ESC; it now recognizes them as user input while still suppressing terminal-generated replies.

**The legacy devserver window endpoint is retired.** The route, adapter, frozen six-field wire type, and the two tests that existed only for that surface are removed. The item gated removal on pre-0.81.0 desktops leaving circulation, which is not a satisfiable condition: the updater manifest carries one hardcoded platform key and the non-macOS launch check is a compile-time empty function, so Linux AppImage and Windows NSIS installs never retire themselves. Removal proceeded on the project's no-back-compat rule instead.

**The empty-pane gallery gains seven animations.** Threefold Veil, Striated Current, Lorenz Constellation, Twin Veil Dance, Rippled Duet, Fourteenfold Bloom, and Hexagonal Bloom take the registry from fourteen entries to twenty-one. Five render through two shared components, and Sixfold Vortex moves onto the same point-drawable path.

**Nix ships a headless package.** The flake exposed only `chan-desktop`, so installing chan through Nix pulled the GTK and WebKit closure onto machines that never render a window; the packaging README conceded this by pointing server users at other channels. A `chan` output now builds the standalone binary alone, keeping both embedded SPA bundles, and the Cachix job publishes and pins both packages into the one cache. `default` remains `chan-desktop`. The install page advertises both, and both Nix commands now name their output explicitly.

## Team and process

One lead on Claude Opus at xhigh effort, five workers on codex `gpt-5.6-sol` at xhigh, each in its own git worktree on its own branch, with disjoint file ownership declared before spawn. Two further jobs ran after the round closed, for the Nix package and the install page.

The standing rule was that workers do the work, the lead does quality verification and correctness, and the host does organisation. It held under pressure. When `@@retire` finished first, the lead did not absorb its work or hand it to another lane; it deepened `@@retire`'s own item with a real-devserver observation of the retired path. When the post-merge validation suite came due, the lead delegated the five runs to lanes with idle capacity and kept only the judgement.

Briefs were adversarially reviewed before the team was spawned: drafted, critiqued against the live tree, then corrected. That pass caught defects that would have produced wrong work, most consequentially a `WindowRecord` field list that was truncated and wrong, which a grep-driven lane would have used to build a bad superset proof.

Decisions routed to the host as they arose rather than accumulating. Three lanes came back with questions instead of assumptions, and all three were right to ask.

## Validation

Per-lane own-gates were crate-scoped, with heavier runs serialized through a lead-held token. The lead re-validated on the integrated tip after each merge.

- Tunnel: 10 iterations at every boundary size in both directions plus a concurrent case, against unmodified source at a named commit, with tests committed before any production change. The 2 GiB proof ran pre-fix and post-fix side by side: three of three short with three different hashes before, three of three byte-identical after.
- Gateway idle timing: 84 of 84 green under deliberate concurrent load. The lead refused a quiet machine for this, on the grounds that the assertion fails specifically when the host is loaded, so an idle-box green is the weaker proof and the one condition under which the old code might also have passed.
- Session abort: reproduced deterministically before the fix, through the named drop paths, and absent after.
- Bounded reads: resident memory, thread count, and descriptor count sampled from the real server process at 25 ms intervals against multi-gigabyte sparse fixtures.
- Browser scenarios: the workspace-lifecycle scenario set plus the round's own two checks, 10 of 10 green.

Two baseline flakes exist on unmodified code and are characterized rather than fixed: an indexer timeout at 3 of 20 whole-binary runs, and a state timeout at 1 of 20. Neither was introduced by this round. They are recorded so a future parallel run is not misread as a regression.

## Retrospective

**The registered item was the wrong shape, and the owner caught it.** Large-transfer support was written as a configurable binary write limit, with a default raise as the deliverable. Reading the tree inverted the sequence: the 50 MiB refusal is the only thing bounding memory today, four HTTP paths still read whole files into one allocation, and there is no admission control anywhere in the server. Raising the ceiling first would have removed the guard before its replacement existed. The item was split, the safety half shipped here, and the capability half moved to v0.83.0 sequenced behind an isolation mechanism.

**Two lanes refuted their own items with measurement.** The tunnel item's 512 KiB threshold model and the flake item's missing-margin diagnosis were both wrong, and both were disproved by evidence rather than argued about. The gateway assertion already had a margin, consumed exactly by an inbound poll, so widening it would have hidden the defect; moving the reference instant made the bound one-sided at zero added runtime.

**The lead stopped mid-task twice.** Both times every surface signal looked healthy: process alive, ledger populated, a sensible next step sitting in its compose box. Both times the next step simply was not taken, and the round looked finished from outside because the lanes had all merged. Detection required measuring CPU ticks and scrollback bytes rather than inferring liveness from process existence. A submitted poke resumed it immediately on each occasion.

**Host-side errors worth recording.** Running five browser smokes concurrently was a host decision, and it produced three environmental failures: disjoint subsets and isolated sandboxes make concurrency safe for correctness but not for timing, and five Chrome instances with 60-second navigation timeouts do not share eight cores. One agent's run also took the harness build path and relinked the shared binary mid-round. The smoke brief additionally pointed reports at a host handle that was not a live terminal, so those pokes landed nowhere. Separately, the lane briefs never pointed at the workspace-lifecycle scenario file, so that coverage was only run after the owner asked for it.

**One capability observation is unexplained.** The tunnel lane was spawned at `gpt-5.6-sol` with xhigh effort and its status line read that at the fifteen-minute mark. Later in the round it read a different model at low effort, with unchanged process arguments and no rate-limit message in its scrollback. The cause is unknown. The lead compensated with extra scrutiny on that lane's diff and proof.

## Follow-ups

- `Workspace::rename_with_link_rewrite` still reads a moved Markdown body whole into a `String`. A 3 GiB rename measured 52,644 ms on an idle box. Same defect class as the four paths fixed here, on a path outside this item's boundary.
- `MAX_DATA_FRAME_BYTES` is enforced on the devserver's inbound frames and not on the desktop's. Closing it is a one-line wire-contract change, deliberately not folded into a bug fix.
- `ghostty-web` registers a canvas context-menu handler whose interaction with chan's own menu is unresolved. The ghostty menu row is pinned at component level because the browser assertion could not be made to pass against the ghostty canvas.
- A macOS WKWebView Cmd+V report was not reproducible on Linux and is explicitly not claimed resolved. The replay-origin fix addresses a real defect found while investigating it, which may or may not be the same one.
- `packaging/nix/chan.nix` carries `cargoHash = lib.fakeHash`. It is harvested from the first Nix build's mismatch and pinned before the tag.
- v0.83.0 carries `large-transfer-capability`, `extensions-v1`, and `web-marketing-onboarding`.

## See also

- [`../roadmap/README.md`](../roadmap/README.md) for the active scope this release closed and what moved forward.
- [`../../CHANGELOG.md`](../../CHANGELOG.md) for the user-facing entry.
