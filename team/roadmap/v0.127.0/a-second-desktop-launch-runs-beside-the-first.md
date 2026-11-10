# A second desktop launch runs beside the first

Status: raised by the owner on 2026-11-10 from his Mac as a `tmux -CC` window on a devserver opening twice; he could not reproduce it after `pkill chan`, the cause read was two desktop processes, and he ruled the fix into v0.127.0 ("if this is the case let's fix in *this* version"). Built the same day on `fix/desktop-single-instance` (`086cd362f`, one commit over `7ca88196c`) and merged into the integration branch as `5a4c6cb69`. Each property is pinned by a test shown red without its fix.

## What was there

- **Two desktops open every window twice.** Each desktop process runs its own window watcher, which counts only its own process's windows (`desktop/src-tauri/src/window_watcher_wiring.rs`), so a second process beside the first opens a native window for every record the first already shows, attached to the same sessions.
- **Nothing stopped the second process.** It failed the handoff listener's flock, logged "CLI-to-desktop handoff listener disabled" and kept running. macOS keeps one instance for a Dock or Finder launch, but a launch of the binary by its path skips that.

## Contract as built

1. A GUI launch claims the per-user handoff endpoint (the flock beside the socket on unix, the named pipe's first instance on Windows) once the CLI personalities and the default-terminal launch have returned, before the shims, the config, the WireGuard fabric or any window (`desktop/src-tauri/src/single_instance.rs`), and its handoff listener later serves that claim (`chan_server::handoff::start_claimed_listener`).
2. A launch that finds the endpoint held sends the new handoff request `Activate`; the running desktop raises its last focused window, or opens a standalone terminal when none shows, answers `Activated`, and the launch exits 0.
3. A running desktop that refuses, one older than `Activate` (it answers an unknown type) or one shutting down, holds the endpoint until it exits: the launch waits up to 5 s for the endpoint and boots if it comes free, else exits 0. When nothing answers within 5 s (connects are retried while the holder boots), the launch exits 1 and shows nothing.
4. A relaunch (an update's restart, a failed Windows install's fallback) gives up the endpoint before it starts the new process.
5. The CLI personalities (`chan`, `cs`, the MCP proxy, `--version`) and the default-terminal launch never reach the guard.
6. A claim that cannot be tried (no owner-controlled runtime directory, a lock file that cannot be opened) boots without the listener, as before.

## Boundaries

- The endpoint is per user (the runtime directory on unix, the user name in the pipe name on Windows), not per `CHAN_HOME`: a second desktop under another `CHAN_HOME` in the same session now exits too, and a separate `XDG_RUNTIME_DIR` keeps two apart (`.agents/desktop.md`).
- `Activate` is additive, so the handoff `PROTOCOL_VERSION` stays 1. No new dependency.
- Delivering a launch's paths to the running desktop stays with the v0.128.0 item `chan-cannot-be-opened-as-a-file-browser-or-markdown-editor.md`.

## Acceptance

1. Tests (met): the start-up decision as a pure function over every outcome; the guard against temporary endpoints (hands over beside a serving desktop, exits 1 beside a silent holder, claims an endpoint the holder frees); the `Activate` round trip and an unknown type refused through the real listener; the claim's held, freed and unavailable states; source pins that every CLI personality returns before the guard and that both relaunches release the endpoint first. The branch's gate at `086cd362f` was green (fmt, clippy, rustdoc, chan-desktop 881 tests, chan-server 2,520, the Nix hash check), and clippy for the Windows and macOS targets passed with a planted warning in each platform's code shown caught.
2. The integration branch's gate and Windows cross-check green with the merge.
3. On chan-desktop on macOS (owner): with chan running, launching the binary by its path (`/Applications/chan.app/Contents/MacOS/chan-desktop`) raises the running desktop's last window and leaves one process (`pgrep -l chan-desktop`); `tmux -CC` on a devserver opens each window once; a relaunch from Check for Updates comes back.
4. On the local Windows VM at the release run: a second launch of the installed desktop raises the first and leaves one process.
