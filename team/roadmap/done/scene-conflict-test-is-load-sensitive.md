# A scene_sessions conflict test fails under host load

Closed: shipped in [v0.87.0](../../release/release-v0.87.0.md).

Status: REGISTERED 2026-08-08 from a full-gate observation during v0.86.0 preparation; deferred to v0.87.0 the same day before the cut.

## What

`scene_sessions::tests::flush_cas_conflict_enters_conflicted_after_corroboration` in `chan-server` failed once during a full `cargo test --all-targets` run, panicking at `crates/chan-server/src/scene_sessions/mod.rs:3333` with `deferred fold-in is not a settled flush`. The run shared the host with four active build lanes.

## Evidence, 2026-08-08

- The failing run: 1046 passed, 1 failed, under concurrent lane builds.
- 20 of 20 isolated runs of the single test passed on the same tree.
- 5 of 5 full parallel `chan-server` lib runs passed once the host quieted.
- The full gate re-run on the quiet host was green end to end.

So the trigger is load, the mechanism is unestablished, and the test guards the doc-session/scene conflict machinery introduced in this release window (`bfec3b12`), which has not yet shipped. This is the same defect class the editor-widget item names: a red that fires on a run that ships trains the operator to discard the next genuine red.

The known prior scene flake (a 1-in-50 SIGABRT from an adopt race with a destructor double-panic) is a different mechanism and a different failure shape; do not merge the two without evidence.

## Contract

- The test passes deterministically under parallel execution on a loaded host, or the behaviour it asserts is covered by a test that does.
- The fix names the mechanism: whether the race is in the test's own sequencing or in the conflict machinery's settling logic. A race reachable by the test is presumed reachable by production until shown otherwise.
- Whatever replaces the assertion still fails when a CAS conflict does not enter the conflicted state after corroboration.

## Acceptance

- The named mechanism is demonstrated, not inferred: reproduce the failure at will (for example under deliberate CPU contention or a paused-clock schedule), then show the fix removes it under the same pressure.
- 20 consecutive isolated runs and 5 consecutive full parallel `chan-server` suite runs on a loaded host, green.
- Per the gate discipline, the repaired test is proven able to go red once, then restored.

## Rough size

Small to medium, mostly investigation; the fix is likely small once the race is named, and the class ruling from the timing-test work (virtual clocks over grace windows) may apply directly.

## Implemented 2026-08-09 (`78afddeb`)

The race is in the tests' own sequencing, not in the conflict machinery's settling logic. `Workspace::write_text` does not reliably move `mtime_ns`: two atomic writes to one path can produce the same nanosecond timestamp. A session reads an unchanged token as its own flush echo, so `write_text_if_unchanged` commits instead of returning `WriteConflict` (`workspace.rs:1787`, `(Some(m), true) => current != Some(m)`, with no content backstop) and `reconcile_session_locked` returns at the flush-echo guard (`mod.rs:1698`) without folding anything in. A test that stages an external edit by writing bytes alone is asserting against a divergence the session never sees. Given a disk whose mtime equals the token, the settling logic did exactly what it is specified to do.

The instrumented capture, from the item's own test:

```
token=Some(1786267823179111267)  after_write=Some(1786267823179111267)  equal=true
flushed_after=Some(1786267823180526355)  state=Clean
```

The flush committed, the session went `Clean`, and the external edit was overwritten, so `settled` was `true`.

This closes the follow-up [`parallel-suite-flake-hygiene`](../done/parallel-suite-flake-hygiene.md) left open at v0.82.0, which removed the mtime input from one adopt test by hand and recorded that "the equal-mtime short circuit is an unproven mechanism rather than a demonstrated root cause" with "the original scene race remains unreproduced". It is now demonstrated, and the one-site workaround is generalised: staging routes through `Fixture::external_write`, which writes the bytes and then advances the file's mtime, so the divergence is the test's own input rather than a property of the filesystem clock. Twenty staging sites across eighteen tests move to it. `timing-test-virtual-clock` does not reach this class: the value that fails to advance is a kernel filesystem timestamp, not an `Instant`, so no virtual clock over `Instant` moves it, and the repair is neither a sleep nor a retry budget.

A second test on the same surface, `reconcile_merges_hand_edits_with_bumped_versions`, fails through the other consumer of the same equality and is repaired by the same change.

### Reproduction

Pressure is a cgroup cap on the lane container rather than host-wide load, which makes it controllable and repeatable: `sudo sdme set chan-v087-scene --cpus 1`, verified on the host at `machine.slice/sdme@chan-v087-scene.service` as `cpu.max: 100000 100000`, with the chan-server lib suite oversubscribed to `--test-threads=32`. The contention is the suite contending with itself for one of the host's eight CPUs; nothing else is applied. Under it the suite goes red about 2 runs in 60 before the change and 0 in 60 after.

The item's acceptance says "on a loaded host". The cap is used instead, deliberately, because the measurement shows load is the amplifier and not the cause, so a controllable amplifier is the better instrument. `write_text` leaves `mtime_ns` unchanged for 29, 12 and 37 of 5000 back-to-back writes on an idle uncapped host, and 66 of 5000 under the cap. The acceptance runs below also happened to run with the host genuinely loaded at 15 to 18 by a concurrent release-profile LTO build, so both readings of the bar are covered.

### Validation

Twenty consecutive isolated runs of each repaired test, green. Five consecutive full parallel `chan-server` suite runs under the cap on a loaded host, with zero `scene_sessions` failures in all five. Isolated runs are recorded for the acceptance but are a weak signal for this defect: 400 consecutive isolated runs of each test are green on the unfixed code, because a test's own gap between the fixture write and the staged write is usually wide enough to hide it.

Four mutation probes, each recorded with what it fails:

- Fix reverted, `advance_mtime` dropped from `external_write`: 3 red in 60 suite runs, against 0 in 60 with it. The repair is load-bearing.
- Deferred fold-in reports as settled (`return true` where the CAS-conflict arm returns `false` on a parked observation): fails exactly `flush_cas_conflict_enters_conflicted_after_corroboration`, 1 failed of 67.
- Overlapping divergence merges instead of conflicting (`MergeOutcome::Conflict` replaced by `Merged`): fails the same test at `corroborated divergence must enter Conflicted`, the contract line this item names, plus the five other tests that claim conflict entry.
- A clean session's external edit never folds in (`merge_disk` dropped from the tail of `reconcile_session_locked`): fails exactly `reconcile_merges_hand_edits_with_bumped_versions` at `disk merges fan to everyone`, plus three other tests that claim clean-session fold-in.

Scoped own-gate on the root workspace: `cargo fmt --check` clean, re-run after the final edit; `cargo clippy --all-targets -- -D warnings` clean; `cargo test --all-targets --no-fail-fast` green across every target except one pre-existing unrelated flake, `handoff::tests::desktop_liveness_probe_bounds_missing_and_stale_sockets`, measured at 3 red in 15 runs on the unmodified tree against 2 in 15 with this change.

### What this does not fix

The same equality is load-bearing in production. An external editor writing within the same non-advancing timestamp window as chan's own last write or stat defeats `write_text_if_unchanged`, so chan overwrites the external edit, and defeats the flush-echo guard, so chan ignores it. `doc_sessions/mod.rs:25-30` already concedes that mtime cannot identify a flush echo, which is why the content-hash `DiskEchoRing` exists; the CAS has no such backstop. That is a silent-data-loss path rather than a test defect and is registered separately, as is the same latent staging class in the `doc_sessions` tests, whose `same_bytes_rewrite_refreshes_the_retained_token` still forces the token with a bare 20ms sleep.
