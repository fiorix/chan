#!/usr/bin/env bash
# Run the tracked Nix package checks in a disposable Ubuntu sdme guest.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
SDME="${SDME:-sudo sdme}"
NIX_SDME_ROOTFS="${NIX_SDME_ROOTFS:-ubuntu}"
NIX_PACKAGE="${NIX_PACKAGE:-all}"
OUT="${OUT:-/var/tmp/chan-nix-sdme-check}"
OUT_INPUT="$OUT"
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
CONTAINER="chan-nix-check-$$"
STATUS_NAME="status"
SOURCE_SNAPSHOT=
CONTAINER_STARTED=0

# Selection is deliberately validated before the first sdme invocation.
case "$NIX_PACKAGE" in
    all|chan|chan-desktop) ;;
    *)
        echo "error: NIX_PACKAGE must be all, chan, or chan-desktop (got '$NIX_PACKAGE')" >&2
        exit 2
        ;;
esac

read -r -a SDME_CMD <<<"$SDME"
[ ${#SDME_CMD[@]} -gt 0 ] || {
    echo "error: SDME must name the sdme command" >&2
    exit 1
}

if ! OUT="$(realpath -m -- "$OUT_INPUT")"; then
    echo "error: could not resolve output directory '$OUT_INPUT'" >&2
    exit 1
fi
HOST_HOME=
if [ -n "${HOME:-}" ] && [ -d "$HOME" ]; then
    HOST_HOME="$(cd "$HOME" && pwd -P)"
fi
if [ "$REPO" = / ]; then
    echo "error: refusing to bind host root as the repository" >&2
    exit 1
fi
if [ "$OUT" = / ]; then
    echo "error: refusing to bind host root as the output directory" >&2
    exit 1
fi
if [ -n "$HOST_HOME" ] && { [ "$REPO" = "$HOST_HOME" ] || [ "$OUT" = "$HOST_HOME" ]; }; then
    echo "error: refusing to bind the host home directory" >&2
    exit 1
fi
if [[ "$OUT" == "$REPO" || "$OUT" == "$REPO/"* || "$REPO" == "$OUT/"* ]]; then
    echo "error: repository and output directory must not overlap ($REPO, $OUT)" >&2
    exit 1
fi
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd -P)"
if [[ "$OUT" == "$REPO" || "$OUT" == "$REPO/"* || "$REPO" == "$OUT/"* ]]; then
    echo "error: repository and output directory must not overlap ($REPO, $OUT)" >&2
    exit 1
fi

if ! FS_LIST="$("${SDME_CMD[@]}" fs ls 2>&1)"; then
    echo "error: '${SDME_CMD[*]} fs ls' failed:" >&2
    echo "$FS_LIST" >&2
    exit 1
fi
if ! awk -v name="$NIX_SDME_ROOTFS" \
    '$1 == name { found = 1 } END { exit !found }' <<<"$FS_LIST"; then
    echo "error: sdme rootfs '$NIX_SDME_ROOTFS' is not imported" >&2
    echo "hint: ${SDME_CMD[*]} fs import docker.io/ubuntu:26.04 --name $NIX_SDME_ROOTFS --install-packages=yes -v" >&2
    exit 1
fi

LOG_FILE="$OUT/build.log"
STATUS_FILE="$OUT/$STATUS_NAME"
rm -f "$LOG_FILE" "$STATUS_FILE"

cleanup() {
    local status="$?" cleanup_output step_status cleanup_status=0
    trap - EXIT INT TERM
    if [ "$CONTAINER_STARTED" -eq 1 ]; then
        if cleanup_output="$("${SDME_CMD[@]}" rm -f "$CONTAINER" 2>&1)"; then
            :
        else
            step_status=$?
            echo "error: could not remove sdme container '$CONTAINER' (status $step_status)" >&2
            [ -z "$cleanup_output" ] || printf '%s\n' "$cleanup_output" >&2
            cleanup_status="$step_status"
        fi
    fi
    if [ -n "$SOURCE_SNAPSHOT" ]; then
        case "$SOURCE_SNAPSHOT" in
            /var/tmp/chan-nix-source.*) ;;
            *)
                echo "error: refusing to remove unexpected source snapshot '$SOURCE_SNAPSHOT'" >&2
                [ "$cleanup_status" -ne 0 ] || cleanup_status=1
                SOURCE_SNAPSHOT=
                ;;
        esac
    fi
    if [ -n "$SOURCE_SNAPSHOT" ]; then
        if rm -rf -- "$SOURCE_SNAPSHOT"; then
            SOURCE_SNAPSHOT=
        else
            step_status=$?
            echo "error: could not remove source snapshot '$SOURCE_SNAPSHOT' (status $step_status)" >&2
            [ "$cleanup_status" -ne 0 ] || cleanup_status="$step_status"
        fi
    fi
    if [ "$status" -ne 0 ]; then
        exit "$status"
    fi
    exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ! git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "error: Nix sdme source must be a Git working tree" >&2
    exit 1
fi
if git -C "$REPO" ls-files --stage |
    awk '$1 == "160000" { found = 1 } END { exit !found }'; then
    echo "error: Nix sdme source snapshots do not support submodules" >&2
    exit 1
fi

SOURCE_SNAPSHOT="$(mktemp -d /var/tmp/chan-nix-source.XXXXXX)"
SOURCE_SNAPSHOT="$(cd "$SOURCE_SNAPSHOT" && pwd -P)"
if [[ "$OUT" == "$SOURCE_SNAPSHOT" || "$OUT" == "$SOURCE_SNAPSHOT/"* || "$SOURCE_SNAPSHOT" == "$OUT/"* ]]; then
    echo "error: source snapshot and output directory must not overlap ($SOURCE_SNAPSHOT, $OUT)" >&2
    exit 1
fi
(
    cd "$REPO"
    git ls-files -z --cached |
    while IFS= read -r -d '' path; do
        if [ -e "$path" ] || [ -L "$path" ]; then
            printf '%s\0' "$path"
        fi
    done |
    tar -c --null --verbatim-files-from --no-recursion \
        -T - -f -
) | tar -x -C "$SOURCE_SNAPSHOT" -f -

GUEST_RUN='set -uo pipefail
run_check() {
    local flake_ref="path:/src"
    if ! grep -Eq "^ID=(ubuntu|\"ubuntu\")$" /etc/os-release; then
        echo "error: Nix sdme check requires an Ubuntu guest" >&2
        return 1
    fi

    # $TMPDIR must exist before apt runs: package postinst scripts inherit it,
    # and update-ca-certificates fails outright when it points nowhere.
    install -d -m 0755 /var/tmp "$TMPDIR" "$NIX_BUILD_DIR" || return
    apt-get update || return
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates curl git make nix-bin nix-setup-systemd python3 || return
    systemd-tmpfiles --create /usr/lib/tmpfiles.d/nix-daemon.conf || return
    # Re-apply after the install: `q /var/tmp 1777` in
    # /usr/lib/tmpfiles.d/tmp.conf restores the world-writable mode during a
    # tmpfiles pass, and Nix refuses to build under a world-writable
    # temporary directory.
    install -d -m 0755 /var/tmp "$TMPDIR" "$NIX_BUILD_DIR" || return
    mkdir -p /etc/nix || return
    printf "%s\n" \
        "experimental-features = nix-command flakes" \
        "build-dir = $NIX_BUILD_DIR" >>/etc/nix/nix.conf || return
    export NIX_REMOTE=local

    echo ">> guest OS: $(. /etc/os-release && printf "%s %s" "$ID" "${VERSION_ID:-unknown}")"
    nix --version || return
    nix store ping || return
    cd /src || return

    if [ "$NIX_PACKAGE" = all ]; then
        make nix-check NIX=nix NIX_FLAKE="$flake_ref"
        return
    fi

    nix flake check --all-systems --no-build "$flake_ref" || return
    out="$(nix build --no-link --print-out-paths "$flake_ref#$NIX_PACKAGE")" || return
    if [ -z "$out" ] || [ "$(printf "%s\n" "$out" | wc -l)" -ne 1 ]; then
        echo "error: expected one Nix output path for $NIX_PACKAGE, got: $out" >&2
        return 1
    fi
    scripts/smoke-nix-package.sh "$out" "$NIX_PACKAGE"
}

status=0
run_check || status=$?
printf "%s\n" "$status" >/out/status
chown "$HOST_UID:$HOST_GID" /out/status /out/build.log 2>/dev/null || true
exit 0'

echo ">> Nix sdme check: package=$NIX_PACKAGE rootfs=$NIX_SDME_ROOTFS out=$OUT" >&2
CONTAINER_STARTED=1
set +e
"${SDME_CMD[@]}" new --name "$CONTAINER" -r "$NIX_SDME_ROOTFS" -t 180 \
    -b "$SOURCE_SNAPSHOT:/src:ro" -b "$OUT:/out" \
    -- /usr/bin/env HOST_UID="$HOST_UID" HOST_GID="$HOST_GID" \
    NIX_PACKAGE="$NIX_PACKAGE" TMPDIR=/var/tmp/chan-nix-tmp \
    NIX_BUILD_DIR=/var/tmp/chan-nix-build /bin/bash -c "$GUEST_RUN" \
    2>&1 | tee "$LOG_FILE"
pipeline_status=("${PIPESTATUS[@]}")
set -e
sdme_status="${pipeline_status[0]}"
tee_status="${pipeline_status[1]}"

case "$sdme_status" in
    130|143) exit "$sdme_status" ;;
esac
if [ "$sdme_status" -ne 0 ]; then
    echo "error: '${SDME_CMD[*]} new' failed with status $sdme_status" >&2
    exit "$sdme_status"
fi
if [ "$tee_status" -ne 0 ]; then
    echo "error: could not preserve guest output in $LOG_FILE" >&2
    exit "$tee_status"
fi
if [ ! -r "$STATUS_FILE" ]; then
    echo "error: Nix check guest wrote no status to $STATUS_FILE" >&2
    exit 1
fi
status="$(<"$STATUS_FILE")"
case "$status" in
    0) ;;
    ''|*[!0-9]*)
        echo "error: Nix check guest wrote invalid status '$status'" >&2
        exit 1
        ;;
    *) exit "$status" ;;
esac
