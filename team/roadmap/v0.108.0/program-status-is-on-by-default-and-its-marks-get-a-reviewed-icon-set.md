# Program status is on by default and its marks get a reviewed icon set

Status: raised for v0.108.0 by the owner's word of 2026-10-20 ("turn the osc 7501 default on, and we'll need a test server for me to view and chat with an agent about changing the default icon for things related to these status, and all status that we support"); owner the frontend seat with the runtime seat for the default.

## What is asked

Two changes, reviewed together on one test server:

1. `terminal.program_status` defaults to on.
2. The owner reviews, with an agent on the test server, the icon each program status shows and every status chan supports, and chooses the default icons.

## What is there

The flag is `program_status` under `[terminal]` (`crates/chan-library/src/config.rs`, `default_terminal_program_status()` returns `false`), read as off when the key is absent on both sides (the settings toggle in `components/settings/TerminalSection.svelte` reads `?? false`). It was set off by the shipped item's decision 6, the owner's words then: "i want the default config for this to be off just in case theres unexpected bugs in the parser or anything tha would slow down the terminals" (`team/roadmap/done/a-program-in-a-chan-terminal-cannot-report-its-status-osc-7501.md`). That decision's own check is that while off the framer's byte entry returns before any per-byte work; turning it on puts that per-byte work on every terminal.

The protocol's states are `idle`, `working`, `done`, `blocked` and `error`; a blocked report carries a kind `permission`, `question` or `auth`; a report may carry `progress`. The marks are on the terminal tab only (`components/Pane.svelte`), all lucide icons at size 14:

| Status | Place | Shown today | Colour |
| --- | --- | --- | --- |
| no working record | leading | `Terminal` | default |
| working, no progress | leading | the file tab's spinner | default |
| working with progress | leading | an inline SVG ring | default |
| blocked, permission | trailing | `Shield` | `--warn-text` |
| blocked, question | trailing | `CircleHelp` | `--warn-text` |
| blocked, auth | trailing | `KeyRound` | `--warn-text` |
| blocked, other kind | trailing | `Pause` | `--warn-text` |
| error | trailing | `CircleAlert` | `--danger-text` |
| done | trailing | `CircleCheck` | `--info-text` |
| idle; a seen done or error | trailing | none, or the unseen dot | |

The tab menu's "Program status" inspector lists records as text (`components/TerminalTab.svelte`); `cs terminal list` has a `program` column.

## What to do

1. Measure before flipping: the terminal throughput cost with the flag on against off, on the framer's own benchmark or a `cat` of a large file, so the default is changed on a number. The decision 6 risk is the reason to measure, not a reason to keep it off.
2. The default: `default_terminal_program_status()` true; the settings toggle reads a missing key as on; `docs/config-reference.md`, `CHANGELOG.md`, `web/packages/workspace-app/src/design.md`, and the marketing manual pages `manual/settings.html` and `manual/terminal.html` (both say "off by default") updated; the off-by-default tests (`config.rs` `program_status_is_off_unless_the_config_says_on`, `program_status_tests.rs` `status_is_off_in_a_registry_built_from_the_default_config`, `TerminalSection.programStatus.test.ts`, `TerminalTab.programStatus.test.ts`) inverted to pin on, keeping the tests that pin the off path when a user turns it off.
3. A test server for the owner: a workspace with terminals each held in one status (a small script emitting each state, kind and a progress value, so every row of the table above is on screen at once), light and dark themes; the owner reviews there with an agent and picks icons (and colours if they ask). A side-by-side candidate page (current icon beside one or two lucide alternatives per row) on the same server is the cheapest way to compare.
4. The chosen icons applied in `Pane.svelte`, with `Pane.programStatus.test.ts` pinning each one, including the question kind, which no test pins today.

## Boundaries

`crates/chan-library/src/config.rs` (default only), `components/settings/TerminalSection.svelte`, `components/Pane.svelte` (icons and colours of the marks), their tests, the docs listed. Not changed: the protocol, its parsing, the attention ranking, `cs`.

## Acceptance

1. A throughput reading on and off, recorded here, before the default changes.
2. A fresh configuration shows program status with no setting; a configuration with `program_status = false` still turns it off end to end (the existing off tests, kept).
3. Every status, kind and progress shape on screen at once on the test server; the owner's icon choices recorded here in their words.
4. The chosen icons pinned per status, each distinct; browser check `162-program-switch.mjs` and the program checks green with the new default.

## The throughput reading 2026-10-20

Acceptance 1, with the owner's choice of protocol ("A let's do this": the v0.106.0 harness at this base on its two corpora plus the raw output of a real Claude Code and a real Codex session). The harness is v0.106.0's `escthr` probe (kept in the round's archive) extended with a ring reader for the captures: 4096-byte reads through `Session::record_output`, 1,024 warm-up and 65,536 measured reads per run, seven alternating off and on pairs per corpus in one release test binary at `4e9a68c8c`, each arm proved by one report, the verdict the median of the per-pair ratios against the 0.85 tolerance. Run on the owner's host (16 threads, pinned to one CPU) beside three other agents, so labelled contended; the series window read no CPU pressure. All 56 observations are kept and every ratio was recomputed from the raw logs.

| corpus             | off MiB/s | on MiB/s | median on/off |
| ------------------ | --------- | -------- | ------------- |
| plain              | 395.6     | 394.6    | 0.997         |
| escape-dense       | 480.9     | 419.3    | 0.874         |
| Claude Code output | 346.5     | 300.8    | 0.868         |
| Codex output       | 342.5     | 294.0    | 0.859         |

All four are inside the tolerance; five of the 28 pairs read under 0.85 (one plain pair is the low half of a bimodal plain rate on this host, cause not found). The escape-dense figure reproduces v0.106.0's 0.872. Real agent output is nearly as escape-dense as the synthetic corpus (100 and 108 ESC per KiB against 123, mostly CSI, drawn by cursor positioning), so it costs about the same: 13 to 14 percent of `record_output` alone. The captures are each session's replay ring at one moment (351,569 and 1,865,365 bytes); the Codex one holds three OSC 7501 reports, which the on arm published. In a real terminal the PTY and the server's read path dominate: a timed `cat` of 1 GiB in a standalone server's terminal with no browser attached, three alternating pairs, read 0.998 on plain and 0.985 on escape-dense (128 and 75 MiB/s), a sanity read rather than an acceptance figure.

## The owner's icon choices 2026-10-20

Reviewed on the test server (every status, kind and progress shape held in its own terminal tab, plus a page of candidates drawn as real-size tabs in both themes). The owner's words, in order: "about the icons: i need better options for the spinner and the progress one; the rest lgtm"; on the second page, after "maybe the spinner one could be a pulsating thing, or some geometric form spinning": "prompt with a typing cursor, pie inside a ring".

| Status                 | Place    | Chosen                                     |
| ---------------------- | -------- | ------------------------------------------ |
| no working record      | leading  | `Terminal` (kept)                          |
| working, no progress   | leading  | the Terminal prompt, underscore typed out  |
| working with progress  | leading  | a pie inside a ring                        |
| blocked, permission    | trailing | `Shield` (kept)                            |
| blocked, question      | trailing | `CircleHelp` (kept)                        |
| blocked, auth          | trailing | `KeyRound` (kept)                          |
| blocked, other kind    | trailing | `Pause` (kept)                             |
| error                  | trailing | `CircleAlert` (kept)                       |
| done                   | trailing | `CircleCheck` (kept)                       |
| idle, seen done/error  | trailing | none, or the unseen dot (kept)             |

Colours are unchanged. The typing prompt's cursor grows from a dot to the full underscore, holds and returns (1.2 s); under reduced motion it stays a dot, so a working tab still differs from the plain `Terminal` icon. The pie keeps the ring's dash reading (`pathLength="100"`, `stroke-dasharray="N 100"`), so the program checks read progress as before; `data-program-activity` keeps its values (`icon`, `spinner`, `ring`) as the state names the checks select on.
