#!/usr/bin/env bash
#
# Build the chan-desktop Linux bundles (AppImage + .deb, plus the .rpm that
# Tauri's targets:"all" emits for free) inside an sdme container, then copy
# them out to the host. This is the local-dev mirror of the release.yml
# linux-desktop-artifacts job; CI builds natively on its ubuntu runners and
# does NOT use sdme (see docs/contributing/linux-and-macos.md).
#
# Invoked through `make linux-chan-desktop DISTRO=<distro>` (root Makefile ->
# packaging/linux/Makefile). Standalone:
#
#   CHAN_REPO=/path/to/chan DISTRO=ubuntu packaging/sdme/build-chan-desktop.sh
#
# Host portability is via $SDME: on macOS sdme runs inside a lima VM
# (the default), on a Linux host it runs directly.
#
#   macOS (lima):  SDME='limactl shell default sudo sdme'   (default)
#   Linux host:    SDME='sudo sdme'
#
# Two non-obvious container facts this script accommodates:
#   - sdme mounts a small (~800M) tmpfs over /tmp; the cold Rust + tauri-cli
#     compile overflows it, so the in-container build sets TMPDIR=/var/tmp
#     (the disk-backed overlay).
#   - lima mounts the host home READ-ONLY via virtiofs, so artifacts cannot
#     be sdme-cp'd straight back onto a host path. On the lima path we stage
#     them in the VM and pull with `limactl copy` (SSH), which writes the
#     host fs directly. On a native Linux host sdme cp lands them in one hop.

set -euo pipefail

DISTRO="${DISTRO:-ubuntu}"
SDME="${SDME:-limactl shell default sudo sdme}"
# lima instance name, used by `limactl copy` on the macOS path. Derived from a
# default SDME of "limactl shell <instance> ..."; override for a non-default VM.
LIMA_INSTANCE="${LIMA_INSTANCE:-default}"

if [ -z "${CHAN_REPO:-}" ]; then
    echo "error: CHAN_REPO must be set (the chan repo root)" >&2
    exit 1
fi

ROOTFS="chan-desktop-${DISTRO}"
CONTAINER="chan-desktop-build-${DISTRO}"
SDME_TEMPLATE="${CHAN_REPO}/packaging/sdme/${ROOTFS}.sdme"
OUT_DIR="${OUT_DIR:-${CHAN_REPO}/target/linux-desktop/${DISTRO}}"
# In-VM staging dir for the lima copy-out. /var/tmp is on the disk-backed
# overlay (not the small /tmp tmpfs) and world-readable, so the unprivileged
# lima ssh user can read it for `limactl copy`.
STAGE="/var/tmp/chan-desktop-out-${DISTRO}"

# Is this the lima (macOS) path or a native Linux host?
case "$SDME" in
    *limactl*) LIMA=1 ;;
    *)         LIMA=0 ;;
esac

echo "==> chan-desktop linux build: distro=${DISTRO} rootfs=${ROOTFS} container=${CONTAINER}"

if [ ! -f "$SDME_TEMPLATE" ]; then
    echo "error: no sdme template at ${SDME_TEMPLATE}" >&2
    echo "       (add one per distro under packaging/sdme/)" >&2
    exit 1
fi

# 1. Rootfs: build it from the .sdme template if it is not imported yet. The
#    template bakes the Tauri build deps + the Rust toolchain so this one-time
#    cost is not paid per build. After editing the .sdme template, force a
#    rebuild with REBUILD_ROOTFS=1 (an existing rootfs is NOT auto-rebuilt on a
#    template change, so a dep added to the .sdme would otherwise be silently
#    missing from the container).
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
#    survives between runs (a cold chan-desktop compile is ~20 min; an
#    incremental re-seed + rebuild is a minute or two). This deliberately
#    departs from the gateway's recreate-each-time pattern, justified by that
#    build length. Force a clean slate with REBUILD_CONTAINER=1 (or it is
#    recreated automatically when absent / not running).
if [ "${REBUILD_CONTAINER:-0}" = "1" ] \
    || ! $SDME ps 2>/dev/null | grep -qE "^${CONTAINER}[[:space:]].*running"; then
    echo "==> (re)creating container ${CONTAINER}"
    $SDME rm -f "$CONTAINER" >/dev/null 2>&1 || true
    $SDME create --name "$CONTAINER" -r "$ROOTFS" --started -t 120
else
    echo "==> reusing running container ${CONTAINER} (REBUILD_CONTAINER=1 to reset)"
fi

# 3. Seed the committed tree (tracked files only, same as CI's checkout). The
#    archive is written under target/ so it is reachable from the VM even when
#    the host home is mounted read-only.
echo "==> seeding repo (git archive HEAD)"
SEED_DIR="${CHAN_REPO}/target/linux-desktop"
mkdir -p "$SEED_DIR"
git -C "$CHAN_REPO" archive HEAD -o "${SEED_DIR}/chan-src-${DISTRO}.tar"
$SDME cp "${SEED_DIR}/chan-src-${DISTRO}.tar" "${CONTAINER}:/root/chan.tar"
$SDME exec "$CONTAINER" /bin/sh -c \
    'mkdir -p /root/chan && tar -xf /root/chan.tar -C /root/chan'

# 4. Build. TMPDIR off the small /tmp tmpfs; the pinned toolchain
#    (rust-toolchain.toml) auto-installs on the first cargo call.
echo "==> building chan-desktop bundles in the container"
$SDME exec "$CONTAINER" /bin/sh -c '
    set -e
    export HOME=/root
    . /root/.cargo/env
    export TMPDIR=/var/tmp
    cd /root/chan && make chan-desktop'

# 5. Copy the bundles out of the container to OUT_DIR on the host. They live in
#    the container overlay; getting them onto the host differs by host type.
echo "==> collecting bundle paths"
bundle_paths=$($SDME exec "$CONTAINER" /bin/sh -c \
    'ls /root/chan/target/release/bundle/appimage/*.AppImage \
        /root/chan/target/release/bundle/deb/*.deb \
        /root/chan/target/release/bundle/rpm/*.rpm 2>/dev/null')
if [ -z "$bundle_paths" ]; then
    echo "error: no bundles found in ${CONTAINER}" >&2
    exit 1
fi

mkdir -p "$OUT_DIR"
echo "==> copying artifacts to ${OUT_DIR}"
if [ "$LIMA" = "1" ]; then
    # lima: the host home is read-only in the VM, so sdme cp cannot land on
    # OUT_DIR directly, and limactl copy reads the VM filesystem (not the
    # container overlay). So sdme cp each bundle from the container onto a
    # world-readable VM staging dir, then pull it to the Mac over SSH with
    # limactl copy (which writes the Mac fs directly). SDME_HOST_SH is the sdme
    # prefix minus the trailing "sdme", i.e. a plain root shell on the VM.
    SDME_HOST_SH="${SDME% sdme}"
    $SDME_HOST_SH /bin/sh -c "rm -rf '$STAGE' && mkdir -p '$STAGE' && chmod 0777 '$STAGE'"
    for p in $bundle_paths; do
        $SDME cp "${CONTAINER}:${p}" "${STAGE}/"
    done
    for p in $bundle_paths; do
        limactl copy "${LIMA_INSTANCE}:${STAGE}/$(basename "$p")" "${OUT_DIR}/"
    done
else
    # native Linux host: sdme cp lands straight on OUT_DIR.
    for p in $bundle_paths; do
        $SDME cp "${CONTAINER}:${p}" "${OUT_DIR}/"
    done
fi

echo
echo "chan-desktop ${DISTRO} bundles:"
ls -lh "$OUT_DIR"
