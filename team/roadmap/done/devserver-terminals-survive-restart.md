# Devserver terminals survive every systemd restart

Status: REGISTERED for v0.81.0, grounded statically 2026-07-29 at 568ded3c; design ruled (continuous parking; manifest fresh on clean shutdown, best-effort on crash).

## Observed

Only `chan devserver --service=systemd --restart` preserves live PTYs, because preservation is a transactional client-driven protocol: the CLI POSTs `/api/devserver/systemd-fdstore/prepare` (`crates/chan-server/src/devserver.rs:2022`, client at `crates/chan/src/lib.rs:4414`), the devserver parks each master fd plus a 30-second-TTL manifest (`crates/chan-server/src/devserver/fdstore.rs:358`), the CLI bounces the unit, and the boot restore empties the store again (`fdstore.rs:336`). The store is vacant during normal serving, so a bare `systemctl --user restart chan-devserver`, a watchdog-initiated restart (WatchdogSec=30 + Restart=on-failure), and a crash restart all kill every terminal. The watchdog case is the ironic one: the supervision added to recover a seized devserver destroys all its terminals doing so. The CAUTIONS block in `crates/chan/src/help.rs` documents the narrow contract ("--service=systemd --restart preserves live PTYs ... and ABORTS if that handoff fails").

## Desired contract

- Under the Linux systemd unit, live terminal PTYs survive EVERY restart flavor: `chan devserver --restart`, bare `systemctl --user restart chan-devserver`, a watchdog kill, and a crash restart (Restart=on-failure). Terminals rebuild on boot with today's import fidelity (same session ids, windows, placement, modes; replay exact after a clean restart, best-effort after a crash).
- `chan devserver --stop` and bare `systemctl --user stop` end terminals. PTY fds never outlive the unit: parked fds are SCM_RIGHTS duplicates systemd releases on stop, closing the master and HUPping the slave side. `chan devserver --stop` additionally tears sessions down explicitly through the management API before stopping, keeping today's forcefulness for HUP-immune children; bare `systemctl stop` behaves like closing a terminal emulator window.
- The two-phase prepare protocol is deleted (endpoint, CLI prepare call, ABORT-on-handoff-failure semantics, manifest TTL + nonce cleanup): hard swap, no compatibility shim. `--force` remains the destructive restart: explicit session teardown, then restart.
- Non-systemd paths are unchanged: `--service=chan`, launchd, foreground Ctrl-C, non-Linux.

## Fix shape (continuous parking)

The unit already carries everything needed -- FileDescriptorStoreMax=512, KillMode=process (`crates/chan-systemd/src/lib.rs:116-145`), and systemd's default FileDescriptorStorePreserve=restart (store kept across restarts including on-failure, released on stop) -- so NO unit changes and no KnownLegacy migration. `chan_systemd::fdstore()` hands systemd its own duplicate via SCM_RIGHTS, so parking is free in-process and the restart/stop asymmetry lives entirely in systemd; the devserver never needs to distinguish stop from restart at SIGTERM, which is exactly why bare `systemctl restart` becomes safe.

- Park at spawn: every session gains an fdstore entry once it has a window_id (at spawn, or when a windowless session gains one on first attach), under a stable name `chan.pty.<session_id>.<child_pid>`; FDSTOREREMOVE on every session end (exit reap, explicit close, idle reap, session-cap eviction, and in-place restart, which re-parks the new PTY).
- The manifest becomes a maintained snapshot of parked sessions, rewritten on session lifecycle changes and flushed with fresh replay bytes on graceful shutdown: the SIGTERM path detaches parked sessions without killing children (the existing `detach_for_fdstore_restart` seam, `crates/chan-library/src/terminal_sessions.rs:3313`), and the per-session `fdstore_preserve_on_shutdown` flag (`terminal_sessions.rs:2414`) becomes "is parked" rather than "prepare succeeded". Crash restores use the last-written manifest: possibly stale replay, never a lost terminal. Drop the TTL and nonce checks; keep version, library_id, and `pty_master_has_live_slave` validation, and the existing skip cleanup (HUP+TERM by manifest/fd-name pid, FDSTOREREMOVE, window-row reaping, `fdstore.rs:547-579`) so failed restores neither leak children nor accumulate across restarts.
- Boot restore keeps the StartupRestore shape (take before serving, apply at `devserver.rs:1693`, window-registry guardrails in `crates/chan-library/src/host.rs:1251-1324`) but re-parks restored sessions instead of emptying the store, and rewrites the manifest instead of deleting it. A session spawned after the last manifest write must still restore, so spawn is itself a manifest write.
- CLI: `--restart` drops the prepare call and keeps its remaining value (linger, unit rewrite to the current binary/address, enable + systemctl restart, `crates/chan/src/lib.rs:4387`); `--force` performs explicit teardown first; `--stop` drains sessions via the management API, then systemctl stop + disable (`lib.rs:4493`). Update the tunnel-listen rationale comments (`lib.rs:3313`, `lib.rs:3843`) and the help.rs CAUTIONS text, which both cite the prepare handoff.
- Alternative rejected: distinguishing stop-vs-restart at SIGTERM by querying systemd's pending job over D-Bus -- racy, adds a dependency, and the store-release model makes the guess unnecessary.

## Acceptance

- New systemd e2e (committed under scripts/e2e/, alongside the CHAN_SYSTEMD_FDSTORE_E2E suite in chan-systemd): a real devserver unit with a live terminal survives (1) bare `systemctl --user restart`, (2) `chan devserver --restart`, (3) a watchdog restart (SIGSTOP the main process), each rebuilding the session with its window; and (4) `systemctl --user stop` ends the shell child and leaves the fd store empty (FileDescriptorStoreN=0 or equivalent).
- `chan devserver --stop` kills sessions explicitly (child gone before the unit stops); `--restart --force` kills them and restarts.
- Session-end paths remove their store entries: exit, close, idle reap, cap eviction, in-place restart (unit tests on the registry hooks plus the e2e store count).
- Crash restore: kill -9 the devserver; on restart the terminal comes back (replay may be stale), including a session spawned after the previous lifecycle event.
- Existing fdstore unit tests and the chan-systemd e2e stay green; the deleted endpoint's tests are removed with it.

## Rough size

Medium. Rework of devserver/fdstore.rs (transactional to continuous), lifecycle hooks in chan-library terminal_sessions.rs/host.rs, CLI simplification in crates/chan/src/lib.rs, help.rs text, one new e2e script. No unit-file, web, or gateway changes.

## Open

- Whether `--stop`'s explicit drain needs a new management endpoint or can reuse an existing close-all path; spec decides.
- Manifest write cadence bounds (coalescing lifecycle bursts) and whether the graceful-shutdown replay flush needs a size/time budget for many sessions; the 512-entry store cap is far above the session cap either way.
