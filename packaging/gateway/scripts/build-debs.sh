#!/usr/bin/env bash
# Build .deb packages for all chan-gateway services, for amd64 and
# arm64, from a macOS host using cargo-zigbuild.
#
# Prereqs:
#   - rustup target add x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu
#   - cargo install cargo-zigbuild cargo-deb
#   - brew install zig
#   - node + npm
#
# Output: target/<triple>/debian/*.deb (also copied to dist/ at the
# repo root for convenience).

set -euo pipefail

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)/gateway"

CRATES=("profile" "identity" "devserver-proxy" "devserver-control" "admin")
TARGETS=("x86_64-unknown-linux-gnu" "aarch64-unknown-linux-gnu")

# Frontend bundle. rust-embed bakes whatever is in
# crates/identity/web/dist into the binary at compile time, so we
# MUST build the SPA first. The gateway profile SPA is @chan/profile,
# a member of the ./web npm workspace (the gateway carries no npm
# root of its own); building it emits to the frozen embed dist.
echo "==> building SPA bundle"
(cd ../web && npm ci --silent && npm run build -w @chan/profile --silent)

# Cross-compile binaries.
for target in "${TARGETS[@]}"; do
    echo "==> cargo-zigbuild --release --target $target"
    cargo zigbuild --release --target "$target" \
        -p profile -p identity -p devserver-proxy -p devserver-control -p admin
done

# Package each crate per target.
mkdir -p dist
rm -f dist/*.deb
for target in "${TARGETS[@]}"; do
    for crate in "${CRATES[@]}"; do
        echo "==> cargo deb -p $crate (target=$target)"
        # --no-build: cargo-deb would otherwise try to recompile and
        # would not pick up the cargo-zigbuild artifact.
        # --no-strip: we want symbols stripped, but cargo-zigbuild
        # already emits stripped binaries via [profile.release]; let
        # it pass through (cargo-deb's strip uses the host toolchain
        # which can't strip foreign-arch ELF).
        cargo deb --no-build --no-strip \
            --target "$target" \
            -p "$crate" \
            --output "dist/"
    done
done

echo
echo "==> built:"
ls -la dist/*.deb
