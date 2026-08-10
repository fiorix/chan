{
  description = "Chan";

  # The public release cache. Consumers who accept this flake configuration
  # substitute published closures from chan.cachix.org; the signing key is
  # public by design.
  nixConfig = {
    extra-substituters = [ "https://chan.cachix.org" ];
    extra-trusted-public-keys = [ "chan.cachix.org-1:HyczzIqJQpKs85VnILY/Kt0dKjlL6CfK69mbAgZPlCk=" ];
  };

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      rust-overlay,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      manifest = builtins.fromTOML (builtins.readFile "${self}/Cargo.toml");

      # The build id `chan --version`, the health surfaces, and the desktop
      # app report.
      #
      # `crates/chan/build.rs` and `desktop/src-tauri/build.rs` derive this
      # from git for an ordinary checkout build, but `src = self` puts the
      # flake source in the Nix store with no `.git`, so a git-derived id ALONE
      # would stamp `unknown` in exactly the release path that has to carry
      # one. The flake hands it down instead, through the derivation
      # environment.
      #
      # Both derivations take it. `chan-desktop` needs it TWICE, because that
      # package ships two identities out of one build: the desktop binary's own
      # `CHAN_DESKTOP_BUILD_ID`, and the `CHAN_BUILD_ID` of the `chan` CLI
      # linked into the same multi-call binary and symlinked at `bin/chan`.
      # Threading it to only one of the two leaves the other stamping
      # `unknown`, which is the shape this replaced.
      #
      # Guarded rather than a bare `self.shortRev`, because a revisionless
      # flake ref has no `rev` attribute AT ALL: reading it fails EVALUATION
      # rather than falling back. That is not hypothetical -- it is the case
      # `make nix-sdme-check` runs, which builds from a `git ls-files` tarball
      # snapshot at `path:/src` (`packaging/nix/build-with-sdme.sh:133-153`).
      #
      # The tags matter as much as the ids: both kinds are 12 hex characters
      # and only one can be looked up in the history, while an operator
      # reading a build id through a tunnel has no shell on the host to
      # resolve the ambiguity. `crates/chan/src/build_id.rs` documents the
      # same two tags; keep them in step.
      buildId =
        if self ? rev then
          "git-${builtins.substring 0 12 self.rev}"
        else if self ? dirtyRev then
          # `dirtyRev` is "<40 hex>-dirty"; take the hash and re-suffix.
          "git-${builtins.substring 0 12 self.dirtyRev}-dirty"
        else if self ? narHash then
          # No revision to name, so name the source CONTENT instead. This is a
          # real degradation, not a rename: two commits with identical tracked
          # content -- an amend that rewrites only the message or the author, a
          # rebase that preserves the tree -- share a narHash and stay
          # indistinguishable here. It is the honest floor for a source tree
          # that arrived with no history attached.
          "nar-${builtins.substring 0 12 (builtins.hashString "sha256" self.narHash)}"
        else
          "unknown";
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ rust-overlay.overlays.default ];
          };
          chan = pkgs.callPackage ./packaging/nix/chan.nix {
            src = self;
            version = manifest.workspace.package.version;
            inherit buildId;
          };
          chan-desktop = pkgs.callPackage ./packaging/nix/chan-desktop.nix {
            src = self;
            version = manifest.workspace.package.version;
            inherit buildId;
          };
        in
        {
          inherit chan chan-desktop;
          default = chan-desktop;
        }
      );
    };
}
