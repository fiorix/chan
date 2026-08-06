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

### v0.85.0

| item | state | what needs to happen |
| --- | --- | --- |
| [standalone-terminal-appearance-settings](v0.85.0/standalone-terminal-appearance-settings.md) | implemented, owner validation pending | confirm a standalone terminal matches a workspace terminal on macOS, including the selected backend |
| [desktop-library-window-open-unavailable](v0.85.0/desktop-library-window-open-unavailable.md) | implemented, owner validation pending | confirm native window creation and focus in a gateway-served and a local chan-desktop window on macOS |
| [large-transfer-capability](v0.85.0/large-transfer-capability.md) | implementation in progress | finish the bulk-transfer lane, admission control, queue protocol, browser state, and acceptance evidence before raising the ceiling |
| [ghostty-macos-trackpad-scroll-parity](v0.85.0/ghostty-macos-trackpad-scroll-parity.md) | implemented, owner validation pending | calibrate the accepted factor on macOS hardware and complete live client checks |
| [ghostty-live-output-scroll-stability](v0.85.0/ghostty-live-output-scroll-stability.md) | implemented, owner validation pending | complete the real streaming and browser evidence |
| [hybrid-nav-mouse-split-affordances](v0.85.0/hybrid-nav-mouse-split-affordances.md) | implemented, owner validation pending | complete runtime input evidence on real hardware; jsdom proves no layout |
| [file-browser-context-menu-inspector-actions](v0.85.0/file-browser-context-menu-inspector-actions.md) | implemented, evidence complete | close at GA |
| [chan-config-key-coverage](v0.85.0/chan-config-key-coverage.md) | implemented, validation pending | complete integrated validation of the serialized key authority |
| [settings-checked-checkbox-pill-border](v0.85.0/settings-checked-checkbox-pill-border.md) | implemented, evidence complete | close at GA |
| [cs-terminal-list-queue-depth](v0.85.0/cs-terminal-list-queue-depth.md) | implemented, evidence complete | close at GA |

### v0.86.0

| item | state | what needs to happen |
| --- | --- | --- |
| [notifications](v0.86.0/notifications.md) | deferred from v0.85.0, not implemented on the release ancestry | start from the contract; the earlier implementation is on an abandoned candidate chain and was excluded from the v0.85.0 recovery |
| [web-marketing-onboarding](v0.86.0/web-marketing-onboarding.md) | deferred from v0.85.0, not specced | turn the product-positioning notes into a focused onboarding page with diagrams and short videos |
| [web-lock-check-destroys-node-modules](v0.86.0/web-lock-check-destroys-node-modules.md) | accepted, specced | make the lockfile sync check non-destructive on the pinned npm, and correct the comment that says it already is |
| [editor-widget-tests-are-nondeterministic](v0.86.0/editor-widget-tests-are-nondeterministic.md) | accepted, specced | fix the render race behind three intermittently failing editor tests so the gate stops going red on an unmodified tree |
| [large-transfer-ceiling-refinements](v0.86.0/large-transfer-ceiling-refinements.md) | accepted, specced | bound archives cumulatively by the ceiling, charge ranged reads by transferred length, and plumb recovery with the reported value |
| [gateway-tests-do-not-run-off-main](v0.86.0/gateway-tests-do-not-run-off-main.md) | accepted, specced | execute the gateway's tests on the path that delivers gateway code, not only on a push to main or a gateway-path PR |

## Completed

### v0.84.1

Shipped 2026-08-05; see [release-v0.84.1](../release/release-v0.84.1.md). Closed items in [`done/`](done/):

- [graph-large-workspace-render-cost](done/graph-large-workspace-render-cost.md) - a selection click no longer re-heats the layout and a settled graph paints nothing, with the selection-derived paint inputs memoised and the viewport culled.

The release also carried five fixes that entered from live use without their own roadmap items: live-only BM25 path enumeration, a pane split surviving a mid-teardown layout read, terminal chrome following a custom background, a devserver join detaching on non-TTY stdin EOF, and an honest chan-desktop window-open message with its refusal diagnostics. The desktop library-window repair behind that last one was deferred to v0.85.0 as [desktop-library-window-open-unavailable](v0.85.0/desktop-library-window-open-unavailable.md).

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
