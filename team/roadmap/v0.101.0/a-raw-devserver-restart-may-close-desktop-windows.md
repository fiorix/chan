# A graceful restart of a raw devserver may close desktop windows that it should keep

Status: raised for a decision on 2026-09-27 by the plan for the fourth fix round of the desktop's wait for a restarting devserver (`dev/v0101-team/followups/followup-Runtime-Lead-17.md` in the development tree, section 7, item 5), whose trace of the records was a read-only map at `76b735596` and which marks it as read by that map and not verified; the lines it cites read again at `37e9d23dd`, where each holds as below. That the last change reaches the desktop before its socket closes is inferred, and nothing was run. Recommendation: accept for v0.101.0, with a code map first.

## What was seen

A graceful shutdown of the devserver takes every hosted tenant out of the host's map before it shuts them down, and then signals a change of the library's window set (`drain_tenants`, `crates/chan-library/src/host.rs:3515-3544`, the map drained at `:3525` and the signal at `:3542`). The devserver's run reaches it through `shut_down_hosted` (`crates/chan-server/src/devserver.rs:2388-2405`), which it calls after its server has stopped serving (`:2333`, `:2352`).

What the window set holds after the drain. A workspace window is in it only while its workspace is mounted (`window_in_live_feed`, `host.rs:2239-2246`, applied at `:2271`), so every workspace window leaves it. A terminal window takes its prefix and token from the shared terminal tenant in the map, and both are empty once that tenant is gone (`terminal_window_live`, `:2948-2968`).

The library window feed's socket sends the whole set again on every change and ends only when its client goes or a send fails; it reads no shutdown of its own (`watch_library_windows`, `crates/chan-server/src/routes/library.rs:1058-1102`). The record reads that the socket of a desktop connected to the devserver directly is still open when the drain signals, so its last frame carries that set. That is inferred: whether the server's stop has closed an upgraded socket by then was not read.

A desktop connected to a devserver without a gateway takes each frame of that socket as its snapshot (`stream_window_feed`, `desktop/src-tauri/src/window_watcher_wiring.rs:899-928`, the raw socket at `:911-912`), and its watcher reconciles every snapshot (`desktop/src-tauri/src/window_watcher.rs:391-397`). A record is shown only with a token (`should_show`, `:222-228`, the token at `:227`), and every native window that is no longer shown, or no longer in the snapshot, is closed (`reconcile`, `:257-267`). So that frame, if it arrives, closes the desktop's native windows of that devserver, terminal and workspace alike, where a restart is meant to keep a window and give it the new token in place (the comment at `:252-256`); the snapshot after the restart opens them again at the same labels (`:257-262`). All of this is inferred from the code; the record asks for a probe on a display.

## Desired contract

A graceful restart of a devserver leaves a connected desktop's native windows of that devserver open, to be retargeted in place once it is back; only a window the library discarded, a workspace turned off, or a window the user buried closes.

## What to do

A code map first, as recommended: establish whether the drain's last frame reaches the desktop, from the order of the server's stop and the drain, for a desktop connected directly and for one behind a gateway. Then, as suggestions: the devserver sends no change of its window set once its shutdown has begun, or the feed ends its socket before the drain; or the desktop tells a devserver that stops from one whose workspaces turn off, and keeps that devserver's windows through the stop. Red first: a devserver's drain with a desktop's feed attached, and the desktop's reconcile shown to close its windows.

## Boundaries

`crates/chan-library/src/host.rs` (`drain_tenants`), `crates/chan-server/src/devserver.rs` (`shut_down_hosted` and the run around it) and `crates/chan-server/src/routes/library.rs` (`watch_library_windows`), or, on the desktop's side, `desktop/src-tauri/src/window_watcher.rs` and `window_watcher_wiring.rs`, with their tests. The desktop's wait for a restarting devserver and its retarget, which that wait's fix rounds change, are not this item's.

## Acceptance

1. A graceful restart of a devserver with a desktop connected directly leaves the desktop's native windows of that devserver open, and each reaches the restarted devserver in place; pinned red first.
2. A workspace turned off still closes its windows on the desktop, and a discarded window still closes.
3. A reading on a display of a raw devserver restarted with windows open.
