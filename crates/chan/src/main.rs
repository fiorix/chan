// chan: an AI-native workspace for your Markdown notes and projects.
//
// The standalone `chan` binary. The whole CLI surface lives in the `chan`
// library (`src/lib.rs`) so chan-desktop can dispatch `chan` in-process too;
// this binary is a thin shim that owns the tokio runtime and the CLI thread's
// stack, and runs the CLI with the standalone personality (always-browser
// serve, CLI tarball upgrade -- never the desktop handoff/updater).

use anyhow::{Context, Result};
use chan::Personality;

/// Async worker ceiling for the standalone binary. chan is a loopback,
/// single-user server: the heavy lifting (index walks, graph rebuilds,
/// file IO) runs on the blocking pool, not the async workers, so
/// num-cpu workers are pure waste -- 315 of them on the incident box
/// just made the thread dump unreadable.
const MAX_WORKER_THREADS: usize = 8;

/// Stack for the thread the CLI actually runs on.
///
/// The process main thread does NOT get to pick its own stack: on Windows the
/// MSVC linker reserves 1 MB for it and nothing in this build raises that.
/// The future `chan::run` produces does not fit in 1 MB unoptimized, so a debug
/// `chan.exe` died with "thread 'main' has overflowed its stack" before
/// reaching any subcommand -- `--version` and `--help` included -- while the
/// release build squeaked under the ceiling. That made the limit a cliff one
/// future-sized change away from reaching the shipped binary, not a
/// debug-only nuisance.
///
/// A spawned thread takes its stack size from us rather than from the linker,
/// so both profiles get the same headroom on every platform. 8 MiB matches the
/// main-thread stack Linux hands out by default. Reserve is virtual on Windows
/// and committed lazily, so the untouched remainder costs address space, not
/// memory. Prefer this to a `/STACK:` link arg, which a bare `RUSTFLAGS=...`
/// in the environment silently replaces rather than merges with.
const MAIN_STACK_BYTES: usize = 8 * 1024 * 1024;

fn main() -> Result<()> {
    std::thread::Builder::new()
        .name("chan-main".into())
        .stack_size(MAIN_STACK_BYTES)
        .spawn(run_cli)
        .context("spawning the chan main thread")?
        .join()
        // A panic already printed its message and hook output; resume the
        // unwind so the process still dies with the panic's exit status
        // rather than reporting a tidy error it did not have.
        .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
}

fn run_cli() -> Result<()> {
    // One multi-threaded runtime for the whole process: `serve` needs it,
    // and the sync subcommands run inline on it just fine. The library's
    // `run` is async, so the runtime must be built out here (you can't build
    // one from inside an async context).
    let worker_threads = std::thread::available_parallelism()
        .map(|n| n.get().min(MAX_WORKER_THREADS))
        .unwrap_or(MAX_WORKER_THREADS);
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(worker_threads)
        // Declared rather than inherited: this runtime can execute transfer
        // work, and tokio's default blocking pool is large enough that bulk
        // work would just expand into the threads interactive work needs.
        .max_blocking_threads(chan_server::bulk_transfer::MAX_BLOCKING_THREADS)
        .enable_all()
        .build()
        .context("building tokio runtime")?;
    let res = rt.block_on(chan::run(std::env::args_os(), Personality::Standalone));
    // Don't block on detached blocking-pool tasks on exit (e.g. an in-flight
    // initial reindex on a large workspace): chan-workspace's reindex is
    // uncancellable today, so a normal Runtime drop would wait for it after
    // Ctrl-C. shutdown_background detaches the pool so the process exits; the
    // index may be left partially populated until the next rebuild.
    rt.shutdown_background();
    res
}

#[cfg(test)]
mod tests {
    /// The ceiling is a construction property, so it is pinned at the
    /// construction seam. Observing thread counts at runtime would prove
    /// nothing: tokio creates blocking threads lazily, so a run that never
    /// needs 32 looks identical to one that is capped at 32.
    #[test]
    fn production_runtime_blocking_limit() {
        // Only the production half: this test names the same call it checks
        // for, so scanning the whole file would match itself and keep passing
        // after the real call was deleted.
        let production = include_str!("main.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("binary source has a production half");
        assert!(
            production.contains("fn main()"),
            "the production half must be what was scanned"
        );
        assert!(
            production.contains(
                ".max_blocking_threads(chan_server::bulk_transfer::MAX_BLOCKING_THREADS)"
            ),
            "the standalone runtime must declare its blocking-thread ceiling"
        );
        assert_eq!(chan_server::bulk_transfer::MAX_BLOCKING_THREADS, 32);
    }

    /// Also a construction property, and pinned the same way: whether the CLI
    /// runs on a stack we sized cannot be observed from inside a test, which
    /// runs on the harness's own generously-sized thread and so never sees the
    /// 1 MB main-thread ceiling this guards against.
    #[test]
    fn cli_runs_on_a_thread_with_an_explicit_stack() {
        let production = include_str!("main.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("binary source has a production half");
        assert!(
            production.contains(".stack_size(MAIN_STACK_BYTES)"),
            "the CLI must run on a thread whose stack this binary sizes, not \
             the linker-provided main-thread stack"
        );
        const {
            assert!(
                super::MAIN_STACK_BYTES >= 8 * 1024 * 1024,
                "8 MiB is the floor the debug-profile future needs"
            );
        }
    }
}
