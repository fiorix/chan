# chan-desktop

Desktop edition of [chan](https://chan.app), an IDE in a single binary: a terminal emulator and multiplexer plus a workspace manager.

chan-desktop is a Tauri shell that embeds `chan-server` for normal local workspaces. Non-CLI users get a familiar app icon, a window for managing workspaces, and a one-click "open workspace" flow without a separate per-workspace `chan serve` process.

The workspace UI is the same Svelte app shipped in the standalone `chan` binary. Desktop opens it in Tauri webview windows backed by the embedded server or by explicit remote attachments.

## Download

Notarized macOS builds, signed Windows installers, and Linux builds (`.AppImage`, `.deb`, `.rpm`) are published on https://chan.app. End users should grab the build from there rather than building from source.

## Build and run

Requirements: stable Rust (pinned in `rust-toolchain.toml`) and npm for the embedded web build. The Makefile builds the embedded web bundle (`web/dist`) and installs `tauri-cli` v2 under `../target/tauri-cli` if `cargo-tauri` is not already on `$PATH`.

```bash
make dev      # cargo tauri dev (launch the desktop app in dev mode)
make build    # cargo tauri build (release bundle for the host platform)
make check    # cargo check
make clean    # cargo clean
```

The desktop app stores its config at `~/.chan/desktop/config.json` -- the same `~/.chan` home as the CLI registry, not a separate OS app-data directory.

## Workspace modes

- Local embedded: desktop owns the local workspace runtime through its embedded `chan-server` host.
- Remote outbound: desktop opens an already-running `chan serve` URL pasted by the user. The remote server owns its own lifecycle.

There is no local sidecar fallback mode. Running `chan serve` directly is still supported, but desktop treats it as a remote attachment.

## License

Apache 2.0. See [LICENSE](./LICENSE).
