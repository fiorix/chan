# RC report: 0.111.0-rc1 / v0111-xdgtex

## Scope

chan-desktop runs as a default terminal for the xdg-terminal-exec contract, so Omarchy and any desktop that launches terminals through `xdg-terminal-exec` can select it. Item: [chan-desktop-cannot-be-selected-as-the-default-terminal-through-xdg-terminal-exec](../roadmap/done/chan-desktop-cannot-be-selected-as-the-default-terminal-through-xdg-terminal-exec.md).

1. **The launch contract.** `chan-desktop [--dir=PATH] [--app-id=ID] [--title=TITLE] [--hold] [-e CMD ARGS... | -- CMD ARGS...]` opens one terminal-only window in its own process. Everything after `-e` or `--` is the command's argv, exec'd as given on the PTY; with no command the window runs the user's shell. The shell or command starts in `--dir` (a stale directory falls back to home with a warning); a program PATH cannot find exits 127 before any window. The window and the process end when the command exits, with its exit code, unless `--hold`. Plain `chan-desktop` and positional arguments keep the launcher.
2. **A terminal-only process.** The launch skips the launcher boot: no shims, library stores, handoff listener, window watcher, gateway autoconnect or update check. Its host opens the library and an ephemeral loopback port that is never saved, installs no registries, overlay, launcher root or extension processes, and mounts one `/exec` tenant. The window is a `control`-kind window under the `terminal-exec` label, titled exactly as asked, and its close button real-closes with no prompt. New Window starts a detached sibling process with the same `--dir` and `--app-id`.
3. **The app id.** `--app-id` sets the GLib program name before GTK initialises, which is where GTK 3 takes the Wayland app_id and the X11 class from, since tauri passes no GTK application id. Without it the class stays `chan-desktop`.
4. **The library and server layers.** A terminal tenant's default program is a shell command line (the devserver control terminal's path, with its banner) or an argv exec'd directly with no banner, kept on the session so a restart re-execs it; a terminal tenant can be mounted with a cwd that becomes its root. The shared tenant is declared by its caller rather than inferred from "no command".
5. **The entry.** `packaging/distros/shared/chan-desktop.desktop` carries `System;TerminalEmulator;` and the five `X-TerminalArg*` keys, and drops the stale `chan://` scheme-handler line.

## Commit range

`44a58f957..4f8fc2884` on `0.111.0-rc1`, five commits (roadmap raise, library and server, desktop, packaging, roadmap built), rebased onto `v0111/lnpanl` at `aefd215b0`. The rebase onto lnpanl met two conflicts: the IPC command table, which this branch moves into `app_invoke_handler()` and lnpanl extends with `toggle_launcher_panel`, and the menu bullets of `desktop/design.md`; both resolved by taking lnpanl's text into this branch's shape.

## Validation

- Tests, red first then green: eight chan-library tests (argv with a space, a `;`, a `$HOME` and quotes intact; no banner; cwd is the root; the exit code reaches `last_exit`; a restart re-execs; a command override replaces the program; the host front refuses an empty argv and a relative cwd), one chan-server test (the tenant root is the registry root), and 33 chan-desktop tests over the parser and its helpers plus serve.rs pins for the capability globs and the close handler. Two parser mutations each fail the tests pinning them. Suites after the rebase onto lnpanl: chan-library 758, chan-server 2483, chan-desktop 691 passed.
- `make pre-push` on the rc1 pin commit `a190bc4f6` on the build host: twenty-one of its twenty-two steps green (the static lints, the build-matrix and sdme contracts, the browser suite's Node tests, both Nix hash checks, the web lock check, fmt, clippy over all targets, rustdoc, `cargo test --all-targets`, the no-default-features build, the gateway fmt, lint, doc, tests and build, web-check, the marketing check, shortcuts and file classes); the last step, `host-build-check`, built the release CLI and passed its devserver smoke and then failed at the AppImage bundle with `failed to run linuxdeploy`, the known condition of this Arch host (linuxdeploy's bundled strip cannot read the host libraries). The `release.yml` dry run on the branch is the Linux bundle's proof. `desktop-file-validate` exits 0 with two hints. Cargo.lock is changed only by the pin bump.
- The upstream `xdg-terminal-exec` script with the entry on `XDG_DATA_DIRS` and named in `xdg-terminals.list` prints `chan-desktop.desktop` for `--print-id` and maps Omarchy's four launches to exactly the argv chan-desktop parses, one item per line, with a `bash -c` script as one item.
- Under a headless Weston 15 on the build host (the `proto` debug scope recording each client's requests): `--app-id=org.example.Probe --title=Probe -e sleep 5` sets that app_id and title and exits 0 about two seconds after the sleep; `-e sh -c 'exit 3'` exits 3; a missing program exits 127 with no toplevel; `--dir=/tmp` runs the shell as the desktop's direct child in `/tmp`; `--hold` keeps the window after the exit; `-e bash -c '...'` has the command as the desktop's direct child. Seven launches left `~/.chan` untouched.

## Candidate runs

On `0.111.0-rc1` at `fba4e6145`: Gateway CI 40251347402 green (on `bd4766ff6`, which the later commits do not change for the gateway), CI 40257051277 green (Linux, macOS and Windows arms, the AUR, Nix, container, deb and rpm and source-package jobs), and the `release.yml` dry run 40257053345 with publish off green on every job, including Linux validation, the macOS desktop package with its signing and notarization, the signed Windows packages and both Linux desktop package architectures. Two earlier dispatches on `bd4766ff6` and `ed6d42101` went red only on Windows-side compile checks of this branch (the shell profile out of scope for the Windows PATH layering, then a unix-only test helper ungated for Windows), fixed by `2964adf53` and `fba4e6145`; every other job of those runs was green.

## Hand-smoke (pending)

- In an Omarchy or Arch VM with the package installed: `xdg-terminal-exec --app-id=TUI.float -e btop` floats and `hyprctl clients` shows `class: TUI.float`; the menu's Install, Package opens a floating chan window and the install runs; Super+Return from a focused chan window opens in its cwd.
- The close button and Ctrl+D under `--hold`, and the New Window sibling (no input injection on a headless compositor).
- A terminal launch beside a running chan-desktop GUI (none runs on the build host).

## Known risks

- **The Tauri AppImage is not selectable.** It carries the entry Tauri generates, without the keys; the distro packages and the Nix package install the shared entry. A `bundle.linux.deb.desktopTemplate` is the later fix.
- **One PTY per window.** The window is the `control` kind: no tabs or splits; New Window is a sibling process.
- **Exit is polled.** The exit watcher reads the tenant's last exit every 200 ms; a push hook would be the later refinement.
- **The launcher toggle chord in a default-terminal window** reaches `toggle_launcher_panel`, which refuses the `terminal-exec` label with an error; nothing shows.

## Changelog-worthy user impact

- Added: chan-desktop is a default terminal for xdg-terminal-exec. `chan-desktop -e CMD ARGS...` runs the command in its own window and exits with its code; `--dir`, `--app-id`, `--title` and `--hold` complete the contract, and the desktop entry declares `TerminalEmulator` with the `X-TerminalArg*` keys, so `chan-desktop.desktop` in `~/.config/xdg-terminals.list` makes chan the terminal Omarchy's Super+Return, TUIs and installers open.
- Changed: the desktop entry no longer declares the retired `chan://` scheme handler.
