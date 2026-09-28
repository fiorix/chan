# The restart manifest's writer asks every workspace root's filesystem while it holds the host's routing lock

Status: raised for a decision on 2026-09-28 by the code map for the order on parked terminals across a prefix move (`dev/v0101-team/int31-docs/codemaps/parked-terminals-across-a-prefix-move.md` in the development tree, its fifth headline, read at `91e34559f`, nothing run), which found that no roadmap item names it. Read again in code at `fe2708e45`; that a root that stops answering stalls the writer is inferred, and not run. Recommendation, the lead's: accept for v0.101.0, with the orders that are left of the hung root.

## What was seen

A devserver started under systemd's notify protocol on Linux installs a parker, which keeps each windowed terminal session's descriptors in systemd's store and describes them in a restart manifest (`crates/chan-server/src/devserver.rs:2239-2241`; `DevserverParker`, `crates/chan-server/src/devserver/fdstore.rs:403-458`). Every write of the manifest holds the parker's phase mutex and, under it, asks the host for the entries: a park's commit (`store_and_commit`, `fdstore.rs:311-370`, the entries at `:325`), a debounced rewrite (`write_if_active`, `:286-294`; `write_manifest_locked`, `:247-250`; the writer task, `:450-456`), activation's rewrite (`activate`, `:466-473`) and the seal's final write at a graceful shutdown (`seal_flush_detach`, `:480-507`).

The host builds the entries under the routing map's read lock, across every tenant (`WorkspaceHost::fdstore_manifest_sessions`, `crates/chan-library/src/host.rs:1965-1983`), and each tenant under its session map's mutex, across its sessions (`Registry::fdstore_manifest_sessions`, `crates/chan-library/src/terminal_sessions.rs:3377-3387`). A parked session's entry reads its shell's working directory (`fdstore_manifest_entry`, `terminal_sessions.rs:4458-4519`, the directory at `:4498`), and that read resolves both the directory and the workspace root on the filesystem (`Session::cwd`, `:5211-5214`; `path_inside_root`, `crates/chan-library/src/terminal_sessions/platform.rs:179-183`; `process_cwd`, `:185-188`).

A park's commit runs synchronously when a session is created with a window, for the new process at an in-place restart, and when a windowless session gains its first window (`park_if_windowed`, `terminal_sessions.rs:1837-1850`, called at `:2240`, `:2331`, `:2526`). So, inferred: once a root's filesystem stops answering while a session parked in it holds a directory under it, the next write waits in that resolution with the phase mutex, the routing map's read lock and that tenant's session mutex held; every windowed terminal created in any tenant then waits on the phase mutex, every later rewrite waits, and so does the seal's final write, and with it a graceful shutdown's detach of the parked sessions (`fdstore.rs:480-507`). A mount's publication or a close's removal of a tenant, which take the routing map's write lock, would wait behind the read lock; whether later readers of the routing map then queue behind such a writer depends on the standard library's lock and was not read.

The stall seam that the hung-root tests use holds chan-workspace's own canonicalization (`canonicalize_normalized`, `crates/chan-workspace/src/paths.rs:426-433`), and `path_inside_root` calls the standard library's, so the seam cannot hold this call as it is.

## Desired contract

A write of the restart manifest asks no workspace root's filesystem while it holds the host's routing lock, a tenant's session lock or the parker's phase lock. A root that stops answering costs at most its own sessions' working directories in the manifest, and no park, rewrite or seal of another root's sessions waits on it.

## What to do

Suggestions beyond the record, each to weigh against the manifest's order in hand for parked terminals across a prefix move: read the working directories outside the locks, within a bound, from a snapshot of the parked sessions' processes and roots taken under them, which changes when a directory is read against the snapshot; or record the directory the kernel reports and compare it with the root by the root's stored spelling, with no resolution, which changes which directory a restored shell gets under a root reached through a symlink (inferred). Red first: a seam of its own that holds one session's directory resolution, and a windowed terminal created in another tenant that answers while it is held; today it waits.

## Boundaries

`crates/chan-library/src/terminal_sessions.rs` (`fdstore_manifest_entry`, `Session::cwd`, `Registry::fdstore_manifest_sessions`), `crates/chan-library/src/terminal_sessions/platform.rs` (`path_inside_root`), `crates/chan-library/src/host.rs` (`fdstore_manifest_sessions`), `crates/chan-server/src/devserver/fdstore.rs`, and their tests. Not the manifest's format or its import.

## Acceptance

1. With one parked session's directory resolution held, a windowed terminal created in another tenant, a debounced rewrite and the seal's final write each complete, pinned red first.
2. A session whose root answers gets the working directory in the manifest that it gets now.
