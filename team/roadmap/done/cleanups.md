# v0.75.0 cleanups round

> Status: shipped in [v0.75.0](../../release/release-v0.75.0.md).

Status: complete on branch `v075/cleanups` (base `main` @ 9cd6f97c), not
pushed. Six commits, each gated and proven individually; the full
pre-push gate and the complete headless browser-smoke suite are green
on the final tree.

Commits, in order:

- `a66df970` fix(e2e): sandbox CHAN_HOME in the browser-smoke harness
- `015d9162` refactor(survey): retire the followup file; [F] is a bare
  signal
- `20e37ad7` test(e2e): survey [F] smoke, SMOKE_ONLY filter, ephemeral
  port
- `974b35c1` feat(terminal): plumb the mouse_capture server setting
- `80504a1c` feat(terminal): refuse TUI mouse capture when
  mouse_capture is off
- `95a57001` test(e2e): terminal mouse-capture toggle smoke

## Item A: survey [F] is a pure "will follow up later" signal

The follow-up-file machinery is retired end to end. `[F]` keeps its
wire tag (`followup`) but the reply carries only the survey id, exactly
like `[X]` dismiss; the blocked `cs terminal survey` call prints
`host will follow up later` on stdout, keeping the agent's three-way
branch (option label verbatim / `survey dismissed; no answer` /
follow-up coming). Deleted outright: the server's followup-file writer
and helpers, `SurveySpec.followup` + the `SurveyFollowup` wire struct,
the CLI `--followup-dir`/`--from`/`--to` flags and context builders,
and the SPA's followup payload (`SurveyFollowupContext`, the
title/bodyMarkdown echo). The help text, the survey skill topic, and
the generated team bootstrap now document the new contract. The team
scaffold's `followups/` directory is a separate feature and is
untouched; the Rich Prompt was already independent (since v0.63.0) and
has no changes.

Proof:

- Rust gates: fmt --check, clippy -D warnings, cargo test green on
  chan-shell (104) / chan-server (760) / chan (139, including the
  76-col help pins and the bootstrap literal pins). Web gates:
  svelte-check 0 errors, full vitest, production build.
- Headless smoke `96-survey-followup-signal` drives a real
  `cs terminal survey` through all three replies via the SPA overlay
  and asserts the exact stdout lines plus a workspace-wide scan for
  any `followups/` dir or `followup-*.md` (none).
- Red-proofs against the pre-change binary: the old
  `host deferred; no follow up file created` line fails the check's
  exact-match, and a `--followup-dir` run produced a real
  `team/followups/followup-*.md` that the same scanner caught.
- Adversarial verification (two independent passes): behavior PASS
  (end-to-end trace, dismiss/option arms untouched, window fan-out
  intact, no scope creep); remnant sweep found only doc gaps
  (chan-shell design.md wire-contract paragraphs, CHANGELOG entry),
  fixed before commit.

## Item B: terminal mouse-capture toggle (narrow variant)

New `terminal.mouse_capture` server setting (bool, default on) with a
"Mouse capture" toggle in the Terminal settings section, wired like
`mcp_env`/`scrollback_mb` and served to the SPA over the existing
preferences channel; no wire or route changes. With the setting off, a
newly opened terminal strips the DECSET mouse-enable sequences (params
9, 1000-1003, 1005, 1006, 1015, 1016 in `CSI ? Pm h`) from program
output before xterm parses them, so xterm never enters mouse mode:
click-drag selection works over a full-screen TUI while wheel
scrolling, links, and the context menu keep working. Applies to newly
opened terminals (spawn-time read, like its sibling settings). With
the setting on, the filter object is never created and the output path
is byte-for-byte the previous behavior.

Mechanism notes: xterm 6 exposes no public API to refuse mouse
reporting, and selection dies at the mode flip inside xterm, not at
report traffic, so dropping outgoing reports or capture-phase pointer
interception cannot restore selection (both were disproven in an
isolated headless repro before implementation). The write-path filter
is a pure per-terminal module (`terminal/mouseModeFilter.ts`):
mixed param lists are rewritten preserving original param text,
partial escape tails are held across chunk boundaries (256-byte cap,
fail-open), DECRST/DECRQM/colon/non-`?` sequences pass verbatim. It is
applied on both write sites: live PTY output and the snapshot restore
(SerializeAddon re-emits mouse DECSET).

Proof:

- Red-proof: check `97-terminal-mouse-toggle` was written and run
  against the plumbing-only build; the default-on leg passed and the
  off leg failed on exactly the mechanism-missing selection assert,
  three runs deterministic.
- 33 unit tests port the repro's probe matrix (every chunk-split
  offset, mixed-list survival, lossless oversized/leading-zero params,
  pass-throughs, fail-open cap, 1 MiB throughput) plus TerminalTab
  source pins (spawn-time `?? true` read, write-site integration,
  original-byte seq accounting). Serde polarity is pinned in
  chan-server: a legacy `[terminal]` block without the key
  deserializes to true.
- Headless smoke green both legs, renderer-independent (headless
  Chrome runs xterm's WebGL renderer, so the check probes selection
  via the terminal's copy chord and wheel delivery via a `cat -v` PTY
  echo, with the on leg as positive control). The off leg also proves
  the settings PATCH lands in the sandboxed harness CHAN_HOME.
- Adversarial verification (two passes): default-identical PASS
  (filter structurally absent when on; ring-cursor math untouched);
  mechanism/scope PASS. Documented coverage notes: positive
  wheel-scroll/links/context-menu behavior with the filter active is
  guaranteed structurally (mode never flips; the filter touches only
  output bytes) and covered by the pre-implementation repro, not by a
  committed test.

## Round infrastructure

The browser-smoke harness now sandboxes CHAN_HOME per run
(`a66df970`). The harness previously inherited the host's real
`~/.chan`; a live host preference (`browser_side_panes.left = true`)
turned four pre-existing checks red on a clean tree and was root-caused
with an instrumented repro before any round change landed. The sandbox
also lets settings-writing checks (Item B's) assert against throwaway
toml files instead of mutating the host's real config. Additional
harness hardening in `20e37ad7`: `chan open --port 0` (a live chan on
the host held 8787), the `SMOKE_ONLY` lexical-prefix filter, and a
README note on the lexical check ordering (96/97/98 are the tail
slots).

## Close gate (final tree)

- make shell-check + make workflow-check: green.
- cargo fmt --check: green. cargo clippy --all-targets -D warnings:
  green. cargo test --all-targets: green (all crates).
- cargo build --no-default-features: green. make gateway-build
  (separate workspace): green.
- make web-check: svelte-check 0 errors on both packages; vitest
  294 + 2923 tests green; production build green.
- make web-marketing-check: green.
- Full browser-smoke suite on the committed tree: 15/15 ALL GREEN.

Round proof artifacts (red-proof transcripts, green-run logs,
screenshots) live in the round workspace under
`dev/v0.75.0-cleanups/proof/`.

## Notes and follow-ups

- Merging `v075/cleanups` and `v075/bug-fixes-1` to main may lightly
  conflict in `chan-library/src/config.rs` and
  `TerminalSection.svelte` (both touch the terminal config block; the
  bug-fix branch changed `scrollback_mb` bounds). Known, merge-time
  concern.
- The roadmap doc's deferral quote mentioned a command-launcher entry
  for the toggle; the decided round scope was the server setting plus
  the settings checkbox, so no launcher entry was added.
- Reconnect edge (flagged, not fixed, rare and bounded): a reconnect
  that falls back to a full replay while the filter holds a partial
  escape tail could corrupt at most one sequence at repaint start.
- The four editor/inspector smoke checks' `openDoc` helper still
  assumes no dock tree is visible at startup; the CHAN_HOME sandbox
  makes that assumption hold hermetically, so no check change was
  needed.
