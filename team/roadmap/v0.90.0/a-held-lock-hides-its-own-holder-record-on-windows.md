# A held lock hides its own holder record on Windows

Status: REGISTERED 2026-08-14, found and fixed in the same round while writing the `chan.exe` Windows smoke ([the-standalone-windows-cli-ships-untested](the-standalone-windows-cli-ships-untested.md)). Product bug, Windows-only, high severity for the paths it silently disabled. Recorded after the fix rather than before it, so this item carries the evidence rather than a proposal.

## What

Every read of a workspace's lock record returned `None` on Windows, and had since the lock existed.

`WorkspaceLock` takes its advisory lock with `LockFileEx`, which is a MANDATORY byte-range lock: while a holder owns `writer.lock`, no other handle may read it -- not in another process, and not in the holder's own. The holder record (pid, canonical path, start time) was stored in the body of that same file, and every consumer of it reads it precisely while the lock is held. So the record was writable by exactly one process and readable by none.

Unix flock never blocked reads, so the whole class was invisible on the arms that run this crate's tests. The `ci-windows` arm is scoped to chan-library and chan-desktop, so chan-workspace's suite had never executed on Windows at all.

Four behaviors depended on that read, and all four were dead:

- `chan ps` cannot name a holder: the BY, PID and SINCE columns are blank for a served workspace, and the devserver enrichment that needs a pid never runs.
- `chan close` reads `read_lock_record` to find the serving process, gets `None`, and takes the "no holder" branch -- reporting **not served for a workspace that is served**.
- `WorkspaceLock::try_steal` can never confirm a recorded holder is dead, so a leaked lock is never reclaimed and the workspace stays permanently refused.
- `is_locked_by_foreign_holder` treats an unreadable record as foreign, so chan calls **its own** lock foreign; launchers and menus show a workspace they are serving as taken by someone else.

A fifth follows from the third: a second acquire inside one process reads as the cross-process `WorkspaceLocked` instead of `WorkspaceAlreadyOpen`, so a launcher turn-on racing chan's own in-flight mount surfaces "locked by another process" rather than being idempotent.

## Grounding

Verified on Windows 11 at `6eccb8c8`:

- Five existing tests in `crates/chan-workspace/src/lock.rs` already assert this behavior and all five fail there: `records_holder_identity`, `second_acquire_same_process_is_already_open`, `foreign_lock_probe_treats_free_and_own_locks_as_actionable`, `live_holder_is_never_stolen`, `stale_record_does_not_block_a_free_lock`. They are not gated to unix; they had simply never been run on Windows.
- Directly, outside chan: while a real devserver held a workspace, `writer.lock` held valid 139-byte JSON, `cat` reported `Device or resource busy`, and .NET `File.ReadAllText` reported the file "is being used by another process". Both reads succeeded the moment the daemon stopped.
- On a live devserver, `chan ps --json` reported `served: true` with `served_by`, `pid`, `since` and `activity` all `null`.

## Contract

The record must be readable by any process at any time, including while the lock is held, on every platform. The advisory lock keeps its current semantics; only the record's storage moves.

Compatibility matters here because chan versions coexist on one machine (an installed release plus a development build): a current chan must still read a lock dir written by an older one, and an older one should still be able to read a record a current one writes.

## Acceptance

- The holder record is readable while the lock is held, pinned by a test that names that invariant on its own.
- The five failing tests above pass on Windows, and a lock dir written by a build that predates the change still resolves a holder.
- On a real Windows devserver, `chan ps` reports the holder's pid and a `devserver` BY column for a served workspace.

## Shipped 2026-08-14

`crates/chan-workspace/src/lock.rs`: the record moves to a `writer.json` sidecar, which carries no lock and reads on both platforms. The lock body keeps a copy so an older chan can still read a record we write, and reads fall back to it for a lock dir an older chan wrote -- self-healing as soon as a current chan acquires. One record value feeds both copies so they cannot disagree, and the sidecar goes through `fs_ops::atomic_write`, so a reader racing the write sees one whole record or the other rather than a torn half. Unix behavior is unchanged; it gains the sidecar and the same code path.

Two regression tests were added: `the_record_is_readable_while_the_lock_is_held` (which fails without the sidecar) and `a_legacy_lock_dir_without_a_sidecar_still_reads`.

Measured rather than assumed: chan-workspace's suite had 10 failures on Windows before the change and 9 after -- the change fixes one beyond the five above (`reset_workspace_refuses_when_another_handle_in_process_holds_lock`) and breaks none. The 9 that remain are unrelated pre-existing Unix assumptions in the harnesses (path canonicalization, sub-second mtime granularity, removing files still open), which the deferred full-suite Windows port covers.
