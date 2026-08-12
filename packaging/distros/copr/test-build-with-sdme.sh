#!/usr/bin/env bash
# Check build-with-sdme.sh's host-side control flow against a stub sdme.
#
# The real matrix needs imported CentOS rootfs images and hours of offline RPM
# rebuilds, so the parts that are easy to get wrong and expensive to reach
# (per-target status capture, the guest wrapper reaching its result handback,
# a re-run after a failed target, an unusable result directory, interrupt
# handling, knob and preflight validation) are exercised here. A stub sdme
# reproduces the two container behaviours the driver is built around,
# confirmed by a live sdme probe on 2026-07-19:
#
#   - `sdme new` propagates the guest exit status and deletes the container
#     when it is non-zero, while the writable host bind survives.
#   - `-- /usr/bin/env VAR=... /bin/bash -c '<multiline>'` delivers the script
#     as one argv element.
#
# The driver under test is symlinked into a throwaway repo skeleton, so it is
# the real file; only its guest side and sdme are stubs.
#
# What this cannot cover: the stub guest runs as the host user, so every file
# it writes is host-owned before the wrapper runs and no assertion here can see
# a uid change. A chown shim on the guest's PATH records the handback instead,
# which gates the wrapper reaching it on the failing path as well as the
# passing one. That the chown crosses uids for real is a property of a root
# guest against a host bind, and only a real container run shows it.
#
# Run: packaging/distros/copr/test-build-with-sdme.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRIVER="$SCRIPT_DIR/build-with-sdme.sh"
SRPM_DRIVER="$SCRIPT_DIR/build-srpm.sh"
MAKE_SRPM="$SCRIPT_DIR/make-srpm.sh"
SNAPSHOT_HELPER="$SCRIPT_DIR/../../snapshot-tracked-tree.sh"
BUILD_POLICY="$SCRIPT_DIR/../../sdme-build-policy.sh"
WORK="$(mktemp -d)"
REPO="$WORK/repo"
COPR_DIR="$REPO/packaging/distros/copr"
export STUB_STATE="$WORK/state"
FAILURES=0

# shellcheck disable=SC2329  # runs from the EXIT trap
cleanup() {
    chmod -R u+rwX "$WORK" 2>/dev/null || true
    rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$COPR_DIR" "$REPO/packaging" "$WORK/bin" "$STUB_STATE/containers" "$STUB_STATE/shim"
ln -s "$DRIVER" "$COPR_DIR/build-with-sdme.sh"
ln -s "$SNAPSHOT_HELPER" "$REPO/packaging/snapshot-tracked-tree.sh"
ln -s "$BUILD_POLICY" "$REPO/packaging/sdme-build-policy.sh"
: >"$STUB_STATE/chown.log"
printf '%s\n' centos-stream-9 centos-stream-10 >"$STUB_STATE/rootfs"

cat >"$WORK/bin/sdme" <<'STUB'
#!/usr/bin/env bash
# Stub sdme: enough of `fs ls`, `rm -f`, and `new` to drive the host side.
set -uo pipefail
state="${STUB_STATE:?}"
cmd="${1:?stub sdme: no subcommand}"
shift
fail() {
    echo "stub sdme: $1" >&2
    exit 64
}
case "$cmd" in
    fs)
        [ "${1:-}" = ls ] || fail "unsupported fs subcommand ${1:-}"
        cat "$state/rootfs"
        ;;
    rm)
        [ "${1:-}" = -f ] || fail "unsupported rm form"
        [ -e "$state/containers/$2" ] || exit 1
        rm -f "$state/containers/$2"
        ;;
    new)
        printf '%s\n' "$@" >>"$state/new-args"
        [ "${1:-}" = --name ] || fail "new requires --name"
        name="${2:?stub sdme: no container name}"
        shift 2
        binds=()
        while [ $# -gt 0 ]; do
            case "$1" in
                -r|-t|--storage|--disk) shift 2 ;;
                -b) binds+=("$2"); shift 2 ;;
                --) shift; break ;;
                *) fail "unexpected argument $1" ;;
            esac
        done
        printf '%s\n' "${binds[@]}" >>"$state/binds"
        for bind in "${binds[@]}"; do
            case "$bind" in
                *:/src:ro) printf '%s\n' "${bind%:/src:ro}" >>"$state/sources" ;;
            esac
        done
        [ "${1:-}" = /usr/bin/env ] || fail "guest argv does not start with /usr/bin/env"
        shift
        envs=()
        while [ $# -gt 0 ] && [ "$1" != /bin/bash ]; do
            envs+=("$1")
            shift
        done
        [ "${1:-}" = /bin/bash ] || fail "guest argv has no /bin/bash"
        shift
        [ "${1:-}" = -c ] || fail "guest argv has no -c"
        shift
        script="${1:?stub sdme: no guest script}"
        shift
        [ $# -eq 0 ] || fail "guest script did not arrive as one argv element"
        case "$script" in
            *$'\n'*) ;;
            *) fail "guest script lost its line structure" ;;
        esac

        # Retarget the guest paths at their host side, longest first so /srpm
        # survives the /src substitution.
        out=""
        while read -r _ bind; do
            host="${bind%%:*}"
            guest="${bind#*:}"
            guest="${guest%%:*}"
            script="${script//$guest/$host}"
            [ "$guest" = /out ] && out="$host"
        done < <(printf '%s\n' "${binds[@]}" | awk -F: '{ print length($2), $0 }' | sort -rn)
        [ -n "$out" ] || fail "no /out bind"

        printf '%s\n' "$name" >>"$state/started"
        : >"$state/containers/$name"
        [ -n "${STUB_SLEEP:-}" ] && sleep "$STUB_SLEEP"
        if [ -n "${STUB_EXIT:-}" ]; then
            rm -f "$state/containers/$name"
            exit "$STUB_EXIT"
        fi
        env "${envs[@]}" STUB_OUT="$out" PATH="$state/shim:$PATH" \
            /bin/bash -c "$script"
        status=$?
        if [ -n "${STUB_EAT_STATUS:-}" ]; then
            rm -f "$out/status"
            status=0
        fi
        # A non-zero guest status takes the container with it.
        [ "$status" -eq 0 ] || rm -f "$state/containers/$name"
        exit "$status"
        ;;
    *)
        fail "unsupported subcommand $cmd"
        ;;
esac
STUB

cat >"$WORK/bin/sudo" <<'STUB'
#!/usr/bin/env bash
# Stub sudo: runs the command, so a missing sdme surfaces the way it does on a
# host where sudo itself always exists.
exec "$@"
STUB

cat >"$STUB_STATE/shim/chown" <<'STUB'
#!/usr/bin/env bash
# Stub chown on the guest's PATH: the stub guest already runs as the host user,
# so a real chown would be an invisible no-op. Record the call so the harness
# can see whether the wrapper reached its handback.
printf '%s\n' "$*" >>"${STUB_STATE:?}/chown.log"
STUB

cat >"$COPR_DIR/build-srpm.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/target/distros/srpm"
mkdir -p "$dir"
for pkg in "$@"; do
    : >"$dir/$pkg-0.0.0-1.src.rpm"
done
# Hold the driver here on request, so a signal can be delivered while it is
# between phases instead of inside the sdme pipeline.
if [ -n "${STUB_SRPM_HOLD:-}" ]; then
    : >"${STUB_STATE:?}/srpm-holding"
    for _ in $(seq 1 200); do
        [ -e "$STUB_STATE/srpm-release" ] && break
        sleep 0.05
    done
fi
STUB

cat >"$COPR_DIR/build-in-container.sh" <<'STUB'
#!/usr/bin/env bash
# Stub guest: writes the artifacts a real run leaves behind, then exits with
# the status the test asked for. $STUB_OUT stands in for the /out bind.
set -uo pipefail
out="${STUB_OUT:?}"
state="${STUB_STATE:?}"
: >"$out/$PKG-0.0.0-1.el$EL_RELEASE.$(uname -m).rpm"
printf 'use dnf upgrade\n' >"$out/upgrade.out"
status_file="$state/guest-status-$EL_RELEASE-$PKG"
[ -r "$status_file" ] && exit "$(cat "$status_file")"
exit "${STUB_GUEST_STATUS:-0}"
STUB

chmod +x "$WORK/bin/sdme" "$WORK/bin/sudo" "$STUB_STATE/shim/chown" \
    "$COPR_DIR/build-srpm.sh" "$COPR_DIR/build-in-container.sh"

git init -q "$REPO"
printf '/target/\n' >"$REPO/.gitignore"
git -C "$REPO" add -- .
git -C "$REPO" -c user.name=contract \
    -c user.email=contract@example.invalid commit -qm baseline

ok() { echo "ok   $1"; }
bad() {
    echo "FAIL $1"
    FAILURES=$((FAILURES + 1))
}
assert_status() {
    if [ "$1" = "$2" ]; then
        ok "$3 (exit $2)"
    else
        bad "$3: expected exit $1, got $2"
    fi
}
assert_grep() {
    if grep -qF -- "$1" "$2"; then
        ok "$3"
    else
        bad "$3: '$1' missing from $2"
    fi
}
assert_present() {
    if [ -e "$1" ]; then
        ok "$2"
    else
        bad "$2: $1 is missing"
    fi
}

run_driver() {
    # run_driver <log name> <results name> [VAR=VALUE ...]
    local name="$1" out="$2"
    shift 2
    rm -f "$STUB_STATE/started" "$STUB_STATE/new-args" \
        "$STUB_STATE/binds" "$STUB_STATE/sources"
    : >"$STUB_STATE/chown.log"
    LOG="$WORK/$name.log"
    OUT_DIR="$WORK/out-$out"
    env SDME="$WORK/bin/sdme" OUT="$OUT_DIR" "$@" \
        "$COPR_DIR/build-with-sdme.sh" >"$LOG" 2>&1
    return $?
}

echo "== all targets pass"
run_driver pass pass PKG=all COPR_RELEASE=all
assert_status 0 $? "clean matrix succeeds"
assert_grep "PASS el9 chan" "$LOG" "el9 chan reported PASS"
assert_grep "PASS el10 chan-desktop" "$LOG" "el10 chan-desktop reported PASS"
assert_status 3 "$(wc -l <"$STUB_STATE/started")" "three targets ran"
assert_status 3 "$(grep -c '^--storage$' "$STUB_STATE/new-args")" "every target passes an explicit storage backend"
assert_status 3 "$(grep -c '^btrfs$' "$STUB_STATE/new-args")" "every target selects btrfs storage"
assert_status 3 "$(grep -c '^--disk$' "$STUB_STATE/new-args")" "every target passes a disk cap"
assert_status 3 "$(grep -c '^44G$' "$STUB_STATE/new-args")" "every target applies the build disk cap"
assert_status 0 "$(grep -cF "$REPO:/src:ro" "$STUB_STATE/binds" || true)" "the live worktree is never mounted"
assert_status 3 "$(grep -cE '^/var/tmp/chan-copr-source\..*:/src:ro$' "$STUB_STATE/binds")" "every target mounts the isolated source snapshot"
source_snapshot="$(head -1 "$STUB_STATE/sources")"
if [ -e "$source_snapshot" ]; then
    bad "the isolated source snapshot survives a normal driver exit"
else
    ok "the isolated source snapshot is removed after the run"
fi
assert_status 0 "$(ls "$STUB_STATE/containers" | wc -l)" "no container survives a clean run"
assert_status 3 "$(wc -l <"$STUB_STATE/chown.log")" "every target's wrapper reaches the result handback"

echo "== one target fails"
printf '7\n' >"$STUB_STATE/guest-status-10-chan"
run_driver fail1 fail PKG=chan COPR_RELEASE=all KEEP_CONTAINER=1
assert_status 1 $? "a failed target fails the matrix"
assert_grep "PASS el9 chan" "$LOG" "the earlier target still passes"
assert_grep "FAIL el10 chan $(uname -m) (status 7" "$LOG" "the failed target reports the guest status"
# A container file is named after its target, so the glob answers whether the
# el10 chan container is still there. An unmatched glob expands to itself,
# which the -e test rejects.
kept_container=0
for container in "$STUB_STATE/containers"/*-el10-chan-*; do
    [ -e "$container" ] || continue
    kept_container=1
    break
done
if [ "$kept_container" -eq 1 ]; then
    ok "the failed target's container survives KEEP_CONTAINER=1"
else
    bad "the failed target's container was deleted under KEEP_CONTAINER=1"
fi
FAIL_DIR="$OUT_DIR/el10/$(uname -m)/chan"
assert_present "$FAIL_DIR/build.log" "the failed target leaves a build log"
assert_present "$FAIL_DIR/upgrade.out" "the failed target leaves its guest artifacts"
assert_grep "-R $(id -u):$(id -g) $FAIL_DIR" "$STUB_STATE/chown.log" \
    "the wrapper hands the failed target's whole result tree back"
rm -f "$STUB_STATE/containers"/*
kept_source_snapshot="$(head -1 "$STUB_STATE/sources")"
case "$kept_source_snapshot" in
    /var/tmp/chan-copr-source.*) rm -rf -- "$kept_source_snapshot" ;;
    *) bad "retained container source has an unexpected path: $kept_source_snapshot" ;;
esac

echo "== re-run over a failed run's results"
run_driver fail2 fail PKG=chan COPR_RELEASE=all REUSE_SRPM=1
assert_status 1 $? "the failure reproduces on the second run"
assert_grep "reusing existing SRPMs" "$LOG" "REUSE_SRPM=1 skips the SRPM build"
rm -f "$STUB_STATE/guest-status-10-chan"
run_driver fixed fail PKG=chan COPR_RELEASE=all REUSE_SRPM=1
assert_status 0 $? "a fixed target passes on re-run over the same results"
assert_grep "PASS el10 chan" "$LOG" "the stale FAIL status is not reused"

echo "== the guest wrapper never ran"
run_driver nostatus nostatus PKG=chan COPR_RELEASE=9 STUB_EAT_STATUS=1
assert_status 1 $? "a missing status file with sdme exit 0 is a failure"
assert_grep "wrote no" "$LOG" "the missing status file is reported"

echo "== interrupt"
# The operator's Ctrl-C reaches the whole process group, so cover both halves:
# the driver taking the signal itself, and sdme dying on it first. Job control
# gives the driver its own process group and stops bash from making a
# background job ignore SIGINT, which is what a terminal run looks like.
rm -f "$STUB_STATE/started"
set -m
env SDME="$WORK/bin/sdme" OUT="$WORK/out-int" PKG=chan COPR_RELEASE=all \
    STUB_SLEEP=2 "$COPR_DIR/build-with-sdme.sh" >"$WORK/int.log" 2>&1 &
int_pid=$!
set +m
for _ in $(seq 1 100); do
    [ -s "$STUB_STATE/started" ] && break
    sleep 0.1
done
kill -INT -- -"$int_pid"
wait "$int_pid"
assert_status 130 $? "SIGINT to the driver aborts with 130"
assert_status 1 "$(wc -l <"$STUB_STATE/started")" "the matrix stops at the interrupted target"
assert_grep "aborting the matrix" "$WORK/int.log" "the abort is announced"

run_driver int2 int2 PKG=chan COPR_RELEASE=all STUB_EXIT=130
assert_status 130 $? "an interrupted sdme aborts with 130"
assert_status 1 "$(wc -l <"$STUB_STATE/started")" "no later target is started"
assert_grep "was interrupted" "$LOG" "the interrupted sdme is named"

# Both interrupts above reach sdme, where the loop's own 130/143 guard can act
# on the pipeline status. Deliver one where only the signal handler can act:
# to the driver alone, while it is held in the SRPM phase.
rm -f "$STUB_STATE/started" "$STUB_STATE/srpm-holding" "$STUB_STATE/srpm-release"
set -m
env SDME="$WORK/bin/sdme" OUT="$WORK/out-int3" PKG=chan COPR_RELEASE=all \
    STUB_SRPM_HOLD=1 "$COPR_DIR/build-with-sdme.sh" >"$WORK/int3.log" 2>&1 &
int3_pid=$!
set +m
for _ in $(seq 1 100); do
    [ -e "$STUB_STATE/srpm-holding" ] && break
    sleep 0.1
done
kill -INT "$int3_pid"
: >"$STUB_STATE/srpm-release"
wait "$int3_pid"
assert_status 130 $? "SIGINT outside the sdme pipeline aborts with 130"
assert_grep "aborting the matrix" "$WORK/int3.log" "the abort is announced"
if [ -s "$STUB_STATE/started" ]; then
    bad "a target started after an interrupt outside the sdme pipeline"
else
    ok "no target starts after an interrupt outside the sdme pipeline"
fi

echo "== knob and preflight validation"
run_driver knob1 knob1 KEEP_CONTAINER=yes
assert_status 1 $? "KEEP_CONTAINER=yes is rejected"
assert_grep "KEEP_CONTAINER must be 0 or 1" "$LOG" "the rejection names the knob"
run_driver knob2 knob2 REUSE_SRPM=true
assert_status 1 $? "REUSE_SRPM=true is rejected"
assert_grep "REUSE_SRPM must be 0 or 1" "$LOG" "the rejection names the knob"

PATH="$WORK/bin:$PATH" run_driver nosdme nosdme SDME="sudo definitely-not-sdme"
assert_status 1 $? "a missing sdme behind sudo fails the preflight"
assert_grep "fs ls' failed" "$LOG" "the preflight probes through the sudo form"

run_driver norootfs norootfs PKG=chan COPR_RELEASE=9 COPR_EL9_ROOTFS=not-imported
assert_status 1 $? "an unimported rootfs stops the run"
assert_grep "centos-stream-10" "$LOG" "the error lists the host's rootfs entries"

echo "== unwritable results"
STALE="$WORK/out-stale/el9/$(uname -m)/chan"
mkdir -p "$STALE"
: >"$STALE/status"
chmod 500 "$STALE"
env SDME="$WORK/bin/sdme" OUT="$WORK/out-stale" PKG=chan COPR_RELEASE=all \
    "$COPR_DIR/build-with-sdme.sh" >"$WORK/stale.log" 2>&1
assert_status 1 $? "an unclearable result directory fails its target"
assert_grep "cannot write results into" "$WORK/stale.log" "the error names the directory"
assert_grep "sudo rm -rf" "$WORK/stale.log" "the error says how to clear it"
assert_grep "FAIL el9 chan" "$WORK/stale.log" "the unusable directory is reported as a target failure"
assert_grep "PASS el10 chan" "$WORK/stale.log" "the rest of the matrix still runs"
chmod 700 "$STALE"

# A result directory the host can clear but not rewrite takes the same path,
# and the probe's own redirection error must not precede the message.
LOCKED="$WORK/out-locked/el9/$(uname -m)/chan"
mkdir -p "$LOCKED"
: >"$LOCKED/build.log"
chmod 400 "$LOCKED/build.log"
env SDME="$WORK/bin/sdme" OUT="$WORK/out-locked" PKG=chan COPR_RELEASE=9 \
    "$COPR_DIR/build-with-sdme.sh" >"$WORK/locked.log" 2>&1
assert_status 1 $? "an unwritable result log fails its target"
if grep -q "Permission denied" "$WORK/locked.log"; then
    bad "the probe leaks a raw redirection error before its own message"
else
    ok "the probe reports the directory without a raw redirection error"
fi
chmod 600 "$LOCKED/build.log"

echo "== SRPM external tarball staging"
MAKE_SRPM_REPO="$WORK/make-srpm-repo"
MAKE_SRPM_DIR="$MAKE_SRPM_REPO/packaging/distros/copr"
MAKE_SRPM_EXTERNAL="$WORK/make-srpm-external"
mkdir -p "$MAKE_SRPM_DIR" "$MAKE_SRPM_REPO/packaging/distros/fedora" \
    "$MAKE_SRPM_EXTERNAL" "$WORK/make-srpm-out"
ln -s "$MAKE_SRPM" "$MAKE_SRPM_DIR/make-srpm.sh"
cat >"$MAKE_SRPM_REPO/packaging/distros/fedora/chan.spec" <<'EOF'
%global upstream_version 0.0.0
Name: chan
Source0: chan-vendored-%{upstream_version}.tar.xz
EOF
printf 'vendored source\n' >"$MAKE_SRPM_EXTERNAL/chan-vendored-1.2.3.tar.xz"

cat >"$WORK/bin/rpmbuild" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"${STUB_MAKE_SRPM_STATE:?}/args"
: >"$STUB_MAKE_SRPM_STATE/invoked"
STUB
chmod +x "$WORK/bin/rpmbuild"

STUB_MAKE_SRPM_STATE="$WORK/make-srpm-out" PATH="$WORK/bin:$PATH" \
    "$MAKE_SRPM_DIR/make-srpm.sh" \
    --repo "$MAKE_SRPM_REPO" \
    --spec "$MAKE_SRPM_REPO/packaging/distros/fedora/chan.spec" \
    --outdir "$WORK/make-srpm-out" \
    --tarball "$MAKE_SRPM_EXTERNAL/chan-vendored-1.2.3.tar.xz" \
    >"$WORK/make-srpm.log" 2>&1
assert_status 0 $? "an external tarball builds from a fresh tracked-source copy"
assert_present "$WORK/make-srpm-out/invoked" "rpmbuild runs after external tarball staging"
assert_grep "%global upstream_version 1.2.3" \
    "$MAKE_SRPM_REPO/target/distros/chan.spec" \
    "the container-local spec records the external tarball version"
assert_grep "_sourcedir $MAKE_SRPM_EXTERNAL" "$WORK/make-srpm-out/args" \
    "rpmbuild reads Source0 from the external read-only bind"
if [ -e "$MAKE_SRPM_REPO/target/distros/chan-vendored-1.2.3.tar.xz" ]; then
    bad "the external tarball is copied into the container-local source tree"
else
    ok "the external tarball is not copied into the container-local source tree"
fi

echo "== SRPM container mount boundary"
SRPM_REPO="$WORK/srpm-repo"
SRPM_DIR="$SRPM_REPO/packaging/distros/copr"
mkdir -p "$SRPM_DIR" "$SRPM_REPO/packaging/distros/fedora" \
    "$SRPM_REPO/packaging" "$WORK/srpm-state"
ln -s "$SRPM_DRIVER" "$SRPM_DIR/build-srpm.sh"
ln -s "$SNAPSHOT_HELPER" "$SRPM_REPO/packaging/snapshot-tracked-tree.sh"
printf 'Name: chan\n' >"$SRPM_REPO/packaging/distros/fedora/chan.spec"

cat >"$SRPM_REPO/packaging/distros/mkdist" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
out=
while [ "$#" -gt 0 ]; do
    case "$1" in
        --repo|--rev) shift 2 ;;
        --outdir) out="$2"; shift 2 ;;
        *) exit 64 ;;
    esac
done
mkdir -p "$out"
tarball="$out/chan-vendored-0.0.0.tar.xz"
: >"$tarball"
printf '%s\n' "$tarball"
STUB

cat >"$SRPM_DIR/make-srpm.sh" <<'STUB'
#!/usr/bin/env bash
exit 99
STUB

cat >"$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
state="${STUB_SRPM_STATE:?}"
[ "${1:-}" = run ] || exit 64
shift
binds=()
while [ "$#" -gt 0 ]; do
    case "$1" in
        --rm) shift ;;
        -v) binds+=("$2"); shift 2 ;;
        *) image="$1"; shift; break ;;
    esac
done
printf '%s\n' "${binds[@]}" >"$state/binds"
printf '%s\n' "$image" >"$state/image"
printf '%s\n' "$*" >"$state/guest"
out=
for bind in "${binds[@]}"; do
    case "$bind" in
        *:/src:ro) printf '%s\n' "${bind%:/src:ro}" >"$state/source" ;;
        *:/out) out="${bind%:/out}" ;;
    esac
done
[ -n "$out" ] || exit 65
mkdir -p "$out"
: >"$out/chan-0.0.0-1.src.rpm"
STUB

chmod +x "$SRPM_REPO/packaging/distros/mkdist" \
    "$SRPM_DIR/make-srpm.sh" "$WORK/bin/docker"
git init -q "$SRPM_REPO"
printf '/target/\n' >"$SRPM_REPO/.gitignore"
git -C "$SRPM_REPO" add -- .
git -C "$SRPM_REPO" -c user.name=contract \
    -c user.email=contract@example.invalid commit -qm baseline

STUB_SRPM_STATE="$WORK/srpm-state" DOCKER="$WORK/bin/docker" \
    "$SRPM_DIR/build-srpm.sh" chan >"$WORK/srpm.log" 2>&1
assert_status 0 $? "the SRPM boundary fixture succeeds"
assert_status 3 "$(wc -l <"$WORK/srpm-state/binds")" "the SRPM container receives exactly three host binds"
assert_grep ":/src:ro" "$WORK/srpm-state/binds" "the SRPM source bind is read-only"
assert_grep ":/dist:ro" "$WORK/srpm-state/binds" "the vendored tarball bind is read-only"
assert_grep ":/out" "$WORK/srpm-state/binds" "the SRPM output is the writable bind"
if grep -qF "$SRPM_REPO:/src" "$WORK/srpm-state/binds"; then
    bad "the SRPM container binds its live repository"
else
    ok "the SRPM container does not bind its live repository"
fi
assert_grep "cp -a /src /work" "$WORK/srpm-state/guest" "the root container writes only to its local source copy"
srpm_source="$(<"$WORK/srpm-state/source")"
if [ -e "$srpm_source" ]; then
    bad "the standalone SRPM source snapshot survives driver exit"
else
    ok "the standalone SRPM source snapshot is removed after the run"
fi

echo
if [ "$FAILURES" -eq 0 ]; then
    echo "all checks passed"
    exit 0
fi
echo "$FAILURES check(s) failed"
exit 1
