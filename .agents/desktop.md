# chan-desktop contributor guide

chan-desktop is the desktop edition of chan, a supercharged terminal emulator: a Tauri shell that puts chan's windows on the desktop, embeds the server for local work, reaches devservers over a TCP tunnel or through a self-hosted gateway, and is the `chan` and `cs` command line at the same time. What the shell is and why it is shaped that way is [`desktop/design.md`](../desktop/design.md). This guide is what a contributor does with it: build it, run it in dev mode, debug it, sign, notarize and package it, and keep its release artifacts consistent.

## Layout and build inputs

- The crate is `desktop/src-tauri`, a member of the root Cargo workspace. `desktop/Makefile` owns every build recipe; the root Makefile's desktop targets (`chan-desktop`, `desktop-dev`, `macos-chan-app`, `macos-chan-dmg`, `macos-chan-dmg-notarised`, `windows-chan-installer`, `linux-chan-desktop`) delegate to it.
- The binary links `chan-server` (and through it `chan-library` and `chan-workspace`), the `chan` CLI crate, `chan-shell` and `chan-revtunnel` as libraries, and embeds `web/dist` and `web-launcher/dist` through rust-embed at compile time. Both web bundles must exist before any cargo build of the crate, or the launcher bakes in empty; the Makefile's `web` prerequisite runs the root `make web`.
- `frontendDist` in `src-tauri/tauri.conf.json` is `../src`, the small static shell of the About and connecting pages, not the SPA. The bundle declares no `externalBin` and no extra macOS files, so on macOS and Linux no second binary ships. The Windows configs (`tauri.windows.conf.json`, `tauri.ci.windows.conf.json`) add `target/release/chan.exe` as a resource, so `cargo build --release -p chan` runs first there.
- `tauri-cli` and the dmgbuild venv install under `.build-tools/`, never `target/`: CI caches `target/`, and a cached copy would outrank the pinned tool a job just installed. Keep build tooling out of cached paths, and validate a tool by running it, not by testing for its file.

## Dev loop

```bash
make -C desktop dev         # cargo tauri dev (or: make desktop-dev at the root)
make -C desktop build       # cargo tauri build, every bundle for the host
make -C desktop check       # cargo check
make -C desktop lint        # clippy, all targets, warnings denied
make -C desktop test        # cargo test --all-targets
make -C desktop xwin-check  # compile-check the core crates for the MSVC target with cargo-xwin
```

`xwin-check` needs the LLVM toolchain (`llvm-lib`, `clang-cl`) on PATH. It proves the `cfg(windows)` arms of chan-server, chan-shell and chan-workspace compile; the desktop's own Windows build is proven by `make ci-windows` on a native Windows host.

On Linux, `make build` splits a dashed candidate version: Tauri requires semver, so the deb and AppImage build with the dashed version and the RPM is bundled separately with the undashed `version` and `0~<suffix>` as `Release`, which sorts before the GA release `1`. The Fedora specs instead put `~<suffix>` in `Version`. `make linux-chan-desktop` builds the Linux bundles inside an sdme container (`packaging/sdme/build-chan-desktop.sh`), which is how a macOS workstation produces them.

### Package proofs without secrets

`make ci-linux`, `make ci-macos` and `make ci-windows` in `desktop/Makefile` build the native package on each host with no signing (`tauri.ci.macos.conf.json` signs ad hoc with `-`, `tauri.ci.windows.conf.json` sets `signCommand` to null) and smoke the result with `scripts/smoke-built-devserver.sh`. Each refuses to run off its native host. The root `make pre-push` and `ci.yml` run them. `make dmg-layout-proof` builds an unsigned `.app` and the Finder-less DMG so the layout can be inspected before a release.

## Debugging

- Logs go to stderr only; nothing is written to a file. The filter variable is `CHAN_LOG` (`RUST_LOG` is ignored), default `warn,chan_desktop=info`. A Finder launch discards stderr, so run the bundle binary from a terminal: `CHAN_LOG=chan_desktop=debug,warn /Applications/Chan.app/Contents/MacOS/chan-desktop`.
- WebView DevTools ships in release builds (the `devtools` feature of the `tauri` dependency). Cmd+Opt+I on macOS, Ctrl+Alt+I elsewhere, opens it in workspace windows through the key bridge. The launcher is a wry webview placed outside Tauri (`launcher_panel.rs` builds it with DevTools enabled), so inspect it with right-click, Inspect Element, or from Safari's Develop menu.
- The launcher's loopback library API can be called with curl using values from that console: `location.origin` is the ephemeral port, the `?t=` query parameter is the bearer for `Authorization: Bearer`, and `GET /api/library/windows` returns the records the window watcher reconciles (`origin`, `hidden`, `token`).
- `devserver window feed disconnected; reconnecting` at WARN means that devserver's windows are dark: remote windows are learned only through the watch feed, so none opens and the launcher list goes stale until it reconnects.
- Four other WARNs name one row or one frame of a live feed, usually a devserver on another release serving a shape this desktop cannot read. Each carries `devserver=<id>`; the row lines add `source=list` or `source=watch frame`, `row=window_id <id>` (or `row=index <n>` when the id itself is unreadable) and the serde error. `unreadable devserver window row is hidden from the desktop`: no window opens for it. `devserver window row turned unreadable; its window keeps the stale record last read`: the window stays on the last readable record until the row reads again or the feed reconnects. `unreadable devserver window frame is skipped; the view keeps its last snapshot`: the next frame repairs the view. `devserver window list failed; seeding no windows until the watch feed's first snapshot`: the connect-time list call failed outright. The row lines fire once per row per feed connection, so a reconnect repeats them.
- Window placement: hidden-and-rebuilt windows (`local::*` and `lib-*::*`) have their geometry captured on every hide and reapplied on rebuild (`serve.rs`: `capture_window_geometry`, `resolve_geometry_plan`, `apply_geometry_plan`; the per-monitor-signature LRU and `to_points` in `config.rs`). All three log a `WINGEO` line (`capture`, `resolve`, `applied`) with the points rect, monitor signature, scale and monitors; read those on real multi-monitor hardware before changing the geometry code. Why geometry is in points rather than pixels is in the design document.
- A build id tells builds apart where the version string cannot, since version pins move only at the release cut. `build.rs` stamps `CHAN_DESKTOP_BUILD_ID` as `git-<12 hex>`, with `-dirty` when the tree had uncommitted changes and `unknown` outside a git checkout. The About window shows it, the `chan-desktop starting` log line carries it, and the `native_vocabulary` command returns it to a served page.

### Acceptance on the gateway surface

A gateway-served window couples two builds: the page comes from the remote devserver over the tunnel, while the ACL gating its invokes belongs to the chan-desktop installed on this machine, and launching from the Dock or `/Applications` runs the installed bundle regardless of what was just built. An acceptance run on that surface therefore builds both ends from the same commit, launches the fresh bundle by path, and confirms the running build by its build id. A single-command ACL refusal (`Command <name> not allowed by ACL`) on this surface is what version skew looks like: an older bundle refuses exactly the commands added since it was built and serves everything else. Check the build id before treating it as a capability defect.

## Apple Developer ID signing

The `.app` and the `.dmg` are codesigned with an Apple Developer ID Application certificate so Gatekeeper accepts the install on a default macOS. The identity name lives in `src-tauri/tauri.conf.json` under `bundle.macOS.signingIdentity`:

```json
"bundle": {
  "macOS": {
    "signingIdentity": "Developer ID Application: <Name> (<TEAMID>)"
  }
}
```

The identity name is public (it is what `security find-identity -v -p codesigning` prints) and safe in the repo. The private key and certificate stay outside it: in the developer's Keychain for local builds, and in GitHub Actions Secrets for CI, where `apple-actions/import-codesign-certs@v7` imports `APPLE_CERTIFICATE_BASE64` and `APPLE_CERTIFICATE_PASSWORD` into a temporary keychain. The secret names the workflows require are declared in `.github/workflows/release.yml`; the per-secret table is kept in the team's private, gitignored dev/ tree. The release cycle itself is the [release skill](skills/release/SKILL.md).

`bundle.macOS.providerShortName` is omitted because the Apple Developer account is an Individual enrollment with a single team; set it only for an account that belongs to several teams.

The Makefile auto-detects `APPLE_SIGNING_IDENTITY` when the keychain holds exactly one `Developer ID Application:` certificate and derives `APPLE_TEAM_ID` from the trailing `(TEAMID)`; pin both explicitly when there is more than one certificate or the name does not follow that convention. An empty identity is never exported, because Tauri treats a present-but-empty `APPLE_SIGNING_IDENTITY` as an explicit identity and fails instead of taking its unsigned path.

- Local build with the certificate in the Keychain: `make app-signed` and `make app-notarized` sign the `.app` with the named identity.
- Local build without it: both fail at `sign-prereqs` with `identity '...' not in keychain`. That is expected; `make build` still works for everyday development.
- CI: `release.yml` (job `macos-desktop-artifacts`, the tag-triggered path) imports the certificate and runs `make macos-chan-dmg-notarised`, the root alias of `app-notarized`, with the env vars populated. `release-desktop.yml` is the manual `workflow_dispatch` dry run of the same lane.

### Rotating the Developer ID certificate

Developer ID Application certificates expire after five years; the same steps apply to a revoked or replaced one.

1. Generate the new certificate (the generation steps are in the private dev/ tree).
2. Update `bundle.macOS.signingIdentity` in `tauri.conf.json`: a single-field swap.
3. Refresh `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` and `APPLE_TEAM_ID` in GitHub Actions Secrets.
4. Import the new `.p12` into the local Keychain and delete the old certificate (`security delete-certificate -c "Developer ID Application: <Old Name> ..."`), so the Makefile's single-certificate detection resolves unambiguously.

No bridge release is needed: Gatekeeper trusts any Developer ID Application certificate chained to Apple's root, whichever one signed the previous release. The updater key below is different.

## Local notarization setup

`make app-notarized` reads notarization credentials from two sources, in this order:

1. The environment variables `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID`, which is what CI uses from GitHub Actions Secrets. They win when present, so a one-off `APPLE_ID=... APPLE_PASSWORD=... APPLE_TEAM_ID=... make app-notarized` shadows the Keychain profile.
2. A `notarytool` Keychain profile, Apple's mechanism for local development. One-time setup on the workstation:

   ```
   xcrun notarytool store-credentials chan \
       --apple-id <your-apple-id-email> \
       --team-id <10-char-team-id> \
       --password <app-specific-password>
   ```

   After this a plain `make app-notarized` runs from a bare shell: the Makefile detects the profile and passes `--keychain-profile chan` to `xcrun notarytool submit`. `NOTARIZE_PROFILE=othername make app-notarized` selects a profile stored under another label.

The app-specific password comes from <https://account.apple.com/>, Sign-In and Security, App-Specific Passwords. It is not the iCloud password, which `notarytool` refuses because of two-factor auth.

`security find-generic-password -s "com.apple.gke.notary.tool" -a chan` confirms the profile exists; it exits non-zero otherwise and never prints the password, since there is no `-g` or `-w`. `xcrun notarytool history --keychain-profile chan` is the network check: it lists the account's submissions and fails on a bad profile.

### Why build and notarize are separate steps

`cargo tauri build --bundles app` signs the `.app` through `codesign`, driven by `APPLE_SIGNING_IDENTITY`. The `.dmg` is then built by `packaging/desktop/build-dmg.sh` with `dmgbuild`, because tauri-bundler's DMG step lays the Finder window out over AppleScript, which no-ops on a headless runner and ships a flat default layout; dmgbuild writes the layout programmatically from `packaging/desktop/dmg_settings.py`, so local and CI match. tauri-bundler can notarize during the build, but only from `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`; it does not read Keychain profiles. To serve the local profile path and the CI env-var path with one recipe, the Makefile unsets the three variables for the `cargo tauri build` call, then signs the DMG, runs `xcrun notarytool submit --wait` with whichever credential source it found, and staples the ticket to the DMG. The DMG is the artifact CI validates (`stapler validate`, `spctl -a -t install`); the `.app` inside the updater payload is signed but not stapled. CI needs no Keychain profile.

## Windows Authenticode signing

The Windows CLI, the desktop binary, the NSIS plugins and the installer are signed remotely through SSL.com eSigner by `src-tauri/scripts/windows/sign.ps1`, which `release.yml` (job `windows-artifacts`) and the `release-desktop.yml` dry run call directly and through the `signCommand` in `tauri.windows.conf.json`. The script needs `ES_USERNAME`, `ES_PASSWORD`, `CREDENTIAL_ID` and `ES_TOTP_SECRET`, plus `CODESIGNTOOL` and `CODE_SIGN_TOOL_PATH` from the install step; with none of the signing variables set it leaves the input unsigned and exits 0, so a local `make windows-installer` builds an unsigned installer.

Rules the script and the workflows enforce, each with its reason:

- CodeSignTool is pinned to a GitHub release and runs the JDK bundled in its archive, whose truststore predates `SSL.com TLS RSA Root CA 2022`, the root the signing endpoint chains to. The `Install SSL.com CodeSignTool` step checks the committed [`ssl-com-tls-rsa-root-ca-2022.pem`](../desktop/src-tauri/scripts/windows/ssl-com-tls-rsa-root-ca-2022.pem) against its pinned SHA-256 fingerprint and imports it with that JDK's own `keytool`.
- CodeSignTool exits 0 even when a sign fails, so its exit code is not a signal: `sign.ps1` reads every `.exe`, `.dll` and `.msi` back with `Get-AuthenticodeSignature` and throws unless the status is `Valid`.
- The NSIS uninstaller stub reaches the bundler's sign hook under an `nst*.tmp` name, which CodeSignTool refuses by extension; `sign.ps1` signs a sibling `.exe` copy and writes the signed bytes back before the stub is embedded.
- The `Probe SSL.com eSigner credentials` step runs CodeSignTool's `get_credential_ids` before the release build and fails unless the listing names `CREDENTIAL_ID`, without printing the tool's output, so a TLS trust, username, password or credential id problem fails before the build rather than after it. The probe takes no TOTP secret, so a bad `ES_TOTP_SECRET` still fails at the first signed file.
- The `Verify Windows Authenticode signatures` step checks `chan.exe`, `chan-desktop.exe` and the installer with `Get-AuthenticodeSignature` and `signtool verify /pa`, installs the installer silently, verifies the installed `uninstall.exe` the same way, and uninstalls with `_?=<install dir>` so the step waits for the uninstall to finish. A headless `chan serve` boot of `chan-desktop.exe` then smokes `/api/health`.

## Updater signing (tauri-plugin-updater)

The desktop verifies update payloads with a minisign signature against `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. The private key stays in the release owner's secret store and in CI secrets. Three payloads are signed at release time, each with a detached `.sig` asset: the macOS `Chan_<v>_aarch64.app.tar.gz` (`macos-desktop-artifacts`), each Linux `Chan_<v>_{amd64,aarch64}.AppImage` itself (`linux-desktop-artifacts`), and the Windows `Chan_<v>_x64-setup.exe` installer itself (`windows-artifacts`, minisigned after Authenticode so the signature covers the shipped bytes). All three jobs fail fast when `TAURI_SIGNING_PRIVATE_KEY` is absent. The key is selected by `TAURI_SIGNING_PRIVATE_KEY` (contents) or `TAURI_SIGNING_PRIVATE_KEY_PATH` (a file), with an optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; CI reads them from secrets, never from the repo.

Key inspection, signing a payload by hand, and the bridge release a rotation needs are in [`desktop/updater-bridge.md`](../desktop/updater-bridge.md). In short: an install trusts only the public key it was built with, so a rotation ships one release that embeds the new key but is signed with the old one, and every later release is signed with the new key.

### The manifest

The client probes one static manifest, `https://chan.app/dl/desktop/latest.json`, generated at release time by `web/packages/marketing/scripts/generate-release-metadata.mjs` and deployed to GitHub Pages with the rest of chan.app; there is no dynamic `/dl` server. It is a Tauri static manifest: a top-level `version` and a `platforms` map keyed `{os}-{arch}` (`darwin-aarch64`, `linux-x86_64`, `linux-aarch64`, `windows-x86_64`), each carrying the `signature` and the release-asset `url`. The platform-to-asset map is single-sourced in `web/packages/marketing/scripts/release-assets.mjs` (`updaterPayloads`); add a platform there, not in the generator. An optional top-level `minimum_system_version` maps an updater target (`darwin`) to that build's macOS floor, which `collect-release-assets.mjs` reads from `desktop/src-tauri/tauri.conf.json` at the release tag; the desktop refuses an update whose floor the running macOS is below (`src/update_floor.rs`), since the updater would otherwise install an app LaunchServices refuses to open.

## Release artifact names and versions

Bundle names derive from `src-tauri/tauri.conf.json`: `productName` gives the `Chan` prefix and `version` the semantic version. The local DMG builds as `Chan_<version>_<arch>.dmg`; `release.yml` renames it to `Chan_<version>.dmg`, the name the Homebrew cask template and the site's asset list expect, and publishes `Chan_<version>_aarch64.app.tar.gz` beside it. A dashed candidate version ships the AppImage as the desktop payload; its deb and RPM are uploaded as diagnostic workflow artifacts on a prerelease only.

`version` is a manual pin in the release version-pin bump; `release.yml`'s `context` job asserts that the tag, the workspace Cargo version, this field and the gateway version all match. The crate's Rust version is inherited from the workspace, so once this field matches, the `.app` and the workspace agree.
