//! Ambient-environment isolation for tests that parse env-backed CLI args or
//! spawn `chan` child processes.
//!
//! Integration tests link this crate without `cfg(test)`, so the shared
//! harness lives in the library itself; production code does not call it.
//! A chan terminal exports a `CHAN_*` namespace to its shells (MCP discovery,
//! tab identity, tunnel credentials), and clap reads `CHAN_TUNNEL_*` for the
//! devserver args, so a test launched from such a terminal inherits values
//! that change what it parses and which real home it writes to. The harness
//! removes that input class entirely instead of patching variables one at a
//! time.
//!
//! Values are captured, never rendered: assertions and failure paths must not
//! interpolate an inherited value, because `CHAN_TUNNEL_TOKEN` carries a live
//! `chan_pat_` credential.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

/// Serializes every in-process environment mutation behind one permit.
/// Env vars are process-global, so two guarded tests running in parallel
/// would otherwise restore each other's snapshots. Poison-tolerant: a test
/// that panics while guarded must not wedge the tests that run after it.
static ENV_PERMIT: Mutex<()> = Mutex::new(());

fn acquire_permit() -> MutexGuard<'static, ()> {
    ENV_PERMIT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Uniqueness for per-test homes when several guarded tests run back to back
/// in one process.
static HOME_COUNTER: AtomicU64 = AtomicU64::new(0);

fn is_chan_var(key: &OsStr) -> bool {
    key.to_string_lossy().starts_with("CHAN_")
}

/// RAII guard for one test's isolated environment.
///
/// Construction captures the complete `CHAN_*` namespace, removes it, and
/// points `CHAN_HOME` at a fresh temporary directory so nothing the test runs
/// can read or write the developer's real chan home. Drop restores the exact
/// captured state, including during panic unwinding, and removes the
/// temporary home. The guard holds the process-wide permit for its whole
/// lifetime, so guarded tests serialize against each other.
pub struct ChanTestEnv {
    // Held only when constructed through `new`; callers that already
    // serialize on the raw permit build through `under_permit` and keep
    // their own guard.
    _permit: Option<MutexGuard<'static, ()>>,
    captured: Vec<(OsString, OsString)>,
    home: PathBuf,
}

impl ChanTestEnv {
    pub fn new() -> Self {
        let permit = acquire_permit();
        let mut env = Self::under_permit(&permit);
        env._permit = Some(permit);
        env
    }

    /// Captures and clears without locking; the caller proves serialization
    /// by holding the raw permit. Private because bypassing the lock without
    /// holding it would race every other guarded test.
    fn under_permit(_permit: &MutexGuard<'static, ()>) -> Self {
        // Resolve the fresh unique directory completely before mutating
        // `CHAN_*`: a `create_dir` failure here panics with the environment
        // still untouched, and after the first mutation below there is no
        // fallible step that could strand the captured snapshot.
        //
        // A leftover directory from a crashed earlier run (same pid, counter
        // restarted at 0) must never be reused: `create_dir` refuses it and
        // the counter advances to a fresh candidate.
        let home = loop {
            let candidate = std::env::temp_dir().join(format!(
                "chan-test-env-{}-{}",
                std::process::id(),
                HOME_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            match std::fs::create_dir(&candidate) {
                Ok(()) => break candidate,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create per-test CHAN_HOME: {error}"),
            }
        };
        let captured: Vec<(OsString, OsString)> = std::env::vars_os()
            .filter(|(key, _)| is_chan_var(key))
            .collect();
        for (key, _) in &captured {
            std::env::remove_var(key);
        }
        std::env::set_var("CHAN_HOME", &home);
        Self {
            _permit: None,
            captured,
            home,
        }
    }

    /// The temporary `CHAN_HOME` this guard installed.
    pub fn home(&self) -> &std::path::Path {
        &self.home
    }
}

impl Default for ChanTestEnv {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for ChanTestEnv {
    fn drop(&mut self) {
        // Vars the test added on top of the guard's baseline are cleared
        // first so the restore below reproduces the captured state exactly.
        for (key, _) in std::env::vars_os().filter(|(key, _)| is_chan_var(key)) {
            std::env::remove_var(key);
        }
        for (key, value) in &self.captured {
            std::env::set_var(key, value);
        }
        // Best-effort only: a cleanup failure during panic unwinding must not
        // abort the process.
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

/// A copy of the current process environment with the complete `CHAN_*`
/// namespace removed, for preloading a child `Command` (paired with
/// `env_clear`). A child built from this cannot inherit terminal-session
/// state or credentials; the caller then sets its own sandbox values.
pub fn scrubbed_process_env() -> Vec<(OsString, OsString)> {
    std::env::vars_os()
        .filter(|(key, _)| !is_chan_var(key))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALPHA: &str = "CHAN_TEST_ENV_ALPHA";
    const BETA: &str = "CHAN_TEST_ENV_BETA";

    // Every test holds the raw permit for its whole body: a `CHAN_*` mutation
    // or observation made outside the permit can interleave with another
    // test's namespace-wide clear/restore and flip its expectations.

    /// Restores one env key to its exact captured state (value or absence)
    /// on drop, so an ambient key with the same name survives the test run.
    /// Declare after the permit so restoration happens before it is released.
    struct KeyRestore(&'static str, Option<OsString>);

    impl KeyRestore {
        fn capture(key: &'static str) -> Self {
            Self(key, std::env::var_os(key))
        }

        /// Seed an explicit prior state instead of capturing the live one,
        /// for restoring a value remembered across a panic boundary.
        fn seed(key: &'static str, prior: Option<OsString>) -> Self {
            Self(key, prior)
        }

        fn prior(&self) -> Option<&OsStr> {
            self.1.as_deref()
        }
    }

    impl Drop for KeyRestore {
        fn drop(&mut self) {
            match &self.1 {
                Some(value) => std::env::set_var(self.0, value),
                None => std::env::remove_var(self.0),
            }
        }
    }

    #[test]
    fn clears_namespace_and_installs_temporary_home() {
        let permit = acquire_permit();
        let alpha = KeyRestore::capture(ALPHA);
        let prior_home = std::env::var_os("CHAN_HOME");
        std::env::set_var(ALPHA, "one");
        let installed_home = {
            let env = ChanTestEnv::under_permit(&permit);
            assert!(std::env::var_os(ALPHA).is_none());
            let home = std::env::var_os("CHAN_HOME").expect("CHAN_HOME installed");
            assert!(
                home.as_os_str() == env.home().as_os_str(),
                "installed CHAN_HOME must match the guard home (paths redacted)"
            );
            assert!(env.home().is_dir());
            env.home().to_path_buf()
        };
        assert!(!installed_home.exists());
        assert!(
            std::env::var(ALPHA).ok().as_deref() == Some("one"),
            "ALPHA must hold the test-owned baseline (received value redacted)"
        );
        assert!(
            std::env::var_os("CHAN_HOME") == prior_home,
            "CHAN_HOME must be restored to its prior state (value redacted)"
        );
        drop(alpha);
    }

    #[test]
    fn restores_exact_prior_state_on_drop() {
        let permit = acquire_permit();
        let alpha = KeyRestore::capture(ALPHA);
        let beta = KeyRestore::capture(BETA);
        std::env::set_var(ALPHA, "original");
        {
            let _env = ChanTestEnv::under_permit(&permit);
            // A var added on top of the guard's baseline must not survive it;
            // an ambient one comes back exactly.
            std::env::set_var(BETA, "added");
        }
        assert!(
            std::env::var(ALPHA).ok().as_deref() == Some("original"),
            "ALPHA must hold the test-owned baseline (received value redacted)"
        );
        assert!(
            std::env::var_os(BETA).as_deref() == beta.prior(),
            "BETA must be restored to its prior state (value redacted)"
        );
        drop((alpha, beta));
    }

    #[test]
    fn restores_prior_state_after_panic_and_recovers_permit() {
        // Capture the ambient state under the permit first; the panicking
        // closure overwrites ALPHA and adds BETA, and the ambient state must
        // survive.
        let (ambient_alpha, ambient_beta) = {
            let _permit = acquire_permit();
            (std::env::var_os(ALPHA), std::env::var_os(BETA))
        };
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let permit = acquire_permit();
            std::env::set_var(ALPHA, "kept");
            // The panic unwinds with the guard alive: its Drop must still
            // restore the whole captured namespace, and dropping the permit
            // poisons the mutex.
            let _env = ChanTestEnv::under_permit(&permit);
            assert!(std::env::var_os(ALPHA).is_none());
            std::env::set_var(BETA, "added-before-panic");
            panic!("simulated assertion failure");
        }));
        assert!(panicked.is_err());
        // The poisoned permit must not wedge the tests that run after it, and
        // the unwound guard must have restored the pre-panic namespace:
        // ALPHA back to its baseline, the panic-time BETA gone. The seeded
        // restores make the final ambient repair RAII-safe: a failed
        // verification assertion cannot leave either key altered.
        let permit = acquire_permit();
        let alpha = KeyRestore::seed(ALPHA, ambient_alpha.clone());
        let beta = KeyRestore::seed(BETA, ambient_beta.clone());
        assert!(
            std::env::var(ALPHA).ok().as_deref() == Some("kept"),
            "ALPHA must hold the test-owned baseline (received value redacted)"
        );
        assert!(
            std::env::var_os(BETA) == ambient_beta,
            "BETA must be restored to its ambient state (value redacted)"
        );
        drop((alpha, beta));
        assert!(
            std::env::var_os(ALPHA) == ambient_alpha,
            "ALPHA must be restored to its ambient state (value redacted)"
        );
        drop(permit);
    }

    #[test]
    fn fresh_home_rejects_a_stale_leftover_directory() {
        let permit = acquire_permit();
        // Simulate a crashed earlier run: the next candidate path exists with
        // junk in it. The guard must skip it and install an empty home.
        let stale = std::env::temp_dir().join(format!(
            "chan-test-env-{}-{}",
            std::process::id(),
            HOME_COUNTER.load(Ordering::Relaxed)
        ));
        if !stale.exists() {
            std::fs::create_dir(&stale).expect("seed stale leftover");
        }
        std::fs::write(stale.join("stale-junk"), b"x").expect("seed junk");
        let env = ChanTestEnv::under_permit(&permit);
        assert!(
            env.home() != stale,
            "the guard must skip the stale leftover directory (paths redacted)"
        );
        assert!(env.home().is_dir());
        assert!(std::fs::read_dir(env.home())
            .expect("read home")
            .next()
            .is_none());
        drop(env);
        std::fs::remove_dir_all(&stale).expect("clean stale leftover");
        drop(permit);
    }

    #[test]
    fn scrubbed_env_drops_namespace_but_keeps_the_rest() {
        let permit = acquire_permit();
        let alpha = KeyRestore::capture(ALPHA);
        std::env::set_var(ALPHA, "secret-sentinel");
        let scrubbed = scrubbed_process_env();
        assert!(scrubbed.iter().all(|(key, _)| !is_chan_var(key)));
        assert!(scrubbed
            .iter()
            .any(|(key, _)| key.as_os_str() == OsStr::new("PATH")));
        drop(alpha);
        drop(permit);
    }
}
