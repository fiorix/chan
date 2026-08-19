# Roadmap

Active development scope for chan, organized by the release it targets. This is the roadmap front door: what has been accepted as work for an upcoming version, and where each item goes once it ships, is withdrawn, or slips. It is not a second release report; closed history lives in [`../release/`](../release/README.md), and the process that moves an idea from a problem to a shipped release is described in [`../README.md`](../README.md).

Each item is one Markdown file that names an observed behavior or need, the evidence for it, the desired contract, its implementation boundaries, and its acceptance checks. An item earns a place here only once it is accepted scope for a concrete target version; a raw draft in the gitignored `dev/` tree is not a roadmap item until it is copied in and accepted.

## Lifecycle

1. `vX.Y.Z/{item}.md` is accepted active scope for that target version.
2. Implementation and validation evidence accumulate in the proposal, its candidate report, or the round's artifacts, without replacing the proposal's original rationale.
3. At GA the item moves to `done/{item}.md` and gains a status line linking to `[vX.Y.Z](../../release/release-vX.Y.Z.md)`; the text says `shipped` only when the item actually shipped.
4. A withdrawn item also moves to `done/`, states plainly that it did not ship, and links to the release report that records the decision.
5. A deferred item moves to the next active version directory before GA. It is not marked done.
6. After the GA close commit the released version's directory is gone; every one of its items lives in `done/` or in a later active version.

## Layout rules

`done/` is intentionally flat, so item filenames must stay descriptive and repository-wide unique. If a future item would collide with a closed one, prefix that filename with its version when it is closed.

## Active

### v0.94.0

- [a-standalone-window-cannot-create-drafts](v0.94.0/a-standalone-window-cannot-create-drafts.md) - New draft, New diagram, New slide deck, and Rich Prompt work in a standalone window, backed by a per-library draft store (`~/.chan/Drafts` on a desktop host, `~/.chan/devserver/Drafts` on a devserver) with a working flat trash; registered after the fact with the implementation and verification already carried out on the v0.93.0 GA base, including the companion repair that makes a discarded workspace draft a restorable trash entry instead of sweep fodder.

An item earns a place here once it is accepted for a concrete target version, which happens when a round is set up; until then, candidates raised by the last release live in that release's report under Follow-ups.

## Completed

### v0.93.0

Shipped 2026-08-18; see [release-v0.93.0](../release/release-v0.93.0.md). Closed items in [`done/`](done/):

- [one-filesystem-namespace-and-a-workspace-window-that-can-reach-it](done/one-filesystem-namespace-and-a-workspace-window-that-can-reach-it.md) - file content and transfers serve from one `/api/fs` namespace rooted at the serving tenant's capability root, `cs download` and `cs upload` behave identically in every window kind, and `/api/files` stays as an alias documented for removal in v0.94.0; the migration was 243 live references across 73 files against an item that estimated five.
- [the-linux-desktop-still-refuses-webgl-after-its-blocker-was-fixed](done/the-linux-desktop-still-refuses-webgl-after-its-blocker-was-fixed.md) - the renderer follows the desktop's own dma-buf decision instead of the operating system, delivered for the AppImage only, and the lane caught a shipping blocker in its own change that the lead had already cleared; all three pixel readings are unmeasured and named as a gap.
- [the-desktop-liveness-probe-test-is-load-sensitive-and-unexplained](done/the-desktop-liveness-probe-test-is-load-sensitive-and-unexplained.md) - the mechanism is fork-time descriptor inheritance, close-on-exec acting at exec rather than at fork, proven outside the flaky test and repaired structurally; the rig measured 0 red in 15 on unmodified code, so the acceptance is a deterministic 20-of-20 forced race rather than a rate.

Three items closed and none carried. The round also produced work no item asked for: a package-parameterised one-CPU reproduction rig, the first measured flake rates this project holds for that population (3 in 15 and 1 in 15 for two unrelated tests), a pre-existing transfer-ceiling disagreement between the browser-smoke checks and the product on unmodified code, and a bounded production reach for the liveness mechanism that `try_handoff` contains. Its two genuine gate reds were both in places a scoped check cannot see: the separate gateway workspace, which the root formatter never reaches, and stale in-tree guards that only the full `web-check` and `--all-targets` runs exercise.

### v0.92.0

Shipped 2026-08-17; see [release-v0.92.0](../release/release-v0.92.0.md). Closed items in [`done/`](done/):

- [the-gateway-has-no-canonical-desktop-to-devserver-design](done/the-gateway-has-no-canonical-desktop-to-devserver-design.md) - the gateway has one cross-component design with four parsed Mermaid diagrams, and the documentation set was checked against the live implementation rather than against its own stale claims.
- [a-terminal-renderer-can-cache-glyphs-before-its-font-loads](done/a-terminal-renderer-can-cache-glyphs-before-its-font-loads.md) - renderer construction waits for the selected bundled face and uses a stable fallback chain when it cannot load; the automated gates passed, while a separate cold-cache pixel reading was not recorded.
- [graph-from-here-on-a-directory-comes-up-without-its-files](done/graph-from-here-on-a-directory-comes-up-without-its-files.md) - a directory scope opens at the shallowest depth that contains a file, proven red then green in a browser check over the actual graph payload.
- [the-about-widget-bottom-row-touches-the-window-edge](done/the-about-widget-bottom-row-touches-the-window-edge.md) - the browser surface measured equal margins and the native window was confirmed on WKWebView; WebKitGTK was not exercised and remains a named evidence gap.
- [an-external-edit-intermittently-never-reaches-a-dirty-editor](done/an-external-edit-intermittently-never-reaches-a-dirty-editor.md) - closed without a behavior change after the non-converging arm was characterized as a correct retained conflict rather than a reconcile that never ran.

Five items closed and three carried into v0.93.0: the filesystem namespace remains `/api/files`, the desktop liveness probe still lacks a mechanism for its stale-socket false positive, and the Linux desktop still refuses WebGL by default.

### v0.90.0

Shipped 2026-08-14; see [release-v0.90.0](../release/release-v0.90.0.md). Closed items in [`done/`](done/):

- [windows-team-work-terminals-can-deadlock-on-a-startup-dsr](done/windows-team-work-terminals-can-deadlock-on-a-startup-dsr.md) - reproduced deterministically on real Windows 11 with the mechanism corrected: the `\x1b[6n` is ConPTY's own startup handshake gating every server-spawned Windows shell, not a pwsh prompt racing the SPA's reattach cursor; the library answers it on the controller's 25 ms tick after a grace an attached frontend's own report wins, the natural-exit tests are un-gated on the Windows arm, and the no-double-CPR acceptance is verified live against a frontend-silent control.
- [the-standalone-windows-cli-ships-untested](done/the-standalone-windows-cli-ships-untested.md) - chan.exe is executed by CI for the first time: a smoke on the Windows arm drives `--version`, the `DETACHED_PROCESS` daemon spawn, and named-pipe discovery plus an Identify round trip through `chan ps`, proven able to fail against a known-broken binary.
- [a-held-lock-hides-its-own-holder-record-on-windows](done/a-held-lock-hides-its-own-holder-record-on-windows.md) - the holder record is readable while the lock is held via a `writer.json` sidecar the body-first read order keeps honest, restoring `chan ps`/`chan close` holder resolution and the same-process idempotent reopen on Windows; found and fixed in the round that wrote the smoke, then amended at intake so a crash leftover can neither shadow a live holder nor authorize a steal.

Three items closed and four carried into v0.91.0: the external-edit stale read still deferred on its precondition, the WebGL present stall reframed and untouched, the frame-rate acceptance guards with no code shipped, and AUR publication still blocked upstream, re-checked unmet on 2026-08-14. The era's fixes without items entered from live use: the AppImage terminal environment reconstruction, the reverse tunnel surviving fd-pressure accept errors, and the darwin transient openpty retry. Writing the CLI smoke surfaced two defects its item had not predicted, the held-lock record and the debug-profile stack overflow, both fixed in the same round; the branch's intake review then caught the sidecar repair's own crash-leftover hole before it merged.

### v0.89.0

Shipped 2026-08-12; see [release-v0.89.0](../release/release-v0.89.0.md). Closed items in [`done/`](done/):

- [the-deck-chords-are-invisible-to-the-shortcut-registry](done/the-deck-chords-are-invisible-to-the-shortcut-registry.md) - the deck's present and preview chords become registry commands, rebindable while the shipped defaults stay, and the capture handler is gated on `builtInChordSuperseded` rather than widened to match by resolved chord.
- [assigning-an-already-held-chord-has-no-swap-path](done/assigning-an-already-held-chord-has-no-swap-path.md) - the assign dialog offers to swap a held chord, and the close review then narrowed the offer to a single-holder candidate whose holder dispatches through the override layer, after it was found to ship a fresh collision otherwise.
- [the-graph-palette-has-never-been-configurable](done/the-graph-palette-has-never-been-configurable.md) - the graph node hues are settable per colour scheme across SPA, Rust and CLI, the override rides the graph subtree rather than the document root, and a hand-edited invalid hue is dropped rather than poisoning the write.
- [settings-is-organised-by-concern-not-by-app](done/settings-is-organised-by-concern-not-by-app.md) - the overlay derives its sections from the command registry's own surface grouping, so each app's controls sit together, rebuilt on shared settings-field primitives.
- [ctrl-shift-w-closes-the-window-not-the-tab](done/ctrl-shift-w-closes-the-window-not-the-tab.md) - off macOS the chord closes the tab through the same `app.tab.close` path every window kind takes, window close moves to `Ctrl+Alt+W`, and an AltGr keydown falls through the key bridge so international character entry is not swallowed.
- [agy-submit-agent](done/agy-submit-agent.md) - Google Antigravity's `agy` CLI is a first-class submit agent across Rust and the Team Work TypeScript mirror, live-probed with a bracketed-paste-plus-CR chord; gemini stays supported and is marked for a later deprecation.
- [canonicalize-failure-has-four-answers-on-the-path-sandbox](done/canonicalize-failure-has-four-answers-on-the-path-sandbox.md) - the path sandbox fails closed on an uncanonicalizable path, the four inconsistent answers become one, and the symlink-blind lexical fallback is consolidated behind one method whose root comes from the walker; the server half stayed open after the headline repair and was closed after reading the acceptance against the tree.
- [a-failed-reset-wedges-the-workspace-behind-a-retryable-error](done/a-failed-reset-wedges-the-workspace-behind-a-retryable-error.md) - the workspace cell is restored on every fallible reset arm, so a failed reset leaves the previous workspace reachable rather than answering a permanent state as a retryable 503 forever; reproduced in-process against the unrepaired flow before any code changed.
- [chan-home-collapses-to-the-working-directory](done/chan-home-collapses-to-the-working-directory.md) - an absent OS home resolves to a named absolute path through a test seam rather than a relative one, so a process whose home does not resolve no longer writes the registry and every workspace's metadata into its working directory.
- [chan-home-is-mutated-process-globally-during-a-parallel-suite](done/chan-home-is-mutated-process-globally-during-a-parallel-suite.md) - the three named windows where tests mutated `CHAN_HOME` process-globally are closed, and an isolated library opened at an injected config path no longer sends its metadata to the ambient home.
- [watch-registration-lifecycle-test-is-load-sensitive](done/watch-registration-lifecycle-test-is-load-sensitive.md) - the process-global injection slot four tests clobbered is now a path-keyed map, and the two ignored-subtree tests inspect their own counter before accepting `Healthy`, making the registration claim positive rather than vacuous; measured 14/20 and 19/20 red before, 0/20 after, on the checked-in 1-CPU rig.
- [the-1-cpu-reproduction-rig-has-no-checked-in-form](done/the-1-cpu-reproduction-rig-has-no-checked-in-form.md) - the load-sensitive-failure reproducer every timing item had rebuilt from prose gets a checked-in form that fails closed when it cannot confirm the CPU cap from the host, reproduced cold by a second operator who had never built it.
- [indexer-timing-sites-have-no-lexical-signature](done/indexer-timing-sites-have-no-lexical-signature.md) - the three timing sites a shipped classification kept were reopened, examined, and kept on an evidence-led ruling, a conforming outcome recorded as such rather than as a failure to change anything; that half of the commit is comments only.
- [the-sdme-build-drivers-are-uncapped-and-mount-a-live-worktree](done/the-sdme-build-drivers-are-uncapped-and-mount-a-live-worktree.md) - the sdme build drivers are capped and stopped mounting the live worktree, merged from three drafts into one lane, with the storage half widened by ruling into a standing rule that every sdme container this repository creates uses the btrfs backend.
- [release-artifacts-are-labelled-gnu-and-contain-musl](done/release-artifacts-are-labelled-gnu-and-contain-musl.md) - the two sites that named the wrong libc on the Linux CLI artifacts are corrected, so a musl binary is no longer labelled gnu.

Fifteen items closed and four carried into v0.90.0: the external-edit stale read still deferred on its precondition, the WebGL present stall reframed after measurement, the frame-rate acceptance guard with no code yet, and AUR publication still blocked upstream. The round also produced a fable/ultracode close review that caught three defects the round itself introduced before they shipped (the chord-swap collision, the metadata-import 500, and the graph-palette silent write failure), and a Windows CI investigation that scoped the arm to chan-library and chan-desktop and surfaced two follow-ups now promoted into v0.90.0: a candidate ConPTY startup-DSR deadlock and the untested standalone Windows CLI.

### v0.88.0

Shipped 2026-08-10; see [release-v0.88.0](../release/release-v0.88.0.md). Closed items in [`done/`](done/):

- [browser-smoke-is-unrunnable-and-rate-based](done/browser-smoke-is-unrunnable-and-rate-based.md) - the suite runs from a clean project container through `make browser-smoke-deps` and 23 network-idle waits across 19 checks wait on the property each check consumes, so the editor is exercised in a browser at all; four of five acceptance lines met, the fifth reported unmet rather than rounded up, because `56-external-edit-matrix` reached nine of ten runs and was stopped by two defects this work uncovered.
- [chan-ps-cannot-answer-what-a-workspace-is-doing](done/chan-ps-cannot-answer-what-a-workspace-is-doing.md) - readiness, generation, required action, indexer status and queue depth are surfaced from the same values `/api/health` and `/api/index/status` already served, so the command cannot report a different truth than they do and a diagnosis that took a shell, two tokens and hand-read JSON is a five-second read; one acceptance line is only partly met because the stall it was to be demonstrated against is unreachable at this commit.
- [the-boot-overlay-locks-the-workspace-behind-its-own-index-rebuild](done/the-boot-overlay-locks-the-workspace-behind-its-own-index-rebuild.md) - a recovery or index pass that is progressing reports itself instead of locking the workspace, with `locked: false` under `readiness.state: recovering` in 80 of 80 samples on a 25,000-file workspace and content search saying it is paused rather than returning an empty result set; structurally correct and merged green but not validated by experiment, because the rig built for it does not reach the defect.
- [desktop-build-id-is-unknown-in-the-nix-package](done/desktop-build-id-is-unknown-in-the-nix-package.md) - the flake threads its guarded build id into both surfaces the package ships, `chan-desktop` itself and the `chan` binary symlinked at `bin/chan`, `chan-desktop --version` makes the app's own id readable without a display, and the assertion lives in the package smoke rather than in one eyeballed run.
- [release-dry-run-does-not-predict-the-tagged-run](done/release-dry-run-does-not-predict-the-tagged-run.md) - `DMG_VENV` and `TAURI_CLI_ROOT` move out of the cached `target/` tree into `.build-tools/`, so a step's behaviour can no longer depend on what a cache handed it, closing the class behind the v0.87.0 tag failing a job its dry run had passed on the identical tree; the audit also falsified the item's own premise, and the DMG path needs macOS so it is first exercised by the next dry run.
- [devserver-restart-destroys-the-tunnel-registration](done/devserver-restart-destroys-the-tunnel-registration.md) - the endpoint requirement no longer fires ahead of the code that recovers the endpoint from the installed unit, so `--restart` stops refusing a shell that holds the token and stops silently rewriting a tunnelled service as a local one, which destroyed the only copy of the PAT; exercised in both directions against a live supervised unit.
- [terminal-font-and-block-glyph-parity](done/terminal-font-and-block-glyph-parity.md) - **partial**: the bundled `@font-face` src is no longer absolute so the face decodes under a tenant slug instead of hiding behind a lookalike system font, and ghostty draws block elements from cell geometry; the xterm DOM renderer the Linux desktop ships still bands rules and blocks at 96.0% rule continuity and 95.2% block coverage, independently reproduced on a second machine, and the WebGL present stall that keeps that renderer in place stayed unmeasured for want of a GPU host with an Xorg session, so both residuals carry forward.
- [canvas-animations-are-software-rasterized-on-linux](done/canvas-animations-are-software-rasterized-on-linux.md) - the whole animation family, point cloud host included, paints through WebGL2 rather than the 2D canvas paths Linux software-rasterizes, and frames allocate nothing; closed on the owner's observation of the named animations running correctly on real Linux, Windows and macOS hardware, which is an observation and not a frame-rate measurement.
- [terminal-restart-env-test-is-load-sensitive](done/terminal-restart-env-test-is-load-sensitive.md) - one harness defect explains all three clustered tests: `collect_until` drained only `handle.rx` and never `handle.replay`, so the collector was missing half a contract production honours, with 5 of 8 cluster-red before the repair and 0 of 13 after under condition-matched arms on a calibrated cgroup rig.
- [control-socket-takeover-test-races-a-fixed-sleep](done/control-socket-takeover-test-races-a-fixed-sleep.md) - the fixed 25ms sleep is removed rather than lengthened and the holder's release is observable through a test seam, reproduced at 3 red in 30 runs under a 1-CPU rig and 0 in 30 after, with the repaired assertion proven able to go red.
- [doc-sessions-tests-stage-external-edits-on-the-filesystem-clock](done/doc-sessions-tests-stage-external-edits-on-the-filesystem-clock.md) - the hand-rolled 20ms sleep is gone and fourteen staging sites route through the settled `scene_sessions` construction, repaired as a structural hazard on the strength of the sleep and the precedent; the item states that no `doc_sessions` test was ever observed failing from the mtime collision in 60 rig runs, which is what it predicted of itself.
- [audit-the-workarounds-nobody-followed-up](done/audit-the-workarounds-nobody-followed-up.md) - 53 sites marked across `crates/chan-workspace/src/` with the sites found clean recorded alongside the rest so the pass carries a denominator, the fail-open specimen repaired, seven findings recorded and eight candidates registered; complete over the time-shaped signature population it declared and explicitly not over the fallback-on-failure axis those signatures cannot see.
- [one-stalled-workspace-may-block-the-others](done/one-stalled-workspace-may-block-the-others.md) - the unverified lead was falsified rather than built against: closes do not serialize, do not exhaust the runtime and are bounded, so no code changed, and the observation remains unexplained with two candidate mechanisms ruled out and a third named and uninvestigated.

Nothing reached this release without an item, but three of the thirteen were done unplanned and off the roadmap and registered after the fact so the release carries them as accepted scope rather than as unattributed lines: the canvas animation family, the `chan devserver --restart` tunnel-registration repair, and the terminal face and block glyph work. The release's other result has no item here at all, because it is a defect rather than a delivery: the browser smokes, runnable for the first time, found an intermittent stale read on the editor's external-edit convergence path on their first properly runnable execution, carried forward with a preserved reproducer rather than repaired here as [an-external-edit-intermittently-never-reaches-a-dirty-editor](done/an-external-edit-intermittently-never-reaches-a-dirty-editor.md); the v0.87.0 mtime CAS is not implicated and nothing is silently lost. Of the fourteen items in scope, thirteen shipped and one deferred: [aur-publication-is-suspended](done/aur-publication-is-suspended.md), still blocked upstream. The partial terminal item's residual carries forward as [the-webgl-present-stall-is-unmeasured-and-costs-linux-the-grid](done/the-webgl-present-stall-is-unmeasured-and-costs-linux-the-grid.md), and what the canvas item exposed about writing a frame-rate acceptance that a software stack can satisfy carries forward as [a-frame-rate-acceptance-needs-guards-that-can-fire](done/a-frame-rate-acceptance-needs-guards-that-can-fire.md). The seventeen drafts the round also produced were triaged on 2026-08-11 and their disposition is recorded in the v0.89.0 release report.

### v0.87.0

Shipped 2026-08-09; see [release-v0.87.0](../release/release-v0.87.0.md). Closed items in [`done/`](done/):

- [mtime-cas-silently-overwrites-external-edits](done/mtime-cas-silently-overwrites-external-edits.md) - the write CAS verifies the bytes the caller last saw instead of trusting a timestamp that does not always advance, closing a silent-overwrite data-loss path, with four limitations named.
- [scene-conflict-test-is-load-sensitive](done/scene-conflict-test-is-load-sensitive.md) - the mechanism named and demonstrated; the item was filed as a test defect and exposed the production data-loss path above.
- [gitignore-write-strands-the-workspace-in-recovering](done/gitignore-write-strands-the-workspace-in-recovering.md) - a watcher-requested reconcile has a driver, so a `.gitignore` write stops parking the workspace behind a boot overlay no worker would ever clear.
- [desktop-authorize-strands-the-browser-off-origin](done/desktop-authorize-strands-the-browser-off-origin.md) - the authorized browser lands on the gateway profile page instead of a dead-end loopback page, with the listener's neutrality invariant intact.
- [devserver-build-identity](done/devserver-build-identity.md) - `chan --version` and the health surface carry a build id, the server-side sibling of the desktop identity from v0.86.0.
- [submit-cannot-override-a-wrong-derivation](done/submit-cannot-override-a-wrong-derivation.md) - the agent named in `cs terminal write --submit` selects the chord, so an agent started by hand inside a shell session is reachable at all.
- [tab-commands-are-launcher-search-only](done/tab-commands-are-launcher-search-only.md) - a chosen launcher scope lists completely, the focused application's commands lead its Tab scope, and four unreachable actions are commands again.
- [window-list-is-verb-first](done/window-list-is-verb-first.md) - one Windows branch replaces the Focus/Hide/Show/Close quartet, listing each window once with the actions it can actually take.
- [load-sensitive-tests-keep-recurring-after-three-sweeps](done/load-sensitive-tests-keep-recurring-after-three-sweeps.md) - **partial**: all 49 chan-server timing sites classified with per-site justification, verified by set comparison; the repairs the same item asks for did not ship and the item says so.

The release also carried the WebKitGTK flip-face fix, which had no roadmap item: WebKitGTK ignores `backface-visibility` while Chrome honours it, so a hidden card face covered the entire window in the shipped app while every Chrome-driven check passed. Ten items were deferred to v0.88.0 above, none of them started.

### v0.86.0

Shipped 2026-08-08; see [release-v0.86.0](../release/release-v0.86.0.md). Closed items in [`done/`](done/):

- [extensions-unreachable-through-the-gateway](done/extensions-unreachable-through-the-gateway.md) - the gateway admits the exact extension capability path shape, so cookieless sandboxed-iframe fetches reach the devserver whose per-process capability check authorizes them; extensions boot through the gateway for the first time.
- [extension-errors-are-cors-masked](done/extension-errors-are-cors-masked.md) - every response leaving the extension namespace on both binaries carries the response policy, and the capability segment is redacted from both binaries' trace spans.
- [extension-capability-staleness-across-restart](done/extension-capability-staleness-across-restart.md) - extension tabs converge after a devserver restart via catalog re-resolution and frame reconciliation, proven live in a headless browser with the fix withheld and restored.
- [cs-terminal-new-cannot-spawn-an-agent-session](done/cs-terminal-new-cannot-spawn-an-agent-session.md) - cs terminal new and restart carry --command and --env on shared plumbing, so a single terminal derives an agent and a live shell tab can be repaired.
- [gateway-window-skew-presents-as-a-code-defect](done/gateway-window-skew-presents-as-a-code-defect.md) - a chan-desktop build is identifiable at runtime and advertises its native vocabulary to remotely-served pages.
- [editor-widget-tests-are-nondeterministic](done/editor-widget-tests-are-nondeterministic.md) - the fold walker refreshes on tree identity, closing a production staleness path behind three flaky tests, now deterministic.
- [large-transfer-ceiling-refinements](done/large-transfer-ceiling-refinements.md) - archives bounded by the ceiling on both arms with refuse-before-first-byte semantics; the Range and recovery gaps closed by ruling.
- [source-pins-bound-on-sibling-string-literals](done/source-pins-bound-on-sibling-string-literals.md) - all 24 dead end-bounds on unique definition-form needles, with a committed mutation probe.
- [gateway-tests-do-not-run-off-main](done/gateway-tests-do-not-run-off-main.md) - the gate executes the database-free gateway suites and states execute versus compile per step.
- [web-lock-check-destroys-node-modules](done/web-lock-check-destroys-node-modules.md) - environment-fixed with an npm >= 10 floor; the destructive premise was falsified in re-verification.

The release also carried the owner's team-config pane layout, the empty-pane mark flash, and two cross-branch composition fixups. The web-marketing-onboarding item was withdrawn to the chan-mkt repository during preparation ([done/web-marketing-onboarding.md](done/web-marketing-onboarding.md)), and aur-publication-is-suspended deferred to v0.87.0 still blocked upstream.

### v0.85.0

Shipped 2026-08-06; see [release-v0.85.0](../release/release-v0.85.0.md). Closed items in [`done/`](done/):

- [large-transfer-capability](done/large-transfer-capability.md) - the 50 MiB compiled-in write limit replaced by a configuration ceiling, with every transfer path on a process-wide admission lane and a queue bound that refuses before reading a body.
- [desktop-library-window-open-unavailable](done/desktop-library-window-open-unavailable.md) - chan-desktop opens and focuses library windows through capability-gated native commands, resolving the target library from the invoking window's own label.
- [standalone-terminal-appearance-settings](done/standalone-terminal-appearance-settings.md) - standalone terminals fetch preferences and receive live changes, so the full terminal preference set applies rather than only defaults.
- [hybrid-nav-mouse-split-affordances](done/hybrid-nav-mouse-split-affordances.md) - dragging a pane onto an edge zone previews and stages a 50/50 split, refusing an edge whose result would fall below the minimum pane size.
- [file-browser-context-menu-inspector-actions](done/file-browser-context-menu-inspector-actions.md) - one capability-driven classifier behind both surfaces, so they cannot drift apart by construction.
- [ghostty-live-output-scroll-stability](done/ghostty-live-output-scroll-stability.md) - ghostty writes and pixel-wheel input route through one viewport controller, with anchored output preserving its position.
- [ghostty-macos-trackpad-scroll-parity](done/ghostty-macos-trackpad-scroll-parity.md) - synchronous primary-screen trackpad scrolling with the xterm parity factor, pinned by test and calibrated by the owner.
- [settings-checked-checkbox-pill-border](done/settings-checked-checkbox-pill-border.md) - selected checkbox and radio pills keep the neutral border and are distinguished by background alone.
- [cs-terminal-list-queue-depth](done/cs-terminal-list-queue-depth.md) - a queue column reporting messages still waiting, with an unreported value rendering as `-` rather than `0`.
- [chan-config-key-coverage](done/chan-config-key-coverage.md) - the reader, writer, and dump derive from one key set, so a serialized field cannot reach the dump without reaching `get` and `set`.

The release also carried the ghostty overlay scrollbar correction and the withheld-native-command message, neither of which had its own roadmap item: the first entered as an owner acceptance finding and the second from diagnosing one. The gateway acceptance failure that reopened the round was version skew rather than a defect, and is registered forward as [gateway-window-skew-presents-as-a-code-defect](done/gateway-window-skew-presents-as-a-code-defect.md), which shipped in v0.86.0.

### v0.84.1

Shipped 2026-08-05; see [release-v0.84.1](../release/release-v0.84.1.md). Closed items in [`done/`](done/):

- [graph-large-workspace-render-cost](done/graph-large-workspace-render-cost.md) - a selection click no longer re-heats the layout and a settled graph paints nothing, with the selection-derived paint inputs memoised and the viewport culled.

The release also carried five fixes that entered from live use without their own roadmap items: live-only BM25 path enumeration, a pane split surviving a mid-teardown layout read, terminal chrome following a custom background, a devserver join detaching on non-TTY stdin EOF, and an honest chan-desktop window-open message with its refusal diagnostics. The desktop library-window repair behind that last one was deferred to v0.85.0 as [desktop-library-window-open-unavailable](done/desktop-library-window-open-unavailable.md).

### v0.84.0

Shipped 2026-08-05; see [release-v0.84.0](../release/release-v0.84.0.md). Closed items in [`done/`](done/):

- [cs-open-non-text-reveal-and-audio](done/cs-open-non-text-reveal-and-audio.md) - `cs open` reveals existing non-text files in the File Browser, and supported audio files gain inline and dedicated native players.
- [hybrid-nav-staged-editor-bubble](done/hybrid-nav-staged-editor-bubble.md) - queued draft and diagram intents render as removable chips, while shared structural layout changes make the transaction stale and fail closed.
- [terminal-tab-rename-reaches-inventory](done/terminal-tab-rename-reaches-inventory.md) - terminal name and group settle on the server and converge through the tab strip, session inventory, roster, selectors, and fdstore provenance.
- [terminal-editor-appearance-settings](done/terminal-editor-appearance-settings.md) - terminal font size and colours persist through server configuration, while editor font size persists in user preferences and updates live.
- [release-platform-verification](done/release-platform-verification.md) - a disposable Ubuntu sdme guest provides the mandatory Windows release cross-check alongside the macOS-capable workflow dry run.
- [graph-inspector-language-node-detail](done/graph-inspector-language-node-detail.md) - language nodes show delivery estimates and ranked directory detail, with direct navigation into a selected directory scope.
- [tests-inherit-ambient-chan-env](done/tests-inherit-ambient-chan-env.md) - tests clear ambient `CHAN_*` state, use isolated homes, and avoid rendering inherited credentials in failures.
- [rich-prompt-submit-button](done/rich-prompt-submit-button.md) - the Rich Prompt hint is a control strip whose primary action switches between submit and cancel while retaining the existing keymap behavior.
- [terminal-secret-masking-default-off](done/terminal-secret-masking-default-off.md) - secret masking defaults off for usable large scrollback replay, while explicit configuration and the existing ephemeral per-tab switch remain available.
- [sdme-ubuntu-nix-build](done/sdme-ubuntu-nix-build.md) - Nix evaluation, package builds, and smokes run from a tracked-source snapshot in a disposable Ubuntu guest rather than the host filesystem.
- [hybrid-nav-staged-destructive-actions](done/hybrid-nav-staged-destructive-actions.md) - withdrawn before implementation; destructive actions keep the established immediate action and confirmation flow.

### v0.83.4

Shipped 2026-08-04; see [release-v0.83.4](../release/release-v0.83.4.md). Closed items in [`done/`](done/):

- [gateway-served-surface-failures](done/gateway-served-surface-failures.md) - desktop windows served through the gateway read the CSRF token from an origin-scoped Tauri command instead of a cookie WebKit never exposes to JavaScript, and session re-mints publish fresh cookies into open windows, so every mutating surface works again.
- [desktop-window-outage-lifecycle](done/desktop-window-outage-lifecycle.md) - a close during a remote outage settles as closed instead of boomeranging, the connecting probe classifies responses instead of accepting any status, and the close prompt raises its own window instead of stranding behind newer ones.
- [terminal-reattach-replay-storm](done/terminal-reattach-replay-storm.md) - the reattach replay was one full-ring stream paying a per-chunk masker scan; replay writes now batch behind a single whole-buffer scan, taking a 2.1 MiB reattach from over 180 s to 2.8 s.
- [v0.83.4-bug-fixes](done/v0.83.4-bug-fixes.md) - the Rich Prompt recovers from a failed draft create with a visible error and retry, and keyboard paste is no longer suppressed on the Ghostty backend.

### v0.83.3

Shipped 2026-08-03; see [release-v0.83.3](../release/release-v0.83.3.md). Closed items in [`done/`](done/):

- [timing-test-virtual-clock](done/timing-test-virtual-clock.md) - the shutdown-grace test runs on tokio's paused clock and the indexer recovery waits ride one 30 s convergence budget, so a contended host cannot fail the gate.

### v0.83.0

Shipped 2026-08-03; see [release-v0.83.0](../release/release-v0.83.0.md). Closed items in [`done/`](done/):

- [unified-command-launcher](done/unified-command-launcher.md) - one searchable command deck rendered inline by the SPA that owns the focused window, with authority following the rendering SPA and no Tauri overlay window.
- [extensions-v1](done/extensions-v1.md) - TOML-declared extensions run as supervised subprocesses behind an iframe tab, with host capabilities and declared commands.
- [gateway-security-review](done/gateway-security-review.md) - entry-path failures made registry-independent, the identity SPA policy corrected to admit the provider avatar it renders, and strict audit-IP parsing.
- [terminal-secret-masking](done/terminal-secret-masking.md) - secret-shaped values masked in the terminal, with a malformed suffix no longer able to overwrite the user's server.toml.
- [kimi-submit-agent](done/kimi-submit-agent.md) - Kimi as a named submit agent with its own measured chord, command derivation, batching, and SPA mirror.
- [team-spawn-poke-tui-readiness](done/team-spawn-poke-tui-readiness.md) - the identity poke gates on DECSET 2004 with a bounded, named failure instead of a fixed grace.
- [cs-tunnel-single-port-shorthand](done/cs-tunnel-single-port-shorthand.md) - `cs tunnel <port>` as shorthand for `<port>:<port>`.

### v0.82.0

Shipped 2026-08-01; see [release-v0.82.0](../release/release-v0.82.0.md). Closed items in [`done/`](done/):

- [whole-file-read-elimination](done/whole-file-read-elimination.md) - every HTTP read path bounded, the indexer off the workspace lock, and range support on downloads.
- [cs-tunnel-eof-truncation](done/cs-tunnel-eof-truncation.md) - forwarded connections drain already-read bytes before closing; the item's size-threshold model was disproved by measurement.
- [parallel-suite-flake-hygiene](done/parallel-suite-flake-hygiene.md) - a poisoned lock no longer aborts the process, and the gateway idle assertion is anchored rather than padded.
- [retire-devserver-windows-endpoint](done/retire-devserver-windows-endpoint.md) - the legacy window adapter, route, wire type, and its tests are gone.
- [terminal-backend-visibility](done/terminal-backend-visibility.md) - terminals export their engine, the context menu names the live renderer, and the launcher toggles it.

### v0.80.0

Shipped 2026-07-29; see [release-v0.80.0](../release/release-v0.80.0.md). Closed items in [`done/`](done/):

- [chan-desktop-reverse-tunnel](done/chan-desktop-reverse-tunnel.md) - delivered in part: `cs tunnel` forwards TCP from the connected desktop to the devserver over direct and gateway paths with owner gating and foreground-lifetime teardown; UDP remains an explicit refusal and the broader desktop-window-command request did not ship as part of this item.
- [terminal-submit-suffix](done/terminal-submit-suffix.md) - every non-empty agent submit carries exactly one trailing newline ahead of its server-owned chord, raw writes remain byte-identical, and all logical writes refuse above 4,096 UTF-8 bytes.
- [video-preview-and-range-serving](done/video-preview-and-range-serving.md) - MP4/WebM/MOV inline and fullscreen video preview backed by bounded single-range HTTP serving; MP3 has range/content-type support while audio UI, mixed-media viewer navigation, and resumable downloads remain follow-ups.

### v0.79.0

Shipped 2026-07-26; see [release-v0.79.0](../release/release-v0.79.0.md). Closed items in [`done/`](done/):

- [gw-ctrl-plane](done/gw-ctrl-plane.md) - the gateway is administrable as a product boundary without database access: explicit user access states, a durable per-user connected-devserver limit across the proxy fleet, session and tunnel inspection and revocation, an idempotent admin API for an external account service, and account credentials separated from database roles.
- [desktop-launcher-only-menubar](done/desktop-launcher-only-menubar.md) - off macOS only the Chan Launcher window carries a native menubar; the chords the retired per-window-kind bars owned move into the per-window key bridge, and macOS routing is unchanged.
- [ghostty-terminal-backend](done/ghostty-terminal-backend.md) - ghostty-web available as an opt-in terminal backend behind `terminal.ghostty`, default off and never the default.
- [tab-rotation-across-sides](done/tab-rotation-across-sides.md) - next and previous rotate a pane's whole tab set across both Hybrid sides, and the close shortcut on an empty visible side flips to the populated side rather than only flashing the toggle.
- [wall-clock-test-flakiness](done/wall-clock-test-flakiness.md) - the self-write tests take a caller-supplied instant instead of reading the wall clock, browser check 62 asserts a load-monotone structural cap instead of a rate ceiling, and check 60 skips on an absent precondition instead of failing.

### v0.78.0

Shipped 2026-07-26; see [release-v0.78.0](../release/release-v0.78.0.md). Closed items in [`done/`](done/):

- [editor-filesystem-edit-convergence](done/editor-filesystem-edit-convergence.md) - disk-echo ring entries carry an origin, so read bytes no longer inherit the 60s protection meant for written bytes; an external restore reaches the editor in 28ms rather than 58.6s and a truncation in 407ms rather than not at all. Closes the root cause the v0.76.0 fix had only bounded.
- [desktop-linux-clipboard-and-supervisor-entry](done/desktop-linux-clipboard-and-supervisor-entry.md) - native clipboard operations run off the Tauri invoke thread, Linux holds one process-wide clipboard handle so a copy outlives the operation, and the systemd/launchd writers select a `chan`-named entry point instead of persisting the desktop binary.

### v0.77.0

Shipped 2026-07-25; see [release-v0.77.0](../release/release-v0.77.0.md). Closed items in [`done/`](done/):

- [wave3-review-deferred-lows](done/wave3-review-deferred-lows.md) - six LOW findings closed: recovery sidecars off push acknowledgements, resolved recovery collapse, typed systemd desired units plus inherited-AppImage trust, window-owned generated-download cleanup and stale reaping, the documented and pinned client-cooperative 64 KiB chunk contract, and escaped-literal gitignore pruning.

### v0.76.0

Shipped 2026-07-25; see [release-v0.76.0](../release/release-v0.76.0.md). Closed items in [`done/`](done/):

- [devserver-rebuild-storm-and-livelock](done/devserver-rebuild-storm-and-livelock.md) - the rebuild-storm class closed: one `IndexScopePolicy` across walk/index/watch/report, the rebuild generation coordinator, `.gitignore` honoring, and the storm harness green including overflow injection and post-restart convergence.
- [workspace-open-reconcile-off-mount-path](done/workspace-open-reconcile-off-mount-path.md) - `Workspace::open`'s reconcile moved onto a supervised, cancellable recovery worker off the mount path.
- [gitignore-aware-exclusions](done/gitignore-aware-exclusions.md) - `.gitignore` (nested, anchored, negation) honored as the base scope layer beneath `index_excluded_dirs`.
- [devserver-startup-journal-branch-rework](done/devserver-startup-journal-branch-rework.md) - reworked as the devserver startup state machine: `starting` rows before spawn, persisted intent + generation, supervised restore, fdstore ahead of serving terminals, no premature READY.
- [editor-external-restore-echo-swallow](done/editor-external-restore-echo-swallow.md) - the echo ring re-checks after its TTL instead of clearing the observation; browser smoke check 57 ungated.
- [upload-download-budgets](done/upload-download-budgets.md) - bounded streaming transfers (server byte stream, terminal download, desktop native) and bounded 2-download/1-upload concurrency.

### v0.75.0

Shipped 2026-07-24; see [release-v0.75.0](../release/release-v0.75.0.md). Closed items in [`done/`](done/):

- [loopback-redirect-desktop-signin](done/loopback-redirect-desktop-signin.md) - RFC 8252 loopback redirect + PKCE replaced the `chan://` scheme, fixing desktop sign-in on Linux and Windows.
- [windows-deeplink-second-instance](done/windows-deeplink-second-instance.md) - closed as subsumed: the `chan://` scheme and deep-link plugin were removed outright.
- [drop-self-built-desktop-packages](done/drop-self-built-desktop-packages.md) - the unmaintained self-built Tauri `.deb`/`.rpm` are gone; COPR/PPA/AUR is the desktop package channel.
- [terminal-mouse-toggle](done/terminal-mouse-toggle.md) - per-terminal `terminal.mouse_capture` toggle.
- [bug-reports](done/bug-reports.md) / [bug-fixes](done/bug-fixes.md) - the v0.75.0 editor/slides/devserver/terminal bug-fix round and its report bucket.
- [cleanups](done/cleanups.md) - survey `[F]` reduced to a pure will-follow-up signal; browser-smoke CHAN_HOME sandboxing.

### v0.74.0

Shipped 2026-07-22; see [release-v0.74.0](../release/release-v0.74.0.md). Closed items in [`done/`](done/):

- [distributed-proxy-control-plane](done/distributed-proxy-control-plane.md) - the gateway coordinates devserver-proxies through one authenticated control service, replacing uncoordinated singletons.
- [distributed-proxy-control-plane-hardening](done/distributed-proxy-control-plane-hardening.md) - the accepted security hardening (Ed25519 admission leases, opaque sessions, durable revocation) shipped with it.
- [distributed-proxy-control-plane-implementation-security-review](done/distributed-proxy-control-plane-implementation-security-review.md) - the independent adversarial re-review that cleared the hardening to merge.
- [open-routing-multiple-local-instances](done/open-routing-multiple-local-instances.md) - `chan open` routes deterministically when several local instances run.
- [terminal-submit-chord-authority](done/terminal-submit-chord-authority.md) - the server owns the submit chord and `cs terminal list` shows each session's derived agent.
- [control-terminal-wake-rerun](done/control-terminal-wake-rerun.md) - a macOS wake no longer re-runs the devserver connect script on the control terminal.
- [devserver-token-rotation](done/devserver-token-rotation.md) - the devserver bearer token rotates by verb and by age, and stays out of WebView snapshots.
- [markdown-heading-detection-in-fences](done/markdown-heading-detection-in-fences.md) - fold chevrons no longer appear beside `#` comments in fenced code; headings come from the syntax tree.
- [release-asset-verification-coverage](done/release-asset-verification-coverage.md) - the release-asset verifier single-sources the required list and requires the Windows artifacts.
- [aur-publish-verification-race](done/aur-publish-verification-race.md) - the AUR post-push RPC check is advisory, not a false red.
- [copr-build-provenance](done/copr-build-provenance.md) - a frozen-main window plus a publication-provenance probe for COPR.
- [aur-aarch64-publication-gate](done/aur-aarch64-publication-gate.md) - withdrawn: aarch64 AUR CI validation was removed rather than made a gate; the aarch64 PKGBUILD still ships.

### v0.73.0

Shipped 2026-07-20; see [release-v0.73.0](../release/release-v0.73.0.md). Closed items in [`done/`](done/):

- [launcher-flip-pane](done/launcher-flip-pane.md) - the Command Launcher's dead "Flip pane" row works; the overlay stack reconciles at close.
- [terminal-queue-drain-gemini-opencode](done/terminal-queue-drain-gemini-opencode.md) - OpenCode batches its queued terminal notifications; Gemini measured and deliberately kept a boundary.
- [packaging-aarch64-validation](done/packaging-aarch64-validation.md) - delivered in part: the COPR aarch64 evidence is harvested and the item's original premise retired; the AUR gating remainder carries forward.



### v0.72.0

Shipped 2026-07-20; see [release-v0.72.0](../release/release-v0.72.0.md). Closed items in [`done/`](done/):

- [terminal-write-queue-drain](done/terminal-write-queue-drain.md) - queued terminal notifications reconcile in one agent turn, with a reported queue depth.
- [hyperscale-support](done/hyperscale-support.md) - CentOS Stream COPR packaging for `chan` and `chan-desktop`.
- [aur-support](done/aur-support.md) - Arch AUR packaging for `chan` and `chan-desktop`.
- [dump-skill](done/dump-skill.md) - `chan dump-skill` prints an agent-facing manual of chan's whole surface.
- [packaged-desktop-upgrade-refusal](done/packaged-desktop-upgrade-refusal.md) - a distro-packaged build refuses self-upgrade in every personality.

### v0.71.0

Shipped 2026-07-19; see [release-v0.71.0](../release/release-v0.71.0.md). Closed items in [`done/`](done/):

- [terminal-gemini-opencode](done/terminal-gemini-opencode.md) - OpenCode as a first-class terminal agent.
- [tauri-permission](done/tauri-permission.md) - authenticated exact-origin desktop native trust.
- [chan-workspace-graph-fix](done/chan-workspace-graph-fix.md) - unified workspace search and graph traversal.
- [chan-upgrade-release-history-fix](done/chan-upgrade-release-history-fix.md) - `chan upgrade --version` resolves the last five GA releases.
- [cosmetics](done/cosmetics.md) - editor light-codeblock and dark-selection fixes.
- [release-flow](done/release-flow.md) - the team/roadmap + team/release process migration.

## See also

- [`../README.md`](../README.md) - how chan is developed: proposing, teaming, and shipping an item.
- [`../release/README.md`](../release/README.md) - the release history and its conventions.
- [`../../.agents/skills/release/SKILL.md`](../../.agents/skills/release/SKILL.md) - the executable release procedure.
- [`../../.agents/playbook.md`](../../.agents/playbook.md) - operational lessons distilled across the project.
