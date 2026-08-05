# release-v0.84.0

v0.84.0 is a direct GA release of the completed v0.84 work. It makes terminal identity and appearance coherent across clients, makes secret masking opt-in so large scrollback remains usable by default, adds native audio handling and richer graph detail, hardens collaborative Hybrid Nav state, and moves the Windows and Nix release checks into disposable Ubuntu guests. The release deliberately excludes the continuing v0.85 work.

## What shipped

**Terminal metadata is server-settled and survives handoff with its provenance intact.** Creation, restart, and live rename use one registry settlement path for the complete name and group pair. Tabs, rosters, summaries, by-name selectors, and `cs terminal list` converge on that settled live identity. The running shell keeps immutable spawn name and group values for its current incarnation, fdstore preserves both live and spawn pairs, and the UI offers one restart prompt when the values diverge. A failed or disconnected proposal remains editable instead of creating a client-only name.

**Terminal and editor appearance is configurable without splitting renderer behavior.** Terminal font size is a bounded server preference captured when a renderer mounts, and the same value drives xterm, Ghostty, and xterm cell measurement. Editor font size applies live from user preferences. Custom terminal background, foreground, and cursor colours persist as one atomic object, with automatic contrast derived from the selected background. Standard theme behavior remains unchanged until Custom is enabled.

**Secret masking is opt-in.** New configurations and configurations that omit `terminal.secret_masking` resolve to `false`, avoiding the replay cost that makes large scrollback difficult to use. An explicit `terminal.secret_masking = true` remains authoritative. The existing context-menu switch remains an ephemeral per-tab control and does not rewrite the persistent preference.

**`cs open` reveals non-text files and audio has a native browser path.** Existing binary files open the File Browser at their parent with the file selected and the inspector visible. MP3, WAV, AIFF, and Ogg files receive exact content types, an inline player, and a dedicated viewer. Playback never autostarts, decode failures remain local to the media element, and every viewer close path stops and releases the media source.

**Hybrid Nav stages editor intents and fails closed on structural collaboration conflicts.** Queued drafts and diagrams appear as removable chips without becoming synthetic tabs or entering persisted layout state. Structural layout, tab, focus, and settled terminal metadata changes make an open transaction permanently stale. Navigation and mutation then remain inert until Escape discards the transaction and applies the newest pending layout. Content, terminal output, inspector state, and appearance changes do not create false conflicts. Healthy commits apply the layout first and settle every create request independently.

**The Rich Prompt hint is a control strip.** Its primary button submits and becomes cancel while a prompt is in flight. Recall appears only when this client owns text it can recover. The controls call the existing editor actions, so the established Mod-Enter, ArrowUp, Escape, queue, cancellation, and draft-restoration behavior remains the authority.

**Graph language nodes show delivery and directory detail.** The inspector exposes file and code totals, COCOMO effort and schedule estimates, and directories ranked by code volume then path. Five directories render initially, the remainder expands on demand, and selecting one graphs from that directory scope. Repository-root files keep the stable `/` label.

**Tests no longer inherit a Chan terminal's ambient state.** The shared harness clears `CHAN_*`, installs an isolated `CHAN_HOME`, and restores the exact prior environment afterward. The gate can run from a Chan terminal without reading the live devserver home, writing a devserver home into the source tree, or including an inherited tunnel credential in an assertion failure.

**Release platform checks are reproducible from Linux.** `make windows-cross-check` provisions Rust and MinGW inside a disposable Ubuntu sdme guest, compiles and lints the release CLI graph for `x86_64-pc-windows-gnu` with warnings denied, and uses a dedicated Cargo target directory. `make nix-sdme-check` snapshots tracked working-tree content, mounts it read-only without Git metadata or ignored products, installs Ubuntu's packaged Nix in a disposable guest, and runs the flake evaluation, package build, and smoke contract against a local store. The host root filesystem is not used as the build image.

**The staged destructive-action proposal did not ship.** It never acquired an accepted inventory or implementation. Destructive operations retain their established immediate action and confirmation flow.

## Team and process

The implementation round began on `v0840-base`, with independently owned feature lanes. The accepted work was integrated onto the v0.83.4 GA base, then the release scope was cut away from the continuing v0.85 branch. The release owner explicitly chose a direct GA cut with no release candidate, so the release branch moves straight from `0.83.4` pins to `0.84.0` while retaining the full local, platform, CI, and `publish=false` gates.

The implementation team was recovered from written handoffs after its original sessions stopped. Release work then moved into `/var/tmp/chan-v0840-release-cut`, separate from the continuing v0.85 worktree. Target-growing v0.85 checks remain held while the release gates run so the two lines do not compete for host capacity.

The final scope also includes three v0.83.4 follow-ups that were safe and complete: two pre-existing gateway rustfmt diffs are corrected, gateway formatting is now part of `make pre-push`, and the v0.83.4 release report records its real publication and downstream outcomes.

## Verification

- The integrated Linux `make pre-push` gate completed with status 0 on `fe450858` on 2026-08-05, covering static scripts and workflows, Rust formatting, Clippy and tests, no-default-features, the gateway workspace, all web workspaces, the release CLI and devserver smoke, and the native Linux AppImage package and smoke. Exact GA-tree verification is repeated after the version and release records are complete.
- Closed roadmap items with recorded focused evidence retain the audio control-socket and browser path; Hybrid Nav conflict partition and two-client smoke; 130 terminal-session library tests plus settled WebSocket, inventory, and SPA checks; appearance persistence and live renderer checks; 3,237 workspace-app tests around the Rich Prompt round; and masking default and explicit-true coverage. The exact GA-tree gate exercises the graph and ambient-environment coverage again.
- The Linux fdstore handoff harness passed all eight cases on 2026-08-04 at `25c96fff`, including distinct live and spawn metadata across a bare systemd restart, CLI restart, watchdog restart, crash adoption, close removal, stop, force restart, and systemd stop.
- The Windows target was proven during implementation by a cold 589.78-second guest run and a 118.10-second clean run with the host Rust and MinGW tools removed from `PATH`. The release tree repeats `make windows-cross-check` before the tag.
- The web lockfile was regenerated with npm 10.9.8. The three Cargo and web lockfile diffs contain only the `0.83.4` to `0.84.0` workspace pin changes, all five root `@chan/*` workspace links remain present, and `npm ci --dry-run --ignore-scripts` passes under npm 10.9.8.
- The shared Nix npm hash and both Cargo hashes were harvested from their own `lib.fakeHash` mismatch errors inside Ubuntu 26.04 guests. The two Cargo derivations independently returned the same vendor hash rather than one value being copied without proof. On 2026-08-05, the combined `NIX_PACKAGE=all make nix-sdme-check` run completed with status 0 in Ubuntu 26.04. Both `chan` and `chan-desktop` reported version 0.84.0 and passed the built-devserver and Nix package smokes. The guest and tracked-source snapshot were removed when the run completed. This validates the final version pins and package inputs; the GA commit's own `ci.yml` run remains the exact committed-tree Nix authority.
- Platform CI, `publish=false` release and downstream rehearsals, tagged publication, and downstream outcomes are recorded in the follow-up to this report after those live systems return their results.

## Retrospective

### Highlights

The strongest release decision was the scope cut. The complete v0.84 work stayed on one clean release line while marketing onboarding, large transfers, notifications, Ghostty input and scroll work, context-menu correction, and configuration-key coverage continued toward v0.85. The secret-masking default and the Ubuntu Nix build were late additions driven by actual release usability and reliability, and both reached the integrated gate without reopening the deferred feature set.

### Lowlights

Roadmap state drift survived until the GA audit: five implemented files still said `ready to implement`, two completed items had no status line, and the Rich Prompt change was missing from the changelog. The implementation evidence was sound, but the release front doors disagreed about it. Shared build targets also exhausted the capacity reserved for concurrent release work and forced the v0.85 checks to pause.

### Honest feedback

Written handoffs made recovery possible, but build ownership needs the same explicit discipline as source ownership. A retained target can be useful evidence and still consume the capacity needed by the release lane. Future rounds should reserve a release-space floor before target-growing work begins and should update each roadmap status when its implementation evidence lands, not defer that bookkeeping to GA.

Skipping an RC saves one version-pin cycle but does not remove any validation obligation. This cut keeps the strict lockfile check, exact-tree Linux and Windows gates, GA-pinned CI, macOS-capable `publish=false` release run, and Docker and Cachix rehearsals before the tag.

## Follow-ups

- v0.85 continues the deliberately excluded web marketing onboarding, large-transfer capability, Ghostty macOS trackpad parity, live-output scroll stability, notifications, Hybrid Nav mouse split affordances, File Browser context-menu correction, and configuration-key coverage work.
- The disposable Nix path intentionally leaves no guest store behind, which keeps the host boundary simple but makes a three-field hash harvest fetch the dependency closure repeatedly. A future release-tooling item can reduce that cost only if it preserves the tracked-source snapshot, Ubuntu image, read-only source mount, and no-host-root build contract.
- The release report receives one factual follow-up after publication with the exact workflow run IDs, artifact results, core release state, `/dl` manifests, Pages deployment, and every downstream outcome.
