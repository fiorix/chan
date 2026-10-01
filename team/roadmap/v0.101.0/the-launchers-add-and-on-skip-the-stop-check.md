# The launcher's own add and on never ask a stopping devserver's coordinator

Status: accepted for v0.101.0 by the owner on 2026-09-27; raised for a decision on 2026-09-27 by the code map written for [the-devserver-stop-refuses-mounts-before-the-host](the-devserver-stop-refuses-mounts-before-the-host.md) (`dev/v0101-team/int24-docs/codemaps/runtime-next.md` in the development tree, headline 2 and "Outside the item's boundaries"), which read it at `4809d8d4d`, before that item's fix; read again in code at `b1ef073ae`, where it holds, and not reproduced.

## Owner ruling

Accepted on 2026-09-27 for v0.101.0, as the lead recommended. The owner accepted in one answer every recommendation the lead had put to them that day; for this item it was to accept it for this version and build it with [a-stopping-devserver-says-it-is-restoring](a-stopping-devserver-says-it-is-restoring.md), which answers in the same stop.

## What was seen

The devserver serves the launcher's routes as its host's root fallback, so `POST /api/library/workspaces` and `POST /api/library/workspaces/{id}/on` reach it on its loopback and through its tunnel (`install_launcher_root_fallback`, `crates/chan-server/src/devserver.rs:2560-2587`). Neither handler can ask the devserver anything: the launcher's state holds the host and the bound address only (`LauncherState`, `crates/chan-server/src/routes/library.rs:53-56`). The add resolves the root, registers it in the library on the blocking pool, and asks the host to mount it (`handle_add_workspace`, `:1828-1884`, the registration at `:1848-1858`); the on asks the host to open the registered root (`handle_workspace_on`, `:1893-1932`).

So the startup coordinator's stop check, which the devserver's own open, on and discovery routes now pass before they register a root (`devserver.rs:1006`), is not on this path. After the stop signal a launcher add registers its root and, until the host's last sweep has begun, mounts it, only for the host's shutdown to close it, as the map reads the stop; once the sweep has begun, the host refuses the mount with 503 and "the workspace host is shutting down; <root> was not mounted" (`library.rs:1879-1881`, `crates/chan-library/src/host.rs:4474-4480`), and the root it registered stays registered. The desktop's gateway arm adds a workspace through this route (`add_workspace`, `desktop/src-tauri/src/devserver.rs:2344-2363`), so `chan workspace serve --on` a devserver reached through a gateway meets it.

## Desired contract

On a devserver, a launcher add or on that arrives after the stop signal is refused before its root is registered, with 503 and a sentence that says the devserver is stopping, as the devserver's own routes are. On the desktop's embedded host, which has no coordinator, the two routes answer as now.

## What to do

Give the launcher's add and on a stop check that the devserver supplies, asked before the root is registered: for instance an admission hook in the launcher's state that `install_launcher_root_fallback` takes from the devserver and the desktop leaves empty, or a stopping state on the host that the devserver sets with the signal. Pin it in the devserver's own stop order through the root fallback, with the stop signal sent as the devserver's own stop sends it (`signal_stop` in the devserver's tests, `devserver.rs:7383-7398`). Red first: a launcher add after the signal registers its root.

## Boundaries

`crates/chan-server/src/routes/library.rs` (`LauncherState`, `handle_add_workspace`, `handle_workspace_on`), `crates/chan-server/src/devserver.rs` (the root fallback's installation and the coordinator) or `crates/chan-library/src/host.rs` if the state lives there, and their tests. The desktop's embedded host keeps its answers.

## Acceptance

1. After the stop signal, a launcher add through the devserver's root fallback answers 503 in the envelope with a sentence that says the devserver is stopping, and leaves no library row.
2. After the stop signal, a launcher on answers the same way and mounts nothing.
3. Both are pinned in the devserver's own stop order.
4. On the desktop's embedded host the two routes answer as they do now.

## What shipped

The build is on the integration branch and not on `main`, and the item stays accepted until the steps through a gateway and on the desktop's connecting page are read at rc0; what a real stop answers on this machine's loopback is measured (below). It came with [a-stopping-devserver-says-it-is-restoring](a-stopping-devserver-says-it-is-restoring.md) in one range and its fix round: `f8dd439d3`, `ce5340d6a` and `681c23bb0`, then `e7dbe6ff9` and `7c15b9d98` (`dev/v0101-team/reports/report-Services-40.md` and `report-Services-42.md` in the development tree; the independent reviews, `dev/v0101-team/reviews/review-Services-19.md` and `review-Services-20.md`). Lines at `4c4ada0a1`.

- **The launcher's add and on ask their surface before they register or mount a root.** The launcher's state holds an admission that its surface supplies (`MountAdmission`, `crates/chan-server/src/routes/library.rs:55-73`). The devserver installs its root fallback with one that asks the startup coordinator (`crates/chan-server/src/devserver.rs:2827-2839`), which refuses in `Stopping` and `Stopped` with the shutting-down error and the sentence `the devserver is stopping; <root> was not mounted` (`refuse_mount_at_stop`, `:711-719`), and the two routes answer it with 503 in the envelope, before the registration and before the mount.
- **The desktop's embedded host supplies no admission,** so its add and on answer as they did.
- **The refusals that come first are unchanged,** by the changelog's entry: a read-only launcher still answers 403, one without a bound address 503 with `launcher not ready`, and an on of an unknown id 404 (`CHANGELOG.md:71`).

**The shape is the lead's ruling, which the owner confirmed as built on 2026-09-29:** an admission that the devserver supplies, the first of the two shapes under What to do.

**The acceptance at the tip.** All four points are met by pins: a launcher add after the stop signal registers nothing (`devserver.rs:9195`), a launcher on after it mounts nothing and leaves a mounted workspace as it was (`:9242`, `:9295`), each in the devserver's own stop order, and a surface without an admission adds and turns on (`routes/library.rs:3930`).

**What a real stop answers, measured on 2026-10-01; no acceptance point of this item.** A refusal reaches a client only when its request is dispatched after the coordinator has entered `Stopping` and before its connection shuts down, so most clients of a stopping devserver meet a closed or refused connection and not the 503; that was inferred from the framework's source (`crates/chan-server/design.md:20`; `review-Services-19.md`, "What only a run on a real devserver can show", eight steps), and on 2026-09-29 the owner ruled who measures it: the team runs the five steps that need no display on a throwaway devserver, under an order of its own, and the steps through a gateway and on the desktop's connecting page stay with the owner at rc0. The five steps ran on 2026-10-01 against a throwaway debug devserver on this machine's loopback, HTTP/1.1, with no gateway, no desktop, no systemd notify and no fd store, with no commit and no product finding. In fifty stops a kept and a fresh connection met a closed or refused connection and never the health 503. In fifty more stops a launcher add after the signal met the stopping 503 once and a closed or refused connection otherwise, as did a launcher on, and nothing registered or turned on survived any stop. Forty timed adds, through the launcher's route and the devserver's own, were all admitted before the signal and completed after it with 200, a registry row and an on row, and the workspace was running again at the next start, at most 52 ms after the first workspace the start brought back; none met the admission's 503 or a closed or refused answer, so the admission's refusal window was not hit by timing, as the order allowed. So the inference holds for ordinary loopback traffic, the refusal is met and comes before the registration, and the cost below is what a request admitted before the signal does; how often other clients or transports see the 503 is not established. Two instrument faults were found and repaired in the runner, neither of the product.

**The cost, written and not built:** an add or an on that was admitted before the stop signal completes after it, and the next start brings the workspace back on, by a ruling of the lead's (`review-Services-19.md`, the lead's notes); `crates/chan-server/design.md` says so, and the measurement above shows it.
