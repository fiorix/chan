#!/usr/bin/env bash
# Compile and lint the release CLI for Windows GNU in a disposable sdme
# container. The host needs sdme, an imported Ubuntu rootfs and a capped btrfs
# pool; the guest installs Rust and MinGW without changing the host toolchain.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=packaging/sdme-build-policy.sh
. "$REPO/packaging/sdme-build-policy.sh"
SDME="${SDME:-sudo sdme}"
WINDOWS_CROSS_ROOTFS="${WINDOWS_CROSS_ROOTFS:-ubuntu}"
WINDOWS_CROSS_CPUS="${WINDOWS_CROSS_CPUS:-2}"
WINDOWS_CROSS_MEMORY="${WINDOWS_CROSS_MEMORY:-6G}"
WINDOWS_CROSS_JOBS="${WINDOWS_CROSS_JOBS:-2}"
WINDOWS_CROSS_TIMEOUT="${WINDOWS_CROSS_TIMEOUT:-7200}"
# The existing Makefile passes CARGO_TARGET_DIR; this host path holds status only.
STATUS_DIR="${CARGO_TARGET_DIR:-$REPO/target/windows-cross-check}"
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
CONTAINER=
STATUS_FILE=
STATUS_NAME=
SOURCE_SNAPSHOT=
CONTAINER_ATTEMPTED=0
NEW_FAILED=0

for name in WINDOWS_CROSS_CPUS WINDOWS_CROSS_JOBS WINDOWS_CROSS_TIMEOUT; do
    value="${!name}"
    if [[ ! $value =~ ^[1-9][0-9]{0,5}$ ]]; then
        echo "error: $name must be a positive decimal integer" >&2
        exit 2
    fi
done
if (( WINDOWS_CROSS_CPUS > 64 || WINDOWS_CROSS_JOBS > 64 || WINDOWS_CROSS_TIMEOUT > 86400 )); then
    echo "error: Windows cross-check CPU, job or timeout limit is out of range" >&2
    exit 2
fi
if [[ ! $WINDOWS_CROSS_MEMORY =~ ^[1-9][0-9]{0,4}[MG]$ ]]; then
    echo "error: WINDOWS_CROSS_MEMORY must be a positive M or G limit" >&2
    exit 2
fi
if (( HOST_UID == 0 )); then
    echo "error: run the Windows cross-check as its non-root build user" >&2
    exit 2
fi

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

SOURCE_REVISION="$(git -C "$REPO" rev-parse --verify HEAD)"
TREE_STATE="$(git -C "$REPO" status --porcelain=v1 --untracked-files=all)"
if [ -n "$TREE_STATE" ]; then
    echo "error: Windows cross-check source must be a clean committed tree at $SOURCE_REVISION" >&2
    exit 1
fi

mkdir -p "$STATUS_DIR"
STATUS_DIR="$(cd "$STATUS_DIR" && pwd -P)"

# The EXIT trap calls this function indirectly.
# shellcheck disable=SC2329
cleanup() {
    result=$?
    trap - EXIT INT TERM
    cleanup_failed=0
    if [ "$CONTAINER_ATTEMPTED" -eq 1 ]; then
        remove_container=1
        if [ "$NEW_FAILED" -eq 1 ]; then
            if container_list="$("${SDME_CMD[@]}" ps --json 2>&1)"; then
                if ! grep -Fq "\"name\":\"$CONTAINER\"" <<<"$container_list"; then
                    echo ">> Windows cross-check guest '$CONTAINER' was not created" >&2
                    remove_container=0
                fi
            else
                echo "error: could not list guests after failed creation: $container_list" >&2
            fi
        fi
        if [ "$remove_container" -eq 1 ]; then
            if ! "${SDME_CMD[@]}" rm -f "$CONTAINER"; then
                echo "error: failed to remove Windows cross-check guest '$CONTAINER'" >&2
                cleanup_failed=1
            fi
        fi
    fi
    if [ "$cleanup_failed" -eq 0 ] && [ -n "$SOURCE_SNAPSHOT" ]; then
        if [[ ! $SOURCE_SNAPSHOT =~ ^/var/tmp/chan-windows-source\.[A-Za-z0-9]{6}$ ]]; then
            echo "error: refusing to remove unexpected source snapshot '$SOURCE_SNAPSHOT'" >&2
            cleanup_failed=1
        elif ! rm -rf -- "$SOURCE_SNAPSHOT"; then
            echo "error: failed to remove source snapshot '$SOURCE_SNAPSHOT'" >&2
            cleanup_failed=1
        fi
    fi
    if [ "$cleanup_failed" -eq 0 ]; then
        if [ -n "$STATUS_FILE" ] && ! rm -f "$STATUS_FILE"; then
            echo "error: failed to remove transient status '$STATUS_FILE'" >&2
            cleanup_failed=1
        fi
    else
        echo "error: preserving snapshot and status for cleanup diagnosis" >&2
    fi
    if [ "$result" -eq 0 ] && [ "$cleanup_failed" -ne 0 ]; then
        result=1
    fi
    exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

SOURCE_SNAPSHOT="$("$REPO/packaging/snapshot-tracked-tree.sh" \
    "$REPO" chan-windows-source)"
if [[ ! $SOURCE_SNAPSHOT =~ ^/var/tmp/chan-windows-source\.[A-Za-z0-9]{6}$ ]]; then
    echo "error: unexpected source snapshot '$SOURCE_SNAPSHOT'" >&2
    exit 1
fi
RUN_ID="${SOURCE_SNAPSHOT##*.}"
CONTAINER="chan-windows-cross-check-${RUN_ID,,}"
STATUS_NAME=".windows-cross-check-status-$RUN_ID"
STATUS_FILE="$STATUS_DIR/$STATUS_NAME"
TREE_STATE="$(git -C "$REPO" status --porcelain=v1 --untracked-files=all)"
if [ "$SOURCE_REVISION" != "$(git -C "$REPO" rev-parse --verify HEAD)" ] ||
    [ -n "$TREE_STATE" ]; then
    echo "error: Windows cross-check source changed during snapshot" >&2
    exit 1
fi
# rust-embed requires both gitignored directories to exist. Create them in the
# isolated snapshot the guest copies, not in the caller's live worktree.
mkdir -p "$SOURCE_SNAPSHOT/web/dist" "$SOURCE_SNAPSHOT/web-launcher/dist"
mkdir -p "$SOURCE_SNAPSHOT/desktop/src-tauri/gen"
# The Windows Tauri config embeds the release CLI as a resource. The
# cross-check compiles desktop tests without building a package, so it needs a
# placeholder at the configured source path for the build script to copy.
mkdir -p "$SOURCE_SNAPSHOT/target/release"
install -m 755 /dev/null "$SOURCE_SNAPSHOT/target/release/chan.exe"

BUILD_RUN='set -euo pipefail
cp -a --no-preserve=ownership /source/. /home/ubuntu/chan/
cd /home/ubuntu/chan
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
export PATH="$CARGO_HOME/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
rustup target add x86_64-pc-windows-gnu
status=0
RUSTFLAGS="-D warnings" cargo check --release -p chan --target x86_64-pc-windows-gnu || status=$?
if [ "$status" -eq 0 ]; then
    RUSTFLAGS="-D warnings" cargo test --release -p chan-library -p chan-server \
        --lib --no-run --target x86_64-pc-windows-gnu || status=$?
fi
if [ "$status" -eq 0 ]; then
    RUSTFLAGS="-D warnings" cargo test --release -p chan-desktop --all-targets \
        --no-run --target x86_64-pc-windows-gnu || status=$?
fi
printf "%s\n" "$status" >"$STATUS_FILE"
exit 0'

GUEST_RUN='set -euo pipefail
if [ "$(id -u ubuntu 2>/dev/null)" != "$HOST_UID" ] ||
    [ "$(id -g ubuntu 2>/dev/null)" != "$HOST_GID" ] ||
    [ "$(getent passwd ubuntu | cut -d: -f6)" != /home/ubuntu ]; then
    echo "error: rootfs needs non-root ubuntu at host uid/gid with home /home/ubuntu" >&2
    exit 1
fi
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl gcc-mingw-w64-x86-64 git pkg-config util-linux
rm -rf /var/lib/apt/lists/*
install -d -o ubuntu -g ubuntu /home/ubuntu /home/ubuntu/chan \
    /home/ubuntu/target /home/ubuntu/target/windows-cross \
    /home/ubuntu/.cargo /home/ubuntu/.rustup
for path in /source/Cargo.toml /status /home/ubuntu/chan \
    /home/ubuntu/target/windows-cross /home/ubuntu/.cargo /home/ubuntu/.rustup; do
    if ! runuser -u ubuntu -- test -r "$path"; then
        echo "error: build user cannot read $path" >&2
        exit 1
    fi
done
if ! runuser -u ubuntu -- test -w /status ||
    ! runuser -u ubuntu -- test -w /home/ubuntu/chan ||
    ! runuser -u ubuntu -- test -w /home/ubuntu/target/windows-cross; then
    echo "error: build user cannot write guest source, target or status" >&2
    exit 1
fi
runuser -u ubuntu -- /usr/bin/env HOME=/home/ubuntu USER=ubuntu LOGNAME=ubuntu \
    CARGO_HOME=/home/ubuntu/.cargo RUSTUP_HOME=/home/ubuntu/.rustup \
    CARGO_TARGET_DIR=/home/ubuntu/target/windows-cross \
    CARGO_BUILD_JOBS="$WINDOWS_CROSS_JOBS" RUST_TEST_THREADS="$WINDOWS_CROSS_JOBS" \
    RAYON_NUM_THREADS="$WINDOWS_CROSS_JOBS" STATUS_FILE="$STATUS_FILE" \
    /bin/bash -c "$1"'

echo ">> Windows GNU cross-check: rootfs=$WINDOWS_CROSS_ROOTFS cpus=$WINDOWS_CROSS_CPUS memory=$WINDOWS_CROSS_MEMORY disk=$SDME_BUILD_DISK jobs=$WINDOWS_CROSS_JOBS timeout=${WINDOWS_CROSS_TIMEOUT}s status=$STATUS_DIR" >&2
echo ">> source: revision=$SOURCE_REVISION clean-tracked-snapshot=$SOURCE_SNAPSHOT" >&2
CONTAINER_ATTEMPTED=1
sdme_status=0
"${SDME_CMD[@]}" new --name "$CONTAINER" -r "$WINDOWS_CROSS_ROOTFS" -t 180 \
    --storage btrfs --disk "$SDME_BUILD_DISK" \
    --cpus "$WINDOWS_CROSS_CPUS" --memory "$WINDOWS_CROSS_MEMORY" \
    -b "$SOURCE_SNAPSHOT:/source:ro" -b "$STATUS_DIR:/status" \
    -- /usr/bin/env HOST_UID="$HOST_UID" HOST_GID="$HOST_GID" \
    WINDOWS_CROSS_JOBS="$WINDOWS_CROSS_JOBS" STATUS_FILE="/status/$STATUS_NAME" \
    /usr/bin/timeout -s TERM -k 30s "${WINDOWS_CROSS_TIMEOUT}s" \
    /bin/bash -c "$GUEST_RUN" windows-cross "$BUILD_RUN" || sdme_status=$?
if [ "$sdme_status" -ne 0 ]; then
    NEW_FAILED=1
fi

case "$sdme_status" in
    130|143) exit "$sdme_status" ;;
esac
if [ "$sdme_status" -ne 0 ]; then
    if [ "$sdme_status" -eq 124 ]; then
        echo "error: guest command returned 124 (timeout bound ${WINDOWS_CROSS_TIMEOUT}s)" >&2
    fi
    echo "error: '${SDME_CMD[*]} new' failed with status $sdme_status" >&2
    exit "$sdme_status"
fi
if [ ! -r "$STATUS_FILE" ]; then
    echo "error: cross-check guest wrote no status to $STATUS_FILE" >&2
    exit 1
fi
status="$(<"$STATUS_FILE")"
if [[ ! $status =~ ^(0|[1-9][0-9]{0,2})$ ]] || (( status > 255 )); then
    echo "error: cross-check guest wrote invalid status '$status'" >&2
    exit 1
fi
if [ "$status" -ne 0 ]; then
    echo "error: cross-check guest build failed with status $status" >&2
fi
exit "$status"
