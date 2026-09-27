# While a devserver stops, its startup gate answers every tenant request that it is restoring terminal sessions

Status: accepted for v0.101.0 by the owner on 2026-09-27; raised for a decision on 2026-09-27 by two code maps, the one written for [the-devserver-stop-refuses-mounts-before-the-host](the-devserver-stop-refuses-mounts-before-the-host.md) (`dev/v0101-team/int24-docs/codemaps/runtime-next.md` in the development tree, headline 2) and the one for the Clients lane's next orders (`dev/v0101-team/int24-docs/codemaps/clients-next.md`, headline 1), which read it at `4809d8d4d` and `c4d7d811c`; read again in code at `b1ef073ae`, where it holds, and not reproduced.

## Owner ruling

Accepted on 2026-09-27 for v0.101.0, as the lead recommended. The owner accepted in one answer every recommendation the lead had put to them that day; for this item it was to accept it for this version, with [the-launchers-add-and-on-skip-the-stop-check](the-launchers-add-and-on-skip-the-stop-check.md) built beside it.

## What was seen

The devserver's startup gate wraps its whole app (`build_devserver_app`, `crates/chan-server/src/devserver.rs:2588-2594`) and lets a request through to a mounted tenant only while the startup coordinator is `Ready` (`gate_tenant_during_startup`, `:2603-2615`; `tenant_routes_ready`, `:768-770`). The stop signal moves the coordinator from `Ready` to `Stopping` (`ServeLifetimeTasks::spawn`, `:2058-2066`; `stop`, `:772-779`), and nothing moves it back. So from the signal until the process exits, every request to a path a mounted tenant owns is refused with 503, `Retry-After: 1` and the sentence "devserver is restoring terminal sessions" (`startup_refusal`, `:2617-2629`): a client is told the devserver is starting while it is going away. That span includes the serve loop's graceful end and the host's shutdown (`run_devserver`, `:2275-2286`, `:2332-2353`); how long it lasts in practice was not measured.

The gate refuses every path under a mounted tenant's prefix (`owns_mounted_tenant_path`, `crates/chan-library/src/host.rs:4157-4170`), a tenant's own `/ws` socket included, so a window open on the stopping devserver is told the same. A client that waits out this 503, as the refusal envelope's ruling asks of the desktop's connecting page for a loopback target ([refusals-answer-in-four-shapes](refusals-answer-in-four-shapes.md), the ruling of 2026-09-27), cannot tell a start it should wait for from a stop it should not, except by the sentence, which is wrong, and has to bound its wait for that reason (the clients map's reading). The only pin of the sentence builds a devserver that has not finished starting (`startup_restoring`, `devserver.rs:4918-4940`).

## Desired contract

While a devserver stops, a request to a mounted tenant is refused with 503 and a sentence that says the devserver is stopping, not restoring. During startup the gate answers as it does now, with `Retry-After: 1`.

## What to do

Have the gate's refusal choose its answer by the coordinator's phase: in `Stopping` and `Stopped` a sentence that says the devserver is stopping, with no invitation to retry, and in the startup phases the answer it gives now. Whether the two carry codes, so that a client can wait out a start and give up on a stop without reading words, is part of the decision. Pin it in the devserver's own stop order (`signal_stop` in the devserver's tests, `:7383-7398`). Build it with [the-launchers-add-and-on-skip-the-stop-check](the-launchers-add-and-on-skip-the-stop-check.md), which answers in the same stop. Red first: after the stop signal, a request to a mounted tenant's path answers the restoring sentence.

## Boundaries

`crates/chan-server/src/devserver.rs` (`gate_tenant_during_startup`, `startup_refusal`, and the coordinator's phase), `crates/chan-server/design.md`, and their tests. The clients that wait on the 503 are outside, beyond the sentence and any code they read.

## Acceptance

1. After the stop signal, a request to a mounted tenant's path answers 503 in the envelope with a sentence that says the devserver is stopping, pinned in the devserver's own stop order.
2. While the devserver starts, the gate answers as it does now, `Retry-After: 1` included.
3. `crates/chan-server/design.md` says what the gate answers in each phase.
