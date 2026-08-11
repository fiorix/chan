#!/usr/bin/env bash
# Build the supported CentOS COPR matrix in disposable sdme containers.
#
# Env: SDME (how sdme is reached), DOCKER, PKG, COPR_RELEASE, REUSE_SRPM,
#      COPR_EL9_ROOTFS, COPR_EL10_ROOTFS, KEEP_CONTAINER, OUT.
# KEEP_CONTAINER and REUSE_SRPM take 0 or 1 and reject anything else.
#
# Linux hosts only: the guest hands its results back through a writable host
# bind, and the macOS lima path mounts the host home read-only over virtiofs.
#
# Every target runs even when an earlier one fails; the exit status is
# non-zero if any target failed. An interrupt aborts the whole matrix.

set -euo pipefail

if [ "$(uname -s)" != Linux ]; then
    echo "error: the COPR container check runs on Linux hosts only" >&2
    echo "hint: the guest writes its results to a writable host bind, which lima's read-only virtiofs home cannot provide" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=packaging/sdme-build-policy.sh
. "$REPO/packaging/sdme-build-policy.sh"
SDME="${SDME:-sudo sdme}"
COPR_EL9_ROOTFS="${COPR_EL9_ROOTFS:-centos-stream-9}"
COPR_EL10_ROOTFS="${COPR_EL10_ROOTFS:-centos-stream-10}"
COPR_RELEASE="${COPR_RELEASE:-all}"
PKG="${PKG:-all}"
OUT="${OUT:-$REPO/target/distros/copr-check}"
KEEP_CONTAINER="${KEEP_CONTAINER:-0}"
REUSE_SRPM="${REUSE_SRPM:-0}"
HOST_ARCH="$(uname -m)"
CONTAINER_ARCH="${HOST_ARCH//_/-}"
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
CONTAINERS=()
RESULTS=()
FAILED=0
SOURCE_SNAPSHOT=
SOURCE_REVISION=

case "$COPR_RELEASE" in
    all) releases=(9 10) ;;
    9|10) releases=("$COPR_RELEASE") ;;
    *) echo "error: COPR_RELEASE must be all, 9, or 10" >&2; exit 1 ;;
esac
case "$PKG" in
    all|chan|chan-desktop) ;;
    *) echo "error: PKG must be all, chan, or chan-desktop" >&2; exit 1 ;;
esac
if [ "$COPR_RELEASE" = 9 ] && [ "$PKG" = chan-desktop ]; then
    echo "error: chan-desktop is unsupported on EPEL Next 9 (WebKitGTK 4.1 and libsoup3 are unavailable)" >&2
    exit 1
fi
case "$KEEP_CONTAINER" in
    0|1) ;;
    *) echo "error: KEEP_CONTAINER must be 0 or 1" >&2; exit 1 ;;
esac
case "$REUSE_SRPM" in
    0|1) ;;
    *) echo "error: REUSE_SRPM must be 0 or 1" >&2; exit 1 ;;
esac

read -r -a SDME_CMD <<<"$SDME"
[ ${#SDME_CMD[@]} -gt 0 ] || {
    echo "error: SDME must name the sdme command" >&2
    exit 1
}
# `sudo sdme` puts sudo in word 0, so probing word 0 alone passes on a host with
# no sdme at all. Probe the whole command form instead, through the rootfs
# listing the matrix needs anyway.
if ! FS_LIST="$("${SDME_CMD[@]}" fs ls 2>&1)"; then
    echo "error: '${SDME_CMD[*]} fs ls' failed:" >&2
    echo "$FS_LIST" >&2
    echo "hint: SDME names how sdme is reached on this host, and defaults to 'sudo sdme'" >&2
    exit 1
fi

# CONTAINERS is empty until the first target starts, and bash before 4.4 treats
# an empty array expansion as unset under `set -u`. Both early returns are
# explicit successes: `set -e` would otherwise abort the signal handler that
# calls this, before it reaches its own exit status.
# shellcheck disable=SC2329  # runs from the EXIT trap
cleanup() {
    if [ "$KEEP_CONTAINER" != 1 ] && [ ${#CONTAINERS[@]} -gt 0 ]; then
        for container in "${CONTAINERS[@]}"; do
            "${SDME_CMD[@]}" rm -f "$container" >/dev/null 2>&1 || true
        done
    fi
    if [ "$KEEP_CONTAINER" = 1 ] && [ ${#CONTAINERS[@]} -gt 0 ] && [ -n "$SOURCE_SNAPSHOT" ]; then
        echo ">> keeping source snapshot $SOURCE_SNAPSHOT for retained containers" >&2
    elif [ -n "$SOURCE_SNAPSHOT" ]; then
        case "$SOURCE_SNAPSHOT" in
            /var/tmp/chan-copr-source.*) rm -rf -- "$SOURCE_SNAPSHOT" ;;
            *) echo "error: refusing to remove unexpected source snapshot '$SOURCE_SNAPSHOT'" >&2 ;;
        esac
    fi
}
# Capturing each target's status keeps the matrix running past a failure, which
# would also swallow an interrupt, so interrupts abort here instead.
# shellcheck disable=SC2329  # runs from the INT and TERM traps
on_signal() {
    trap - EXIT INT TERM
    echo ">> $1 received, aborting the matrix" >&2
    cleanup
    case "$1" in
        INT) exit 130 ;;
        *) exit 143 ;;
    esac
}
trap cleanup EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

MATRIX=()
need_desktop=0
for release in "${releases[@]}"; do
    case "$PKG" in
        all)
            MATRIX+=("$release:chan")
            if [ "$release" = 10 ]; then
                MATRIX+=("$release:chan-desktop")
                need_desktop=1
            fi
            ;;
        chan) MATRIX+=("$release:chan") ;;
        chan-desktop)
            if [ "$release" = 10 ]; then
                MATRIX+=("$release:chan-desktop")
                need_desktop=1
            fi
            ;;
    esac
done
# Defensive: every PKG and COPR_RELEASE pair that survives the validations
# above yields at least one target, so this guard has no reachable input today.
# It keeps a future release or package from expanding into a silent no-op.
[ ${#MATRIX[@]} -gt 0 ] || {
    echo "error: no target matches PKG=$PKG COPR_RELEASE=$COPR_RELEASE" >&2
    exit 1
}

require_rootfs() {
    local rootfs="$1"
    local release="$2"
    if ! awk -v name="$rootfs" '$1 == name { found = 1 } END { exit !found }' <<<"$FS_LIST"; then
        echo "error: sdme rootfs '$rootfs' is not imported" >&2
        echo "hint: import it as ${SDME_CMD[*]} fs import quay.io/centos/centos:stream${release} --name $rootfs --install-packages=yes -v" >&2
        echo "hint: or set COPR_EL${release}_ROOTFS to one of the entries this host already has:" >&2
        echo "$FS_LIST" >&2
        exit 1
    fi
}

for target in "${MATRIX[@]}"; do
    release="${target%%:*}"
    package="${target#*:}"
    if [ "$release" = 9 ]; then
        rootfs="$COPR_EL9_ROOTFS"
    else
        rootfs="$COPR_EL10_ROOTFS"
    fi
    require_rootfs "$rootfs" "$release"
done

srpm_packages=(chan)
[ "$need_desktop" = 1 ] && srpm_packages+=(chan-desktop)
if [ "$PKG" = chan-desktop ]; then
    srpm_packages=(chan-desktop)
fi

SOURCE_REVISION="$(git -C "$REPO" rev-parse --verify HEAD)"
SOURCE_SNAPSHOT="$("$REPO/packaging/snapshot-tracked-tree.sh" \
    "$REPO" chan-copr-source)"
echo ">> source: base-revision=$SOURCE_REVISION content=tracked-working-tree snapshot=$SOURCE_SNAPSHOT" >&2

echo ">> preparing vendored SRPMs: ${srpm_packages[*]}" >&2
if [ "$REUSE_SRPM" = 1 ]; then
    for package in "${srpm_packages[@]}"; do
        find "$REPO/target/distros/srpm" -maxdepth 1 -type f \
            -name "$package-[0-9]*.src.rpm" -print -quit | grep -q . || {
            echo "error: REUSE_SRPM=1 but no $package SRPM exists" >&2
            exit 1
        }
    done
    echo ">> reusing existing SRPMs" >&2
else
    SOURCE_ROOT="$SOURCE_SNAPSHOT" SOURCE_REVISION="$SOURCE_REVISION" \
        "$SCRIPT_DIR/build-srpm.sh" "${srpm_packages[@]}"
fi

# `sdme new` deletes the container when its guest command exits non-zero, which
# would destroy exactly the container an operator wants to inspect. The guest
# wrapper always exits 0 and carries the real status out on the writable /out
# bind, so a failed target leaves its container alive for KEEP_CONTAINER=1.
#
# The wrapper hands the whole result tree back to the host user on every path
# it reaches, failure included: the container is gone once a target ends, so
# /out is the only diagnostic surface that survives a failure, and the host has
# to be able to read it and clear it on the next run. A killed or timed-out
# container never reaches the handback; that leaves root-owned 0644 files in a
# host-owned directory, which the host can still read and delete.
GUEST_RUN='status=0
/bin/bash /src/packaging/distros/copr/build-in-container.sh || status=$?
printf "%s\n" "$status" >/out/status
chown -R "$HOST_UID:$HOST_GID" /out ||
    echo "error: could not hand /out back to uid $HOST_UID" >&2
exit 0'

prepare_result_dir() {
    local dir="$1"
    # Redirections apply left to right, so the stderr redirect has to come
    # first for it to cover the failing one.
    mkdir -p "$dir" 2>/dev/null &&
        rm -f "$dir/status" 2>/dev/null &&
        : 2>/dev/null >"$dir/build.log" && return 0
    echo "error: cannot write results into $dir" >&2
    echo "hint: an older run may have left it owned by a container uid; clear it with: sudo rm -rf $OUT" >&2
    return 1
}

for target in "${MATRIX[@]}"; do
    release="${target%%:*}"
    package="${target#*:}"
    if [ "$release" = 9 ]; then
        rootfs="$COPR_EL9_ROOTFS"
    else
        rootfs="$COPR_EL10_ROOTFS"
    fi
    result_dir="$OUT/el${release}/${HOST_ARCH}/${package}"
    if ! prepare_result_dir "$result_dir"; then
        RESULTS+=("FAIL el${release} ${package} ${HOST_ARCH} (result directory unusable)")
        FAILED=1
        continue
    fi
    status_file="$result_dir/status"
    container="chan-copr-el${release}-${package}-${CONTAINER_ARCH}-$$"
    CONTAINERS+=("$container")

    echo ">> COPR validation: el${release} package=${package} rootfs=${rootfs} arch=${HOST_ARCH}" >&2
    "${SDME_CMD[@]}" rm -f "$container" >/dev/null 2>&1 || true
    sdme_status=0
    "${SDME_CMD[@]}" new --name "$container" -r "$rootfs" -t 180 \
        --storage btrfs --disk "$SDME_BUILD_DISK" \
        -b "$SOURCE_SNAPSHOT:/src:ro" \
        -b "$REPO/target/distros/srpm:/srpm:ro" \
        -b "$result_dir:/out" \
        -- /usr/bin/env PKG="$package" EL_RELEASE="$release" \
        HOST_UID="$HOST_UID" HOST_GID="$HOST_GID" \
        /bin/bash -c "$GUEST_RUN" \
        2>&1 | tee "$result_dir/build.log" || sdme_status=$?

    case "$sdme_status" in
        130|143)
            echo "error: '${SDME_CMD[*]} new' was interrupted (status $sdme_status), aborting the matrix" >&2
            exit "$sdme_status"
            ;;
    esac

    # sdme propagates the guest status verbatim, and the wrapper always exits
    # 0, so a non-zero status here means the wrapper never ran to its end.
    if [ "$sdme_status" -ne 0 ]; then
        status="$sdme_status"
    elif [ -r "$status_file" ]; then
        status="$(cat "$status_file")"
        case "$status" in
            ''|*[!0-9]*)
                echo "error: $status_file holds '$status' instead of an exit status" >&2
                status=1
                ;;
        esac
    else
        echo "error: sdme exited 0 but the guest wrapper wrote no $status_file" >&2
        status=1
    fi

    if [ "$status" = 0 ]; then
        RESULTS+=("PASS el${release} ${package} ${HOST_ARCH}")
    else
        RESULTS+=("FAIL el${release} ${package} ${HOST_ARCH} (status $status, log $result_dir/build.log)")
        FAILED=1
    fi

    # Each container overlay holds a full offline Rust release build, so drop it
    # before the next target starts rather than at the end of the matrix.
    if [ "$KEEP_CONTAINER" = 1 ]; then
        echo ">> keeping container $container for diagnosis" >&2
    else
        "${SDME_CMD[@]}" rm -f "$container" >/dev/null 2>&1 || true
    fi
done

# Every target appends exactly one result on every path that reaches here, and
# the matrix always holds at least one target, so RESULTS needs no empty guard.
echo ">> COPR sdme validation results:" >&2
for result in "${RESULTS[@]}"; do
    echo "   $result" >&2
done
echo ">> artifacts: $OUT" >&2
exit "$FAILED"
