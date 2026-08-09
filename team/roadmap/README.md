# Roadmap

Active development scope for chan, organized by the release it targets. This is the roadmap front door: what has been accepted as work for an upcoming version, and where each item goes once it ships, is withdrawn, or slips. It is not a second release report; closed history lives in [`../release/`](../release/README.md), and the process that moves an idea from a problem to a shipped release is described in [`../README.md`](../README.md).

Each item is one Markdown file that names an observed behavior or need, the evidence for it, the desired contract, its implementation boundaries, and its acceptance checks. An item earns a place here only once it is accepted scope for a concrete target version; a raw draft in the gitignored `dev/` tree is not a roadmap item until it is copied in and accepted.

## Lifecycle

1. `vX.Y.Z/{item}.md` is accepted active scope for that target version.
2. Implementation and validation evidence accumulate in the proposal, its candidate report, or the round's artifacts, without replacing the proposal's original rationale.
3. At GA the item moves to `done/{item}.md` and gains a status line linking to `[vX.Y.Z](../release/release-vX.Y.Z.md)`; the text says `shipped` only when the item actually shipped.
4. A withdrawn item also moves to `done/`, states plainly that it did not ship, and links to the release report that records the decision.
5. A deferred item moves to the next active version directory before GA. It is not marked done.
6. After the GA close commit the released version's directory is gone; every one of its items lives in `done/` or in a later active version.

## Layout rules

`done/` is intentionally flat, so item filenames must stay descriptive and repository-wide unique. If a future item would collide with a closed one, prefix that filename with its version when it is closed.

## Active

### v0.87.0

| item | state | what needs to happen |
| --- | --- | --- |
| [desktop-authorize-strands-the-browser-off-origin](v0.87.0/desktop-authorize-strands-the-browser-off-origin.md) | implemented 2026-08-09 in `0559ba2e` | land the already-signed-in browser on the profile page with a login-successful notification after desktop authorization, instead of the dead-end loopback page |
| [scene-conflict-test-is-load-sensitive](v0.87.0/scene-conflict-test-is-load-sensitive.md) | implemented 2026-08-09 in `78afddeb` | close at GA; the mechanism is named and demonstrated, staging moves the CAS token deliberately, and the production data-loss path it exposed is registered separately |
| [mtime-cas-silently-overwrites-external-edits](v0.87.0/mtime-cas-silently-overwrites-external-edits.md) | implemented 2026-08-09 in `69a4a651` | close at GA; a matching mtime is verified against the bytes the caller last saw instead of trusted, on both the flush and the reconcile echo path, with four named limitations |
| [devserver-build-identity](v0.87.0/devserver-build-identity.md) | implemented 2026-08-09 in `32520ba2`, gateway hop deferred | carry a build id in chan --version and the health surface, the server-side sibling of the desktop build identity that shipped in v0.86.0 |
| [aur-publication-is-suspended](v0.87.0/aur-publication-is-suspended.md) | deferred, blocked upstream | restore AUR publication once the Arch incident notice is superseded and pushes are permitted, deleting the guard job in the same commit |
| [desktop-build-id-is-unknown-in-the-nix-package](v0.87.0/desktop-build-id-is-unknown-in-the-nix-package.md) | registered 2026-08-09 | stamp a real build id into the Nix-built chan-desktop package and the `chan` it ships, both `unknown` today because the flake source in the store has no `.git`; the AppImage/deb/dmg path is unaffected |
| [doc-sessions-tests-stage-external-edits-on-the-filesystem-clock](v0.87.0/doc-sessions-tests-stage-external-edits-on-the-filesystem-clock.md) | registered 2026-08-09 | remove doc_sessions tests' dependence on the filesystem clock advancing, including the hand-rolled 20ms sleep already papering over it; follows the scene_sessions construction |
| [terminal-restart-env-test-is-load-sensitive](v0.87.0/terminal-restart-env-test-is-load-sensitive.md) | registered 2026-08-09, widened to a three-test cluster | name and fix whatever makes api_restart_terminal_updates_chan_tab_name_env go red under CPU starvation; observed 1 red in 3 runs, mechanism unknown and uninvestigated |
| [control-socket-takeover-test-races-a-fixed-sleep](v0.87.0/control-socket-takeover-test-races-a-fixed-sleep.md) | registered 2026-08-09 | remove the hardcoded 25ms sleep the takeover test races against its retry budget; the third load-sensitive test found this round, and the one with a named mechanism |
| [load-sensitive-tests-keep-recurring-after-three-sweeps](v0.87.0/load-sensitive-tests-keep-recurring-after-three-sweeps.md) | accepted 2026-08-09 for the round | classify all 47 timing-dependent sites in chan-server instead of point-fixing a fourth batch; the item's own first grep found only 31 and could not see `devserver.rs`, the file its acceptance names, so the corrected population and the delta are both recorded in it; the inventory is enumerated at nine tests across five crates, the suite reds somewhere different on almost every full run, three hand-applied workarounds for one unnamed mechanism are recorded, and the 20-isolated-runs bar this class certified with greenlights broken code |
| [gitignore-write-strands-the-workspace-in-recovering](v0.87.0/gitignore-write-strands-the-workspace-in-recovering.md) | implemented 2026-08-09 in `53f8b5e6` | give a watcher-requested reconcile a driver, so writing `.gitignore` in a served workspace stops parking it in a locked boot overlay no worker will ever clear; root cause confirmed against the tree, and the wired sibling is one file away |
| [chan-ps-cannot-answer-what-a-workspace-is-doing](v0.87.0/chan-ps-cannot-answer-what-a-workspace-is-doing.md) | registered 2026-08-09 | surface the readiness, generation, required-action, and indexer columns `chan ps` already has access to, so a parked workspace is a five-second read instead of a live investigation |
| [audit-the-workarounds-nobody-followed-up](v0.87.0/audit-the-workarounds-nobody-followed-up.md) | registered 2026-08-09 | enumerate the resolved obstacles nobody followed up: grep the workaround signatures in chan-workspace and ask what else assumes the thing each one worked around, the mechanism that hid the mtime CAS data-loss path for three releases |
| [the-boot-overlay-locks-the-workspace-behind-its-own-index-rebuild](v0.87.0/the-boot-overlay-locks-the-workspace-behind-its-own-index-rebuild.md) | registered 2026-08-09 | the wider reading of the stall item's contract: once a stalled pass is distinguishable from a running one, stop locking the workspace for a pass that is progressing normally; needs a non-blocking surface in the workspace app |
| [one-stalled-workspace-may-block-the-others](v0.87.0/one-stalled-workspace-may-block-the-others.md) | registered 2026-08-09, unverified lead | reproduce first: establish whether a blocked `close_workspace` really exhausts tokio workers behind the global mount lock, or falsify it; no contract until the mechanism is established |
| [submit-cannot-override-a-wrong-derivation](v0.87.0/submit-cannot-override-a-wrong-derivation.md) | implemented 2026-08-09 in `695f25ab` | make the agent named in `cs terminal write --submit` select the chord instead of being discarded, so an agent started by hand inside a shell session is reachable at all; the server's derivation is a sniff of the spawn string and cannot be corrected on a live session |
| [tab-commands-are-launcher-search-only](v0.87.0/tab-commands-are-launcher-search-only.md) | implemented 2026-08-09 in `979d20d5`, owner-tested | close at GA; the Tab scope lists completely with the focused application's own commands leading it, and the four actions the menu trim left with no command are registered |
| [window-list-is-verb-first](v0.87.0/window-list-is-verb-first.md) | implemented 2026-08-09 in `23ab509f`, owner-tested | close at GA; one Windows branch replaces the Focus/Hide/Show/Close quartet, listing each window once and offering the actions that window can actually take |

The notifications item was abandoned on 2026-08-09 without shipping ([done/notifications.md](done/notifications.md)): delivering a notice out of a devserver session, through the gateway, and onto whatever surface the user is watching is a notification service, and mature ones already exist for an agent to call directly.

## Completed

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

The release also carried the ghostty overlay scrollbar correction and the withheld-native-command message, neither of which had its own roadmap item: the first entered as an owner acceptance finding and the second from diagnosing one. The gateway acceptance failure that reopened the round was version skew rather than a defect, and is registered forward as [gateway-window-skew-presents-as-a-code-defect](v0.86.0/gateway-window-skew-presents-as-a-code-defect.md).

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
