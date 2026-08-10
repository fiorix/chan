# The control-socket takeover test races a hardcoded sleep against a retry budget

Status: REGISTERED 2026-08-09 during the v0.87.0 delivery round, observed by the
`devserver-build-identity` lane during a full `cargo test --all-targets` run.
**IMPLEMENTED 2026-08-10**: the fixed 25ms sleep is removed, not lengthened; the holder's
release is now observable through a thread-local test seam. Reproduced at **3 red in 30
runs (10%)** under a 1-CPU cgroup rig and **0 in 30** after, with the repaired assertion
proven able to go red and restored.

> **Reconciling this item against itself.** Two statements above were open questions at
> registration and are now settled; they are kept rather than edited.
>
> - *"attribution to a specific change was still open"* -- **settled: pre-existing.** The
>   registration text correctly warned that a single green run at `main` proves nothing
>   about a probabilistic failure, so it was settled by rate instead: 3 red in 30 runs of
>   the unmodified suite at `e239c770`. The observing lane's changes are not implicated.
> - *"Whether that warrants a suite-wide sweep instead of three separate repairs is an open
>   question above this item"* -- answered by the round rather than by this item: the three
>   turned out to be **three different mechanisms**, and the terminal cluster's three tests
>   collapsed to **one** shared cause. A single sweep would have found neither. The
>   `parallel-suite-flake-hygiene` follow-up's claim that `devserver.rs:6041` was "the
>   remaining chan-server sleep-then-assert site" was simply incomplete; this site existed
>   and its sweep did not reach it, which is the answer to the question that section poses.
>
> **Line numbers above are as of `e239c770`** and this repair moved them. The seam added
> ahead of `take_stable_lock` shifts the test and its assertion down by roughly 55 lines:
> the panic site recorded as `control_socket.rs:4946` in Evidence is `:5018` after the
> change. Anchor on the symbol names -- `take_stable_lock`,
> `stable_bind_absorbs_a_transient_lock_holder` -- rather than on the line numbers, which
> were true when written and are not now.

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
[scene-conflict-test-is-load-sensitive](../done/scene-conflict-test-is-load-sensitive.md) and
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

## Attribution, settled 2026-08-10: pre-existing

Registration left this open and warned that a single green run at `main` settles nothing
because the failure is probabilistic. Settled by measurement instead:
`stable_bind_absorbs_a_transient_lock_holder` went red **3 times in 30 runs (10%)** of the
unmodified `chan-server` lib suite at `e239c770`, under a 1-CPU cgroup cap with
`--test-threads=32`. The observing lane's changes are not implicated; the defect is in the
test as written.

## The margin is narrower than it looks

`take_stable_lock` (`control_socket.rs`) is `ATTEMPTS = 5` with `RETRY_DELAY = 25ms`, so
the takeover spends roughly **100ms** across four sleeps and five `try_lock` attempts. The
test's holder slept a fixed **25ms**.

Both sides used *the same 25ms constant*. The test did not beat the budget by 4x; it beat
it by however many of the four retry sleeps got scheduled promptly. Under oversubscription
that margin disappears, and the outcome was decided entirely by how promptly the machine
scheduled two threads.

## Implemented 2026-08-10: the release becomes observable, not timed

The Contract required the fixed 25ms be **removed rather than lengthened**, and named "a
synchronization primitive that makes the holder's release observable rather than timed" as
a direction. Taken directly.

That requires the takeover to be able to say *when it is retrying*, so it needs a seam in
`control_socket.rs`. A `#[cfg(test)]` hook now fires after each failed attempt inside
`take_stable_lock`, with an RAII guard that clears it on drop so a panicking test cannot
leak it into whatever runs next on that thread.

The test drops its holder inside the hook via `Option::take`, so the sequence is fixed on
any host: attempt 1 fails, the holder vanishes, a later attempt inside the same budget
succeeds. No sleep, no constant, no scheduling dependency.

### The hook is thread-local, deliberately

`take_stable_lock` retries on its **caller's** thread, so a thread-local reaches exactly
the right retry loop while staying invisible to the other 31 threads of a parallel test
binary.

A process-global hook would have been the same class of defect this round registered
against unrelated code in this very suite: shared mutable state written by one test and
read concurrently by others. `std::env::set_var` has been `unsafe` since Rust 1.63 for
precisely that reason. Introducing a global hook here while filing that as a defect
elsewhere would have been incoherent.

### The virtual-clock ruling does not reach this one

[`timing-test-virtual-clock`](../done/timing-test-virtual-clock.md) is the project's answer
to wall-clock *grace windows*, and this item's registration text expected it to apply
directly. It does not, and the reason is worth recording so the next reader does not try:
`take_stable_lock` retries with `std::thread::sleep`, not tokio time, so a paused tokio
clock cannot virtualise it. Reaching the ruling's shape would have meant making the
production retry loop tokio-timed purely to serve a test.

Making the release **observable** removes the timing dependency altogether, which is the
stronger form of the same principle: the ruling's point is that a test should not assert
against a duration, and this asserts against an event instead.

### Discrimination

Preserved by construction, and stated in the test's own comment: remove the retry loop and
the hook never fires, the holder never releases, and the bind returns `AddrInUse`. The
neighbouring `stable_bind_refuses_to_clobber_a_live_server` continues to pass, so the seam
did not weaken the negative case -- a persistent holder is still refused.
