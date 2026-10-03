# The `chan` crate exports a module that only tests call

Status: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-27 by the code map of the test-only features in a shipped binary (`dev/v0101-team/int28-docs/codemaps/test-hooks-in-a-shipped-binary.md` in the development tree, its last line), which read it at `91cdd462e`, ran nothing, and placed it outside [the-aur-check-could-ship-a-test-only-feature](../done/the-aur-check-could-ship-a-test-only-feature.md) because it is not a feature; the lead did not read it. Read again at `37e9d23dd`, with every caller found by `git grep` at that sha; nothing was built.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule this item goes to v0.102.0: it is test-only and changes no known behaviour of the binary, and it collides with the split of the CLI crate ([the-chan-cli-crate-is-one-13k-line-file](../done/the-chan-cli-crate-is-one-13k-line-file.md)), whose moves are verified by a public surface that does not change, the `test_env` module among it, so this item is built after the split has landed and never between two of its moves. When it was raised the lead recommended accepting it for v0.101.0 with the hygiene work, as a module compiled for tests alone. It is not part of v0.101.0.

## What was seen

The `chan` crate's library declares `#[doc(hidden)] pub mod test_env` with no `cfg` (`crates/chan/src/lib.rs:75-79`), and its comment gives the reason: integration tests link the crate without `cfg(test)`. The module holds a guard for one test's environment, `ChanTestEnv`, which takes a process-wide permit, removes every `CHAN_*` variable, points `CHAN_HOME` at a fresh temporary directory, and on drop restores the variables it took and removes that directory (`crates/chan/src/test_env.rs:42-131`, the permit at `:22-32`); and `scrubbed_process_env`, which copies the process's environment without the `CHAN_*` variables for a child command (`:133-141`). Its own comment says that production code does not call it (`:4-5`).

Every caller is a test: the library's own test module, which opens at `lib.rs:9157-9158` and runs to the end of the file (the calls at `:11342`, `:11573`, `:11589`, `:11617`, `:11774`, `:12694`, `:13573` and `:14323`), and the eight integration tests under `crates/chan/tests/` (`cs_alias.rs:29`, `cs_output.rs:466`, `devserver_resilience.rs:78`, `remote_workspace_handoff.rs:45`, `reports_disable.rs:38`, `revtunnel_e2e.rs:99` and `:2100`, `serve_close.rs:82`, `skill_output.rs:22`). No other code in the repository calls it.

So every build of the library compiles the module, the builds the shipped `chan` binary links among them, and the crate's public surface carries it, hidden from its documentation. Whether the shipped binary carries its code was not measured: nothing the binary runs calls it, so the linker is expected to leave it out, which is inferred and was not checked on a built binary.

## Desired contract

Code that only tests call is compiled for tests alone: a build of the `chan` library without its tests neither compiles nor exports `test_env`, and the tests keep their harness.

## What to do

Compile the module for tests alone while the library's own tests and the integration tests keep it. As suggestions: a module the integration tests include by path, with the library's test module declaring it under `cfg(test)`; or a small crate of test support that only dev-dependencies name. A crate feature that the tests enable is a third way, and it would be a test-only feature of the kind [the-aur-check-could-ship-a-test-only-feature](../done/the-aur-check-could-ship-a-test-only-feature.md) keeps out of shipped binaries. Red first: a check that a build of the library without its tests has no `test_env`.

## Boundaries

`crates/chan/src/lib.rs` (the declaration and its test module's uses), `crates/chan/src/test_env.rs`, the integration tests under `crates/chan/tests/`, and `crates/chan/Cargo.toml` if a crate of test support is added. No behaviour of the binary changes.

## Acceptance

1. A build of the `chan` library without its tests compiles no `test_env` and exports none, pinned by a check that fails if it comes back.
2. Every test that uses the harness today runs with it unchanged.
3. No shipped recipe builds whatever the tests use to reach it.

## What shipped

Built on 2026-10-03 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, a reading of its diff, an independent review and its own gate. This record was written that day from that reading.

The `chan` library declares its test harness for tests alone (`#[cfg(test)] mod test_env;`, `crates/chan/src/lib.rs`), neither public nor hidden. The eight integration tests used one function of it, `scrubbed_process_env`; that function and the `CHAN_*` predicate it shares with the guard moved to `crates/chan/src/test_env/child_env.rs`, which the harness mounts as a child and each integration test mounts by path. No feature, no crate and no manifest change. Pinned by `crates/chan/tests/library_exports_no_test_env.rs`, a target that does not compile if the library exports the module again. A module compiled in but private is caught by the dead-code lint under the gate's denied warnings, not by that pin. The binary's behavior does not change, so the changelog has no entry.
