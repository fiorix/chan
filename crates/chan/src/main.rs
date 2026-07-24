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
