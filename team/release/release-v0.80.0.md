# release-v0.80.0

v0.80.0 is cut directly from `main` with no RC pin. Fourteen commits after v0.79.2 deliver reverse TCP tunneling through a connected desktop, bounded seekable video serving and preview, stricter terminal-agent delivery, Ghostty parity work, five more empty-pane animations, two focused UI/gateway fixes, and the design and roadmap records that describe those surfaces.

The `0.80.0` GA commit remains untagged until that exact tree passes the full local pre-push gate, a `release.yml` dispatch with `publish=false`, and the cache-only Docker downstream rehearsal. The tag is the publication boundary.

## What shipped

**A devserver can ask its connected desktop to expose a reverse TCP port.** `cs tunnel [bind:]desktop-port:devserver-port` is a foreground command whose lifetime owns the listener and every relayed connection. The invoking terminal window chooses the one desktop process, and that desktop derives the devserver dial target and credentials from its own connection record rather than trusting the trigger payload. Direct attachments use the devserver bearer over loopback; gateway attachments use the pinned proxy origin, session cookie, and external origin. Both control and data legs live under `/api/library`, require the devserver owner, and bridge binary frames without asking the gateway to understand the tunneled protocol. The implementation is deliberately TCP-only: UDP parses and is refused before any listener opens. Tunnel and connection counts are not capped in this release.

**Video preview uses bounded HTTP ranges instead of whole-file buffering.** MP4, WebM, and MOV files render inline with native controls in the shared file/graph inspector and open in a fullscreen video viewer. Single byte ranges return `206` with an exact `Content-Range`; unsatisfiable ranges return `416`; absent, malformed, or multi-range requests fall back to the full bounded stream. The reader seeks and clamps against the opened file's stat, so response framing and streamed bytes agree. MP3 gains the same range and content-type path but no audio UI.

**Terminal submissions carry a reliable separator and a deliberate message budget.** Every non-empty submitted body is normalized by trimming trailing newlines and appending exactly one newline ahead of the agent-specific chord; empty input remains chord-only. The rule covers `cs terminal write --submit`, Rich Prompt, queue singletons, and framed batches at the shared encoding funnel. Raw writes remain byte-identical. Both raw and submitted logical messages refuse above 4,096 UTF-8 bytes at the CLI read and again at the server queue, without truncation or a partial enqueue. The command help and `chan dump-skill` teach the intended bus shape: longer content belongs in a file and the poke carries its path.

**Ghostty behaves closer to xterm.js while remaining opt-in.** The backend now measures xterm-style cell geometry after open, aligns Ghostty's renderer to it, installs continuous custom box glyphs, preserves scroll position across writes, and intercepts Shift+Enter for the same line-feed fallback used by xterm.js. The compatibility layer and source-shape pins keep the lazy WASM path, xterm-only addons, host-owned chords, OSC 52 bridge, and wheel shim on their established sides.

**The empty-pane catalog grows from nine animations to fourteen.** Exponential Echo, Spiral Spokes, Mutual Force Starburst, Recursive Arc Bloom, and Chaotic Halo join the existing session-persistent catalog. Geometry helpers and renderer-specific tests cover the new math while the shared welcome-surface lifecycle keeps resize, theme, visibility, reduced motion, selection, and shortcut ownership centralized.

**Two narrow fixes close real UI and gateway gaps.** The window status pill follows the live width of a right-side file-browser dock instead of covering its content, while terminal-only windows ignore persisted dock state. The gateway's reserved-username table is sorted again for its binary search, and a pairwise invariant test prevents the same silent authorization drift.

## Team and process

This release ran through team `v080rel` with Release as the sole team member and Alex as host. The terminal-submit implementation arrived as one rebased commit from the `terminal-submit-suffix` worktree; Alex integrated it into `main`, completed the v0.81.0 roadmap follow-up, and gave the release lane an explicit clean-main `GO`. Release owned the integrated gate, version close, workflow dispatches, and publication sequence.

The first gated push exposed an environmental failure rather than a source defect: a cold `cargo-tauri` install exhausted the user quota on the host's `/tmp` tmpfs while compiling `zstd-sys`. After host authorization, the runtime `.chan` artifact was preserved byte-for-byte, the Tauri CLI was installed with extraction and build output under repository `target/`, and the gate was retried. That retry found a second host-specific edge: the absolute workspace `TMPDIR` made a generated `chan-systemd` Unix socket exceed Linux `SUN_LEN`, poisoning the suite's shared environment lock after the first panic. A short `/home/fiorix/chan-v080-tmp` symlink to the same workspace-backed directory restored socket-path headroom. The isolated systemd suite passed 17/17 before the full retry, and the full hook plus HTTPS push then completed green.

The roadmap close is intentionally honest about scope. The reverse-tunnel item was registered with TCP, UDP, and broader desktop window-command language but was never specced in that form. v0.80.0 ships the grounded TCP path, keeps UDP as an explicit refusal, and does not silently claim the broader request.

## Validation

- The integrated pre-version `main` tree passed the full local pre-push hook: shellcheck over 48 scripts, actionlint, build-matrix contract, formatting, root Clippy with warnings denied, all-target Rust tests, the no-default-features build, separate gateway lint/build, launcher Svelte diagnostics plus 293 tests, workspace Svelte diagnostics plus 3,130 tests, both production web builds, marketing release/install smokes, shortcut parity, release CLI build, built-devserver smoke, native AppImage build, and AppImage devserver smoke.
- The short-temp recovery was proven independently before the full retry: canonical path and device/inode matched repository `target/release-tmp`, a worst-case representative generated socket path was 100 bytes against Linux's 108-byte limit, and `TMPDIR=/home/fiorix/chan-v080-tmp RUSTFLAGS='-D warnings' cargo test -p chan-systemd --lib` passed 17/17.
- The reverse-tunnel contract has 30 unit tests over specs, wire frames, registry lifetime, byte pumping, and teardown. The process-boundary end-to-end suite drives a real devserver, desktop trigger, concurrent TCP echo connections, unreachable destinations, foreground-command teardown, desktop disconnect, windowless refusal, UDP refusal, and invalid specs. The gateway credential mapping and owner gate are unit-tested; no deployed gateway or desktop GUI was available on this host for a live gateway hop.
- Video serving has unit and integration coverage for bounded slices, range parsing, response status/framing, and content types. A 29-assertion live curl proof byte-compared ranges against the source file and pinned full/download hashes, while browser smoke 21 exercised range playback, H.264 decode, seek, and the fullscreen viewer.
- The terminal-submit commit passed 162 CLI, 248 library, 924 server, and 118 shell tests plus integrations and docs; 91 focused frontend terminal-write tests; Rich Prompt, submit-refusal, Ghostty-write, and mouse-toggle browser checks; and live Codex queue cases for batches, boundaries, late arrival, and raw/submit caps. Adversarial review added the newline-only input edge and repaired an ineffective server-identity setup in the queue harness.
- The exact GA commit remains gated by a fresh version-triggered local push, `release.yml` with `publish=false`, and the Docker-only `publish-downstream.yml` rehearsal with `publish=false`. The GA tag is forbidden until all are green.

## Retrospective

**Highlights.** The reverse-tunnel architecture follows the only viable direction: a devserver asks over a channel the desktop already opened, and the desktop dials back. Credentials and target selection stay owned by the desktop's connection record, while the server owner gate closes the difference between holding a valid session and being allowed to open a socket on another user's machine. Terminal delivery also converged at the right funnel, so CLI, Rich Prompt, singleton, and batch semantics cannot drift independently.

**Lowlights.** The release gate spent two retries proving build-host assumptions that were not product defects. `/tmp` quota was invisible until a cold native-tool install, and moving to the repository exposed the unrelated Unix-socket path limit. Both failures were diagnosed and preserved in the release journal, but together they made the final gate substantially longer than the source delta warranted.

**Honest feedback.** The reverse-tunnel roadmap statement was broader than what landed and had no accepted spec to record the cut. Calling the whole item shipped would erase the missing UDP path and the broader window-command language. The release instead closes it as delivered in part. The Ghostty parity layer is useful and well-tested, but it is still a compatibility layer over a pre-release backend pin and carries maintenance risk that xterm.js does not.

## Follow-ups

- Decide whether UDP reverse tunneling is worth accepting as a separate item, and whether tunnel/listener connection counts need explicit caps before broader use.
- Add audio preview UI on top of the shipped MP3 range path, mixed-media previous/next navigation, and resumable downloads.
- Move the native-tool install cache and short temporary-path requirement into repeatable gate setup so future cold hosts do not rediscover the same quota and Unix-socket constraints.
- The accepted v0.81.0 roadmap carries editor media copy/view parity, file-browser media double-click, survey focus on tab return, extensions v1, and web-marketing onboarding.
