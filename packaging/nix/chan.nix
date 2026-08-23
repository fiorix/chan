{
  lib,
  src,
  version,
  # Injected build identity. `crates/chan/build.rs` falls back to git, which
  # sees nothing here: the flake source in the store has no `.git`. `flake.nix`
  # computes it and this is the only way it reaches the compiler.
  buildId,
  makeRustPlatform,
  rust-bin,
  fetchNpmDeps,
  nodejs_22,
  npmHooks,
  pkg-config,
  openssl,
}:

let
  rustToolchain = rust-bin.fromRustupToolchainFile ../../rust-toolchain.toml;
  rustPlatform = makeRustPlatform {
    cargo = rustToolchain;
    rustc = rustToolchain;
  };
in
rustPlatform.buildRustPackage (finalAttrs: {
  pname = "chan";
  inherit version src;

  cargoHash = "sha256-DPHkOVmwaZLQj5uyVxde3k6j1PGTToOVtBSt/nXNeyg=";

  npmDeps = fetchNpmDeps {
    name = "${finalAttrs.pname}-${finalAttrs.version}-npm-deps";
    src = "${finalAttrs.src}/web";
    hash = "sha256-RLn7cS+vkdLNUBIY1QqdXAJv41xCdrb6+ZmO4kRpBSo=";
  };
  npmRoot = "web";

  nativeBuildInputs = [
    nodejs_22
    npmHooks.npmConfigHook
    pkg-config
  ];

  buildInputs = [ openssl ];

  env = {
    CHAN_PACKAGED = "nix";
    CHAN_BUILD_ID = buildId;
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
    "chan"
  ];
  # The ordinary Rust CI runs the whole workspace test suite. Repeating
  # release-profile LTO tests in each native Nix architecture nearly doubles
  # the package job; the output smoke in CI is the Nix-specific gate.
  doCheck = false;

  postInstall = ''
    ln -s chan "$out/bin/cs"
    install -Dm644 LICENSE "$out/share/licenses/chan/LICENSE"
    install -Dm644 README.md CHANGELOG.md \
      -t "$out/share/doc/chan/"
    test ! -e "$out/lib/systemd/user/chan-devserver.service"
  '';

  meta = {
    description = "Headless terminal multiplexer and workspace manager";
    homepage = "https://chan.app";
    license = lib.licenses.asl20;
    mainProgram = "chan";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
  };
})
