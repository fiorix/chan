# chan-desktop notes

## Local serving and self-contained runtime

chan-desktop is fully self-contained. It links `chan-workspace` and `chan-server` directly, embeds both web bundles (`web/dist` and the launcher's `web-launcher/dist`) via rust-embed at build time, and links the `chan` CLI, `chan-shell` (`cs`), and `chan-revtunnel` as libraries, dispatching them in-process (`Personality::Desktop`). No separate `chan` binary ships inside the app bundle; a desktop install still provides `chan` and `cs` on the PATH through a shim into the app binary. The `frontendDist` in `tauri.conf.json` is `../src`, a small static shell (the about and connecting pages), not the SPA.

Local workspaces open through the embedded `WorkspaceHost` (owned by chan-library and re-exported as `chan_server::WorkspaceHost`), which owns a single `chan_workspace::Library`. Every registry mutation (add / remove) and feature toggle (semantic search, reports) runs in-process against that same `Library`, or against the live `Arc<Workspace>` the host already holds for a mounted workspace. Routing through one shared registry is what keeps a freshly-added workspace openable immediately: a subprocess `chan add` used to mutate only the on-disk registry, leaving the host's boot-time in-memory snapshot stale, which surfaced as a spurious "workspace not registered" error on first open.

Blocking chan-workspace calls (`register_workspace`, `unregister_workspace`, `open_workspace`, `boot`, the feature setters) run via `tokio::task::spawn_blocking` so a slow initial scan never blocks the async executor. `remove_workspace` runs `unregister_workspace` in a bounded retry loop: `serve::stop` drops the host's handle synchronously, but a background indexer or in-flight request may hold the workspace's flock for a moment, surfacing as `WorkspaceAlreadyOpen` / `WorkspaceLocked` until it releases.

External `chan open` processes are still supported as explicit remote attachments, but they are a separate transport, not a local serving dependency. When a standalone `chan open` already holds a workspace's lock, opening that workspace in chan-desktop maps the `WorkspaceLocked` / `WorkspaceAlreadyOpen` error to a friendly "open in another chan process" message and reverts the row's On toggle rather than surfacing a raw error.

### No bundled binary

There is no `chan-bin` Makefile step, no `bundle.macOS.files` entry, and no `bundle.externalBin`. `make dev` / `make build` depend only on the web bundles (the rust-embed inputs) and the tauri CLI; `app-signed` and `app-notarized` additionally check their signing and notarization prerequisites. Tauri's signing pass codesigns the `.app` directly, with no second binary to sign; the notarize recipe then signs, notarizes, and staples the `.dmg`, which is the artifact CI validates (`stapler validate` + `spctl`). The `.app` inside the updater payload is signed but unstapled. Multi-arch distribution is purely a matter of how the `.app` itself is built and merged. The desktop Makefile also carries `dmg-layout-proof` and the secret-free `ci-linux` / `ci-macos` / `ci-windows` package proofs.

## Debugging

Logs go to stderr only; no file is written. The env var is `CHAN_LOG` (NOT `RUST_LOG`, which is ignored), default filter `warn,chan_desktop=info`. Launching the `.app` from Finder discards stderr, so see logs by launching the bundle binary from a terminal: `CHAN_LOG=chan_desktop=debug,warn /Applications/Chan.app/Contents/MacOS/chan-desktop`.

WebView DevTools ships in release builds (the `devtools` Tauri feature). Cmd+Opt+I works in workspace windows via the key bridge but is NOT wired on the launcher window; inspect the launcher via right-click -> Inspect Element, or Safari -> Develop -> the machine's Chan webview. The launcher's loopback library API is curl-able with the values from that console: `location.origin` is the ephemeral port, the `?t=` query param is the bearer for `Authorization: Bearer`, and `GET /api/library/windows` dumps the exact records the window watcher reconciles (`origin`, `hidden`, `token`).

A `devserver window feed disconnected; reconnecting` WARN means that devserver's whole window surface is dark: the desktop learns about remote windows only through the `/watch` feed, so while it loops no remote window opens and the launcher list goes stale.

## Window geometry

Watcher-managed workspace (`local::*`) and devserver (`lib-*::*`) windows are destroyed when hidden and rebuilt when shown, so their OS size and position are desktop-owned state. `capture_window_geometry` records a window's rect on every bury, and `resolve_geometry_plan` + `apply_geometry_plan` reapply it when the window is rebuilt (`serve.rs`), keyed by the native label under a monitor signature (a small per-signature LRU in `config.rs`). The launcher restores the same way once at boot; standalone terminals keep their native window and let the OS hold the geometry.

Geometry is captured, clamped, and applied in logical points (the global AppKit window coordinate space), not physical pixels, because two macOS behaviors make points the only unit that round-trips across mixed-DPI monitors. A `Restore` builds the window hidden, and a hidden NSWindow has no screen, so tao's `scale_factor()` reports the main display's scale: a `PhysicalSize` apply is converted through that scale, so a window bound for a different-scale monitor renders at `target_scale / main_scale` of its size, while a `LogicalSize` passes through `dpi` untouched and renders correctly on whatever monitor the window opens on. Separately, tao reports each monitor's bounds as points times that monitor's own scale, so monitors of different scales overlap in physical space and `monitor_for_rect` cannot tell which one a window sits on; `config::to_points` divides every monitor's bounds by its scale so the monitors tile without overlap and the containing monitor resolves unambiguously.

`monitor_signature` stays in physical units because it only fingerprints the hardware layout. Capture reads the window's live `scale_factor()` (the window is still shown at bury time) to convert its physical rect to points, and the `WINGEO` tracing lines (`capture`, `resolve`, `applied`) carry the points rect, signature, scale, and monitors for diagnosing placement on real multi-monitor hardware.

## Apple Developer ID signing

The chan-desktop `.app` (and the bundled `.dmg`) are codesigned with an Apple Developer ID Application certificate so Gatekeeper accepts the install on default-configured macOS. The signing identity is named in `src-tauri/tauri.conf.json` under `bundle.macOS.signingIdentity`:

```json
"bundle": {
  "macOS": {
    "signingIdentity": "Developer ID Application: <Name> (<TEAMID>)"
  }
}
```

The identity NAME is a public identifier (the same string that `security find-identity -v -p codesigning` prints), safe to land in the repo. The matching private key + cert blob stay outside the repo entirely: in the developer's macOS Keychain for local builds; in `secrets.APPLE_CERTIFICATE_BASE64` + `secrets.APPLE_CERTIFICATE_PASSWORD` for CI (imported into a temp keychain by `apple-actions/import-codesign-certs@v7` in `release.yml`'s desktop job, and likewise in the manual `release-desktop.yml` dry run). See the [release signing notes](skills/release/SKILL.md); the full per-secret table is kept in the team's private, gitignored dev/ tree.

`bundle.macOS.providerShortName` is omitted because chan-desktop's Apple Developer account is Individual enrollment with a single ASC team. Populate the field only if the account is associated with multiple teams.

### Local-build vs CI-build behaviour

* **Local build with the cert in your Keychain**: `make app-signed` and `make app-notarized` codesign the .app with the named identity. Works out of the box.
* **Local build WITHOUT the cert**: `make app-signed` / `make app-notarized` fail at the codesign step with `identity '...' not in keychain` (the `sign-prereqs` check in `desktop/Makefile`). That is expected; it just means you cannot produce a signed bundle on a workstation that does not hold the signing key. `make build` (the unsigned path) still works for general development.
* **CI build**: `release.yml` (job `macos-desktop-artifacts`, the tag-triggered release path) imports the cert into a temp keychain via secrets, then runs `make macos-chan-dmg-notarised` (the root-Makefile alias for the desktop `app-notarized` recipe) with the env vars populated. `release-desktop.yml` is the manual `workflow_dispatch` dry run of the same lane. Same identity, just supplied differently.

### Rotation (if the Developer ID identity ever changes)

Developer ID Application certs expire every 5 years; rotation also applies if the cert is revoked or replaced. Steps:

1. Generate the new cert per the macOS signing procedure (see the [release signing notes](skills/release/SKILL.md); the detailed Developer ID certificate-generation steps are kept in the team's private dev/ tree).
2. Update `bundle.macOS.signingIdentity` in `tauri.conf.json` to the new identity string. Single-field swap.
3. Refresh `APPLE_CERTIFICATE_BASE64` + `APPLE_CERTIFICATE_PASSWORD`
   + `APPLE_SIGNING_IDENTITY` + `APPLE_TEAM_ID` in GitHub Actions Secrets via the `populate-apple-secrets.sh` helper kept in the team's private dev/ tree (re-run the relevant steps).
4. Refresh the local Keychain: import the new `.p12`; remove the old cert (`security delete-certificate -c "Developer ID Application: <Old Name> ..."`) so the `sign-prereqs` `grep -c "Developer ID Application:"` detection picks the new one unambiguously.

No bridge release is needed for Developer ID cert rotation (unlike the minisign updater key rotation below). Gatekeeper trusts any Developer ID Application cert chained to Apple's root, regardless of which one signed the previous release, so the next signed bundle under the new identity is accepted by clients that had the old one.

## Auto-upgrade signing (tauri-plugin-updater)

The desktop app verifies update bundles with a minisign signature. The production pubkey is embedded in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`. Matching private key material lives outside the repo in the release owner's secret store.

Runbook: [`desktop/updater-bridge.md`](../desktop/updater-bridge.md).

### Bridge release required after key rotation

When the updater pubkey rotates, existing installs still trust only the OLD pubkey and need a bridge release:

1. Ship one bridge release that embeds the NEW pubkey but signs the update bundle with the OLD private key, so existing installs accept it.
2. Sign every release after the bridge with the NEW private key.
3. If the OLD private key is unavailable, existing installs cannot auto-update across the rotation. Users need a manual DMG install for the first new-key release.
4. Old installs that never picked up the bridge release will fail to verify new-key-signed bundles and stall on their last good version until the user manually reinstalls. Plan the bridge window for how long you're willing to support that tail. A Homebrew cask install recovers with `brew reinstall --cask fiorix/chan/chan-desktop`: the cask is `auto_updates` so brew never refreshes it on its own, but every GA rewrites it to the current DMG.
5. The signing identity used at build time is selected via `TAURI_SIGNING_PRIVATE_KEY` (key contents) or `TAURI_SIGNING_PRIVATE_KEY_PATH` (file path), with optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. CI should pull these from a secrets store, never from the repo.

### Manifest endpoint

Client probes a single static manifest: `https://chan.app/dl/desktop/latest.json`

That manifest is generated at release time by `web/packages/marketing/scripts/generate-release-metadata.mjs` (driven by `.github/workflows/release.yml`) and deployed to GitHub Pages alongside the rest of chan.app; there is no separate dynamic server for `/dl`. It is a Tauri static updater manifest: a top-level `version` plus a `platforms` map keyed by `{os}-{arch}` (e.g. `darwin-aarch64`), each carrying the minisign `signature` and the release-asset `url`. Tauri selects the entry for the running target and compares `version`. The endpoint is a flat static path; do not reintroduce a `{{target}}/{{current_version}}` templated URL, which the generator does not serve.

## Release package version metadata

Tauri bundle artifact names are derived from `src-tauri/tauri.conf.json`:

* `productName` supplies the `Chan` prefix.
* `version` supplies the semantic version in bundle names: the local DMG builds as `Chan_${VERSION}_${ARCH}.dmg`, and `release.yml` normalizes the published assets to `Chan_${VERSION}.dmg` plus `Chan_${VERSION}_aarch64.app.tar.gz`.

The `tauri.conf.json` `version` is a manual pin in the release version-pin bump; `release.yml` asserts at tag time that the tag, the workspace Cargo version, this field, and the gateway version all match. The Rust package version for `chan-desktop` is inherited from the workspace, so the `.app` version and the workspace stay aligned once this field matches.

## Local notarization setup

`make app-notarized` (in `desktop/Makefile`) accepts notarization credentials from two sources, in this precedence order:

1. **Environment variables** (`APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`). What CI uses; populated from GitHub Actions Secrets in `.github/workflows/release.yml` (and the manual `release-desktop.yml` dry run). Wins when present, so a one-off `APPLE_ID=... APPLE_PASSWORD=... APPLE_TEAM_ID=... make app-notarized` shadows whatever Keychain profile is configured locally.
2. **`notarytool` Keychain profile** (Apple's blessed mechanism for local dev). One-time setup on the workstation:

   ```
   xcrun notarytool store-credentials chan \
       --apple-id <your-apple-id-email> \
       --team-id <10-char-team-id> \
       --password <app-specific-password>
   ```

   Stashes the Apple ID + Team ID + app-specific password in the default macOS Keychain under a profile named `chan`. After this, plain `make app-notarized` runs from a bare shell with no env exports; the Makefile detects the profile and passes `--keychain-profile chan` to `xcrun notarytool submit`. Override the profile name via `NOTARIZE_PROFILE=othername make app-notarized` if you store it under a different label.

The app-specific password (option 2 above) is generated at <https://account.apple.com/> -> Sign-In and Security -> App-Specific Passwords -> Generate. It is NOT the iCloud account password; the iCloud password will not work for `notarytool` because of two-factor auth.

### Verifying the Keychain profile is in place

```
security find-generic-password -s "com.apple.gke.notary.tool" -a chan
```

Returns the keychain item attributes if the profile exists, exits non-zero otherwise. The actual password value never leaves the Keychain (no `-g`/`-w` flag).

`xcrun notarytool history --keychain-profile chan` is the network-dependent variant: lists Apple-side notary submissions and fails on a bad / non-existent profile. Useful as an end-to-end "is this profile actually valid against Apple" check.

### Why the Makefile splits build from notarize

`cargo tauri build --bundles app` signs the `.app` (via `codesign`, driven by `APPLE_SIGNING_IDENTITY`); the `.dmg` is packaged separately by `packaging/desktop/build-dmg.sh` (`dmgbuild`), because tauri-bundler's DMG step drives Finder over AppleScript and no-ops on headless CI. Tauri's bundler can ALSO notarize as part of the build command, but only when `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID` are present in the env. `tauri-bundler` 2.x does not consume `notarytool` Keychain profiles directly. To support the local Keychain-profile path AND the CI env-var path under one recipe, the Makefile unsets the three notarize env vars during the `cargo tauri build` call (so tauri-bundler skips its own notarize step) and then runs `xcrun notarytool submit` + `xcrun stapler staple` itself with the appropriate flag set.

CI behaviour is identical to the prior path: the credentials reach notarytool the same way, just via a manual invocation instead of tauri-bundler's internal one.

### CI does not need the Keychain profile

The release workflows read `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID` straight from `secrets.APPLE_*` (per the macOS signing procedure; see the release signing notes in `skills/release/SKILL.md`). The env-var path runs unchanged on the runner; no `xcrun notarytool store-credentials` step is needed in CI.
