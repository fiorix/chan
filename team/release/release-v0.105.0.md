# Release v0.105.0

Shipped 2026-10-11 as the one GA commit over the rc0 pin commit `72d439f6b` (branch `0.105.0-rc0`), itself over the candidate `78f787b4d` on `osc7501-int`; `main` moves to the GA commit and the tag `v0.105.0` names it. One item, the Program Status Protocol (OSC 7501), built by the osc7501 team round of 2026-10-09 to 2026-10-11 at the owner's word that v0.105.0 ships with it alone; every other v0.105.0 item is carried to v0.106.0.

## What shipped

### Library, server and devserver

- A terminal session keeps the program status records of OSC 7501 beside its byte ring: a framer that buffers an OSC 7501 or 133 body up to 4087 bytes and applies it at BEL or ESC, every pair of a report checked before any record changes, one record per id with its parent chain, the foreground rule that prunes transient records when the foreground job ends, a 64-record cap, the query answered by the library alone before any client can answer a following `CSI c`, and the records sealed and restored across a graceful devserver restart with the terminal. Escape-dense output runs at 0.646 of the base's throughput with the feature on and plain output at 0.978 (the stated bound, decision of survey 7); the feature is off by default (decision 6), so a fresh install parses nothing until the preference is set.
- The `session` frame carries the record set and revision; a `program-status` frame carries each later value, paced to one per 150 ms per socket, the latest value always delivered and a final value before exit. The list payload gains a `program_status` object per session and `cs terminal list` a `program` column.
- `cs terminal status` sends a report from a script: to the terminal's standard output, else `/dev/tty`, else over the control socket with `CHAN_SESSION_ID`, with every limit checked before a byte is written and a failed write failing the command. The `term_status` control request carries a whole report for a hook with no terminal.
- chan's own marks: a parked `cs terminal survey` reports blocked with the survey's title, `cs export` working, `cs tunnel` working and then an error when the far side ends it, `chan upgrade` in band; these records are kept apart from a program's and survive its clears.
- The feature flag `terminal.program_status` in `server.toml`, `/api/config` and the CLI column, default off: off, no report is parsed, the records held are cleared in one publication, no query is answered, the control request is refused with `program status is disabled by configuration`, chan sets none of its own marks and nothing is stored or restored; a change reaches the saving tenant at once and other tenants at their next build.
- Two fixes of the registry's exit path: its exit copy is written before a session's exit is released (a Windows-only red of a pre-existing test, found by the round's CI run at the freeze), and its two exit readers wait for a drained exit with the registry unlocked (a stall the lead ruled into the same task); and a macOS test fixture reads its terminals while the child runs, since macOS drains a session leader's controlling terminal at exit (the CI run's macOS red).
- The CLI terminal-open path writes the window's layout hash synchronously, so a reload at any moment finds the terminal in the saved layout (the owner's word, survey 8); before it a reload inside the 150 ms debounce dropped the tab.

### Workspace app and launcher

- The tab strip marks a terminal whose program reports: a spinner or a progress ring while it works, a shape for what a blocked program waits on, the mark's tooltip with the decoded fields, and a "Program status" entry in the terminal tab's menu that opens an inspector listing every record. Both engines, xterm.js and ghostty-web, consume the sequence without replying; ghostty-web's bell on a BEL-ended report is guarded.
- The terminal settings panel carries the switch "Program status (OSC 7501)", read as off when the key is absent.

### Gate and browser suite

- 23 browser checks (140 to 162) cover the states, parent and child records, clear, the inspector, the query, attach, reload, window move and restart, the flood, invalid input, chan's own commands, exit, the foreground rule, the lease, hostile text, framing cuts, the echo loop, the cut socket, the headless reporter and the switch; each red once by a named product mutation; the helper turns the flag on for them, so the suite proves the default is off.
- Two scenarios outside the browser: the tunnel marks in `revtunnel_e2e.rs` and the restart arms of `devserver-terminal-replay.sh`, whose replay client now redials on a graceful detach too (a pre-existing harness defect).
- Check 150 waits for a co-viewing page's save to settle before it moves a terminal across windows.

### Observed without a repair

- A terminal moved to another window came back into its source window once (check 150's one red in 22 runs): a co-viewing page's save before the move was applied after it, because the page's own flushed save is not awaited before its refetch; recorded as a v0.106.0 item with the mechanism named. The check now settles the co-viewer's save before the move.
- A reload that lands before a CLI-opened tab's socket opens restores a plain shell under the name, since the shared layout hash carries neither a session id nor the spawn command; a reload after the session frame re-attaches the same session. A v0.106.0 item.
- Check 131 `drafts-image-promote` timed out once waiting for a new draft beside an indexer warning for a vanished file, green in seventeen other whole runs; a v0.106.0 item.
- Under load, green alone and in every other run: browser checks 126 and 157 once each in whole browser runs; the devserver's stranded-mount test three times and its startup-restore test once in whole `chan-server` suite runs under concurrent compile load (the stranded-mount test 0 of 20 alone); the editor's fold unit test once; they fold into the carried item on suite reds under load.

## Team and process

Three seats from the launch at 2026-10-09T18:42Z: the lead on Claude Fable, the Rust seat on Codex Astra until its window ran short and then on Claude Opus, the Web seat on Codex Sol, recycled after each compaction with a standalone handoff. The bus under `dev/osc7501-team/` holds the plan, the environments, the status, the task and followup files, every hand-back, nineteen reviews, the decisions and the evidence of every run; it is archived with the round; twenty-five review files. Every seat built and tested in its own sdme guest on a team-owned btrfs pool, nothing in the host checkout; the lead integrated accepted ranges on `osc7501-int` by cherry-pick with patch-id equality and gated each tip in its own guest. Nine surveys were raised and the owner answered seven (the first timed out unanswered and the second found no window): the backup branch and the first `ci.yml` dispatch, the Nix harvest at the freeze, the framer's one bounded optimization after Acceptance 8 missed its tolerance, the dispatch at the freeze, the measured figures as the stated bound, the fix of the CLI terminal-open race, and the second dispatch at the final tip; the feature flag, its default of off and the release itself were the owner's words typed in the Lead tab. Each authorization was read no wider than its words; the two steps the lead's approval review refuses, the push of `main` and the tag, are the owner's to run.

## Validation

- The candidate `78f787b4d`: the lead's `make ci-linux` green whole in the int guest (90 result lines, 10,328 passed, zero failed, 13 ignored, every pre-push and ci-linux step); the lead's whole browser suite green alone on a quiet host (82 of 82, zero skips); the pack green alone (162, 129, 150) with the 23 program-status checks together red once on 150's backend switch (the pre-existing layout-sync race; green in the suite); Web's quiet whole suite 81 of 82 with 129, 131 and the 23 checks green and the one red the runner's environment (122, green alone with its variable). Every accepted range had the seat's own gate and the lead's independent run at its tip; `make ci-linux` passed whole in the lead's guest at the last four product tips and as a composed run at the two freeze tips before them; the whole browser suite ran at six tips by the lead and twelve by Web. The candidate at `6a0e16b16` had `ci.yml` run 38072526544 with Windows and macOS green; after it the Rust change was the library default of decision 6, not the exit path or the fixtures those jobs test.
- The rc0 pin commit `72d439f6b` (branch `0.105.0-rc0`): the lead's full `make ci-linux` in the int guest: green whole in one run, 07:19Z to 07:53Z (90 result lines, 10,328 passed, zero failed, 13 ignored, every pre-push and ci-linux step, clean tree after); `release.yml` with publish off, run 38120996686: SUCCESS (the release context, the Linux and macOS validations, every CLI tarball and desktop, gateway and Windows package job; the three publish jobs skipped as publish is off); `ci.yml`, run 38120998265: FAILURE on the first attempt, `make ci-macos` red on the pre-existing storage timing test `a_reset_beside_a_drop_that_outlasts_its_wait_for_the_lock_answers_busy_with_a_cell` (2,162 passed beside it; the eight other jobs green, `make ci-windows` among them), then SUCCESS on the rerun of that job (job 114424081822, the test green, zero failed), the run reading success on all nine jobs; the first red is kept on record; the gateway CI, run 38120999644: SUCCESS; `publish-downstream` docker and cachix dry runs against the planned tag, runs 38121001399 and 38121002874: SUCCESS (the four docker images and the two Cachix builds, every publishing job skipped).
- The GA commit: its full `make ci-linux` and the whole browser suite in the lead's guest, and its own `ci.yml` run on `0.105.0-ga`: run after this commit is made, since the commit is what they gate; their figures are recorded on `main` in the publication-record commit that follows the tag, as the previous release did.

## Retrospective

- The one `ci.yml` run the round was allowed at the freeze (a Windows measurement run had gone before it) found two platform reds the Linux guests could not reach: a Windows-only regression of a pre-existing exit-path test from the item's registry change, and the item's own macOS process test, whose fixture read a PTY the exit had drained. Both were fixed in a task and proved only by a second dispatch after the owner's word. A round with no Windows or macOS reader of its own should ask for the platform run at its first integrated product tip and again at the freeze, in one survey.
- Acceptance 8's tolerance of 15 percent on escape-dense output was not met: the per-byte framer costs about a third of the base's throughput on a corpus that is nearly all escapes, after two bounded optimizations. The owner recorded the measured figures as the bound and then set the feature off by default; a v0.106.0 item carries the profile and the condition for a default of on. Measuring the byte-path cost at the first framer, not at the freeze, would have shown the shape earlier.
- Two pre-existing races in the page's layout persistence surfaced only in whole-suite runs: the CLI terminal-open path's debounced hash write, which a reload inside 150 ms lost (fixed at the owner's word), and the co-view sync's unawaited flush, which brought a moved terminal back once (recorded for v0.106.0). A browser check that reloads or moves on a timer reads these races; the bisect over whole runs, six green before a commit, red with the toggle alone and in four of five runs at later tips (six red of nine by the close), pointed at a change that only shifted timing.
- A check's cleanup can mask the leg it cleans up after; the shared helper now collects a cleanup failure beside a leg failure instead of replacing it.
- A runner's environment is a red of its own class: twice in the round check 122 failed on an omitted binary path with a moved target directory. The gate scripts carry the variable; a seat's hand-typed invocation did not.

## Follow-ups

Opened as v0.106.0 items at this release, each with its record and acceptance in the roadmap:

- A terminal moved to another window can come back into its source window (the co-view sync's unawaited flush).
- A CLI-opened terminal reloaded before its socket opens restores a plain shell under the name.
- Escape-dense terminal output runs at two thirds of the base with program status on; the profile and the condition for a default of on.
- Check 131 timed out once waiting for a new draft beside an indexer warning.

Carried from v0.105.0 to v0.106.0 at the owner's word, untouched by this release: the thirty-two items the version held beside this one.

## Platform and pipeline

- Windows and macOS executed the Rust suites on the runners three times: run 38032464492 at `77c0c7b88` (the two reds above), run 38072526544 at `6a0e16b16` (both green, the two fixed tests passing by name) and run 38120998265 at the rc0 commit (Windows green; macOS green on the rerun of its job after one pre-existing timing test), beside the GA commit's own run; a Windows measurement run (37992338771) went before them. The browser scenarios ran on Linux only, under xterm.js and ghostty-web in Chrome.
- `make windows-cross-check` was not run: the earlier rounds recorded that this host refuses it (sdme and the disk cap); the `ci.yml` Windows job stood for it.
- The release candidate branch `0.105.0-rc0` ran `release.yml` with publish off, `ci.yml`, the gateway CI and the two downstream dry runs; the figures are under Validation.
- The GA commit was gated in the lead's guest with the full `make ci-linux` and the whole browser suite, then by its own `ci.yml` run on `0.105.0-ga`; the owner moves `main` and pushes the tag after those greens.

## Known gaps

- `chan upgrade`'s real run, the desktop webviews and a real agent CLI are not exercised end to end, as the item says; no agent CLI inspected holds the sequence as a literal.
- The browser scenarios ran on Linux only.
