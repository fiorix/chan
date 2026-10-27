# chan-desktop has no FreeBSD build though its toolkit supports FreeBSD

Status: raised on 2026-10-27 by the owner after the v0.112.0 GA; accepted for v0.113.0 by the owner's word of 2026-10-27 ("organise 3 independent worktrees for 3 agents to work on ... they will build in parallel"); building on `v0113/a-freebsd`.

## What was seen

The owner's words of 2026-10-27: "do you think it's possible to build chan-desktop on freebsd, too?", then, after a trial in a FreeBSD 15 Lima guest on a chan checkout at version 0.112.0, "it worked, include this as an item for the next roadmap".

The trial, in order:

1. `pkg install webkit2-gtk_41 gtk3 pkgconf`: WebKitGTK 2.46.6 with the 4.1 API (GTK 3, libsoup 3) that Tauri 2 links.
2. `cargo check -p chan-desktop` failed in tao 0.37.1 with three `E0425` errors: `crate::window::hit_test` is gated to Windows and Linux (`src/window.rs` line 1665), and the GTK event loop that FreeBSD shares with Linux calls it. tao 0.37.2 (2026-10-23) widens the gate to the BSDs; `cargo update -p tao --precise 0.37.2` cleared it.
3. The check then failed in tauri-plugin-updater 2.14.0, the latest stable release, with four `E0433` and one `E0609`: its AppImage update code is compiled on Linux and every BSD, but the crates it uses (`flate2`, `tar`, `dirs`) are declared for Linux only, its `OsStr` import is gated to Windows and Linux, and it reads `Env::appimage`, a Tauri field that exists only on Linux. A local copy of the plugin with those three gaps closed, through `[patch.crates-io]`, cleared it.
4. The check then finished with three `dead_code` warnings, each a path FreeBSD compiles out: `Native::Done` in `crates/chan-workspace/src/no_replace.rs` (line 61; the native no-replace rename is gated to Linux, Android and Apple), and in chan-desktop `DesktopUpdateReadyPayload` (`main.rs` line 68) and `launcher_panel::show_for_attention` (line 203), both reached only from `notify_desktop_update_ready` (`main.rs` line 3661, gated to macOS, Linux and Windows).
5. The next steps proposed were a linked `cargo build -p chan-desktop`, the web bundles (`make web web-launcher`), and a run under an X11 session; the owner's "it worked" followed them. Which of the three was read, and what the running app showed, is not recorded here.

Read at `ff5713172`:

- The toolkit carries FreeBSD: Tauri 2.12.4, tauri-runtime-wry 2.12.2, wry 0.57.0 and tao 0.37 list FreeBSD beside Linux on their GTK and WebKitGTK paths, and the CLI crates chan-desktop embeds have built and tested on FreeBSD since v0.96.0 (`done/freebsd-is-not-a-published-target.md`, which excluded chan-desktop from its suite).
- chan-desktop has 40 `target_os = "linux"` gates (`main.rs` 17, `launcher_panel.rs` 15, `linux_gui_stack.rs` 6, `terminal_mode.rs` 2) and no mention of FreeBSD, so on FreeBSD each takes the macOS and Windows arm. The in-window launcher builds through wry's `build_as_child`, which under GTK works on X11 only, instead of the GTK overlay the slide relies on; the `gtk` dependency is declared for Linux only; `linux_gui_stack.rs`'s GPU detection and WebKit environment fixes fall to their stubs.
- Release: Tauri's bundler has no FreeBSD format, chan.app's `/dl` metadata has no FreeBSD desktop target for the updater, and the FreeBSD CLI is a static cross-build from Linux, which a desktop that links WebKitGTK dynamically cannot be: it needs a native FreeBSD build, such as a FreeBSD virtual machine job in CI.

## Desired contract

chan-desktop builds on FreeBSD from an unpatched checkout with warnings denied, and runs there with the same window, terminal and launcher behaviour as on Linux. Code that is about GTK and WebKitGTK takes the Linux path on FreeBSD too; what is Linux-specific (the systemd unit, the desktop entry, xdg-terminal-exec, AppImage) stays Linux-only; a feature with no FreeBSD backend, the self-updater among them, is compiled out on FreeBSD rather than patched. Whether FreeBSD desktop is a published target or a build-from-source one is decided and recorded here.

## What to do

1. `Cargo.lock`: tao to 0.37.2 or later, with the Nix cargo hash harvested again in the same commit.
2. The updater on FreeBSD: make `tauri-plugin-updater` a dependency off FreeBSD with its uses gated (the update checks and installs in `main.rs`, the `Update` fields, the plugin's registration in `main.rs` and `terminal_mode.rs`, the update-ready notice), or land the plugin's three fixes upstream and take that release. Report the plugin's gaps to tauri-apps either way, and record which path was taken.
3. One condition for GTK platforms (Linux and FreeBSD) in chan-desktop for the code that is about GTK: the launcher's GTK overlay and its `gtk` dependency, `linux_gui_stack.rs`'s WebKit environment, and the GTK-specific window code. Then gate the three dead items above.
4. The runtime readings on a FreeBSD desktop under X11 and Wayland: a window, a terminal, the launcher's toggle and slide on Ctrl+Shift+P, the plasma background's GPU detection, and the file watcher (`bsdfds`) on a real workspace.
5. The release decision: a FreeBSD port or `pkg` recipe and a `/dl` entry, or build-from-source steps in the manual's install page. A CI job on a FreeBSD virtual machine runs `cargo check -p chan-desktop` with warnings denied either way.

## Boundaries

`desktop/src-tauri/` (`Cargo.toml`, `main.rs`, `launcher_panel.rs`, `linux_gui_stack.rs`, `terminal_mode.rs`), `crates/chan-workspace/src/no_replace.rs` for its FreeBSD warning, `Cargo.lock` and the Nix pins, a CI job if one is added, and the manual's install page if FreeBSD desktop is build-from-source. Not changed: chan-desktop's behaviour on Linux, macOS and Windows.

## Acceptance

1. On FreeBSD 15 with `webkit2-gtk_41` installed, `RUSTFLAGS="-D warnings" cargo build -p chan-desktop` from an unpatched checkout succeeds.
2. The built chan-desktop opens a window under X11, runs a terminal, and shows and hides the launcher.
3. The Linux, macOS and Windows gates and CI stay green.
