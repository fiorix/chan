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

## What shipped

The build is on the integration branch and not on `main`, and the item stays accepted until the steps through a gateway and on the desktop's connecting page are read at rc0; what a real stop answers on this machine's loopback is measured (below). It came with [the-launchers-add-and-on-skip-the-stop-check](the-launchers-add-and-on-skip-the-stop-check.md) in one range and its fix round: `3c17a9dd2` and `d6efb8613`, with the words of `917ac5129`, `d3763cf86`, `386d822c1` and `90e915502` (`dev/v0101-team/reports/report-Services-40.md` and `report-Services-42.md` in the development tree; the independent reviews, `dev/v0101-team/reviews/review-Services-19.md` and `review-Services-20.md`). Lines at `4c4ada0a1`, in `crates/chan-server/src/devserver.rs` where no other file is named.

- **The gate chooses its answer by the coordinator's phase.** It reads the phase once and refuses only a path that a mounted tenant still owns (`gate_tenant_during_startup`, `:2857-2871`; `tenant_routes_closed`, `:836-845`). While the devserver starts it answers as before, 503 with `devserver is restoring terminal sessions` and `Retry-After: 1`. From the stop signal on it answers 503 with `the devserver is stopping`, the code `devserver_stopping` and no `Retry-After` (`startup_refusal`, `:2878-2905`).
- **After a sweep has removed a tenant the gate has nothing to refuse at its paths:** a workspace's health path falls through to the launcher's HTML where its bundle is present, and a shared terminal API path to 404, if a request can still reach the app; in `Stopped` no tenant is left (`CHANGELOG.md:67`).

**The shape is the lead's ruling, which the owner confirmed as built on 2026-09-29:** the stop's answer carries a code and no invitation to retry, so a client can wait out a start and give up on a stop without reading words.

**The acceptance at the tip.** All three points are met: a tenant request after the stop signal hears that the devserver stops, pinned in the devserver's own stop order (`:9165`); the start's answer is pinned as it was (`:5392`), and a stopped phase reads as stopping (`:4736`); and `crates/chan-server/design.md:64` says what the gate answers in each phase, with the changelog's entries (`CHANGELOG.md:67-71`).

**What a real stop answers, measured on 2026-10-01; no acceptance point of this item.** A refusal reaches a client only when its request is dispatched after the coordinator has entered `Stopping` and before its connection shuts down, so most clients of a stopping devserver meet a closed or refused connection and not the 503; that was inferred from the framework's source (`crates/chan-server/design.md:20`; `review-Services-19.md`, "What only a run on a real devserver can show", eight steps), and on 2026-09-29 the owner ruled who measures it: the team runs the five steps that need no display on a throwaway devserver, under an order of its own, and the steps through a gateway and on the desktop's connecting page stay with the owner at rc0. The five steps ran on 2026-10-01 against a throwaway debug devserver on this machine's loopback, HTTP/1.1, with no gateway, no desktop, no systemd notify and no fd store, with no commit and no product finding. In fifty stops a kept and a fresh connection met a closed or refused connection and never the health 503, so the gate's refusal is not what most clients meet, as the design says. A WebSocket held open through the signal, live by ping and pong, was closed by the server with 1001 `server shutdown` 0.8 ms after the signal, its stream at its end at 1.0 ms: the ten-second hold that the review's step expected does not exist for that route, since the same stop signal that moves the coordinator ends the connection, and `crates/chan-server/design.md:20` is the true sentence. The case after a sweep has removed a tenant, a request that still reaches the app and meets the launcher's HTML or a 404, did not occur in the run. The launcher's add and on after the signal, and the adds admitted before it, are measured in [the-launchers-add-and-on-skip-the-stop-check](the-launchers-add-and-on-skip-the-stop-check.md). How often other clients or transports see the 503 is not established. Two instrument faults were found and repaired in the runner, neither of the product.

**The cost:** no client reads the code `devserver_stopping` yet. A search of `web`, `desktop`, `crates/chan` and `crates/chan-shell` at `4c4ada0a1` finds no reader, so a window on its connecting page and a browser window in the shared wait still tell a stop from a start by nothing. Raised on 2026-09-30 as [no-client-reads-the-devserver-stopping-code](../v0.102.0/no-client-reads-the-devserver-stopping-code.md).
