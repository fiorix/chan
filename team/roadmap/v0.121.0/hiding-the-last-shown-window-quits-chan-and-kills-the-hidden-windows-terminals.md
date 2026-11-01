# Hiding the last shown window quits chan and kills the hidden windows' terminals

Status: raised by the owner on 2026-11-01 after it ended a screencast dry take ("if we're hiding the last local window and there are terminals open, we cannot close chan - we must refuse until there's at least one window open"); filed as [fiorix/chan#8](https://github.com/fiorix/chan/issues/8); drafted for v0.121.0.

## What is there now

On chan-desktop 0.120.1 for macOS, a workspace window whose terminal ran an agent session was hidden with `cs window hide`, a throwaway standalone window was hidden the same way, and one standalone terminal window was left shown. `cs window rm <shown window> --force` destroyed the last native window and the desktop exited at once, with no prompt: every hidden window's shells were killed, the agent session among them, and the next `cs` call answered `the server closed the control socket before answering`.

Hiding takes the same path. `bury_window_now` (`desktop/src-tauri/src/serve.rs`) buries a `local::` record through the watcher view, whose reconcile closes the native window, so a hidden local window has no webview. When the last native window is destroyed Tauri requests an exit, and the `RunEvent::ExitRequested` arm in `desktop/src-tauri/src/main.rs` counts the workspace webviews that remain; with none it runs `begin_normal_shutdown` and skips the quit confirmation that a menu Quit goes through. `desktop/design.md`, Quitting, documents it: closing the last native window exits chan on every platform and the exit handler runs the clean shutdown without a prompt; buried windows keep their hidden records and restore hidden at the next boot, but their terminals do not survive the process. Nothing checks for live terminals before the last window goes.

## Desired contract

1. Hiding the last shown local window is refused while any terminal session of the library is alive. `cs window hide` exits non-zero with a sentence that says why and what to do (show or open another window first); the close-confirm overlay's Hide and the launcher's Hide action and `h` key refuse it the same way, with the reason shown where the gesture was made. With no live terminal the hide behaves as today.
2. The same holds for `cs window rm` and the overlay's Close on the last shown window while hidden windows hold live terminals: refused with the reason, or routed through the quit confirmation; which of the two is the decision below.
3. `desktop/design.md`, Quitting, states the guard next to the last-window exit it qualifies.
4. Tests pin the rule where it is decided (shown local windows counted against live sessions) and the `cs window hide` refusal; the last-window exit with no live terminal keeps its current test.

## Next

A decision on contract 2 (refuse, or ask through the quit confirmation), then the row.
