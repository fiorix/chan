# A resilience test dumps a child's transcript before its reader threads drain

Status: raised during v0.101.0 on 2026-09-26 by the lead from landing 15's main CI (`a3a688765`, run 36250993457, `make ci-macos`), where `devserver_discovery_routes_multiple_local_instances` in `crates/chan/tests/devserver_resilience.rs` failed at `:981` with the refusal's last line missing from the captured output; a source reading against `main` at `a3a688765`. First seen; every earlier main run of the suite passed.

## What was seen

`Transcript::capture` (`devserver_resilience.rs:112-121`) drains a child's stdout and stderr in two background threads that push one line at a time under a mutex (`drain`, `:151-159`). `wait_exit` (`:481-490`) polls `try_wait` and returns the moment the child has exited, and `run_handoff_open` (`:366-372`) then calls `dump()` (`:146-148`) at once. Nothing joins the reader threads first, so a line the child wrote before exiting can still be in the reader's buffer, or between two pushes, when the test reads the transcript. On the macOS runner the ambiguous-discovery refusal (`crates/chan/src/lib.rs:3914-3919`, one `eprintln` whose text ends `Choose one with --devserver=<port|url>.`) arrived without its last line: the two candidate lines were pushed, the closing line was not yet, and `output.contains("--devserver=")` failed. The CLI's message is unchanged since before landing 13; nothing in landing 15 touches the discovery path.

## Desired contract

A transcript read after a child has exited holds everything the child wrote. `dump()` and the assertions after `wait_exit` see the complete output, on every runner speed.

## What to do

Keep the drain threads' join handles in `Transcript`, and have `wait_exit` (or `dump()` once the child is known to have exited) join them before returning the text: EOF on both pipes is guaranteed once the child is gone, so the join is bounded. Red first on Linux by inserting a small sleep before the reader's push in a copy of the helper, or by a mutation that drops the join, and show the assertion at `:981` red; then the same for every `dump()` after a `wait_exit` in the file. The other harnesses in `crates/chan/tests` that capture through the same shape get the same join.

## Boundaries

`crates/chan/tests/devserver_resilience.rs` and any sibling test harness in `crates/chan/tests` with the same drain shape; no product code. The CI red is cleared by the job's rerun, as the round's rule says, and this item makes the race impossible rather than rare.
