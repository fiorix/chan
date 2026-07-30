{
  lib,
  src,
  version,
  makeRustPlatform,
  rust-bin,
  fetchNpmDeps,
  nodejs_22,
  npmHooks,
  pkg-config,
  wrapGAppsHook4,
  desktop-file-utils,
  glib-networking,
  libappindicator-gtk3,
  openssl,
  webkitgtk_4_1,
  xdg-utils,
}:

let
  rustToolchain = rust-bin.fromRustupToolchainFile ../../rust-toolchain.toml;
  rustPlatform = makeRustPlatform {
    cargo = rustToolchain;
    rustc = rustToolchain;
  };
in
rustPlatform.buildRustPackage (finalAttrs: {
  pname = "chan-desktop";
  inherit version src;

  cargoHash = "sha256-cZWLFSPc1tU9J/KsM5Pr5LbgfxKYXZkwA8XfvHQ2Mas=";

  npmDeps = fetchNpmDeps {
    name = "${finalAttrs.pname}-${finalAttrs.version}-npm-deps";
    src = "${finalAttrs.src}/web";
    hash = "sha256-LOSXhJFss/4QuOnPwjpleYWY6+VKxfKIlyrdJCz0FUM=";
  };
  npmRoot = "web";

  nativeBuildInputs = [
    desktop-file-utils
    nodejs_22
    npmHooks.npmConfigHook
    pkg-config
    wrapGAppsHook4
  ];

  buildInputs = [
    glib-networking
    libappindicator-gtk3
    openssl
    webkitgtk_4_1
  ];

  env = {
    CHAN_PACKAGED = "nix";
    OPENSSL_NO_VENDOR = 1;
  };

  preBuild = ''
    (
      cd web
      npm run build --workspace @chan/launcher
      npm run build --workspace @chan/workspace-app
    )
    test -f web-launcher/dist/index.html
    test -f web/dist/index.html
  '';

  cargoBuildFlags = [
    "-p"
    "chan-desktop"
  ];
  # The ordinary Rust CI runs the whole workspace test suite. Repeating
  # release-profile LTO tests in each native Nix architecture nearly doubles
  # the package job; the output smoke in CI is the Nix-specific gate.
  doCheck = false;

  postInstall = ''
    ln -s chan-desktop "$out/bin/chan"
    ln -s chan-desktop "$out/bin/cs"

    install -Dm644 packaging/distros/shared/chan-desktop.desktop \
      "$out/share/applications/chan-desktop.desktop"
    install -Dm644 desktop/src-tauri/icons/32x32.png \
      "$out/share/icons/hicolor/32x32/apps/chan-desktop.png"
    install -Dm644 desktop/src-tauri/icons/64x64.png \
      "$out/share/icons/hicolor/64x64/apps/chan-desktop.png"
    install -Dm644 desktop/src-tauri/icons/128x128.png \
      "$out/share/icons/hicolor/128x128/apps/chan-desktop.png"
    install -Dm644 desktop/src-tauri/icons/128x128@2x.png \
      "$out/share/icons/hicolor/256x256/apps/chan-desktop.png"
    install -Dm644 desktop/src-tauri/icons/icon.png \
      "$out/share/icons/hicolor/512x512/apps/chan-desktop.png"
    install -Dm644 LICENSE "$out/share/licenses/chan-desktop/LICENSE"
    install -Dm644 README.md CHANGELOG.md \
      -t "$out/share/doc/chan-desktop/"

    desktop-file-validate \
      "$out/share/applications/chan-desktop.desktop"
    test ! -e "$out/lib/systemd/user/chan-devserver.service"
  '';

  preFixup = ''
    gappsWrapperArgs+=(
      --prefix PATH : ${lib.makeBinPath [ xdg-utils ]}
    )
  '';

  meta = {
    description = "Desktop edition of the Chan AI-native IDE";
    homepage = "https://chan.app";
    license = lib.licenses.asl20;
    mainProgram = "chan-desktop";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
  };
})
