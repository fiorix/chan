#!/usr/bin/env bash
#
# Build the chan-gateway .deb packages (profile, identity, devserver-proxy,
# admin) inside an sdme container, then copy them out to the host. This is the
# local-dev, sdme-based mirror of the release.yml gateway-linux-packages job;
# CI builds natively on its ubuntu runners (amd64 + arm64) and does NOT use
# sdme (see docs/contributing/linux-and-macos.md).
#
# It exists alongside packaging/gateway/scripts/build-debs.sh (cargo-zigbuild cross-
# compile, needs zig + cargo-zigbuild on the host). This path needs only
# lima + sdme, the same mechanism as the chan-desktop Linux build, so a
# contributor set up for one is set up for both.
#
# Invoked through `make linux-gateway` (root Makefile). Standalone:
#
#   CHAN_REPO=/path/to/chan packaging/gateway/scripts/dev/sdme/build-gateway.sh
#
# Host portability is via $SDME: on macOS sdme runs inside a lima VM
# (the default), on a Linux host it runs directly.
#
#   macOS (lima):  SDME='limactl shell default sudo sdme'   (default)
#   Linux host:    SDME='sudo sdme'
#
# Container facts shared with build-chan-desktop.sh (both scripts must
# honor them):
#   - sdme mounts a small (~800M) tmpfs over /tmp; a cold cargo compile can
#     overflow it, so the in-container build sets TMPDIR=/var/tmp (the
#     disk-backed overlay).
#   - lima mounts the host home READ-ONLY via virtiofs, so artifacts cannot
#     be sdme-cp'd straight back onto a host path. On the lima path we stage
#     them in the VM and pull with `limactl copy` (SSH), which writes the
#     host fs directly. On a native Linux host sdme cp lands them in one hop.

set -euo pipefail

SDME="${SDME:-limactl shell default sudo sdme}"
# lima instance name, used by `limactl copy` on the macOS path. Derived from a
# default SDME of "limactl shell <instance> ..."; override for a non-default VM.
LIMA_INSTANCE="${LIMA_INSTANCE:-default}"

if [ -z "${CHAN_REPO:-}" ]; then
    echo "error: CHAN_REPO must be set (the chan repo root)" >&2
    exit 1
fi

ROOTFS="gateway-build"
CONTAINER="chan-gw-build"
SDME_TEMPLATE="${CHAN_REPO}/packaging/gateway/scripts/dev/sdme/${ROOTFS}.sdme"
OUT_DIR="${OUT_DIR:-${CHAN_REPO}/target/linux-gateway}"
# In-VM staging dir for the lima copy-out. /var/tmp is on the disk-backed
# overlay (not the small /tmp tmpfs) and world-readable, so the unprivileged
# lima ssh user can read it for `limactl copy`.
STAGE="/var/tmp/chan-gateway-out"

# Is this the lima (macOS) path or a native Linux host?
case "$SDME" in
    *limactl*) LIMA=1 ;;
    *)         LIMA=0 ;;
esac

echo "==> gateway linux build: rootfs=${ROOTFS} container=${CONTAINER}"

if [ ! -f "$SDME_TEMPLATE" ]; then
    echo "error: no sdme template at ${SDME_TEMPLATE}" >&2
    exit 1
fi

# 1. Rootfs: build it from the .sdme template if it is not imported yet. The
#    template bakes the Rust toolchain + node + cargo-deb so this one-time cost
#    is not paid per build. After editing the .sdme template, force a rebuild
#    with REBUILD_ROOTFS=1 (an existing rootfs is NOT auto-rebuilt on a
#    template change).
if [ "${REBUILD_ROOTFS:-0}" = "1" ] \
    || ! $SDME fs ls 2>/dev/null | grep -qE "^${ROOTFS}[[:space:]]"; then
    echo "==> building rootfs ${ROOTFS}"
    # A container holding this rootfs blocks the rebuild; drop it first (it is
    # recreated below regardless).
    $SDME rm -f "$CONTAINER" >/dev/null 2>&1 || true
    ( cd "$(dirname "$SDME_TEMPLATE")" \
        && $SDME fs build -f "$ROOTFS" "$(basename "$SDME_TEMPLATE")" )
fi

# 2. Container: reuse a running one by default so the cargo target cache
#    survives between runs. Force a clean slate with REBUILD_CONTAINER=1 (or
#    it is recreated automatically when absent / not running).
if [ "${REBUILD_CONTAINER:-0}" = "1" ] \
    || ! $SDME ps 2>/dev/null | grep -qE "^${CONTAINER}[[:space:]].*running"; then
    echo "==> (re)creating container ${CONTAINER}"
    $SDME rm -f "$CONTAINER" >/dev/null 2>&1 || true
    $SDME create --name "$CONTAINER" -r "$ROOTFS" --started -t 120
else
    echo "==> reusing running container ${CONTAINER} (REBUILD_CONTAINER=1 to reset)"
fi

# 3. Seed the committed tree (tracked files only, same as CI's checkout). The
#    WHOLE repo is seeded, not just gateway/: the gateway crates path-depend on
#    ../crates/chan-tunnel-* in the parent workspace, and make gateway-build is
#    a root-Makefile target. The archive is written under target/ so it is
#    reachable from the VM even when the host home is mounted read-only.
echo "==> seeding repo (git archive HEAD)"
SEED_DIR="${CHAN_REPO}/target/linux-gateway"
mkdir -p "$SEED_DIR"
git -C "$CHAN_REPO" archive HEAD -o "${SEED_DIR}/chan-src-gateway.tar"
$SDME cp "${SEED_DIR}/chan-src-gateway.tar" "${CONTAINER}:/root/chan.tar"
$SDME exec "$CONTAINER" /bin/sh -c \
    'rm -rf /root/chan && mkdir -p /root/chan && tar -xf /root/chan.tar -C /root/chan'

# 4. Build + package. make gateway-build builds the identity SPA (gateway-spa)
#    then the four release crates; the cargo-deb loop reads the crate names
#    from the single GATEWAY_RELEASE_CRATES source so a rename cannot drift it.
#    Native build (no --target): the produced .deb is the container/host arch
#    (aarch64 on Apple Silicon). TMPDIR off the small /tmp tmpfs.
echo "==> building + packaging gateway in the container"
$SDME exec "$CONTAINER" /bin/sh -c '
    set -e
    export HOME=/root
    . /root/.cargo/env
    export TMPDIR=/var/tmp
    cd /root/chan
    make gateway-build GATEWAY_CARGO_FLAGS=--release
    cd gateway
    rm -rf release-artifacts && mkdir -p release-artifacts
    for crate in $(make -C .. -s gateway-release-crates); do
        cargo deb --no-build --no-strip -p "$crate" --output release-artifacts/
    done
    ls -la release-artifacts'

# 5. Copy the .deb packages out of the container to OUT_DIR on the host.
echo "==> collecting .deb paths"
deb_paths=$($SDME exec "$CONTAINER" /bin/sh -c \
    'ls /root/chan/gateway/release-artifacts/*.deb 2>/dev/null')
if [ -z "$deb_paths" ]; then
    echo "error: no .deb packages found in ${CONTAINER}" >&2
    exit 1
fi

mkdir -p "$OUT_DIR"
echo "==> copying artifacts to ${OUT_DIR}"
if [ "$LIMA" = "1" ]; then
    # lima: the host home is read-only in the VM, so sdme cp cannot land on
    # OUT_DIR directly, and limactl copy reads the VM filesystem (not the
    # container overlay). So sdme cp each .deb from the container onto a
    # world-readable VM staging dir, then pull it to the Mac over SSH with
    # limactl copy. SDME_HOST_SH is the sdme prefix minus the trailing "sdme",
    # i.e. a plain root shell on the VM.
    SDME_HOST_SH="${SDME% sdme}"
    $SDME_HOST_SH /bin/sh -c "rm -rf '$STAGE' && mkdir -p '$STAGE' && chmod 0777 '$STAGE'"
    for p in $deb_paths; do
        $SDME cp "${CONTAINER}:${p}" "${STAGE}/"
    done
    for p in $deb_paths; do
        limactl copy "${LIMA_INSTANCE}:${STAGE}/$(basename "$p")" "${OUT_DIR}/"
    done
else
    # native Linux host: sdme cp lands straight on OUT_DIR.
    for p in $deb_paths; do
        $SDME cp "${CONTAINER}:${p}" "${OUT_DIR}/"
    done
fi

echo
echo "gateway .deb packages:"
ls -lh "$OUT_DIR"
