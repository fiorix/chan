#!/usr/bin/env bash
# Exercise downgrade-to-snapshot.sh against a pacman stand-in. No container or
# package manager runs here, and every path the script deletes lies under a
# scratch root.
#
# The fixtures in downgrade-to-snapshot-fixture/ are pacman's own output from
# the archlinux:base-devel image of 2026-11-13 (digest
# sha256:957559197e198f84888c8539fa9d6143d59a07c741873a60fa53af0e67dce6f8)
# pinned to the Arch Linux Archive snapshot 2026/10/02, where that image
# carries openssl 4.1.0 beside the openssl-3 compat package the snapshot
# lacks:
#   openssl-3.files            pacman -Qlq openssl-3
#   openssl.files              the lines of pacman -Qlq openssl (3.6.5, after
#                              the downgrade) that openssl-3 also lists
#   openssl-3-left.files       the openssl-3 paths pacman -Qo found unowned
#                              after the downgrade
#   suu-conflict-owned.txt     pacman -Suu with openssl-3 installed
#   suu-conflict-unowned.txt   pacman -Suu after pacman -Rdd --dbonly openssl-3
#   sync-before.txt            pacman -Sl lines before the downgrade
#   sync-after.txt             the same lines after it
#   dk-missing.txt, dk-ok.txt  pacman -Dk after the --dbonly removal and after
#                              the downgrade
# The stand-in serves those paths under the scratch root.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixture="$script_dir/downgrade-to-snapshot-fixture"
subject="$script_dir/downgrade-to-snapshot.sh"

# The subject deletes the paths pacman lists. A stand-in fault that served a
# real path would reach the host's tree, which only root could damage.
if [ "$(id -u)" -eq 0 ]; then
    echo "FAIL run this test as a non-root user" >&2
    exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/bin"

fail() {
    echo "FAIL $*" >&2
    exit 1
}

cat > "$work/bin/pacman" <<'STUB'
#!/usr/bin/env bash
# A pacman holding two packages that matter: openssl-3, which the snapshot
# lacks, while $STUB_STATE/registered names it, and the snapshot's openssl,
# installed by the downgrade. STUB_* variables inject faults.
set -euo pipefail
state="${STUB_STATE:?}" root="${STUB_ROOT:?}" fixture="${STUB_FIXTURE:?}"
printf '%s\n' "$*" >> "$state/calls"

served() { sed "s|^/|$root/|" "$fixture/$1"; }
registered() { grep -Fxq openssl-3 "$state/registered"; }
downgraded() { [ -e "$state/downgraded" ]; }

# pacman refuses to write over an existing file, whether another package
# owns it or none does, unless an --overwrite glob matches it.
upgrade() {
    local -a globs=()
    local path glob covered
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --noconfirm) shift ;;
            --overwrite) globs+=("$2"); shift 2 ;;
            *) echo "stub: unsupported upgrade argument: $1" >&2; exit 2 ;;
        esac
    done
    if [ -n "${STUB_UPGRADE_FAILS:-}" ]; then
        cat "$fixture/suu-conflict-unowned.txt" >&2
        exit 1
    fi
    while IFS= read -r path; do
        case "$path" in */) continue ;; esac
        [ -e "$path" ] || continue
        covered=
        for glob in ${globs[@]+"${globs[@]}"}; do
            # shellcheck disable=SC2053 # the glob is meant to match
            if [[ "$path" == $glob ]]; then covered=1; fi
        done
        if [ -z "$covered" ]; then
            if registered; then
                cat "$fixture/suu-conflict-owned.txt" >&2
            else
                cat "$fixture/suu-conflict-unowned.txt" >&2
            fi
            exit 1
        fi
    done < <(served openssl.files)
    : > "$state/downgraded"
}

case "$*" in
    '-Syy --noconfirm') ;;
    '-Syyuu --noconfirm') upgrade --noconfirm ;;
    -Suu\ *) shift; upgrade "$@" ;;
    -Qmq)
        if [ -n "${STUB_QM_FAILS:-}" ]; then
            echo 'stub: pacman -Qm failed' >&2
            exit 1
        fi
        if registered || { downgraded && [ -n "${STUB_ABSENT_AFTER:-}" ]; }; then
            echo openssl-3
        else
            exit 1
        fi
        ;;
    '-Qlq openssl-3')
        registered || { echo "error: package 'openssl-3' was not found" >&2; exit 1; }
        served openssl-3.files
        ;;
    -Qlq)
        ! downgraded || served openssl.files
        ! registered || served openssl-3.files
        ;;
    '-Rdd --dbonly --noconfirm openssl-3') : > "$state/registered" ;;
    -Sl)
        if downgraded && [ -z "${STUB_DRIFT_AFTER:-}" ]; then
            cat "$fixture/sync-after.txt"
        else
            cat "$fixture/sync-before.txt"
        fi
        ;;
    -Dk)
        if [ -n "${STUB_DEPS_BROKEN:-}" ] || { ! registered && ! downgraded; }; then
            cat "$fixture/dk-missing.txt" >&2
            exit 1
        fi
        cat "$fixture/dk-ok.txt"
        ;;
    *) echo "stub: unsupported pacman call: $*" >&2; exit 2 ;;
esac
STUB
chmod +x "$work/bin/pacman"

# make_image <name> <openssl-3|clean>
# Sets state, root and log for the case. The openssl-3 image has the package
# registered and its files on disk.
make_image() {
    local path
    name="$1"
    state="$work/$name/state"
    root="$work/$name/root"
    log="$work/$name/log"
    mkdir -p "$state" "$root"
    : > "$state/registered"
    if [ "$2" = openssl-3 ]; then
        echo openssl-3 > "$state/registered"
        while IFS= read -r path; do
            case "$path" in
                */) mkdir -p "$root$path" ;;
                *) mkdir -p "$(dirname "$root$path")"; : > "$root$path" ;;
            esac
        done < "$fixture/openssl-3.files"
    fi
}

# run_case <name> <openssl-3|clean> [VAR=value]...
run_case() {
    make_image "$1" "$2"
    shift 2
    status=0
    env STUB_STATE="$state" STUB_ROOT="$root" STUB_FIXTURE="$fixture" \
        PATH="$work/bin:$PATH" "$@" \
        bash "$subject" 2026/10/02 > "$log" 2>&1 || status=$?
}

assert_log() {
    grep -Fq -- "$1" "$log" || fail "$name: the log lacks: $1"
}

# The stand-in must fail where the real image failed: the single
# pacman -Syyuu the recipe ran before gets the CI job's conflict.
make_image model openssl-3
if STUB_STATE="$state" STUB_ROOT="$root" STUB_FIXTURE="$fixture" \
    "$work/bin/pacman" -Syyuu --noconfirm > "$log" 2>&1; then
    fail 'the stand-in downgraded an image that still registers openssl-3'
fi
grep -Fxq 'openssl: /usr/lib/libssl.so.3 exists in filesystem (owned by openssl-3)' "$log" || \
    fail 'the stand-in did not print the conflict the CI job printed'
echo 'ok the stand-in reproduces the conflict of a plain pacman -Syyuu'

run_case downgrade openssl-3
[ "$status" -eq 0 ] || { cat "$log" >&2; fail "downgrade: exit $status"; }
mapfile -t calls < "$state/calls"
expected=('-Syy --noconfirm' -Qmq '-Qlq openssl-3' '-Rdd --dbonly --noconfirm openssl-3')
for i in "${!expected[@]}"; do
    [ "${calls[$i]-}" = "${expected[$i]}" ] || \
        fail "downgrade: pacman call $i was '${calls[$i]-}', not '${expected[$i]}'"
done
case "${calls[4]-}" in
    '-Suu --noconfirm '*) ;;
    *) fail "downgrade: pacman call 4 was '${calls[4]-}', not the downgrade" ;;
esac
for so in libssl.so.3 libcrypto.so.3; do
    [[ " ${calls[4]} " == *" --overwrite $root/usr/lib/$so "* ]] || \
        fail "downgrade: the downgrade does not overwrite /usr/lib/$so"
done
while IFS= read -r path; do
    if grep -Fxq -- "$path" "$fixture/openssl-3-left.files"; then
        [ ! -e "$root$path" ] || fail "downgrade: $path of openssl-3 was left behind"
    else
        [ -e "$root$path" ] || fail "downgrade: $path, which the snapshot's openssl owns, was deleted"
    fi
done < "$fixture/openssl-3.files"
assert_log '>> the snapshot 2026/10/02 lacks 1 installed package(s), dropped from pacman'"'"'s database before the downgrade: openssl-3'
assert_log '>> deleted 159 path(s) of openssl-3 that no snapshot package took over'
assert_log '>> the image matches the snapshot 2026/10/02: 3 installed packages'
echo 'ok an image holding a package the snapshot lacks is downgraded, and what that package left is deleted'

run_case clean clean
[ "$status" -eq 0 ] || { cat "$log" >&2; fail "clean: exit $status"; }
grep -q -- '^-Rdd' "$state/calls" && fail 'clean: a package was removed from an image the snapshot fully carries'
grep -Fxq -- '-Suu --noconfirm' "$state/calls" || fail 'clean: the downgrade did not run plainly'
echo 'ok an image the snapshot fully carries is downgraded with nothing removed'

run_case upgrade-fails openssl-3 STUB_UPGRADE_FAILS=1
[ "$status" -ne 0 ] || fail 'upgrade-fails: a failed pacman -Suu was accepted'
assert_log 'error: pacman -Suu could not downgrade the image to the Arch Linux Archive snapshot 2026/10/02'
assert_log "error: the snapshot lacks these installed packages, already dropped from pacman's database: openssl-3"

run_case drift openssl-3 STUB_DRIFT_AFTER=1
[ "$status" -ne 0 ] || fail 'drift: a package off the snapshot version was accepted'
assert_log 'error: after the downgrade the image does not match the Arch Linux Archive snapshot 2026/10/02:'
assert_log "installed at another version than the snapshot's: core openssl 3.6.5-1 [installed: 4.1.0-1]"

run_case absent openssl-3 STUB_ABSENT_AFTER=1
[ "$status" -ne 0 ] || fail 'absent: a package the snapshot lacks was accepted after the downgrade'
assert_log 'installed, absent from the snapshot: openssl-3'

run_case deps openssl-3 STUB_DEPS_BROKEN=1
[ "$status" -ne 0 ] || fail 'deps: an unmet dependency was accepted'
assert_log "pacman -Dk: error: missing 'openssl-3' dependency for 'python'"

run_case query-fails openssl-3 STUB_QM_FAILS=1
[ "$status" -ne 0 ] || fail 'query-fails: a failed pacman -Qm read as no absent packages'
assert_log 'error: pacman -Qm failed (exit 1) listing the installed packages the snapshot 2026/10/02 lacks'
grep -q -- '^-Suu' "$state/calls" && fail 'query-fails: the downgrade ran after pacman -Qm failed'
echo 'ok a failed downgrade, a version off the snapshot, a package it lacks, an unmet dependency and a failed query each fail and name it'

# The root arm needs pacman and writes system configuration, so its call is
# pinned as source text.
grep -Fq 'bash "$SRC/packaging/distros/arch/downgrade-to-snapshot.sh" "$ARCH_SNAPSHOT"' \
    "$script_dir/build-in-container.sh" || fail 'build-in-container.sh does not downgrade through downgrade-to-snapshot.sh'
grep -Fq 'pacman -Syyuu' "$script_dir/build-in-container.sh" && \
    fail 'build-in-container.sh still downgrades with a plain pacman -Syyuu'
echo 'ok the root arm downgrades through downgrade-to-snapshot.sh'
