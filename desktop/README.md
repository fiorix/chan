# chan-desktop

Desktop edition of [chan](https://chan.app), a supercharged terminal emulator. What chan is, and where the desktop fits in it, is in the root [README](../README.md) and in [`../design.md`](../design.md); the desktop's own design is [`design.md`](design.md).

chan-desktop is a Tauri shell: it puts chan's windows on the desktop, embeds the server for local work, reaches devservers over a TCP tunnel or through a self-hosted gateway, and is the `chan` and `cs` command line at the same time. One process supervises every standalone terminal, every local workspace and every connected devserver, so their windows sit side by side and share one launcher. Every window shows the workspace app the standalone `chan` binary also serves; the desktop adds native windows, menus, dialogs and transfers around it.

## Download

Notarized macOS builds, signed Windows installers, and Linux builds (`.AppImage`, `.deb`, `.rpm`) are published on https://chan.app. End users should grab the build from there rather than building from source.

chan-desktop requires macOS 14 (Sonoma) or later. Its self-updater refuses an update whose published macOS minimum exceeds the running version and keeps the installed app. See [Self-update](design.md#self-update) for the update metadata and checks.

## Build and run

Requirements: stable Rust (pinned in `rust-toolchain.toml`) and npm for the embedded web build. The Makefile builds the embedded web bundle (`web/dist`) and installs `tauri-cli` v2 under the repository's `.build-tools/tauri-cli` if `cargo-tauri` is not already on `$PATH`.

```bash
make dev      # cargo tauri dev (launch the desktop app in dev mode)
make build    # cargo tauri build (release bundle for the host platform)
make check    # cargo check
make clean    # cargo clean
```

The desktop app stores its config at `~/.chan/desktop/config.json` -- the same `~/.chan` home as the CLI registry, not a separate OS app-data directory.

## Runtime shapes

- Local: desktop serves this machine's standalone terminals and workspaces from its embedded `chan-server` host.
- Devserver: desktop connects to a configured `chan devserver` and mirrors its library-managed windows.
- Gateway: desktop signs in to a gateway and projects its authenticated devserver roster into the launcher.

There is no local sidecar fallback mode and no arbitrary URL attachment. A standalone `chan serve` remains an independent browser-served process; when a desktop is already running, the CLI handoff asks it to open the registered workspace instead.

## License

Apache 2.0. See [LICENSE](./LICENSE).
