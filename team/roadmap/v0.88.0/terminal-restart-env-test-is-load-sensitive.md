# A terminal restart-env test goes red under CPU starvation

Status: REGISTERED 2026-08-09 during the v0.87.0 delivery round, observed incidentally by
the `scene-conflict-test-is-load-sensitive` lane. Not implemented, and **not
investigated**: the observation is one lane's incidental sighting on another lane's
surface.

## What

`routes::terminal::tests::api_restart_terminal_updates_chan_tab_name_env`
(`crates/chan-server/src/routes/terminal.rs:2428`) went red once in 3 full-suite runs
while the suite ran under a deliberate 1-CPU cgroup cap with `--test-threads=32`.

That is a second load-sensitive test in the same suite as the one v0.87.0's
`scene-conflict-test-is-load-sensitive` item was opened for, on a different surface and
with no established relationship to it. The mechanism is unknown; nobody has looked. It
should not be assumed to share the mtime-collision cause of the item that found it, and
merging the two without evidence would repeat the mistake that item's own text warns
against.

The round's standing bar is why this is registered rather than shrugged off: a red that
fires on a run that ships trains the operator to discard the next genuine red.

## Contract

- The test passes deterministically under parallel execution on a starved host, or the
  behaviour it asserts is covered by a test that does.
- The fix names the mechanism -- test sequencing versus a real race in the restart path --
  rather than making the red go away. A race reachable by the test is presumed reachable
  by production until shown otherwise.

## Acceptance

- Reproduce at will under the same 1-CPU cgroup rig that surfaced it, then show the fix
  removes it under the same pressure.
- Consecutive full parallel suite runs under that rig, green.
- The repaired assertion is proven able to go red once, then restored.

## Rough size

Unknown until someone reproduces it. The reproduction rig is already established and cheap
(`sdme set --cpus 1` on the build container plus `--test-threads=32`), so the first step is
short even if the mechanism is not.

## It is three tests, not one: treat it as a cluster

Amended 2026-08-09 at lane close. The scene lane's rig surfaced two more `routes::terminal`
tests failing under the same pressure:

- `api_restart_terminal_updates_chan_tab_name_env` (`terminal.rs:2428`) — the original
- `api_restart_terminal_respawns_same_session_command` (`terminal.rs:2372`)
- `api_create_terminal_spawns_command_and_returns_session` (`terminal.rs:2283`)

Three tests in one module failing under the same conditions is a cluster, and **one shared
cause in the terminal test harness is likelier than three independent races**. They are kept
as one item on that reading rather than split into siblings; if the investigation shows
three genuinely different mechanisms, split then, with the evidence.

Investigate the shared harness first. All three spawn a real terminal, so the common
suspects are the spawn path, the readiness wait, and whatever sequencing the tests share
around a live PTY — not three separate assertions each racing something of their own.

## The chan-server sleep sweep does not reach this

Established 2026-08-09 by the audit lane of
[load-sensitive-tests-keep-recurring-after-three-sweeps](../done/load-sensitive-tests-keep-recurring-after-three-sweeps.md):
`api_restart_terminal_updates_chan_tab_name_env` (`routes/terminal.rs:2392-2435`) contains
**no timing construct at all** — no `sleep`, `timeout`, `Instant::now`, `elapsed()`, or
`yield_now`. Its only "sleep" is the string `sleep 1` in a shell command handed to a
spawned terminal, which is shell rather than Rust.

So this test is **not** in that sweep's population, and the sweep completing says nothing
about it. Do not close this item by adjacency when that one lands. The two sites the sweep
does hold in `routes/terminal.rs` are different functions.

Whatever makes this test load-sensitive is not a sleep, which also means the mechanism is
still genuinely unknown — reading the function for a timing keyword will not find it. The
instrument that surfaced it was the suite under a 1-CPU cgroup cap with
`--test-threads=32`; start there.

## Prior art

This failure class has been worked three times already:
[wall-clock-test-flakiness](../done/wall-clock-test-flakiness.md),
[timing-test-virtual-clock](../done/timing-test-virtual-clock.md) (the ruling: virtual
clocks over grace windows), and
[parallel-suite-flake-hygiene](../done/parallel-suite-flake-hygiene.md) in v0.82.0. None
of them covers this test. Read the ruling before choosing a repair, so this does not
become a fourth independent answer to the same question.

## Provenance

Observed by the `scene-conflict-test-is-load-sensitive` lane, which flagged it explicitly
as outside its surface and unexamined rather than folding it into its own findings.
