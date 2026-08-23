// Single source of truth for the names of the assets a GitHub Release carries,
// so the verifier, the collector, and their fixture smoke stop keeping three
// parallel hand-maintained copies (the drift this module removes is exactly
// what let the Windows artifacts go unverified). It does not tie the list to
// release.yml -- the workflow produces those names in shell/PowerShell and by
// cargo-deb/tauri convention, with no machine-readable manifest to read -- but
// it removes the copy-drift that actually bites. The gateway .deb names are
// derived from the Makefile's GATEWAY_RELEASE_CRATES via gateway-services.mjs,
// the same source release.yml builds from, so adding a gateway service can't
// drift these lists.

import { gatewayServices } from "./gateway-services.mjs";
import { gatewayPackageVersion } from "./release-version.mjs";

// FreeBSD first ships in v0.96.0. The verifier requires it for the release
// being cut, while the collector and metadata generator may omit it from
// retained older releases that predate the target.
export function archiveOptionalCliAssets() {
  return [
    "chan-x86_64-unknown-freebsd.tar.gz",
    "chan-aarch64-unknown-freebsd.tar.gz",
  ];
}

// The standalone musl/darwin/FreeBSD self-upgrade tarballs. Distro-built CLI
// packages ship through COPR/PPA/AUR, not as GitHub Release assets.
export function cliAssets() {
  return [
    "chan-x86_64-unknown-linux-musl.tar.gz",
    "chan-aarch64-unknown-linux-musl.tar.gz",
    "chan-aarch64-apple-darwin.tar.gz",
    ...archiveOptionalCliAssets(),
  ];
}

// chan-desktop bundles: the macOS dmg and the tauri-built AppImages. Tauri
// also emits a .deb and .rpm, but those ship through COPR/PPA/AUR, not as
// GitHub Release assets.
export function desktopAssets(version) {
  return [
    `Chan_${version}.dmg`,
    `Chan_${version}_amd64.AppImage`,
    `Chan_${version}_aarch64.AppImage`,
  ];
}

// One chan-gateway .deb per service per arch. The gateway package version can
// differ from the release version (cargo-deb's spelling of a prerelease), so
// this takes the release version and applies the same transform the build does.
export function gatewayDebAssets(version) {
  const gatewayVersion = gatewayPackageVersion(version);
  return gatewayServices.flatMap((service) =>
    ["amd64", "arm64"].map(
      (arch) => `chan-gateway-${service}_${gatewayVersion}-1_${arch}.deb`,
    ),
  );
}

// The Windows CLI zip and desktop NSIS installer. Every release run builds both
// (release.yml gates publish-release on the windows-artifacts job), so the
// verifier requires them; the collector keeps them optional for the archived
// releases it walks, a deliberate exception commented at its call site.
export function windowsAssets(version) {
  return [`Chan_${version}_x64-setup.exe`, "chan-x86_64-pc-windows-msvc.zip"];
}

// The signed desktop updater payloads by Tauri target key, single-sourced for
// the collector and the updater asset list. The macOS payload is a dedicated
// asset (the DMG is the public download); each AppImage is the public download
// itself, since tauri-plugin-updater rewrites the running `$APPIMAGE` in
// place; the Windows payload is the NSIS installer itself, which the plugin
// runs passively over the install. `required` is the collector's contract for
// the retained older releases: every one carries the macOS payload, but the
// AppImage and installer signatures arrived later, so an archived release may
// lack them. The release being cut is held to every signature by the verifier
// (requiredAssets).
export function updaterPayloads(version) {
  return [
    { platform: "darwin-aarch64", asset: `Chan_${version}_aarch64.app.tar.gz`, required: true },
    { platform: "linux-x86_64", asset: `Chan_${version}_amd64.AppImage`, required: false },
    { platform: "linux-aarch64", asset: `Chan_${version}_aarch64.AppImage`, required: false },
    { platform: "windows-x86_64", asset: `Chan_${version}_x64-setup.exe`, required: false },
  ];
}

// The updater assets a GA release carries beyond the public downloads: the
// macOS payload plus every payload's detached signature. The AppImage and
// installer payloads themselves are already listed in desktopAssets and
// windowsAssets.
export function updaterAssets(version) {
  return [
    `Chan_${version}_aarch64.app.tar.gz`,
    `Chan_${version}_aarch64.app.tar.gz.sig`,
    `Chan_${version}_amd64.AppImage.sig`,
    `Chan_${version}_aarch64.AppImage.sig`,
    `Chan_${version}_x64-setup.exe.sig`,
  ];
}

// Every non-updater asset a GA release must carry. Windows is required here.
export function publicAssets(version) {
  return [
    ...cliAssets(),
    ...desktopAssets(version),
    ...gatewayDebAssets(version),
    ...windowsAssets(version),
  ];
}

// Every asset a GA release must carry: the public downloads plus the updater
// payload and its signature.
export function requiredAssets(version) {
  return [...publicAssets(version), ...updaterAssets(version)];
}
