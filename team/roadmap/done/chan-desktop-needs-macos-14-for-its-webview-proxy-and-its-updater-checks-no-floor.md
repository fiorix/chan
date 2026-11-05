# chan-desktop needs macOS 14 for its webview proxy and its updater checks no floor

Status: shipped in [v0.124.0](../../release/release-v0.124.0.md).

Record before the release: found on 2026-11-04 while proving the desktop's WireGuard fabric ([chan-reaches-a-gateway-behind-wireguard-only-through-a-vpn-client-on-the-host](chan-reaches-a-gateway-behind-wireguard-only-through-a-vpn-client-on-the-host.md)). The owner took the recommendation to move the floor to 14.0 over weak-linking Network.framework the same day; built as the last commit of `feat/chan-wireguard` and merged into `v0124/int` with it as `038d82f42`. On 2026-11-04 the owner also decided to ship the floor as it is, though a v0.123.0 desktop below macOS 14 has no guard and will update itself into this release, and asked for the release notes and the user documents to say so: update macOS first, or set `CHAN_UPDATE_CHECK=0`. The CHANGELOG and the release report carry that warning; the user documents state the floor and the refusal (contract 5) and leave the v0.123.0 transition to the release notes.

## What was there

The desktop's WireGuard fabric needs tauri's `macos-proxy` feature, with which wry links Network.framework's `nw_proxy_config_create_http_connect` and `nw_proxy_config_create_socksv5` through a plain `#[link(kind = "framework")]` block: a strong import of symbols that exist from macOS 14. The bundle's `minimumSystemVersion` was 11.0. dyld binds imports at launch, so on macOS 11 to 13 the app would die with "Symbol not found" before `main`, and the run-time gate that withheld the proxy below 14 never ran. Separately, tauri-plugin-updater checks no floor: it installs whatever `latest.json` offers, so a Mac below a release's floor would be updated into an app LaunchServices refuses to open.

## Desired contract

1. chan-desktop's macOS floor is 14.0 (`bundle.macOS.minimumSystemVersion` in `tauri.conf.json`): LaunchServices refuses the app on an older macOS with its own dialog, and every macOS it opens on takes the webview proxy. The run-time gate and its log line go.
2. The release metadata carries each release's floor: `collect-release-assets.mjs` reads `bundle.macOS.minimumSystemVersion` from the tag's `tauri.conf.json` through the GitHub contents API, so each retained release is stamped with its own floor and never the checkout's; a tag without the file or the setting gets no entry, and an unreadable setting or an API answer other than found or absent fails collection. `generate-release-metadata.mjs` writes it into the desktop manifest as a top-level `minimum_system_version` keyed by updater target (`darwin`), which the plugin's deserializer ignores.
3. Before an update check is answered or an install starts, the desktop compares that floor with the running macOS (`NSProcessInfo`) and refuses with both versions named: `chan upgrade` reports it as its error and the on-launch check logs it and skips. A manifest without the entry, or with one that does not read as a version, installs as before.
4. The Homebrew cask keeps `depends_on :macos` with no minimum, its comment naming Sonoma as the floor.
5. The install page, the manual's Install chapter and `desktop/README.md` state macOS 14 (Sonoma) or later, and that an update whose published minimum is above the running macOS is refused and the installed app kept.

## Boundaries

`tauri.conf.json`, `desktop/src-tauri/src/update_floor.rs` and its four call sites in `main.rs`, the run-time gate removed from `wireguard.rs`, the two marketing scripts and their smokes, the cask template's comment, `.agents/desktop.md` (the manifest field), `desktop/design.md`, the comment on tauri's `macos-proxy` feature in `desktop/src-tauri/Cargo.toml` (the `NSProcessInfo` comment there was corrected later by `2d8df9c89`), and the three user documents of contract 5. No change to Linux or Windows updates, the signing path or the manifest's platform map.

## Acceptance

1. `update_floor` tests: versions parse as the bundle setting spells them; a Mac below the floor is refused with both versions named; one at or above it installs; a floor the manifest does not state never refuses.
2. `smoke-release-assets-manifest.mjs` and `smoke-release-metadata.mjs` each carry a floor arm: the value rides through by key, and a non-numeric floor fails both scripts naming the setting.
3. The macOS bundle's `Info.plist` reads `LSMinimumSystemVersion` 14.0 and the Mach-O's `LC_BUILD_VERSION` minos 14.0.
4. On macOS 14 or newer the app launches and takes the webview proxy; on macOS 13 LaunchServices refuses it; a desktop on macOS 13 offered a manifest whose floor is 14.0 refuses the update with both versions named.
5. `brew style` on the cask is green (the release's `homebrew-validate` job).

## Built

`d5ce4fbd1`, feat(desktop): raise the macOS floor to 14 and gate updates on it; `08b233b87`, docs(desktop): state the macOS minimum and update refusal (one of the owner's Codex agents, on `docs/v0124-doc-gaps`), and `2d8df9c89`'s correction of the `NSProcessInfo` comment, which said it decided whether a webview takes the WireGuard proxy; `update_floor.rs` is its only reader.

Verification recorded in the commit and the branch's notes: cargo fmt, clippy over all targets with warnings denied and the chan-desktop `update_floor` and `wireguard` tests on Linux; the same clippy for `x86_64-pc-windows-gnu` through cargo-zigbuild, since the Windows update sites changed; both marketing smokes with their floor arms. Desktop Package Dry Run 41922456707 at `d5ce4fbd1` was green on all three jobs in 33 minutes: the macOS bundle reads `LSMinimumSystemVersion` 14.0 and minos 14.0 (SDK 26.5), with Network.framework a strong `LC_LOAD_DYLIB` importing the two `nw_proxy_config_create` symbols, which the floor makes safe. That covers acceptance 1 to 3. Dry runs 41928160550 and 41943248647 on the integration branch built the macOS bundle again, green.

Open: acceptance 4 was not read before the GA commit, and acceptance 5 runs first at the tag's downstream publication. The guard protects from the next floor change on, not from this one. A v0.123.0 desktop checks no floor, and on macOS its on-launch check downloads and installs an update before it shows the update dialog (`spawn_launch_update_check` in v0.123.0's `main.rs`), so on macOS 11 to 13 its next launch after the v0.124.0 publication installs a release LaunchServices then refuses to open. `CHAN_UPDATE_CHECK=0` in the desktop's environment skips that check (the same literal `0` the CLI's banner reads), and updating macOS first avoids it; the CHANGELOG and the release report say so. How many such installs exist is unknown. The Homebrew cask declares no minimum (its comment reads Sonoma as at or below the oldest macOS Homebrew supports), so a cask install on an older macOS that Homebrew still runs on gets this release too.
