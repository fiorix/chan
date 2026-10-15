//! The `CHAN_*` namespace, and a process environment with it removed for a
//! spawned `chan` child.
//!
//! Mounted twice: by the library's `test_env`, under `cfg(test)`, and by path
//! in each integration test that spawns `chan`, because the library such a
//! test links is built without `test_env`.

use std::ffi::{OsStr, OsString};

/// The `CHAN_*` namespace and the bare `CHAN` marker a chan terminal sets
/// in every process it spawns: a child that kept the marker would read itself
/// as inside a chan terminal, so a gate run from one fails the tests that
/// expect an outside caller.
pub(super) fn is_chan_var(key: &OsStr) -> bool {
    let key = key.to_string_lossy();
    key == "CHAN" || key.starts_with("CHAN_")
}

/// A copy of the current process environment with the complete `CHAN_*`
/// namespace and the `CHAN` marker removed, for preloading a child `Command`
/// (paired with `env_clear`). A child built from this cannot inherit
/// terminal-session state or credentials; the caller then sets its own
/// sandbox values.
pub fn scrubbed_process_env() -> Vec<(OsString, OsString)> {
    std::env::vars_os()
        .filter(|(key, _)| !is_chan_var(key))
        .collect()
}
