# A default-terminal launch beside a running chan-desktop boots a second launcher

Status: built on `desktop/terminal-prototypes` on 2026-10-29 (commit `2d5944560`); read against the built app on macOS by the owner and through `xdg-terminal-exec` on Linux on 2026-10-30 (the section Built and verified); no item was written while it was built, so this record is written from the commit and the readings; closes at the GA.

## What was seen

A default-terminal launch that only runs the user's shell, a bare `chan-desktop` or one with `--dir` alone (`xdg-terminal-exec` with no command, Omarchy's Super+Return), booted a second full launcher beside a running chan-desktop. That launcher restored the saved window set, which is how a new terminal window came up carrying the previous layout instead of one shell in the launch's directory.

## Desired contract

- Such a launch is first offered to a running same-user chan-desktop over the handoff socket, as an `OpenTerminal` request carrying the absolute start directory. That desktop opens a throwaway local terminal window whose first terminal starts in that directory, answers `TerminalOpened`, and the launching process exits 0.
- `-e`, `--hold`, `--app-id` and `--title` keep their own process: the command's exit code, the held window, the per-process GTK app id and the fixed title belong to the launching process, and the running desktop can honour none of them.
- With no desktop running, with the `CHAN_NO_DESKTOP_HANDOFF` opt-out, after a refusal, or with no reply within the three-second budget, the launch goes on as before: a `--dir` launch opens its own window, a bare launch boots the launcher.
- The throwaway window is a row kept in memory and left out of every save, so a relaunch does not restore it; its id stays in the throwaway set after removal so a save of an older snapshot still leaves it out. The window seeds no default terminal: the host parks an `open_term_new` frame, built by the shared terminal tenant's standalone filesystem so the directory is in that tenant's wire form, marks it routed, and only then fires the change signals, so the watcher builds the window without a seeded tab.
- The desktop refuses the request once its shutdown has started, because the updater's relaunch starts the new process while the old one still holds the socket, and that process must boot rather than hand itself back.

## Boundaries

`crates/chan-server/src/handoff.rs` (`Request::OpenTerminal`, `Response::TerminalOpened`, `try_open_terminal`), `crates/chan-server/src/control_socket.rs` (`StandaloneFiles::term_new_frame`), `crates/chan-library/src/windows.rs` (`create_throwaway_terminal`, `is_throwaway`, the save filter), `crates/chan-library/src/host.rs` (`open_throwaway_terminal_window`), `desktop/src-tauri/src/terminal_mode.rs` (`hands_off`, `hand_off`), `main.rs`, `embedded.rs`, `serve.rs` (`spawn_throwaway_terminal_window`), `desktop/design.md`, `design.md`.

## Acceptance

1. Unit tests: the launch eligibility (`hands_off`), the throwaway row's persistence and silent mint, an `OpenTerminal` round trip over a real listener; clippy with warnings denied; the chan-library, chan-server and chan-desktop tests.
2. Against the built app with an isolated `CHAN_HOME` and runtime dir: a `--dir` launch and a bare launch beside a running desktop each exit 0 and open one shell in the requested directory with no default terminal beside it; an `-e` launch returns its command's exit code without touching the desktop; a `--dir` launch with no desktop opens its own window; a relaunch restores only the saved windows.
3. On Linux through `xdg-terminal-exec`, the same, with the desktop entry's `X-TerminalArg*` keys doing the mapping.

## Built and verified

macOS, 2026-10-29, by the commit: the unit tests of acceptance 1 pass with clippy `-D warnings` and the three crates' suites; against the built app with an isolated `CHAN_HOME` and runtime dir, acceptance 2 held in every arm. The updater relaunch refusal and a Linux run were not exercised.

Linux, 2026-10-30, on a CachyOS host under Hyprland 0.57.0 with `xdg-terminal-exec` 0.14.4, the debug build of `e63b637f1`, an own desktop entry (the packaging entry with `Exec=` pointed at the built binary) named in an own `xdg-terminals.list`, an isolated `CHAN_HOME` and `XDG_RUNTIME_DIR`, and every `CHAN*` variable of the launching terminal unset:

- A fresh `CHAN_HOME` boots the desktop into one "Terminal Window 1". `xdg-terminal-exec` with no command from a directory, and `xdg-terminal-exec --dir=<other directory>` from `/tmp`, each exit 0 at once; the running desktop opens "Terminal Window 2" and "Terminal Window 3", each with one bash whose `/proc/<pid>/cwd` is the requested directory and no second shell; `windows.json` keeps its one row throughout.
- `xdg-terminal-exec sh -c 'exit 7'` exits 7 and `xdg-terminal-exec true` exits 0, each in its own `terminal-exec` window, with the running desktop's window count unchanged; `xdg-terminal-exec --title=ProtoTitle` keeps its own process and window with one bash in the launch directory, and SIGTERM ends both.
- With the desktop stopped, `xdg-terminal-exec --dir=<directory>` opens its own window titled "Terminal" with a bash there and binds no handoff listener; a bare `xdg-terminal-exec` boots the launcher, which restores exactly one window, "Terminal Window 1", and none of the throwaway windows.
- `cs terminal list --json` over the test desktop's control socket lists one session per window with `window_kind: standalone-terminal`.

The launcher and desktop logs, the rig and the compositor captures are in the `chan-dev` repository under `releases/v0116/terminal-prototypes-linux/`.

Not read: the shutdown refusal (the updater relaunch path), the `CHAN_NO_DESKTOP_HANDOFF` opt-out beside a running desktop, a handoff refused by the desktop.

Open: the sessions the handoff opens list `cwd: null` in `cs terminal list --json`, where the window's seeded default terminal lists its directory, although the shells start where asked; raised and fixed as [cs terminal list hides the directory of a standalone terminal outside the home](cs-terminal-list-hides-the-directory-of-a-standalone-terminal-outside-the-home.md).
