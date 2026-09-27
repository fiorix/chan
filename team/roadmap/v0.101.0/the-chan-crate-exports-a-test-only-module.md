# The `chan` crate exports a module that only tests call

Status: raised for a decision on 2026-09-27 by the code map of the test-only features in a shipped binary (`dev/v0101-team/int28-docs/codemaps/test-hooks-in-a-shipped-binary.md` in the development tree, its last line), which read it at `91cdd462e`, ran nothing, and placed it outside [the-aur-check-could-ship-a-test-only-feature](the-aur-check-could-ship-a-test-only-feature.md) because it is not a feature; the lead did not read it. Read again at `37e9d23dd`, with every caller found by `git grep` at that sha; nothing was built. Recommendation: accept for v0.101.0, with the hygiene work, as a module compiled for tests alone.

## What was seen

The `chan` crate's library declares `#[doc(hidden)] pub mod test_env` with no `cfg` (`crates/chan/src/lib.rs:75-79`), and its comment gives the reason: integration tests link the crate without `cfg(test)`. The module holds a guard for one test's environment, `ChanTestEnv`, which takes a process-wide permit, removes every `CHAN_*` variable, points `CHAN_HOME` at a fresh temporary directory, and on drop restores the variables it took and removes that directory (`crates/chan/src/test_env.rs:42-131`, the permit at `:22-32`); and `scrubbed_process_env`, which copies the process's environment without the `CHAN_*` variables for a child command (`:133-141`). Its own comment says that production code does not call it (`:4-5`).

Every caller is a test: the library's own test module, which opens at `lib.rs:9157-9158` and runs to the end of the file (the calls at `:11342`, `:11573`, `:11589`, `:11617`, `:11774`, `:12694`, `:13573` and `:14323`), and the eight integration tests under `crates/chan/tests/` (`cs_alias.rs:29`, `cs_output.rs:466`, `devserver_resilience.rs:78`, `remote_workspace_handoff.rs:45`, `reports_disable.rs:38`, `revtunnel_e2e.rs:99` and `:2100`, `serve_close.rs:82`, `skill_output.rs:22`). No other code in the repository calls it.

So every build of the library compiles the module, the builds the shipped `chan` binary links among them, and the crate's public surface carries it, hidden from its documentation. Whether the shipped binary carries its code was not measured: nothing the binary runs calls it, so the linker is expected to leave it out, which is inferred and was not checked on a built binary.

## Desired contract

Code that only tests call is compiled for tests alone: a build of the `chan` library without its tests neither compiles nor exports `test_env`, and the tests keep their harness.

## What to do

Compile the module for tests alone while the library's own tests and the integration tests keep it. As suggestions: a module the integration tests include by path, with the library's test module declaring it under `cfg(test)`; or a small crate of test support that only dev-dependencies name. A crate feature that the tests enable is a third way, and it would be a test-only feature of the kind [the-aur-check-could-ship-a-test-only-feature](the-aur-check-could-ship-a-test-only-feature.md) keeps out of shipped binaries. Red first: a check that a build of the library without its tests has no `test_env`.

## Boundaries

`crates/chan/src/lib.rs` (the declaration and its test module's uses), `crates/chan/src/test_env.rs`, the integration tests under `crates/chan/tests/`, and `crates/chan/Cargo.toml` if a crate of test support is added. No behaviour of the binary changes.

## Acceptance

1. A build of the `chan` library without its tests compiles no `test_env` and exports none, pinned by a check that fails if it comes back.
2. Every test that uses the harness today runs with it unchanged.
3. No shipped recipe builds whatever the tests use to reach it.
