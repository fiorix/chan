# A close or a Disconnect on the connecting page discards a library window and reaps its terminals

Status: accepted for v0.101.0 by the owner on 2026-09-27; raised for a decision on 2026-09-27 by the code map written for the fix round of the desktop's readiness wait (`dev/v0101-team/int24-docs/codemaps/services-desktop-fix.md` in the development tree, headline 2 and section B), which read it at `9a3dd3e5c`; read again in code at `b1ef073ae`, where the mechanism holds as the map gives it, and not reproduced. A reading on Abandon after a stop that keeps the windows is carried here on 2026-09-28 (below).

## Owner ruling

Accepted on 2026-09-27 for v0.101.0, as the lead recommended. The owner accepted in one answer every recommendation the lead had put to them that day; for this item it was to accept it for this version, with no shape of the fix named.

## What was seen

A devserver window (a `lib-` label) that is still on the bundled connecting page reaches `request_close_window` in four ways: its OS close button (the connecting arm of `on_close_requested`, `desktop/src-tauri/src/serve.rs:949-965`); the page's own Ctrl+D and Cmd/Ctrl+W (`desktop/src/connecting.js:354-365`); the key bridge's close chords while the page is `connecting.html` (`desktop/src-tauri/src/key_bridge.js:127-128`, `:191-193`, `:281-283`); and the Disconnect button the page shows once it has given up (`connecting.js:223-226`). For a `lib-` label, `request_close_window` queues the window's delete, buries the label in the watcher's view, starts the delete and destroys the window (`desktop/src-tauri/src/main.rs:4210-4241`). The delete is `DELETE /api/library/windows/{id}` on the devserver (`discard_library_window`, `desktop/src-tauri/src/devserver.rs:2175-2196`, sent from `main.rs:6550-6557`), whose handler discards the window (`crates/chan-server/src/routes/library.rs:1190-1206`): the host drops its record and reaps its terminal sessions and its session blobs (`discard_window`, `crates/chan-library/src/host.rs:2749-2769`, the reap at `:2834-2859`; `forget_window`, `crates/chan-library/src/terminal_sessions.rs:2681-2689`).

So one close, or one Disconnect, on a window that is waiting for its devserver ends that window for good, with its terminals. The records say it only cancels: `desktop/design.md` says the close chord and the close button on the connecting screen "cancel and really close" (`:180`, `:220`) and that such a window closes "with no prompt" (`:212`), and the page's comments say that Disconnect "destroys the window (same as Cmd+W)" and that on this screen "there is no session or shell worth keeping, only the retry loop being cancelled" (`connecting.js:210-213`, `:345-353`). A devserver window loads this page whenever the desktop builds it (`open_watched_remote_window`, `serve.rs:336-366`): on its first open, when the watcher opens it again, and when a Reload finds no window to retarget (`main.rs:4090-4094`). So a window whose record already holds terminals on the devserver, one the watcher reopens after a reconnect for instance, can be discarded with them from this page (inferred from those paths; not run).

On macOS, Cmd+W through the File menu does something else: it only destroys a window on the connecting screen (`close_spa_or_native_window`, `main.rs:6922-6929`) and leaves its record, which the map infers the watcher reopens at its next reconcile. The same window on its live workspace page asks Hide, Close or Cancel before anything is dropped (`serve.rs:1019-1036`), and Hide buries it with its record (`hide_window_from_close_confirm`, `main.rs:4257-4262`).

**Carried here, read and not run: after a stop that keeps the windows, Abandon may leave them open.** Added on 2026-09-28 from the independent review of the desktop's third fix round (`dev/v0101-team/reviews/review-Services-14.md` in the development tree, the fifth of its display checks), which the lead's notes carry to this item. It is outside that range and older than it, and was read again at `7957bccef`. When a script-backed devserver's control script exits, the desktop retires that devserver's window watcher and keeps its windows, and in retiring it takes the watcher's stop sender out of its map (`mark_devserver_control_exited`, `desktop/src-tauri/src/main.rs:1463-1496`, the stop at `:1484`; `stop_devserver_watcher`, `:1286-1293`). The disconnect overlay's Abandon tears the devserver down (`abandon_devserver_for_window`, `:4252-4269`; `teardown_devserver_connection`, `:1436-1448`), and its removal of the devserver's windows asks the watcher to close them through that same map (`remove_devserver_windows`, `:1301-1309`), where no sender is left. So, by reading, the kept windows stay open after Abandon, and nothing else in the code read closes them, although the overlay's comment says that the window closes through the watcher (`web/packages/workspace-app/src/components/DisconnectOverlay.svelte:61-66`); the review asks for it on a display.

## Desired contract

A close or a Disconnect on a window waiting on its connecting page stops the wait and closes the native window without discarding the window's record or reaping its terminals, as the records say it cancels; a discard stays an explicit choice. The design document and the page's comments say what each close does.

## What to do

Decide what the page's close and Disconnect mean, then make every route to them agree. Two shapes meet the contract: route them through the bury the live page's Hide uses, so the window leaves the screen and stays reopenable from the Window menu with its terminals; or destroy the native window without the delete, as the macOS menu already does, and let the watcher decide whether it reopens. The first keeps a closed window closed; the second can bring it straight back. Keeping the discard instead, and saying so in the records, is the third answer, and it leaves one click able to reap a window's terminals. Red first: a `lib-` window on the connecting page, closed by its button and by Disconnect, with the host's record and a terminal session shown to survive.

## Boundaries

`desktop/src-tauri/src/main.rs` (`request_close_window`), `desktop/src-tauri/src/serve.rs` (`on_close_requested`), `desktop/src/connecting.js`, the close arms of `key_bridge.js`, `desktop/design.md`, and their tests. The server's discard route and the live page's prompt are unchanged.

## Acceptance

1. A `lib-` window on the connecting page, closed by its OS button, by the page's close chords, by the bridge's chords or by Disconnect, leaves the host's window record and its terminal sessions in place, pinned by tests of each route.
2. The live workspace page's Hide, Close and Cancel behave as now.
3. `desktop/design.md` and the page's comments say what a close on the connecting page does.
