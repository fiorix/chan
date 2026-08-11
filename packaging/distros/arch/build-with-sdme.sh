#!/usr/bin/env bash
# Build the AUR packages from a committed local revision in a disposable sdme
# Arch container. The rootfs architecture determines the package architecture.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=packaging/sdme-build-policy.sh
. "$REPO/packaging/sdme-build-policy.sh"
REV="${REV:-HEAD}"
SDME="${SDME:-sudo sdme}"
# A plain upstream Arch base rootfs, named like the other base imports the
# packaging paths use (ubuntu, centos-stream-*). The pre-provisioned desktop
# build rootfs is deliberately not reused: its baked dependencies would hide
# missing PKGBUILD declarations.
AUR_ROOTFS="${AUR_ROOTFS:-archlinux}"
OUT="${OUT:-$REPO/target/aur-out}"
SOURCE_DIR="$REPO/target/aur-source"
SOURCE_SNAPSHOT=
HOST_ARCH="$(uname -m)"
# sdme container names take lowercase letters, digits, and hyphens only, so the
# underscore in machine names like x86_64 has to go.
CONTAINER_ARCH="${HOST_ARCH//_/-}"
CONTAINER="chan-aur-build-${CONTAINER_ARCH}-$$"

# SDME carries the transport too (a lima VM on macOS, sudo on a Linux host),
# so parse it into an array once instead of relying on word splitting.
read -r -a SDME_CMD <<<"$SDME"
[ ${#SDME_CMD[@]} -gt 0 ] || {
    echo "error: SDME must name the sdme command" >&2
    exit 1
}

revision="$(git -C "$REPO" rev-parse --verify --quiet "$REV^{commit}")" || {
    echo "error: $REV does not name a commit" >&2
    exit 1
}
version="$(git -C "$REPO" show "$revision:Cargo.toml" | sed -n 's/^version = "\(.*\)"/\1/p' | head -1)"
[ -n "$version" ] || { echo "error: cannot derive version from $REV" >&2; exit 1; }

if ! "${SDME_CMD[@]}" fs ls | awk -v name="$AUR_ROOTFS" \
    '$1 == name { found = 1 } END { exit !found }'; then
    echo "error: sdme rootfs '$AUR_ROOTFS' is not imported" >&2
    echo "hint: sudo sdme fs import docker.io/archlinux/archlinux:base --name $AUR_ROOTFS" >&2
    exit 1
fi

mkdir -p "$SOURCE_DIR" "$OUT"
source_archive="$SOURCE_DIR/chan-$version.tar.gz"
git -C "$REPO" archive --format=tar.gz --prefix="chan-$version/" -o "$source_archive" "$revision"
SOURCE_SNAPSHOT="$("$REPO/packaging/snapshot-tracked-tree.sh" \
    "$REPO" chan-aur-source)"

cleanup() {
    "${SDME_CMD[@]}" rm -f "$CONTAINER" >/dev/null 2>&1 || true
    if [ -n "$SOURCE_SNAPSHOT" ]; then
        case "$SOURCE_SNAPSHOT" in
            /var/tmp/chan-aur-source.*) rm -rf -- "$SOURCE_SNAPSHOT" ;;
            *) echo "error: refusing to remove unexpected source snapshot '$SOURCE_SNAPSHOT'" >&2 ;;
        esac
    fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo ">> running AUR checks in sdme rootfs '$AUR_ROOTFS' disk=$SDME_BUILD_DISK revision=$revision" >&2
# Pass the build environment to the joined command itself. sdme's `--env`
# configures the container service, but the auto-join command does not inherit
# those values.
"${SDME_CMD[@]}" new --name "$CONTAINER" -r "$AUR_ROOTFS" -t 120 \
    --storage btrfs --disk "$SDME_BUILD_DISK" \
    -b "$SOURCE_SNAPSHOT:/src:ro" -b "$SOURCE_DIR:/local:ro" -b "$OUT:/out" \
    -- env SRC=/src OUT=/out VERSION="$version" \
    HOST_UID="$(id -u)" HOST_GID="$(id -g)" \
    AUR_LOCAL_SOURCE="/local/chan-$version.tar.gz" \
    bash /src/packaging/distros/arch/build-in-container.sh
