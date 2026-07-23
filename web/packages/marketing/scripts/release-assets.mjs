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

// The standalone musl/darwin self-upgrade tarballs. Distro-built CLI packages
// ship through COPR/PPA/AUR, not as GitHub Release assets.
export function cliAssets() {
  return [
    "chan-x86_64-unknown-linux-musl.tar.gz",
    "chan-aarch64-unknown-linux-musl.tar.gz",
    "chan-aarch64-apple-darwin.tar.gz",
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

// The signed macOS updater payload and its detached signature.
export function updaterAssets(version) {
  return [
    `Chan_${version}_aarch64.app.tar.gz`,
    `Chan_${version}_aarch64.app.tar.gz.sig`,
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
