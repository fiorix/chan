# release-v0.81.0

v0.81.0 is integrated on `main` at `6b0a48f1`, with a five-commit close-out branch covering the cross-target cfg fix, the desktop Window-menu regression, the v0.82.0 retirement item, and this report. The release combines continuous systemd terminal parking, media and presentation parity, survey focus correctness, browser gateway entry, Nix and Homebrew packaging, and smaller desktop and empty-pane improvements. The GA tag remains pending the final release procedure and the host-owned Cachix credential bootstrap.

## What shipped

**Linux systemd devserver terminals survive every restart flavor.** Terminal PTY masters park continuously in systemd's fd store once they belong to a window, and a maintained v2 manifest records their metadata and bounded replay tails. Bare `systemctl --user restart`, `chan devserver --restart`, watchdog recovery, and crash recovery all rebuild the sessions with stable ids and window placement. Clean shutdown flushes current replay before detaching the parked set; crash recovery uses the last durable snapshot. Explicit stop and `--restart --force` still terminate sessions through the authenticated drain endpoint before the unit transition. The old prepare endpoint, TTL, nonce, and abort-on-handoff protocol are gone.

**Images and diagrams have consistent copy and View actions.** Image previews add pixel Copy PNG and source Copy SVG where applicable while retaining the existing markdown-copy behavior. Excalidraw embeds gain Copy SVG. Slide preview and play add hover/focus View plus SVG/PNG copy chrome only on the live overlay, leaving document rendering and PDF export unchanged. Image and diagram viewers mount above web fullscreen, and their event boundaries prevent one dismiss or arrow key from also closing or advancing the slide underneath.

**File-browser media gestures open the existing viewers.** Double-click and Enter route images and SVG through the image viewer with same-directory navigation, video through the video viewer, and PDF through the PDF viewer. Single-click selection and inspector behavior are unchanged, ordinary text still opens in a pane, and unsupported media keeps the existing fallback.

**Survey cards retain keyboard ownership across tab switches.** Returning to a terminal tab with a pending survey deterministically focuses the card instead of the xterm input. Hidden-tab surveys remain inert, every reachable terminal-focus path respects an active survey, and resolving the card restores terminal focus. A real two-tab browser smoke proves option, follow-up, and dismissal keys never leak to the PTY.

**Browser dashboard entry preserves the strict Origin gate.** The gateway identity handoff uses `strict-origin` in both its response header and document meta policy, so a browser's cross-origin form POST carries the exact identity Origin that devserver-proxy requires. The proxy still rejects absent, multiple, `null`, and non-exact Origin values; the sender changed, not the CSRF gate.

**Nix and Homebrew become first-class package paths.** The root flake exposes `chan-desktop` as the default package for x86_64-linux and aarch64-linux, installs `chan` and `cs` aliases, suppresses self-update behavior in Nix-owned builds, and wires native build, smoke, Cachix pin, and fresh-runner substitution jobs. Public Cachix publication still needs the host-owned cache token bootstrap. The separately developed Homebrew work adds a self-owned tap with a desktop cask and headless formula, GA rendering and audit/install smokes, downstream publication, and install-page guidance.

**The surrounding desktop surface is tighter.** The launcher window is named Computers consistently. Empty-pane animations gain arrow-key selection, a speed ladder, enso transitions, off-screen frame-loop suspension, transient WebKit context recovery, and geometry tuning. Closed but persisted devserver windows return to the desktop Window menu through the authoritative library feed; the legacy devserver endpoint remains as a one-release compatibility adapter for older desktops.

## Team and process

The main round used Core, Media, Focus, and Lead roles over separate worktrees from `fdf8661e`. Focus first reproduced the survey failure live and merged the fix as `8c0ca195`. Media delivered image/slide actions and file-browser routing through review-fix cycles, merged as `f12286cc` and `c5d225fc`. The Focus slot then took the disjoint gateway Origin item, merged as `5f250fd5`. Core specified and implemented continuous fdstore parking across chan-library, chan-server, and the CLI, with repeated adversarial review before merges `a2f64541` and `22c87bbd`.

The destructive fixed-unit fdstore proof was deliberately deferred until the live team stopped using `chan-devserver.service`. Its first post-teardown run reached the new implementation but failed because the script still queried the stubbed `/api/devserver/windows` endpoint. Commit `c96f3957` moved the harness to `/api/library/windows`; the complete eight-case suite then passed 8/8.

The isolated pre-push gate exposed a separate parallel-suite race. Fdstore boot tests rewrote process-wide `CHAN_HOME`, while workspace-mounting tests could resolve it concurrently and read or persist tenant state under the wrong home. The round's ordered Rust gates used `--test-threads=1`, so they could not expose that interleaving. Commits `4da4a77a`, `23fc1c1c`, and `f30de4a8` added an RwLock-backed environment guard and covered every real-workspace mounting test. The isolated gate then passed end to end. Main integrated the round as `8e9960ad`, then union-merged the separately shipped Homebrew packaging as `6b0a48f1`.

Main CI found one more cross-target boundary: the Linux-only fdstore detach sweep was cfg-gated, but its `Session::detach_for_fdstore_restart` helper was not, so Windows and macOS warning-deny jobs rejected it as dead code. The close-out branch aligns the helper with its only caller. Live validation also found the desktop Window-menu reopen block still consuming the stubbed compatibility endpoint; the server now serves the frozen adapter for older desktops, while the current desktop polls the gateway-aware library feed.

## Validation

- The integrated round passed two complete native Rust test runs serially, one under an independently resolved `TMPDIR`; native formatting and warning-deny Clippy were green.
- The Windows GNU workspace cross-check passed after the child-liveness platform split. Main CI's later warning-deny finding on the Linux-only detach helper is cfg-corrected in the close-out batch and passes native plus `x86_64-pc-windows-gnu` chan-library Clippy with warnings denied.
- The integrated workspace-app gate passed with 0 diagnostics and 327/327 files, 3,178/3,178 tests. The survey browser regression passed three consecutive real two-tab runs.
- The gateway workspace passed formatting, warning-deny Clippy, and 276/276 identity plus devserver-proxy tests against the seeded database.
- The destructive `scripts/e2e/devserver-fdstore.sh` suite passed all eight restart, crash, close, force, and stop cases after its feed correction. The lower-level real-systemd suite also passed 17/17.
- The isolated full pre-push gate passed after the parallel `CHAN_HOME` race was fixed across all workspace-mounting tests.
- The Window-menu close-out has server wire and behavior regressions, native server Clippy, and 323/323 chan-desktop binary-target tests green. The package has no library target, so the work order's literal `cargo test -p chan-desktop --lib` selector is invalid; `--bin chan-desktop` is the full desktop unit-test target.
- The Nix CI lane remains red until the host provisions the Cachix authentication token. This is external credential bootstrap, not a source or build failure.

## Retrospective

**Highlights.** The checkpointed review model paid for itself. Media review found event bubbling, stale async View actions, pre-load image chrome, MIME misclassification, and mixed-paragraph alignment before integration. Core review forced exact store ordering, provisional-park race compensation, honest cap and barrier claims, deterministic cleanup, and a real destructive matrix rather than accepting unit coverage as equivalent. The gateway fix preserved the security boundary by correcting the browser's referrer policy instead of weakening exact-Origin validation.

**Lowlights.** The most expensive evidence arrived after the nominal round. The fixed-unit suite could not run while the team's own terminals depended on that unit, then its first safe run failed on an obsolete endpoint in the harness. The isolated gate needed several iterations because the first environment guard covered observed victims instead of the full class of workspace-mounting tests. Main CI then found a warning that the non-warning-deny cross-target round command had reported but not failed.

**Honest feedback.** The round's serial Rust gates were strong determinism checks but structurally incapable of finding a process-environment race that requires parallel tests. The Windows cross-check proved compilation but omitted `-D warnings`, so it normalized a warning that CI correctly treated as a release failure. Neither static gate exercised the desktop Window menu against persisted disconnected devserver rows; the stubbed endpoint and surviving legacy consumer were both visible in source, but only live use connected them into a regression. Future close-outs need parallel server tests, warning-deny cross-target checks, and a consumer audit whenever an endpoint becomes a stub or compatibility surface.

## Follow-ups

- Provision the public Cachix cache credentials and rerun the Nix publication/substitution lane before GA.
- Deploy the gateway identity/proxy pair in version lockstep and verify browser Open against production.
- Retire `GET /api/devserver/windows`, its adapter type, route, and wire tests in v0.82.0 after one release of compatibility life.
- Extensions v1 and web marketing onboarding moved to v0.82.0 before this round and remain active roadmap items.

## CHANGELOG draft

- Linux systemd devserver terminals now survive CLI, bare systemctl, watchdog, and crash restarts; stop and forced restart still terminate them.
- Image previews add Copy PNG and Copy SVG actions, and slide preview/play add View plus copy chrome for images and diagrams.
- Double-click or press Enter on image, SVG, video, and PDF rows in the File Browser to open the matching viewer.
- Survey cards keep keyboard focus after switching away from and back to their terminal tab.
- Browser Open from the gateway dashboard reaches the devserver without weakening exact-Origin validation.
- Nix users get a default chan-desktop flake package for x86_64-linux and aarch64-linux, with Nix-owned update behavior.
- macOS users can install Chan Desktop or the headless CLI from the `fiorix/homebrew-chan` tap.
- The launcher is named Computers, and empty-pane animations gain speed controls plus off-screen suspension.
- Closed, persisted devserver windows return to the desktop Window menu.
