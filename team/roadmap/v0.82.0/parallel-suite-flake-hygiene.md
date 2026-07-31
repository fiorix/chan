# Parallel-suite flake hygiene

Status: REGISTERED for v0.82.0; both flakes observed once each during the v0.81.0 close-out, neither reproducible on demand.

## What

Two rare test failures can red a gate without a product defect:

- `scene_sessions::tests::restamped_disk_adopt_keeps_durable_bytes_and_settles_its_echo` failed once with the adopted durable baseline missing an attribute present on disk (adopt/echo ordering), then a `Drop` path called `lock_state()`, whose `.expect` on the now-poisoned mutex turned one failing test into a SIGABRT of the whole chan-server test binary. 0/43 reproductions at the same commit afterward.
- Gateway `ws_bridge_survives_idle_window_on_client_frames_alone` failed once on a loaded shared runner with "cut arrived before the idle window elapsed: 449.9ms", a wall-clock assertion with no scheduling margin. Green on rerun.

## Contract

- Diagnose whether the scene adopt/echo ordering can actually lose a baseline attribute in product code or only in the test's interleaving; fix whichever is real.
- Cleanup and `Drop` paths in scene sessions must not `.expect` a possibly-poisoned lock; recover the guard (`unwrap_or_else(PoisonError::into_inner)`) so a failing test reports its own assertion instead of aborting the binary.
- The ws-bridge idle-window assertion gets an explicit scheduling margin or a virtual-clock harness; no gateway test asserts unpadded wall-clock durations.
- Sweep both test suites for the same two patterns (poisoned-lock expects on cleanup paths; unpadded wall-clock assertions) and fix the class, not the instances.

## Acceptance

- The scene adopt test's failure mode is explained and either the product ordering or the test synchronization is fixed.
- No cleanup path in chan-server tests can convert a single test failure into a process abort.
- Gateway CI passes repeatedly on loaded runners with no timing reruns needed.

## Rough size

Small to medium: two focused fixes plus a pattern sweep.
