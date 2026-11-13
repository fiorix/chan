# A warm chan-term launch opens its window without Chan coming forward on macOS

Status: accepted for v0.130.0 by the owner on 2026-11-13; not started.

Record: seen on the owner's Mac walk of v0.129.0's [chan-term row](../done/the-default-terminal-is-chan-desktop-under-flags-of-its-own.md) on 2026-11-13 (`dev/v0129/owner/reports/parts-abc-at-8a44e110e.md`, Part B, `T2`), which recorded where the keyboard went without predicting it. Asked whether a warm `chan-term` launch should bring Chan forward on macOS in v0.129.0, the owner answered: "let's add a follow up item for this, no need to fix in this version".

## What is there now

A `chan-term` that only runs the shell, beside a running desktop, hands the desktop an `OpenTerminal` and exits 0. The desktop answers it with `serve::spawn_throwaway_terminal_window` (`desktop/src-tauri/src/serve.rs`, called from the handoff handler in `desktop/src-tauri/src/main.rs`), which records a throwaway terminal window for the window watcher to open. Nothing on that path calls the shared raise (`raise::raise_window`), which a second launch's coming forward, a close confirmation and a Window menu row go through. By reading, not proven by a run.

## Evidence

- In the run with the owner's tiling window manager quit (Part B, `T2n`; macOS 27.0.1, a build of `8a44e110e`): `T2a`, a bare launch, and `T2b`, a launch with `--dir`, each added one window to the one desktop (5 to 6, then 6 to 7), exited 0 with nothing printed, and read `front=Terminal` four seconds after the launch: the window opened and the keyboard stayed in Terminal. `T2c`, a missing directory starting at home with a warning, added its window too; its front app was not read. Where the windows appeared on screen was not seen by eye.
- In the same walk a `chan-term -e` window in a process of its own came to the front (`T5a`, `front=chan-term`), and a cold start ended with Chan frontmost and its terminal key (`T6f`).

## Desired contract

1. A warm `chan-term` launch that hands its shell to the running desktop ends with the new terminal window key and Chan frontmost, as a second launch's raise does.
2. No focus is taken where nothing was opened, as the raise row's second contract line says.

## Boundaries

- The desktop's answer to the hand-off's `OpenTerminal` on macOS; the shared raise, applied once the window exists, is the first candidate, as the round's notes say. On Linux, read first: under a window manager that prevents focus stealing, a raise asked for by a launch started in a terminal gets no focus at v0.128.0 or v0.129.0 (the [raise row](../done/coming-forward-to-a-minimized-window-may-not-activate-the-app.md)'s open items).
- Windows installs no `chan-term`, so it has no such launch.

## Acceptance

1. A test that pins the hand-off's terminal window going through the shared raise once it exists, red without the change.
2. The chan-term walk's `T2a` and `T2b` on the owner's Mac with the tiling window manager quit, ten runs each: one window added, one desktop, and Chan frontmost with the new window key in every run.
