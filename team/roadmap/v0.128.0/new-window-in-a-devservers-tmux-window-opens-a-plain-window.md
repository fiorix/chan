# New Window in a devserver's tmux window opens a plain window

Status: raised by the owner on 2026-11-10 and accepted for v0.128.0 the same day; not started.

## What is there now

Cmd+Shift+N (New Window) opens a new window like the focused one (`open_new_window_for_label`, `desktop/src-tauri/src/main.rs` around 7141). For a local window (`local::` label) it reads the window's record first: a tmux window (a record with a tmux mark that is not the connection's control terminal) asks its own page for a new tmux window (`TMUX_NEW_WINDOW_DISPATCH_JS`, the page's `app.tmux.newWindow` command), so tmux creates the window and chan opens it; a terminal opens another standalone terminal; a workspace window mints another window for its workspace. For a devserver's window (`lib-<library_id>::<window_id>` label) the handler matches the focused label against each connected devserver's feed and mints another window of the same kind on that devserver, with no tmux branch, so in a `tmux -CC` window running on a devserver Cmd+Shift+N opens a plain devserver window instead of a new window in that tmux session. The owner noticed it on his Mac: locally Cmd+Shift+N in a tmux window makes a tmux window, on a devserver it does not. The desktop already sends a devserver's tmux connection a new-window request elsewhere (`desktop/src-tauri/src/devserver.rs` around 5302, `TmuxRequest::NewWindow`).

## Desired contract

1. Cmd+Shift+N in a `tmux -CC` window on a devserver creates a new tmux window in that tmux session, which chan opens as its own window, as it does for a local tmux window; pressed again in the new window, it creates another.
2. The connection's control terminal on a devserver keeps the plain terminal branch, as it does locally.
3. Every other devserver window keeps today's behaviour, and so does every local window.

## Boundaries

- The desktop's New Window routing for devserver windows; tmux's own window creation and chan's minting of tmux windows are unchanged.

## Acceptance

1. Tests of the routing: a devserver window whose record carries a tmux mark goes to the tmux new-window path, its control terminal and plain devserver windows do not, alongside the existing local cases.
2. On chan-desktop (owner): in a `tmux -CC` window on a devserver, Cmd+Shift+N three times opens three new tmux windows, each in its own chan window.
