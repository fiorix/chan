#!/usr/bin/env bash
# Build the three release binaries the e2e needs -- devserver-control-service,
# devserver-proxy-service, and chan -- inside an sdme container that carries the rust+node toolchain
# (gateway-build rootfs), then copy them to the host. The binaries run in the
# zone containers, which are Ubuntu, so building them in an Ubuntu container
# keeps the glibc match (the host has no rust toolchain anyway).
#
# Idempotent: reuses the rootfs + build container so the cargo target cache
# survives between runs. Configured limits replace earlier limits on a kept
# guest; with none configured, earlier limits remain. REBUILD_CONTAINER=1 resets it.
# One-time cold build is ~10 min.
#
#   SDME selects the sdme transport (sudo -n sdme by default). Output:
#   $REPO/target/devserver-e2e/bin/{devserver-control-service,devserver-proxy-service,chan}
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
# shellcheck source=packaging/sdme-build-policy.sh
. "$REPO/packaging/sdme-build-policy.sh"
sdme_build_limits E2E_BINS || exit $?
SDME="${SDME:-sudo -n sdme}"
ROOTFS="gateway-build"                       # bakes rust + node + cargo-deb
BUILD_SDME="$REPO/packaging/gateway/scripts/dev/sdme/${ROOTFS}.sdme"
CONTAINER="chan-e2e-build"
OUT_DIR="$REPO/target/devserver-e2e/bin"
SEED="$REPO/target/devserver-e2e"

remove_existing_container() {
  local listing
  listing="$($SDME ps)" || return
  if grep -qE "^${CONTAINER}[[:space:]]" <<<"$listing"; then
    $SDME rm -f "$CONTAINER"
  fi
}

mkdir -p "$OUT_DIR" "$SEED"

echo "==> [1/6] ensure ubuntu base rootfs"
$SDME fs ls 2>/dev/null | grep -qE "^ubuntu[[:space:]]" \
  || $SDME fs import docker.io/ubuntu --name ubuntu --install-packages=yes -v

echo "==> [2/6] ensure ${ROOTFS} rootfs (rust+node+cargo-deb)"
$SDME fs ls 2>/dev/null | grep -qE "^${ROOTFS}[[:space:]]" \
  || ( cd "$(dirname "$BUILD_SDME")" && $SDME fs build -f "$ROOTFS" "$(basename "$BUILD_SDME")" )

echo "==> [3/6] ensure build container ${CONTAINER}"
if [ "${REBUILD_CONTAINER:-0}" = 1 ] \
  || ! $SDME ps 2>/dev/null | grep -qE "^${CONTAINER}[[:space:]].*running"; then
  remove_existing_container
  sdme_build_log_limits E2E_BINS
  $SDME create --name "$CONTAINER" -r "$ROOTFS" --storage btrfs \
    ${SDME_BUILD_LIMIT_ARGS[@]+"${SDME_BUILD_LIMIT_ARGS[@]}"} --started -t 120
elif [ ${#SDME_BUILD_LIMIT_ARGS[@]} -gt 0 ]; then
  sdme_build_log_limits E2E_BINS
  set_status=0
  # sdme says restart for limits to take effect, but applies them at once.
  $SDME set "$CONTAINER" ${SDME_BUILD_LIMIT_ARGS[@]+"${SDME_BUILD_LIMIT_ARGS[@]}"} || set_status=$?
  if [ "$set_status" -ne 0 ]; then
    echo "error: could not set limits on kept container $CONTAINER; REBUILD_CONTAINER=1 recreates it" >&2
    exit "$set_status"
  fi
else
  echo "==> no limit configured for this run; limits from an earlier run on kept container $CONTAINER remain in force; REBUILD_CONTAINER=1 recreates it without them"
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
# CARGO_BUILD_JOBS bounds cargo, not the web build inside make web.
build_env=()
[ -z "$SDME_BUILD_LIMIT_JOBS" ] || build_env+=(CARGO_BUILD_JOBS="$SDME_BUILD_LIMIT_JOBS")
build_bound=()
[ -z "$SDME_BUILD_LIMIT_TIMEOUT" ] || build_bound=(timeout -s TERM -k 30s "${SDME_BUILD_LIMIT_TIMEOUT}s")
build_status=0
$SDME exec "$CONTAINER" -- /usr/bin/env ${build_env[@]+"${build_env[@]}"} ${build_bound[@]+"${build_bound[@]}"} /bin/sh -c '
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
' || build_status=$?
if [ "$build_status" -eq 124 ] || [ "$build_status" -eq 137 ]; then
  echo "error: timed-out build; stopping kept container $CONTAINER" >&2
  $SDME stop "$CONTAINER" || exit 1
fi
[ "$build_status" -eq 0 ] || exit "$build_status"

echo "==> [6/6] copy binaries to ${OUT_DIR}"
$SDME cp "${CONTAINER}:/root/chan/gateway/target/release/devserver-proxy-service" "${OUT_DIR}/"
$SDME cp "${CONTAINER}:/root/chan/gateway/target/release/devserver-control-service" "${OUT_DIR}/"
$SDME cp "${CONTAINER}:/root/chan/target/release/chan" "${OUT_DIR}/"
ls -lh "$OUT_DIR"
echo "==> done -- now run ./run.sh"
