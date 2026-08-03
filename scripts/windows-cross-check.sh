#!/usr/bin/env bash
# Compile and lint the release CLI for Windows GNU in a disposable sdme
# container. The host supplies only sdme and an imported Ubuntu rootfs; the
# guest installs Rust and MinGW without changing the host toolchain.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
SDME="${SDME:-sudo sdme}"
WINDOWS_CROSS_ROOTFS="${WINDOWS_CROSS_ROOTFS:-ubuntu}"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$REPO/target/windows-cross-check}"
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
CONTAINER="chan-windows-cross-check-$$"
STATUS_NAME=".windows-cross-check-status-$$"

# SDME carries the transport too (for example sudo on a Linux host), so parse
# it once instead of relying on word splitting at every invocation.
read -r -a SDME_CMD <<<"$SDME"
[ ${#SDME_CMD[@]} -gt 0 ] || {
    echo "error: SDME must name the sdme command" >&2
    exit 1
}

if ! FS_LIST="$("${SDME_CMD[@]}" fs ls 2>&1)"; then
    echo "error: '${SDME_CMD[*]} fs ls' failed:" >&2
    echo "$FS_LIST" >&2
    exit 1
fi
if ! awk -v name="$WINDOWS_CROSS_ROOTFS" \
    '$1 == name { found = 1 } END { exit !found }' <<<"$FS_LIST"; then
    echo "error: sdme rootfs '$WINDOWS_CROSS_ROOTFS' is not imported" >&2
    echo "hint: ${SDME_CMD[*]} fs import docker.io/ubuntu --name $WINDOWS_CROSS_ROOTFS --install-packages=yes -v" >&2
    exit 1
fi

mkdir -p "$CARGO_TARGET_DIR" "$REPO/web/dist" "$REPO/web-launcher/dist"
CARGO_TARGET_DIR="$(cd "$CARGO_TARGET_DIR" && pwd)"
STATUS_FILE="$CARGO_TARGET_DIR/$STATUS_NAME"
rm -f "$STATUS_FILE"

cleanup() {
    rm -f "$STATUS_FILE"
    "${SDME_CMD[@]}" rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

GUEST_RUN='set -euo pipefail
hand_back_target() {
    chown -R "$HOST_UID:$HOST_GID" "$CARGO_TARGET_DIR" || true
}
trap hand_back_target EXIT

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl gcc-mingw-w64-x86-64 git pkg-config
rm -rf /var/lib/apt/lists/*

curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
export PATH="/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
cd /src
rustup target add x86_64-pc-windows-gnu
status=0
RUSTFLAGS="-D warnings" cargo check --release -p chan --target x86_64-pc-windows-gnu || status=$?
printf "%s\n" "$status" >"$STATUS_FILE"
exit 0'

echo ">> Windows GNU cross-check: rootfs=$WINDOWS_CROSS_ROOTFS target=$CARGO_TARGET_DIR" >&2
sdme_status=0
"${SDME_CMD[@]}" new --name "$CONTAINER" -r "$WINDOWS_CROSS_ROOTFS" -t 180 \
    -b "$REPO:/src:ro" -b "$CARGO_TARGET_DIR:/cargo-target" \
    -- /usr/bin/env HOST_UID="$HOST_UID" HOST_GID="$HOST_GID" \
    CARGO_TARGET_DIR=/cargo-target STATUS_FILE="/cargo-target/$STATUS_NAME" \
    /bin/bash -c "$GUEST_RUN" || sdme_status=$?

case "$sdme_status" in
    130|143) exit "$sdme_status" ;;
esac
if [ "$sdme_status" -ne 0 ]; then
    echo "error: '${SDME_CMD[*]} new' failed with status $sdme_status" >&2
    exit "$sdme_status"
fi
if [ ! -r "$STATUS_FILE" ]; then
    echo "error: cross-check guest wrote no status to $STATUS_FILE" >&2
    exit 1
fi
status="$(<"$STATUS_FILE")"
case "$status" in
    0) ;;
    ''|*[!0-9]*)
        echo "error: cross-check guest wrote invalid status '$status'" >&2
        exit 1
        ;;
    *) exit "$status" ;;
esac
