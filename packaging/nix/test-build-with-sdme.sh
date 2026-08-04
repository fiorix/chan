#!/usr/bin/env bash
# Contract test for build-with-sdme.sh. No container or Nix installation runs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRIVER="$SCRIPT_DIR/build-with-sdme.sh"
TMP_BASE="${TMPDIR:-/var/tmp}"
case "$TMP_BASE" in
    /tmp|/tmp/*)
        echo "error: contract-test temporary state must not use /tmp" >&2
        exit 1
        ;;
    /*) ;;
    *)
        echo "error: TMPDIR must be an absolute path" >&2
        exit 1
        ;;
esac
TMP="$(mktemp -d "$TMP_BASE/chan-nix-sdme-contract.XXXXXX")"
TEST_REPO="$TMP/repo"
TEST_FLAKE="path:$TEST_REPO"
STATE="$TMP/state"
BIN="$TMP/bin"
TEST_OUT="$TMP/output"
failures=0

cleanup() {
    rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TEST_REPO/packaging/nix" "$TEST_REPO/scripts" "$STATE" "$BIN"
ln -s "$DRIVER" "$TEST_REPO/packaging/nix/build-with-sdme.sh"

fail() {
    echo "not ok - $*" >&2
    failures=$((failures + 1))
}

assert_grep() {
    local pattern="$1" file="$2" message="$3"
    grep -Eq -- "$pattern" "$file" || fail "$message"
}

assert_not_grep() {
    local pattern="$1" file="$2" message="$3"
    if [ -e "$file" ] && grep -Eq -- "$pattern" "$file"; then
        fail "$message"
    fi
}

assert_status() {
    local expected="$1" actual="$2" message="$3"
    [ "$actual" -eq "$expected" ] || fail "$message (expected $expected, got $actual)"
}

run_driver() {
    local package="$1"
    shift
    rm -rf "$STATE/run" "$TEST_OUT"
    mkdir -p "$STATE/run"
    set +e
    env PATH="$BIN:/usr/bin:/bin" SDME="$BIN/sdme" \
        STUB_STATE="$STATE/run" NIX_PACKAGE="$package" OUT="$TEST_OUT" "$@" \
        "$TEST_REPO/packaging/nix/build-with-sdme.sh" \
        >"$STATE/run/driver.log" 2>&1
    RUN_STATUS=$?
    set -e
}

cat >"$BIN/sdme" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail

state="${STUB_STATE:?}"
printf '%s\n' "$*" >>"$state/calls"

case "${1:-}" in
    fs)
        if [ "${STUB_FS_FAIL:-0}" = 1 ]; then
            echo "stub fs failure" >&2
            exit 18
        fi
        if [ "${STUB_ROOTFS_MISSING:-0}" != 1 ]; then
            printf '%s ready\n' "${STUB_ROOTFS_NAME:-ubuntu}"
        fi
        ;;
    rm)
        printf '%s\n' "${3:-missing}" >>"$state/removed"
        if [ "${STUB_RM_FAIL:-0}" = 1 ]; then
            echo "stub cleanup failure" >&2
            exit 23
        fi
        rm -f "$state/container"
        ;;
    new)
        shift
        printf '%s\n' "$@" >"$state/new-args"
        : >"$state/binds"
        rootfs=
        repo=
        out=
        package=
        guest=
        while [ "$#" -gt 0 ]; do
            case "$1" in
                --name)
                    printf '%s\n' "$2" >"$state/container"
                    shift 2
                    ;;
                -r)
                    rootfs="$2"
                    shift 2
                    ;;
                -b)
                    printf '%s\n' "$2" >>"$state/binds"
                    case "$2" in
                        *:/src:ro) repo="${2%:/src:ro}" ;;
                        *:/src) repo="${2%:/src}" ;;
                        *:/out) out="${2%:/out}" ;;
                    esac
                    shift 2
                    ;;
                -t)
                    shift 2
                    ;;
                --)
                    shift
                    break
                    ;;
                *) shift ;;
            esac
        done
        printf '%s\n' "$rootfs" >"$state/rootfs"
        while [ "$#" -gt 0 ]; do
            case "$1" in
                HOST_UID=*|HOST_GID=*|NIX_PACKAGE=*|TMPDIR=*|NIX_REMOTE=*)
                    export "$1"
                    case "$1" in NIX_PACKAGE=*) package="${1#NIX_PACKAGE=}" ;; esac
                    ;;
            esac
            guest="$1"
            shift
        done
        printf '%s\n' "$package" >"$state/package"
        : >"$state/started"
        if [ "${STUB_SLEEP:-0}" = 1 ]; then
            trap 'exit 143' TERM
            trap 'exit 130' INT
            while :; do sleep 1; done
        fi

        printf 'ID=%s\nVERSION_ID="26.04"\n' "${STUB_GUEST_ID:-ubuntu}" >"$state/os-release"
        mkdir -p "$state/etc-nix"
        guest="${guest//\/etc\/os-release/$state/os-release}"
        guest="${guest//\/etc\/nix/$state/etc-nix}"
        guest="${guest//\/src/$repo}"
        guest="${guest//\/out/$out}"
        PATH="${STUB_BIN:?}:/usr/bin:/bin" bash -c "$guest"
        guest_status=$?
        if [ "${STUB_STATUS_MISSING:-0}" = 1 ]; then
            rm -f "$out/status"
        elif [ "${STUB_STATUS_INVALID:-0}" = 1 ]; then
            printf 'not-a-status\n' >"$out/status"
        fi
        if [ "${STUB_SDME_FAIL:-0}" = 1 ]; then
            exit 19
        fi
        exit "$guest_status"
        ;;
    *)
        echo "unexpected sdme command: $*" >&2
        exit 99
        ;;
esac
STUB

cat >"$BIN/apt-get" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${STUB_STATE:?}/apt"
exit 0
STUB

cat >"$BIN/install" <<'STUB'
#!/usr/bin/env bash
printf '%s|TMPDIR=%s\n' "$*" "${TMPDIR:-}" >>"${STUB_STATE:?}/install"
exit 0
STUB

cat >"$BIN/systemd-tmpfiles" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${STUB_STATE:?}/tmpfiles"
if [ "${STUB_STORE_SETUP_FAIL:-0}" = 1 ]; then
    echo "stub store setup failure" >&2
    exit 24
fi
: >"${STUB_STATE:?}/store-ready"
STUB

cat >"$BIN/nix" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${STUB_STATE:?}/nix"
printf 'TMPDIR=%s NIX_REMOTE=%s\n' "${TMPDIR:-}" "${NIX_REMOTE:-}" >>"${STUB_STATE:?}/nix-env"
if [ "${1:-}" = --version ]; then
    echo "nix (stub) 2.24.0"
    exit 0
fi
if [ "${1:-} ${2:-}" = "store ping" ]; then
    if [ ! -e "${STUB_STATE:?}/store-ready" ] || [ "${STUB_STORE_PING_FAIL:-0}" = 1 ]; then
        echo "stub store unavailable" >&2
        exit 25
    fi
    echo "Store URL: local"
    exit 0
fi
if [ "${1:-}" = build ]; then
    if [ "${STUB_GUEST_FAIL:-0}" = 1 ]; then
        exit 7
    fi
    package="${*: -1}"
    printf '/nix/store/stub-%s\n' "${package##*#}"
fi
STUB

cat >"$BIN/make" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${STUB_STATE:?}/make"
printf 'TMPDIR=%s NIX_REMOTE=%s\n' "${TMPDIR:-}" "${NIX_REMOTE:-}" >>"${STUB_STATE:?}/make-env"
if [ "${STUB_GUEST_FAIL:-0}" = 1 ]; then
    exit 7
fi
STUB

cat >"$BIN/chown" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${STUB_STATE:?}/chown"
exit 0
STUB

cat >"$TEST_REPO/scripts/smoke-nix-package.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${STUB_STATE:?}/smoke"
printf 'TMPDIR=%s NIX_REMOTE=%s\n' "${TMPDIR:-}" "${NIX_REMOTE:-}" >>"${STUB_STATE:?}/smoke-env"
STUB

chmod +x "$BIN/sdme" "$BIN/apt-get" "$BIN/install" "$BIN/systemd-tmpfiles" \
    "$BIN/nix" "$BIN/make" "$BIN/chown" \
    "$TEST_REPO/scripts/smoke-nix-package.sh"

export STUB_BIN="$BIN"

run_driver all
assert_status 0 "$RUN_STATUS" "the default all-package check succeeds"
assert_grep '^-r$' "$STATE/run/new-args" "sdme new uses explicit -r"
assert_grep '^ubuntu$' "$STATE/run/rootfs" "the default imported rootfs is selected"
assert_grep "^$TEST_REPO:/src:ro$" "$STATE/run/binds" "the repository bind is read-only"
assert_grep "^$TEST_OUT:/out$" "$STATE/run/binds" "the output bind is writable at /out"
if [ "$(wc -l <"$STATE/run/binds")" -ne 2 ]; then
    fail "the repository and sole output are the only host binds"
fi
assert_not_grep '^/:' "$STATE/run/binds" "host root is never bound"
assert_not_grep "^$HOME:" "$STATE/run/binds" "host home is never bound"
assert_grep "^nix-check NIX=nix NIX_FLAKE=$TEST_FLAKE$" "$STATE/run/make" "all delegates to make nix-check with the mounted path flake"
assert_grep '^all$' "$STATE/run/package" "all reaches the guest command"
assert_grep '^-d -m 1777 /var/tmp[|]TMPDIR=/var/tmp$' "$STATE/run/install" "guest temporary state is prepared under /var/tmp"
assert_grep '^install -y --no-install-recommends ca-certificates curl git make nix-bin nix-setup-systemd python3$' "$STATE/run/apt" "the declared Nix and smoke prerequisites are requested"
assert_grep '^--create /usr/lib/tmpfiles.d/nix-daemon.conf$' "$STATE/run/tmpfiles" "the Ubuntu Nix store layout is initialized"
assert_grep '^experimental-features = nix-command flakes$' "$STATE/run/etc-nix/nix.conf" "flakes are enabled inside the guest"
assert_grep '^build-dir = /var/tmp$' "$STATE/run/etc-nix/nix.conf" "Nix build directories stay off /tmp"
assert_grep '^store ping$' "$STATE/run/nix" "the local Nix store is checked before the build"
assert_grep '^TMPDIR=/var/tmp NIX_REMOTE=local$' "$STATE/run/nix-env" "Nix uses /var/tmp and the disposable local store"
assert_grep '^TMPDIR=/var/tmp NIX_REMOTE=local$' "$STATE/run/make-env" "the all-package check inherits the guest build environment"
assert_grep '^0$' "$TEST_OUT/status" "guest status is retained"
assert_grep 'guest OS: ubuntu 26.04' "$TEST_OUT/build.log" "combined guest output is retained"
assert_grep '^chan-nix-check-[0-9]+$' "$STATE/run/removed" "the PID-scoped container is removed on success"

run_driver chan
assert_status 0 "$RUN_STATUS" "the chan-only check succeeds"
assert_grep "^flake check --all-systems --no-build $TEST_FLAKE$" "$STATE/run/nix" "chan evaluates the mounted checkout as a path flake"
assert_grep "^build --no-link --print-out-paths $TEST_FLAKE#chan$" "$STATE/run/nix" "chan builds exactly its path-flake output"
assert_grep '^/nix/store/stub-chan chan$' "$STATE/run/smoke" "chan validates and smokes its output"
assert_grep '^TMPDIR=/var/tmp NIX_REMOTE=local$' "$STATE/run/smoke-env" "the package smoke stays off /tmp"
assert_not_grep 'chan-desktop' "$STATE/run/nix" "chan does not force chan-desktop"

run_driver chan-desktop
assert_status 0 "$RUN_STATUS" "the chan-desktop-only check succeeds"
assert_grep "^build --no-link --print-out-paths $TEST_FLAKE#chan-desktop$" "$STATE/run/nix" "chan-desktop builds exactly its path-flake output"
assert_grep '^/nix/store/stub-chan-desktop chan-desktop$' "$STATE/run/smoke" "chan-desktop validates and smokes its output"

run_driver invalid
assert_status 2 "$RUN_STATUS" "an invalid package selection is rejected"
if [ -e "$STATE/run/calls" ]; then
    fail "an invalid package selection invokes sdme"
fi

run_driver all HOME="$TEST_REPO"
assert_status 1 "$RUN_STATUS" "a repository at the host home is rejected"
assert_grep 'refusing to bind the host home directory' "$STATE/run/driver.log" "the host-home repository refusal is diagnosed"
if [ -e "$STATE/run/calls" ]; then
    fail "a repository at the host home invokes sdme"
fi

run_driver all OUT=/
assert_status 1 "$RUN_STATUS" "host root is rejected as the output directory"
assert_grep 'refusing to bind host root as the output directory' "$STATE/run/driver.log" "the host-root output refusal is diagnosed"
if [ -e "$STATE/run/calls" ]; then
    fail "a host-root output directory invokes sdme"
fi

mkdir -p "$TMP/home-output"
run_driver all HOME="$TMP/home-output" OUT="$TMP/home-output"
assert_status 1 "$RUN_STATUS" "a host-home output directory is rejected"
if [ -e "$STATE/run/calls" ]; then
    fail "a host-home output directory invokes sdme"
fi

run_driver all OUT="$TEST_REPO"
assert_status 1 "$RUN_STATUS" "an output equal to the repository is rejected"
assert_grep 'repository and output directory must not overlap' "$STATE/run/driver.log" "equal repository and output paths are diagnosed"
if [ -e "$STATE/run/calls" ]; then
    fail "an output equal to the repository invokes sdme"
fi

run_driver all OUT="$TEST_REPO/nix-output"
assert_status 1 "$RUN_STATUS" "an output below the repository is rejected"
assert_grep 'repository and output directory must not overlap' "$STATE/run/driver.log" "a repository-contained output is diagnosed"
if [ -e "$STATE/run/calls" ]; then
    fail "an output below the repository invokes sdme"
fi
if [ -e "$TEST_REPO/nix-output" ]; then
    fail "rejecting a repository-contained output creates it"
fi

ln -s "$TEST_REPO" "$TMP/repo-alias"
run_driver all OUT="$TMP/repo-alias/nix-output"
assert_status 1 "$RUN_STATUS" "an output below a repository symlink is rejected"
assert_grep 'repository and output directory must not overlap' "$STATE/run/driver.log" "a symlinked repository-contained output is diagnosed"
if [ -e "$STATE/run/calls" ]; then
    fail "an output below a repository symlink invokes sdme"
fi
if [ -e "$TEST_REPO/nix-output" ]; then
    fail "rejecting a symlinked repository-contained output creates it"
fi

run_driver all OUT="$TMP"
assert_status 1 "$RUN_STATUS" "an output containing the repository is rejected"
assert_grep 'repository and output directory must not overlap' "$STATE/run/driver.log" "an output containing the repository is diagnosed"
if [ -e "$STATE/run/calls" ]; then
    fail "an output containing the repository invokes sdme"
fi

run_driver all STUB_ROOTFS_MISSING=1
assert_status 1 "$RUN_STATUS" "a missing rootfs fails preflight"
assert_grep 'hint: .*/sdme fs import docker.io/ubuntu:26.04 --name ubuntu --install-packages=yes -v' "$STATE/run/driver.log" "the missing-rootfs error prints the exact import hint"
assert_not_grep '^new ' "$STATE/run/calls" "a missing rootfs never starts a container"

run_driver all STUB_FS_FAIL=1
assert_status 1 "$RUN_STATUS" "a rootfs-list failure fails preflight"
assert_grep 'stub fs failure' "$STATE/run/driver.log" "a rootfs-list failure retains the sdme diagnostic"
assert_not_grep '^new ' "$STATE/run/calls" "a rootfs-list failure never starts a container"

run_driver all NIX_SDME_ROOTFS=jammy STUB_ROOTFS_NAME=jammy STUB_GUEST_ID=fedora
assert_status 1 "$RUN_STATUS" "a non-Ubuntu guest is refused"
if [ -e "$STATE/run/apt" ]; then
    fail "guest identity is checked before package installation"
fi
assert_grep '^chan-nix-check-[0-9]+$' "$STATE/run/removed" "the container is removed after identity refusal"

run_driver all STUB_GUEST_FAIL=1
assert_status 7 "$RUN_STATUS" "guest command status propagates when sdme returns zero"
assert_grep '^7$' "$TEST_OUT/status" "a failing guest status is retained"
assert_grep '^chan-nix-check-[0-9]+$' "$STATE/run/removed" "the container is removed after guest failure"

run_driver all STUB_STORE_SETUP_FAIL=1
assert_status 24 "$RUN_STATUS" "a failed Nix store setup propagates"
assert_grep 'stub store setup failure' "$TEST_OUT/build.log" "a failed Nix store setup is retained in the build log"
assert_not_grep '^flake check|^build ' "$STATE/run/nix" "a failed store setup prevents Nix evaluation and builds"

run_driver all STUB_STORE_PING_FAIL=1
assert_status 25 "$RUN_STATUS" "an unusable local Nix store propagates"
assert_grep 'stub store unavailable' "$TEST_OUT/build.log" "an unusable local store is diagnosed"
assert_not_grep '^flake check|^build ' "$STATE/run/nix" "an unusable local store prevents evaluation and builds"

run_driver all STUB_SDME_FAIL=1
assert_status 19 "$RUN_STATUS" "sdme infrastructure failure propagates"
assert_grep '^chan-nix-check-[0-9]+$' "$STATE/run/removed" "the container is removed after sdme failure"

run_driver all STUB_STATUS_MISSING=1
assert_status 1 "$RUN_STATUS" "a missing guest status fails"
assert_grep 'wrote no status' "$STATE/run/driver.log" "the missing guest status is diagnosed"

run_driver all STUB_STATUS_INVALID=1
assert_status 1 "$RUN_STATUS" "an invalid guest status fails"
assert_grep "wrote invalid status 'not-a-status'" "$STATE/run/driver.log" "the invalid guest status is diagnosed"
assert_grep '^chan-nix-check-[0-9]+$' "$STATE/run/removed" "the container is removed after invalid status"

run_driver all STUB_RM_FAIL=1
assert_status 23 "$RUN_STATUS" "cleanup failure fails an otherwise successful run"
assert_grep "could not remove sdme container 'chan-nix-check-[0-9]+' \(status 23\)" "$STATE/run/driver.log" "cleanup failure is diagnosed"
assert_grep '^stub cleanup failure$' "$STATE/run/driver.log" "the cleanup command diagnostic is retained"

run_driver all STUB_GUEST_FAIL=1 STUB_RM_FAIL=1
assert_status 7 "$RUN_STATUS" "cleanup failure does not mask a guest failure"
assert_grep "could not remove sdme container 'chan-nix-check-[0-9]+' \(status 23\)" "$STATE/run/driver.log" "cleanup failure is reported beside a guest failure"

rm -rf "$STATE/run" "$TEST_OUT"
mkdir -p "$STATE/run"
set +e
setsid env PATH="$BIN:/usr/bin:/bin" SDME="$BIN/sdme" STUB_BIN="$BIN" \
    STUB_STATE="$STATE/run" STUB_SLEEP=1 NIX_PACKAGE=all OUT="$TEST_OUT" \
    "$TEST_REPO/packaging/nix/build-with-sdme.sh" \
    >"$STATE/run/driver.log" 2>&1 &
signal_pid=$!
for _ in $(seq 1 100); do
    [ -e "$STATE/run/started" ] && break
    sleep 0.02
done
if [ ! -e "$STATE/run/started" ]; then
    fail "the signal-cleanup fixture did not start"
    kill -TERM "$signal_pid" 2>/dev/null || true
else
    kill -TERM -- "-$signal_pid"
fi
wait "$signal_pid"
signal_status=$?
set -e
assert_status 143 "$signal_status" "SIGTERM propagates as status 143"
assert_grep '^chan-nix-check-[0-9]+$' "$STATE/run/removed" "the container is removed after SIGTERM"

assert_not_grep 'cachix[[:space:]]+(push|pin)|git[[:space:]]+(push|tag)|gh[[:space:]]+release|publish-downstream' "$DRIVER" "the driver contains no publication command"
assert_not_grep 'nixos/nix|oci-mode|curl[[:space:]].*sh' "$DRIVER" "the driver has no OCI-app or curl-installer fallback"
assert_not_grep '(^|[="[:space:]])/tmp(/|["[:space:]]|$)' "$DRIVER" "the driver never selects /tmp for guest build state"

if [ "$failures" -ne 0 ]; then
    echo "FAIL: $failures contract assertion(s) failed" >&2
    exit 1
fi
echo "ok - packaging/nix/build-with-sdme.sh contract"
