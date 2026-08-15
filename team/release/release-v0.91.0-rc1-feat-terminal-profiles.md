# RC report: 0.91.0-rc1 / feat-terminal-profiles

## Scope

A terminal can open a named shell the user chose, instead of the one the server picked. Item: [a-terminal-opens-whatever-shell-the-server-picked](../roadmap/v0.91.0/a-terminal-opens-whatever-shell-the-server-picked.md).

1. **Discovery.** The server enumerates the machine's shells as selectable profiles. On Windows: PowerShell 7, Windows PowerShell, cmd, Git BASH across four resolution tiers, and every WSL distribution read from the Lxss registry. On unix: `$SHELL` plus `/etc/shells`. Cached in a `OnceLock` and primed at boot.
2. **User declarations.** `[[terminal.profiles]]` in `server.toml` layers over discovery: override a discovered entry's name or arguments, hide one, or add a shell discovery cannot find. `terminal.default_profile` names which one new terminals get. Authored by hand; not surfaced in Settings, and the config reference says so.
3. **Spawn and persistence.** `GET /api/terminal/shells` publishes the merged list on both the full and the terminal-only router. `CreateOptions`, `RestartOverrides` and the fd-store manifest carry a profile id, so a tab keeps its shell across restart, server restart, and reload.
4. **The picker.** Indented rows under "New terminal" in the pane hamburger, in both window kinds.
5. **Two riders.** `chan open` strips the Windows `\\?\` verbatim prefix from the serve root, which was leaking into the desktop window title; and the Windows/Linux contributing docs move from "proposed" to validated on real hardware.

## Commit range

`0.91.0-rc1..feat/terminal-profiles`: 13 commits, `1f3e74aa` through `114363cf`. Merged as `fb00df21`. Rebased from its original base `81c0ba97` (8 behind `main`); the rebase replayed clean commit by commit, and the `Co-Authored-By` / `Claude-Session` trailers the branch carried were stripped, since no other commit in this repository has them.

## Validation

- Integrated gate on the merged candidate: fmt, `clippy --all-targets -D warnings`, `cargo test --all-targets` (33 test binaries), `cargo build --no-default-features`, `make web-lock-check`, `make web-check` (419 web test files), `make shortcuts-check`, `make gateway-fmt`, `make gateway-lint`, `make gateway-build`. All green.
- `make workflow-check` (actionlint) green.
- Roughly 20 pure Rust unit tests over discovery and the merge, running on every CI arm rather than only where the shell exists: the three pre-existing argument conventions pinned byte for byte, the WSL one-shot form, the `wsl.exe -l` trap, the `reg query` argv, REG_SZ parsing with spaces in the path, the WSL-versus-Git-BASH `bash.exe` filter, and the full override/hide/add/dedupe/default-resolution matrix. Plus five config tests, a slim-router wiring test, and four web tests.
- The Windows discovery half was exercised on real Windows hardware during development, including a WSL distribution and Git BASH, with pwsh correctly absent before it was installed.
- Adversarial review of the diff by two independent passes, the second tasked with refuting the first.

## Intake findings, all fixed on the branch

1. **Data loss.** `deserialize_terminal_profiles` ran `Vec::<TerminalProfile>::deserialize` to completion before the normalizer, so an entry that failed to *parse* rather than normalize took the whole `server.toml` with it: a stanza with no `id`, `args` written as a string, or a `kind` naming a convention that does not exist. The server then ran on in-memory defaults and the next settings write persisted them over every other setting in the file. The normalizer's own doc comment already promised this could not happen.
2. **The feature did not work as documented.** The picker resolved against the live server config while the spawn resolved against the boot-time snapshot, of which only `ghostty` was ever refreshed. The documented authoring workflow -- hand-edit `server.toml`, pick the shell -- listed a profile that opened the default shell instead. `PATCH /api/config` reaches it too, on a router where no config watcher runs at all.
3. **`chan config get` errored on both new keys** against a default config, because both skip-serialize while unset and the schema sample does not materialize them, for two keys the CLI table and `docs/config-reference.md` both advertise.
4. **Two of the branch's own tests failed on Linux.** `from_program_stem` asked `Path::file_stem`, which does not treat `\` as a separator off Windows, so `C:\WINDOWS\System32\wsl.exe` classified as `Posix` -- the one classification the function's own comment says must not happen, because `-l` to `wsl.exe` lists distributions instead of opening a shell. The function's doc comment claimed "Cross-platform and pure so the classification is table-tested on every CI arm"; it was not.

## Hand-smoke (pending)

- Windows: pick each discovered profile and confirm the shell actually opens with its own argument convention, especially a WSL distribution and Git BASH.
- A profile added to `server.toml` on a running server, picked without restarting it.
- A profile-named terminal surviving restart, server restart, and reload.

## Known risks

- **WSL profiles lose chan's injected environment.** Nothing sets `WSLENV`, and Win32-to-WSL interop forwards only variables named there, so `CHAN_CONTROL_SOCKET`, `CHAN_TAB_NAME`, the `CHAN_MCP_*` block and the rest do not reach the shell inside the distribution. `cs` will not work in a WSL profile terminal. Not fixed here; needs a Windows host to verify any repair.
- **Discovery blocks a tokio worker on the first request** that beats the boot-time prime, which the module it calls says must never happen. Bounded by how long `where pwsh`, `git --exec-path` and the registry read take, and only on a cold first request.
- **`/etc/shells` is the chsh whitelist, not a list of interactive shells**, so on a stock Debian or Ubuntu host the picker lists `rbash`, `screen` and `tmux`, and `/bin/sh` and `/usr/bin/dash` appear as two entries for one interpreter. Picker noise rather than a broken spawn: `screen -l` and `tmux -l` are both valid.
- **WSL discovery lists every distribution under Lxss**, including Docker Desktop's `docker-desktop` utility distribution on machines that have it.
- Three code comments cite a commit sha, which `.agents/writing-rules.md` bars; `docs/config-reference.md` still places the picker on the new-terminal button, which a later commit on the same branch moved into the hamburger. Both cosmetic, neither fixed.

## Changelog-worthy user impact

- Added: terminals open on a shell you pick. The server lists the machine's shells, and the pane's New terminal menu offers them.
- Added: `[[terminal.profiles]]` and `terminal.default_profile` in `server.toml` rename, hide, or add a shell, and choose the default.
- Fixed: `chan open` no longer leaks the Windows `\\?\` verbatim prefix into the window title.
