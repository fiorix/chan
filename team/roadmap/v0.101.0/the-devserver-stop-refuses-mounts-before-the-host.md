# A stopping devserver refuses a new mount with a config error before its host is asked

Status: accepted for v0.101.0 by the owner on 2026-09-27; raised during v0.101.0 on 2026-09-27 by an independent reading of the fix for [a-late-http-mount-escapes-the-shutdown-sweep](a-late-http-mount-escapes-the-shutdown-sweep.md); read in code and not reproduced, a source reading at `72578a59b`.

## Owner ruling

Accepted on 2026-09-27 for v0.101.0 as the lead recommended. The lead's ruling on what the item leaves open: the coordinator's phase is checked before the root is registered, so a mount refused at stop leaves no registered row behind its error. In the runtime lane after the launcher's refusals in [refusals-answer-in-four-shapes](refusals-answer-in-four-shapes.md), since it changes the devserver handlers that lane converted.

## What was seen

When the devserver's shutdown signal fires, the lifetime task stops the startup coordinator (`ServeLifetimeTasks::spawn`, `crates/chan-server/src/devserver.rs:2038-2046`), the serve arm stops it again when the serve loop returns (`:2264-2276`), and only after that does `run_devserver` call `shut_down_hosted` (`:2334`). From then on `StartupCoordinator::track` refuses every new mount attempt with "cannot start workspace mount while devserver is Stopping" (`:690-708`), and `begin_registered_mount` returns that as `Error::Config` (`:1081`), before the host is asked. So `POST /api/devserver/workspaces` answers 400 (`handle_open`, `:2888-2899`) and the per-prefix on route answers 500 (`handle_set_workspace_on`, `:2932-2976`), where the host's own refusal once its last sweep has begun, `Error::ShuttingDown`, answers 503 (`:2894`, `:2970`). A client cannot tell a devserver that is going away from a bad request or a fault except by the message's words.

The refusal also comes after `mount_key_at` has registered the root in the library (`:988-1001`), so a refused open leaves a registered, off workspace behind its error; that order predates the late-mount fix. A discovery registration (`chan serve`) the listener accepted before it stopped accepting, but which reaches the coordinator after the signal, is refused the same way (`handle_discovery_request`, `:2715`, into `register_workspace_keyed`, `:2743`), not drained with the registrations already under way.

The devserver's 503 is therefore reached only by an attempt that passed the coordinator before the signal and reached publication after the host's last sweep. The pin for it, `a_mount_refused_by_a_stopping_host_answers_503` (`:6804-6820`), builds its state with the coordinator ready (`complete_test_startup`, `:7308-7322`) and calls `shut_down_hosted`, which does not stop the coordinator (`:2370-2388`): an order the devserver's own stop never produces. The desktop's embedded host has no coordinator, and there the launcher's add and on answer 503 during the quit drain (`routes/library.rs:1875`, `:1924`).

## Desired contract

A mount the devserver refuses because it is stopping answers 503 with a sentence that says so, whichever check refuses it first, and a client never learns of a stop through a 400 or a 500.

## What to do

Have the coordinator's stop refusal reach the routes as the shutting-down error rather than a config error (a typed refusal from `track`, or a check of the coordinator's phase before `mount_key_at` registers the root), and pin it in the devserver's own order: the coordinator stopped as the signal stops it, then a mount through each route. Whether a mount refused at stop should leave its root registered is part of the decision.

## Boundaries

`crates/chan-server/src/devserver.rs` (`StartupCoordinator::track`, `begin_registered_mount`, `mount_key_at`, `handle_open`, `handle_set_workspace_on`, the discovery registration's reply) and its tests. The host's refusal and the launcher's routes are unchanged.

## Acceptance

1. With the coordinator stopped as the shutdown signal stops it, `POST /api/devserver/workspaces` and the per-prefix on route answer 503 with a sentence that says the devserver is stopping.
2. A pin of the 503 runs in the order the devserver's own stop produces.
3. A discovery registration refused at stop tells its client that the devserver is stopping.

## What shipped

Landed on 2026-09-27 in the shape the lead ruled: the coordinator's phase is checked before the root is registered. The lead verified the range, and it had no independent review. Lines are cited at `b1ef073ae`, in `crates/chan-server/src/devserver.rs` where no other file is named.

- **The check.** `mount_key_at` asks the startup coordinator first, before it rejects a reserved prefix or registers the root in the library (`:1006`, the registration at `:1008-1020`). In `Stopping` or `Stopped` the coordinator refuses with `Error::ShuttingDown` and the sentence "the devserver is stopping; <root> was not mounted" (`refuse_mount_at_stop`, `:646-654`, `:701-706`). The open route and a discovery registration reach `mount_key_at` through `register_workspace_keyed` (`:967-975`), and the per-prefix on route through `set_workspace_on` and `mount_at` (`:1327-1328`, `:985-991`). A repeat of a mount already pending is refused the same way: the check comes before `begin_registered_mount` would answer with the pending attempt's prefix (`:1093-1095`).
- **What each entry point answers at stop.** `handle_open` and `handle_set_workspace_on` answer `Error::ShuttingDown` with 503 in the refusal envelope (`:2936-2938`, `:3016-3018`), and a discovery registration gets the same sentence in its error reply (`handle_discovery_request`, `:2798-2800`). Before the change, after the real stop signal, the open route answered 400, the on route 500 and discovery its error reply, each with "config: cannot start workspace mount while devserver is Stopping", and a repeat of a pending mount answered 200 with its prefix: the lane's red runs, tabled in its report (`dev/v0101-team/reports/report-Runtime-21.md` in the development tree, "What the three entry points answer at stop").
- **The window that remains.** A mount admitted before the signal can register its root after it and still be refused: by the coordinator's second check, `track`, which now refuses with the same typed error (`:708-710`, called from `begin_registered_mount` at `:1101`), or by the host once its last sweep has begun, whose refusal also answers 503 ("the workspace host is shutting down; <what> was not mounted", `crates/chan-library/src/host.rs:4474-4480`). Its row stays registered, because the only way to undo a registration, unregistering, would erase the workspace's state (`crates/chan-server/design.md:28`; the pin's comment, `:7506-7508`); the check and the registration are not one atomic step. The refusal names the root at the first check and the mount's prefix at the second (`:705`, `:710`).
- **The earlier pin** keeps the coordinator ready and now says that it isolates the host's own refusal (`a_mount_refused_by_a_stopping_host_answers_503`, `:7551-7570`). `crates/chan-server/design.md` states the admission, the refusals and the remaining window (`:28`), and chan-library's `ShuttingDown` says that its message names what was not mounted (`crates/chan-library/src/error.rs:18-21`).

Pinned in the devserver's own stop order. Each test sends the real stop signal through `ServeLifetimeTasks` and waits until the coordinator is `Stopping`; for the full order it also shuts the host down and marks the coordinator `Stopped` (`signal_stop`, `:7383-7398`). In both phases the open, on, discovery and pending-repeat requests are refused with 503, `application/json` and the whole body, and the refused open and discovery leave no library row and no workspace entry (`refuses_after_signal` and its four tests, `:7420-7504`). A mount held in its registration by the `root_stall` seam across the signal is refused with 503 naming its prefix, keeps its registered row and mounts nothing (`a_mount_admitted_before_stop_keeps_its_registration`, `:7509-7548`). The lane's report shows the five tests red before the fix and a mutation of each check failing its own tests, and ran each test 200 times as it is and 200 on one CPU. The pins read the devserver's reply; what `chan serve` prints of the discovery refusal was not read, and nothing was run against a devserver process.
