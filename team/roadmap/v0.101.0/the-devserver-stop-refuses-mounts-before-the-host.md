# A stopping devserver refuses a new mount with a config error before its host is asked

Status: raised for a decision on 2026-09-27 by an independent reading of the fix for [a-late-http-mount-escapes-the-shutdown-sweep](a-late-http-mount-escapes-the-shutdown-sweep.md); read in code and not reproduced, a source reading at `72578a59b`. Recommendation: accept for v0.101.0, built with the conversion of the devserver's routes to the refusal envelope in [refusals-answer-in-four-shapes](refusals-answer-in-four-shapes.md), which changes the same handlers.

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
