# The Windows claim is a name another account can hold

Status: accepted for v0.130.0 by the owner on 2026-11-13; not started.

Record: raised before v0.128.0 by the review of the Windows handoff pipe's account isolation (gaps 1 and 2; in the `chan-dev` repository under `releases/v0128/team/reviews/review-winpipe-t3.md`), stated as a limit in that release's row ([the Windows handoff pipe row](../done/the-windows-handoff-pipe-takes-clients-early-and-collides-across-accounts.md), "Built: the account isolation") and drafted as a row for the next release on the owner's word (`releases/v0128/team/reports/row-draft-the-windows-claim-is-a-name-another-account-can-hold.md` in the same repository; `team/release/release-v0.128.0.md`, "Rows drafted for the next release"). v0.129.0's record lists it as still without a row. On 2026-11-13 the integrator named it, with the AppImage's environment, as the two items with a security angle: another account can take the Windows claim pipe. The owner: "sure, let's include them".

## What is there now

Read at `342dbe791`, by reading only. The claim is as v0.128.0 left it: v0.129.0 changed the guard's callers (the `chan-term` terminal a launch hands over, `check_terminal_at`, and the raise in `come_forward`, `desktop/src-tauri/src/single_instance.rs`) and nothing of the claim.

- On Windows the desktop's single-instance claim is the first and only instance of a named pipe, `\\.\pipe\chan-desktop-<SID>.claim` (`claim_endpoint_at` and `create_claim_pipe`, `crates/chan-server/src/handoff.rs`): owner-only through chan-winpipe, inbound, one instance at most, first instance. Pipe names are one namespace for the machine, so any local account can create a pipe of that name first, with whatever descriptor and limit it chooses.
- The claim reads what `CreateNamedPipe` answers: pipe busy is this account's holder (`ClaimError::Held`), access denied is another account's pipe (`ClaimError::Foreign`). The guard (`claim`, `single_instance.rs`) turns `Foreign` into `Lock::Unavailable`, so the launch boots without the handoff listener and holds no claim.
- Two shapes of a pipe another account creates first follow; `crates/chan-server/design.md` and `desktop/design.md` state both as limits.
  - A pipe that grants this account nothing, or grants it access with room for more instances (the first-instance flag then answers access denied too): every launch of this account boots a desktop with no listener and no claim, so a second launch boots a second desktop, whose window watcher opens a native window for every record the first shows. `chan serve` and the other handoff clients find no endpoint pipe and serve on their own, and as long as the pipe stays, the CLI says "chan-desktop is starting", since `desktop_is_starting` reads a claim pipe without an endpoint pipe as a desktop still booting.
  - A pipe of limit one that grants this account access: it answers busy like the account's own claim and reads as held. The launch waits `BOOT_BOUND` (30 s) for a listener that never comes and `ASK_BOUND` (5 s) for an answer, shows "Chan is not responding" about a copy the user cannot find, and exits 1. This account cannot start Chan while the pipe stays.
- Neither shape reaches what the desktop serves: the endpoint's pipe and every instance the listener arms grant this account alone, and every client reads the account of the pipe's server before it writes (`connect_endpoint_as`).
- The unix claim is a lock on a file beside the socket, in a directory checked as owner-controlled (`take_stable_lock`, `crates/chan-server/src/control_socket.rs`, `std::fs::File::try_lock`; `ensure_owner_dir_at`, `handoff.rs`). Another account can neither create that file nor lock it.

## Desired contract

1. On Windows only this account can hold its claim. The claim is a lock (`std::fs::File::try_lock`, the unix lock's twin) on a file under the account's own profile (`%LOCALAPPDATA%`), in a directory only the account can write. No pipe another account creates under this account's names, whatever it grants, keeps a launch of this account from claiming, or reads as a holder that is not this account's desktop.
2. The claim pipe stays only as the listing's sign of a desktop still booting (`endpoint_is_booting_at`, `desktop_is_starting`). Another account's pipe of that name can at most make the CLI's "starting" line wrong.
3. One desktop per account holds as today: two launches of this account end in one desktop; a desktop whose listener fails or stops keeps the claim; a relaunch releases it first.
4. Nothing splits at the release boundary. The endpoint keeps its name, so a CLI of either release reaches a desktop of the other as today, and a launch of this release beside a v0.129.0 desktop of this account, which holds the claim pipe and no lock, ends in one desktop, as does the reverse.

## Boundaries

- The Windows arm of the claim in `handoff.rs` (`EndpointClaim`, `claim_endpoint_at`, and `ClaimError::Foreign`, which then has no Windows source) and the guard's reading of it in `single_instance.rs`. chan-server keeps `#![forbid(unsafe_code)]`; a descriptor for the lock's directory, if one is needed, comes from chan-winpipe. The unix arms are unchanged.
- An elevated process of another account can write any profile and end any process. It is out of reach here, as it is for every per-account file.
- Not here: another account's pipe under the endpoint's own name, created first. The desktop then keeps its claim and runs without a listener: the CLI serves on its own, and a second launch cannot bring the desktop forward and exits 1 after the ask. The other pipe families keep their names and descriptors.

## Acceptance

1. Windows tests, run on the Windows VM (`dev/vm/windows.sh`), added to the Windows CI list (`CHAN_SERVER_WINDOWS_TESTS`, `Makefile`), and red on the code without the change. Beside a claim-name pipe that grants this account nothing (the tests' stand-in through `chan_winpipe::create_with_sddl`), a launch claims and a second launch reads the claim as held. Beside one of limit one that grants this account access, a launch claims at once, without the boot wait. A claim pipe with no endpoint pipe still reads as a boot.
2. On the Windows VM with the installed build, a second local account holds each shape of the claim's name. This account's Start menu launch starts Chan, a second launch brings it forward with exit 0, and `chan serve` hands its workspace to that desktop. At the base, the first shape boots two desktops and the second shows "Chan is not responding" after about 35 s. The v0.128.0 row's two-account readings are repeated.
3. On the Windows VM: a v0.129.0 desktop running and a launch of this build started by hand beside it, and the reverse, each end in one desktop.
4. `crates/chan-server/design.md`, `desktop/design.md` and `crates/chan-winpipe/design.md` say what the claim is, without the two limits. The manual's install page (`web/packages/marketing/src/pages/manual/install.html`) is checked against the result.
