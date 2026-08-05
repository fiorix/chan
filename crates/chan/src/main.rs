// chan: an AI-native workspace for your Markdown notes and projects.
//
// The standalone `chan` binary. The whole CLI surface lives in the `chan`
// library (`src/lib.rs`) so chan-desktop can dispatch `chan` in-process too;
// this binary is a thin shim that owns the tokio runtime and runs the CLI
// with the standalone personality (always-browser serve, CLI tarball
// upgrade -- never the desktop handoff/updater).

use anyhow::{Context, Result};
use chan::Personality;

/// Async worker ceiling for the standalone binary. chan is a loopback,
/// single-user server: the heavy lifting (index walks, graph rebuilds,
/// file IO) runs on the blocking pool, not the async workers, so
/// num-cpu workers are pure waste -- 315 of them on the incident box
/// just made the thread dump unreadable.
const MAX_WORKER_THREADS: usize = 8;

fn main() -> Result<()> {
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
}
