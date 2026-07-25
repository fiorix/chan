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

### v0.77.0

| item | state | what needs to happen |
| --- | --- | --- |
| [wave3-review-deferred-lows](v0.77.0/wave3-review-deferred-lows.md) | six LOW findings from the v0.76.0 wave-3 adversarial review (none drop user data); all six re-verified against the live tree and still reachable | debounce editor recovery off the ack path; collapse a resolved Conflicted session on rehydrate; derive chan's own systemd unit from the trusted renderer; reap desktop generated-download temps on window teardown; bound the desktop chunk frame before materializing; decode escaped leading gitignore path components |

### v0.78.0

| item | state | what needs to happen |
| --- | --- | --- |
| [video-preview-and-range-serving](v0.78.0/video-preview-and-range-serving.md) | registered, grounded but not specced | spec first; the real chunk is HTTP range/206 in the file route (mirrors the image path on the frontend) |

## Completed

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
