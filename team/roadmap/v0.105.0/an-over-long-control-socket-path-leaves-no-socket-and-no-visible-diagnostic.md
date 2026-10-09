# An over-long control socket path leaves no socket and no visible diagnostic

Status: raised for v0.105.0 by the owner's word of 2026-10-09, from the v0.104.0 release report's follow-ups; written down, not designed, not accepted for build.

## What was seen

While the connecting-page hide driver of the owner's checklist was being proved on 2026-10-08, two development runs held their reading and then stopped at the reopen with no control socket to speak to. `dev/v0104-team/evidence/Desktop104/item10/run1-fixture-dev-01.log` and `run1-fixture-dev-02.log` both end "INCONCLUSIVE: timed out after 15s waiting for a control socket that lists windows", status 3. The driver puts the runtime directory of everything it starts under its output directory (`obs_setup` in `scripts/e2e/desktop-observations/lib.sh` exports `XDG_RUNTIME_DIR` as the work directory's `run`), and in the first run that directory was `/home/ubuntu/r10/run1-fixture-dev-01/chan-owner-connecting-hide.q7tI8T/run`, 74 characters as measured for this item.

One read of that runtime directory was kept (`dev/v0104-team/evidence/Desktop104/item10/run1-fixture-dev-01-read.log`). It lists two lock files, `chan-control-s4954d727a7843775.sock.lock` and `chan-control-sb565fcb7dc3e3de1.sock.lock`, the handoff socket `chan-desktop.sock` with its lock, a `chan-devserver` directory, the socket `chan-mcp-488761-82606d0e.sock` and `dconf`. It lists no `chan-control-*.sock` at all. The six last lines of the desktop's log that the read kept carry no line about a socket. By arithmetic on those names, the two sockets that were bound make paths of 92 and 104 characters under that directory, a stable control socket name of the lock files' form makes 110 and a pid-scoped one of the next run's form makes 108; the driver's own comment gives the limit as 107 characters. In the next run, with a short output path (`run1-fixture-dev-03.log`, status 0), the control socket that answered was `chan-control-492254-78cd9989.sock`.

How it was reported and held. The seat's hand-back (`dev/v0104-team/tasks/task-Desktop104-Lead104-56.md`, "Hand-back 2026-10-08T16:05:38Z"): the output path "made the desktop's socket path too long; the desktop left a lock file and no socket and logged nothing I saw", outside the range and not chased. `dev/v0104-team/reports/held-observations-Lead104.md` row 17 ("Added 2026-10-08T16:07:53Z") holds it with the proposed home "the desktop says why it has no control socket", and the release report's Follow-ups say "Give an overlong desktop socket path a visible diagnostic" (`team/release/release-v0.104.0.md`). The driver has refused an output path over 44 characters since, and the run sheet says so (`scripts/e2e/desktop-observations/owner-connecting-hide.sh`, the test before `binaries.sha256` is written; `OWNER-CHECKS.md`, the paragraph on `owner-connecting-hide.sh`).

Source at the released tree, read for this item and not run. `start_control_socket` in `crates/chan-server/src/lib.rs` turns a failed bind into a tenant with no control socket, so its shells lack `CHAN_CONTROL_SOCKET`, and its one sign is a warn-level log line, "control socket bind failed at" with the path and the error. `start_stable` in `crates/chan-server/src/control_socket.rs` creates and locks the `.lock` sibling before it binds, and does not remove that file when the bind then fails. The stable path is taken only for a host with a control identity, which `crates/chan-server/src/devserver.rs` installs for a devserver; every other tenant takes the pid-scoped name of `pick_socket_path`, which has no lock file. The test `stable_socket_name_fits_macos_socket_dirs` in `control_socket.rs` gives the caps as 104 bytes on macOS and 108 on Linux, and on Windows the control socket is a named pipe.

Platform: a Linux guest with the desktop on WebKitGTK; the two logs name the drivers' checkout, `74a5741dd`, where the driver itself was not yet committed, and not the binaries they ran.

Not established: which process each failed bind belonged to. The record says the desktop; the two lock files carry the stable name that the source gives a devserver's tenants, and the driver starts its fixture devserver with the same runtime directory as the disposable desktop, so the lock files may be the fixture devserver's while the socket the reopen lacked is the desktop's pid-scoped one. Whether the warn line was written by either process: only six lines of one log were kept, and the work directories stayed in the guest. Whether a release build shows that line at its default level, and where a desktop user would see it. What `cs` and a terminal say when their tenant has no control socket. How a user reaches such a path outside a fixture. macOS, where the cap is lower, and Windows were not observed.

## Desired contract

A desktop or a devserver that cannot bind a control socket because its path is longer than a Unix socket address holds says so where its user will see it, naming the path and the limit. Today the tenant runs on with no control socket and the only sign the source shows is a warn-level log line that the record does not show reaching anyone.

## What to do

Reproduce first, with a runtime directory just over the limit: the desktop alone and a devserver alone, each on a debug and on a release build, reading the whole log and not its tail. Say which process fails which bind, whether the warn line appears and at what level, what is left on disk, and what a terminal of that tenant and `cs` then show. Then design where the diagnostic belongs (the start-up log, the launcher, `cs`), reviewed before code. Read at source what the lower macOS cap does to the same names; an observation there is the owner's.

## Boundaries

`start_control_socket` in `crates/chan-server/src/lib.rs`, `crates/chan-server/src/control_socket.rs` and `mcp_bridge.rs` for the bind and its directory, `crates/chan-shell/` for what `cs` says without a socket, and the desktop's sources under `desktop/src-tauri/src/` where it reports on its tenants. Not changed: how socket names are formed and kept stable across a devserver restart, the validation of the socket directory and its fallback, and the hide driver's own refusal of a long output path.

## Acceptance

1. A recorded reproduction on Linux: the runtime directory's length, which process failed which bind, the complete log at the default level of a debug and of a release build, what was left on disk, and what a terminal of that tenant and `cs` showed.
2. With the repair, the same arrangement produces a diagnostic that names the socket path and the limit, where a release build shows it by default; pinned red first by a test that starts a tenant under an over-long socket directory.
3. A path within the limit produces no such diagnostic; pinned.
4. The tenant still starts without its control socket, as it does today, or the design says why it should not; pinned either way.
5. The record says by a source read what macOS and Windows do, and that neither was observed unless the owner takes a reading.
