# The launcher's own add and on never ask a stopping devserver's coordinator

Status: raised for a decision on 2026-09-27 by the code map written for [the-devserver-stop-refuses-mounts-before-the-host](the-devserver-stop-refuses-mounts-before-the-host.md) (`dev/v0101-team/int24-docs/codemaps/runtime-next.md` in the development tree, headline 2 and "Outside the item's boundaries"), which read it at `4809d8d4d`, before that item's fix; read again in code at `b1ef073ae`, where it holds, and not reproduced. Recommendation: accept for v0.101.0, built with [a-stopping-devserver-says-it-is-restoring](a-stopping-devserver-says-it-is-restoring.md), which answers in the same stop.

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
