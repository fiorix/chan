# Release v0.75.0 - loopback sign-in, cs pane addressing, a bug-fix round

Cut 2026-07-24 from `main`, bundling everything since v0.74.0.

## What shipped

- **Loopback desktop sign-in.** chan-desktop replaces the `chan://`
  custom scheme with an RFC 8252 loopback redirect plus PKCE (S256,
  code-in-query). This fixes sign-in on Linux and Windows (the OS
  delivered the `chan://` callback to a second process that could not
  complete it) and needs no system scheme registration. The `chan://`
  scheme and deep-link plugin are removed outright, which also closes
  the windows-deeplink second-instance item. The gateway consent page
  stops asserting the requesting app's identity and names the local
  callback port.
- **Stop shipping self-built desktop `.deb`/`.rpm`.** With `chan://`
  gone, the unmaintained Tauri-built desktop packages lose their only
  role; GitHub releases ship the AppImage, and the `.deb`/`.rpm` channel
  is the maintained COPR/PPA/AUR packages.
- **`cs pane` addressing.** A consistent `cs pane` surface (`new`,
  `focus`, `resize`, `equalize`, `swap`, `close`, `close-tab`,
  `close-all`, `list`) plus `--window`/`--pane`/`--side a|b` on every
  tab opener, addressing windows, panes, and both Hybrid sides.
- **Cleanups round.** Survey `[F]` reduced to a pure will-follow-up
  signal (the follow-up-file machinery retired), and a per-terminal
  `terminal.mouse_capture` toggle that lets text selection work over a
  full-screen TUI.
- **Bug-fix round.** Editor (clickable line after a table, mermaid
  click-through, slow-network save conflict), slides (heading spacer
  band, PDF diagram sizing), the devserver `--join` watchdog, terminal
  scrollback/reattach budgets, and the rich-prompt image-paste chord.

## Team / process

Solo owner plus one host-agent session. The agent drove the work through
multi-agent workflows (parallel scouts to understand, implementers per
half, adversarial reviewers to verify) across dedicated worktrees, one
per feature, merging each to `main` behind its own gate. The owner made
every scope and publish decision; the agent reviewed, gated, and
reported. No live human team ran this cycle.

## Validation

The full two-workspace `make pre-push` gate ran green on each merge and
on the GA tree. Each feature carried an adversarial review: loopback
landed SOUND-WITH-FIXES (the review caught that the design's preferred
verifier-keyed redemption re-opened the very cross-user takeover the
item exists to kill; the shipped code-in-query variant plus an honest
residual note is the result), and cs-cmd landed RELEASE-READY-WITH-
FOLLOWUPS. Loopback's gateway half ran its DB-gated integration suite
against a local Postgres; the desktop half is unit-tested. The macOS
sign/notarize path was exercised through the mandatory `publish=false`
dry run before the tag.

Not machine-validated, by design: the interactive desktop OAuth
round-trip. chan has one user (the owner), who validates it first-hand
after ship.

## Retrospective

### Highlights

- The loopback adversarial review earning its keep: catching a login-CSRF
  that loopback + PKCE cannot fully close, and forcing an honest
  "residual, not closed" posture instead of a false guarantee. The
  no-backward-compat constraint (chan has one user) then collapsed the
  design to a clean hard-swap.
- Root-causing a browser-smoke baseline that was red on a clean tree: the
  harness inherited the host's real `~/.chan`, so a live user preference
  leaked into the checks. Sandboxing `CHAN_HOME` per run fixed it and
  became a prerequisite for the settings-writing loopback smoke.

### Lowlights

- cs-cmd arrived as one 4000-line commit with an empty body and a
  design.md that made claims the code did not honor (a "compatible"
  legacy `split`, an overstated concurrency guarantee). The review found
  them; a refinement pass corrected the docs and dropped an unwanted
  coupling to the interactive Hybrid Nav draft.
- Two review-lens agents died on output-envelope limits mid-run; the
  synthesizer covered the gap by hand each time, but the pattern cost a
  retry.
- A version-bump-style full rebuild filled the disk mid-gate once;
  reclaiming merged-worktree `target/` dirs cleared it.

### Honest feedback

The strongest work this cycle was adversarial: the reviews that refused
to accept a plausible-but-wrong security design, and the harness fix that
refused to accept a red baseline as "just flaky." The weakest input was a
large feature landed without a rationale; the review caught it, but a
one-paragraph commit body would have saved a pass.

## Follow-ups

- cs-cmd LOW: a now-unwired pane-mode-settled sink (dead exported API
  left by the Hybrid Nav removal) to drop or re-scope.
- Owner: the interactive desktop OAuth round-trip on macOS, Linux
  (AppImage + one distro package), and Windows.
- v0.76.0 (registered, not specced): video/`.mp4` preview + View needing
  HTTP range serving on the file route, and the large-file-download
  chan-desktop UI hang (upload/download budgets review).
- Loopback edge (flagged, rare): a reconnect that falls back to a full
  replay while the mouse-mode filter holds a partial escape tail.
