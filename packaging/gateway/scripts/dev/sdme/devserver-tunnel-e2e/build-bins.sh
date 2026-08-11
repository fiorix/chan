#!/usr/bin/env bash
# Build the three release binaries the e2e needs -- devserver-control-service,
# devserver-proxy-service, and chan -- inside an sdme container that carries the rust+node toolchain
# (gateway-build rootfs), then copy them to the host. The binaries run in the
# zone containers, which are Ubuntu, so building them in an Ubuntu container
# keeps the glibc match (the host has no rust toolchain anyway).
#
# Idempotent: reuses the rootfs + build container so the cargo target cache
# survives between runs. One-time cold build is ~10 min; warm rebuilds are fast.
#
#   sudo is sdme-only (NOPASSWD /usr/local/bin/sdme); everything runs as
#   `sudo -n sdme`. Output: $REPO/target/devserver-e2e/bin/{devserver-control-service,devserver-proxy-service,chan}
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
SDME="sudo -n sdme"
ROOTFS="gateway-build"                       # bakes rust + node + cargo-deb
BUILD_SDME="$REPO/packaging/gateway/scripts/dev/sdme/${ROOTFS}.sdme"
CONTAINER="chan-e2e-build"
OUT_DIR="$REPO/target/devserver-e2e/bin"
SEED="$REPO/target/devserver-e2e"

mkdir -p "$OUT_DIR" "$SEED"

echo "==> [1/6] ensure ubuntu base rootfs"
$SDME fs ls 2>/dev/null | grep -qE "^ubuntu[[:space:]]" \
  || $SDME fs import docker.io/ubuntu --name ubuntu --install-packages=yes -v

echo "==> [2/6] ensure ${ROOTFS} rootfs (rust+node+cargo-deb)"
$SDME fs ls 2>/dev/null | grep -qE "^${ROOTFS}[[:space:]]" \
  || ( cd "$(dirname "$BUILD_SDME")" && $SDME fs build -f "$ROOTFS" "$(basename "$BUILD_SDME")" )

echo "==> [3/6] ensure build container ${CONTAINER}"
if ! $SDME ps 2>/dev/null | grep -qE "^${CONTAINER}[[:space:]].*running"; then
  $SDME rm -f "$CONTAINER" >/dev/null 2>&1 || true
  $SDME create --name "$CONTAINER" -r "$ROOTFS" --storage btrfs --started -t 120
fi

echo "==> [4/6] seed committed tree (git archive HEAD)"
# Whole repo: the gateway crates path-depend on ../crates/chan-tunnel-*.
git -C "$REPO" archive HEAD -o "${SEED}/chan-src.tar"
$SDME cp "${SEED}/chan-src.tar" "${CONTAINER}:/root/chan.tar"
$SDME exec "$CONTAINER" /bin/sh -c \
  'rm -rf /root/chan && mkdir -p /root/chan && tar -xf /root/chan.tar -C /root/chan'

echo "==> [5/6] build web bundles + all three binaries"
# - devserver-proxy is a GATEWAY-workspace crate -> build from gateway/.
# - chan is the ROOT workspace; --no-default-features drops the ML/embeddings
#   deps (the devserver serves workspaces without them). make web bakes both
#   SPA bundles that chan-server embeds via rust-embed.
$SDME exec "$CONTAINER" /bin/sh -c '
  set -e
  export HOME=/root TMPDIR=/var/tmp
  . /root/.cargo/env
  cd /root/chan
  make web
  ( cd gateway && cargo build --release \
      -p devserver-control --bin devserver-control-service \
      -p devserver-proxy --bin devserver-proxy-service )
  cargo build --release -p chan --no-default-features
  ls -la gateway/target/release/devserver-control-service \
    gateway/target/release/devserver-proxy-service target/release/chan
'

echo "==> [6/6] copy binaries to ${OUT_DIR}"
$SDME cp "${CONTAINER}:/root/chan/gateway/target/release/devserver-proxy-service" "${OUT_DIR}/"
$SDME cp "${CONTAINER}:/root/chan/gateway/target/release/devserver-control-service" "${OUT_DIR}/"
$SDME cp "${CONTAINER}:/root/chan/target/release/chan" "${OUT_DIR}/"
ls -lh "$OUT_DIR"
echo "==> done -- now run ./run.sh"
