# The close of a restored terminal signals a process id and not the process its session started

Status: raised for a decision on 2026-09-28 by the plan of the order on the tests that signal a process they did not start (`dev/v0101-team/followups/followup-Services-Lead-18.md` in the development tree, "Found beside, not changed", 1), and by that order's report, which read at the lead's request what the import would need (`dev/v0101-team/reports/report-Services-35.md`, "Finding 1, as the lead asked: the bare-pid close of an imported session"). Both read a lineage that this landing does not carry; every function they name was read again at `a6834b1ee`, where each is as they read it. Read, not reproduced. Older than this round: `v0.100.0` holds the close (`crates/chan-library/src/terminal_sessions.rs:4069`, `:4977` there) and the devserver's pinned cleanup (`crates/chan-server/src/devserver/fdstore.rs:784-799` there). It is production code, which [tests-signal-a-process-they-did-not-start](tests-signal-a-process-they-did-not-start.md) leaves out of its boundary, so it is a row of its own. Recommendation, the lead's: accept for v0.101.0: the import carries the start time, and the close signals through a pidfd that was pinned against it.

## What was seen

- **The close signals the pid that the manifest named.** A session imported across a restart keeps its metadata's `child_pid` (`Session::from_imported`, `crates/chan-library/src/terminal_sessions.rs:4524`, the pid at `:4619`). Its close sends the session's writer thread a kill (`Session::close`, `:5226-5236`), which ends an imported child through `terminate_imported_child` with that pid (`:4755-4758`): since this process is not the child's parent, it sends HUP and TERM by the bare pid, waits up to a second for the pid to go (`IMPORTED_CHILD_EXIT_GRACE`, `:83-86`), and sends KILL (`:6142-6173`). Nothing checks that the pid still names the process that the session started.
- **The import carries no identity but the pid.** An import holds the session's metadata, its PTY master, its ring file, its replay and whether its manifest was sealed (`FdStoreSessionImport`, `:1042-1056`), and the metadata holds the pid and no start time (`FdStoreSessionMeta`, `:992-1026`). The devserver's restore takes each manifest session apart and drops what its pattern leaves out, the recorded start time among it (`crates/chan-server/src/devserver/fdstore.rs:624-631`), and checks only that some process holds the PTY's slave (`pty_master_has_live_slave`, `:677-697`).
- **The devserver's own cleanup pins the same identity.** The manifest records the boot id (`RestartManifest`, `fdstore.rs:79-94`) and each child's start time (`ManifestSession`, `:96-108`), and the cleanup of a skipped session signals only when both match, through a pidfd opened before the start time is read, so that a pid reused between the check and the signal cannot be reached (`signal_child`, `:929-953`; `crates/chan-server/design.md:27`).

So, by the records' reading, a shell that exits while a background job it started keeps the PTY's slave open leaves the session restorable, and once the shell's pid is reused, in the restart's gap or later in the session's life, a close of that tab sends HUP, TERM and then KILL to whatever process holds the pid by then, when this process may signal it. The probe of the order on the tests that signal showed the close's half of it: an imported session handed the pid of a `sleep` the probe had started ended that `sleep` at its close (`dev/v0101-team/evidence/Services/s34-probe.log`).

**One more thing a fix has to hold,** by the report's reading: the manifest's writer reads each child's start time from `/proc` at every write (`fdstore.rs:263-278`, the start time at `:273`), so a manifest written after the pid was reused records the new holder's start time, and a check against it would pass for that holder.

## Desired contract

The close of a restored terminal signals the process that its session started and no other: the import pins the child by the boot id and the start time that the manifest recorded, and the close signals through that pin.

## What to do

A suggestion from the report: carry the manifest's start time into the import and onto the session; at the import, open a pidfd for the pid and compare the process's start time and the boot id with the manifest's, as `signal_child` does; end the child through that pidfd at the close; and write the start time the session was imported with into later manifests rather than reading `/proc` again. What a session whose child does not match becomes, a session with no child to signal or one the restore skips, is for the plan. Red first: an imported session whose recorded start time does not match the process holding its pid, closed, leaves that process alive; today it ends it.

## Boundaries

`crates/chan-library/src/terminal_sessions.rs` (the import, the session's child, `terminate_imported_child`) and `crates/chan-server/src/devserver/fdstore.rs` (the restore and the manifest's writer), with their tests, `crates/chan-library/design.md` and `crates/chan-server/design.md`. The tests that hand an import a pid they did not start are [tests-signal-a-process-they-did-not-start](tests-signal-a-process-they-did-not-start.md)'s.

## Acceptance

1. A close of an imported session whose pid names another process by then signals nothing, pinned red first.
2. A close of an imported session whose child is the one the manifest recorded still ends it, pinned.
3. A manifest written after a restore keeps the start time that the session was imported with, pinned.
4. The design documents say how an imported child is identified before it is signalled.
