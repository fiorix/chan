# The control-socket takeover test races a hardcoded sleep against a retry budget

Status: REGISTERED 2026-08-09 during the v0.87.0 delivery round, observed by the
`devserver-build-identity` lane during a full `cargo test --all-targets` run. Not
implemented, and attribution to a specific change was still open at registration time --
see Evidence.

## What

`control_socket::tests::stable_bind_absorbs_a_transient_lock_holder` fails under parallel
test execution on a loaded host:

```
panicked at crates/chan-server/src/control_socket.rs:4946:14:
takeover absorbs a holder that vanishes within the retry budget:
Custom { kind: AddrInUse, error: "socket .../chan-control-....sock is owned by a live process" }
```

The test is wall-clock dependent by construction
(`crates/chan-server/src/control_socket.rs:4939-4946`):

```rust
let released = std::thread::spawn(move || {
    std::thread::sleep(std::time::Duration::from_millis(25));
    drop(holder);
});

let cell = Arc::new(RwLock::new(None));
let _handle = start_stable(path.clone(), test_ctx(cell, ControlTenant::Workspace))
    .expect("takeover absorbs a holder that vanishes within the retry budget");
```

A holder thread flocks the lock sibling, sleeps a fixed 25 ms, and drops it; the bind under
test must absorb that holder inside its retry budget. The outcome is decided by how
promptly the machine schedules two threads, so under scheduling pressure the budget can
expire before the holder's sleep does. Nothing about it is deterministic under load.

This is the same failure class as
[scene-conflict-test-is-load-sensitive](scene-conflict-test-is-load-sensitive.md) and
[terminal-restart-env-test-is-load-sensitive](terminal-restart-env-test-is-load-sensitive.md)
-- a fixed-duration assumption losing to a loaded scheduler -- but a distinct mechanism and
a distinct surface. The `timing-test-virtual-clock` ruling (virtual clocks over grace
windows) is the project's stated answer to this shape and applies here directly.

Three independent instances surfacing in one round suggests the suite carries a class of
fixed-duration timing assumptions rather than three coincidences. Whether that warrants a
suite-wide sweep instead of three separate repairs is an open question above this item.

**This class has prior art, and that is the argument for a sweep.** It has been addressed
three times already: [wall-clock-test-flakiness](../done/wall-clock-test-flakiness.md),
[timing-test-virtual-clock](../done/timing-test-virtual-clock.md) (the ruling: virtual
clocks over grace windows), and
[parallel-suite-flake-hygiene](../done/parallel-suite-flake-hygiene.md) in v0.82.0.

That last one matters directly here. Its Follow-ups section names
`crates/chan-server/src/devserver.rs:6041` as "**the remaining** chan-server
sleep-then-assert site" needing the injected-instant treatment. `control_socket.rs:4939`
is a sleep-then-assert site in the same crate, so either that sweep was not exhaustive or
this site was added after it. Whoever picks this up should establish which, because the
answer decides whether a fourth point fix is the right move or whether the class needs a
mechanical audit that cannot miss a site.

## Evidence, 2026-08-09

- Failed once in `cargo test --all-targets`: 1067 passed, 1 failed, exit 101. The run
  overlapped a release-profile LTO Nix build on the same 8-core host, load average ~20.
- **Re-run in isolation: 10/10 green**, still under load average 15-20 with that build
  running. So the single test survives a loaded box; what it did not survive was the full
  `--all-targets` suite running many test binaries in parallel *on top of* that build. The
  amplifier is parallel oversubscription, not CPU scarcity alone.
- **Attribution was still open when this was registered.** The observing lane's changes
  (`routes/health.rs`, `devserver.rs`, `routes/mod.rs`, a one-line `pub use` in `lib.rs`)
  touch no socket binding, flock, or takeover code, and no mechanism connects a health
  field to a bind race -- but that lane correctly declined to assert independence on the
  strength of reading its own diff, and ran the check at `main` instead. Whoever picks this
  up should confirm the attribution outcome rather than assume it: a reproduction at `main`
  settles it as pre-existing, while a single green run at `main` settles nothing, because
  the failure is probabilistic.

## Contract

- The test passes deterministically under parallel execution on a loaded host, or the
  behaviour it asserts is covered by a test that does.
- The fixed 25 ms sleep is removed rather than lengthened. A larger constant moves the
  failure rate without removing the race, and buys it back as suite latency on every run.
- Whatever replaces the assertion still fails when a takeover does **not** absorb a holder
  that vanishes inside the retry budget.

## Acceptance

- Reproduce at will under deliberate pressure -- the established rig is `sdme set --cpus 1`
  on the build container with the suite oversubscribed to `--test-threads=32`, which
  reproduces the parallel oversubscription this needs rather than mere host busyness.
- Show the fix removes it under that same pressure.
- Consecutive full parallel `chan-server` suite runs under the rig, green.
- The repaired assertion is proven able to go red once, then restored.

## Rough size

Small once the mechanism is accepted, since it already is: the sleep-versus-budget race is
visible in the source and needs no investigation phase. The work is choosing the
replacement -- a virtual clock over the retry budget, or a synchronization primitive that
makes the holder's release observable rather than timed -- and proving it under the rig.

## Provenance

Observed by the `devserver-build-identity` lane, which reported the red before diagnosing
it, declined to call it a flake, and declined to claim it was unrelated to its own change
without running the check.
