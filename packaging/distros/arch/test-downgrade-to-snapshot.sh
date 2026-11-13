#!/usr/bin/env bash
# Exercise downgrade-to-snapshot.sh against stand-ins for pacman, pacman-conf
# and systemd-detect-virt. No container or package manager runs here, and
# every path the script deletes lies under a scratch root.
#
# The fixtures in downgrade-to-snapshot-fixture/ are real output from the
# archlinux:base-devel image of 2026-11-13 (digest
# sha256:957559197e198f84888c8539fa9d6143d59a07c741873a60fa53af0e67dce6f8)
# pinned to the Arch Linux Archive snapshot 2026/10/02. That image carries
# openssl 4.1.0 beside the openssl-3 compat package the snapshot lacks; the
# dummy-compat files come from the same image with dummy packages added, one
# of them, dummy-compat, absent from the snapshot and owning oddly named files
# the snapshot's dummy also owns. For each of openssl-3 and dummy-compat:
#   <pkg>.files                      pacman -Qlq <pkg>
#   <pkg>-owned.files                the lines of pacman -Qlq after the
#                                    downgrade that <pkg> also lists
#   <pkg>-suu-conflict-owned.txt     pacman -Suu with <pkg> installed
#   <pkg>-suu-conflict-unowned.txt   pacman -Suu after pacman -Rdd --dbonly
#                                    <pkg>, without a matching --overwrite
#   dummy-compat-suu-config.txt      what pacman -Suu said of backup files
# and further:
#   openssl-3-left.files             the openssl-3 paths pacman -Qo found
#                                    unowned after the downgrade
#   sync-before.txt, sync-after.txt  pacman -Sl lines before and after it
#   dk-missing.txt, dk-ok.txt        pacman -Dk after the --dbonly removal of
#                                    openssl-3, and after the downgrade
#   pacman-conf-*.txt                pacman-conf --repo-list, Architecture,
#                                    and each repository's Server with the
#                                    snapshot's mirrorlist or the image's own
# The pacman stand-in serves those paths under the scratch root.

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
# A pacman holding the packages that matter for one image: $STUB_PKG, which
# the snapshot lacks, while $STUB_STATE/registered names it, and the packages
# that own $STUB_PKG-owned.files once the downgrade has run. STUB_* variables
# inject faults.
set -euo pipefail
state="${STUB_STATE:?}" root="${STUB_ROOT:?}" fixture="${STUB_FIXTURE:?}" pkg="${STUB_PKG:?}"
printf '%s\n' "$*" >> "$state/calls"

served() { sed "s|^/|$root/|" "$fixture/$1"; }
registered() { grep -Fxq "$pkg" "$state/registered"; }
downgraded() { [ -e "$state/downgraded" ]; }

# pacman splits each --overwrite value at commas into globs, and refuses to
# write over an existing file, whether another package owns it or none does,
# unless one of them matches it.
upgrade() {
    local -a globs=() parts
    local path glob covered
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --noconfirm) shift ;;
            --overwrite) IFS=, read -r -a parts <<< "$2"; globs+=("${parts[@]}"); shift 2 ;;
            *) echo "stub: unsupported upgrade argument: $1" >&2; exit 2 ;;
        esac
    done
    if [ -n "${STUB_UPGRADE_FAILS:-}" ]; then
        cat "$fixture/$pkg-suu-conflict-unowned.txt" >&2
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
                cat "$fixture/$pkg-suu-conflict-owned.txt" >&2
            else
                cat "$fixture/$pkg-suu-conflict-unowned.txt" >&2
            fi
            exit 1
        fi
    done < <(served "$pkg-owned.files")
    : > "$state/downgraded"
    if [ -f "$fixture/$pkg-suu-config.txt" ]; then
        cat "$fixture/$pkg-suu-config.txt" >&2
    fi
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
            echo "$pkg"
        else
            exit 1
        fi
        ;;
    "-Qlq $pkg")
        registered || { echo "error: package '$pkg' was not found" >&2; exit 1; }
        served "$pkg.files"
        ;;
    -Qlq)
        ! downgraded || served "$pkg-owned.files"
        ! registered || served "$pkg.files"
        ;;
    "-Rdd --dbonly --noconfirm $pkg") : > "$state/registered" ;;
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

cat > "$work/bin/pacman-conf" <<'STUB'
#!/usr/bin/env bash
# pacman-conf with the repositories core and extra, served by the snapshot's
# mirrorlist or by the image's own as $STUB_SERVERS says.
set -euo pipefail
fixture="${STUB_FIXTURE:?}"
case "$*" in
    --repo-list) cat "$fixture/pacman-conf-repo-list.txt" ;;
    Architecture) cat "$fixture/pacman-conf-architecture.txt" ;;
    '--repo=core Server' | '--repo=extra Server')
        repo="${1#--repo=}"
        cat "$fixture/pacman-conf-server-${STUB_SERVERS:?}-$repo.txt"
        ;;
    *) echo "stub: unsupported pacman-conf call: $*" >&2; exit 2 ;;
esac
STUB

cat > "$work/bin/systemd-detect-virt" <<'STUB'
#!/usr/bin/env bash
# With --quiet systemd-detect-virt prints nothing: it exits 0 under podman,
# docker and an sdme guest (systemd-nspawn), and 1 outside a container.
case "$*" in
    '--container --quiet') exit "${STUB_CONTAINER:?}" ;;
    *) echo "stub: unsupported systemd-detect-virt call: $*" >&2; exit 2 ;;
esac
STUB
chmod +x "$work/bin/pacman" "$work/bin/pacman-conf" "$work/bin/systemd-detect-virt"

# make_image <name> <openssl-3|dummy-compat|clean>
# Sets name, pkg, state, root and log for the case. An image other than clean
# has its package registered and that package's files on disk.
make_image() {
    local path
    name="$1"
    pkg="$2"
    [ "$pkg" != clean ] || pkg=openssl-3
    state="$work/$name/state"
    root="$work/$name/root"
    log="$work/$name/log"
    mkdir -p "$state" "$root"
    : > "$state/registered"
    if [ "$2" != clean ]; then
        echo "$pkg" > "$state/registered"
        while IFS= read -r path; do
            case "$path" in
                */) mkdir -p "$root$path" ;;
                *) mkdir -p "$(dirname "$root$path")"; : > "$root$path" ;;
            esac
        done < "$fixture/$pkg.files"
    fi
}

# run_case [VAR=value]...
# Runs the subject on the image make_image laid out, inside a container whose
# repositories are the 2026/10/02 snapshot unless the variables say otherwise.
# SNAPSHOT names the date the subject is given.
run_case() {
    status=0
    env STUB_STATE="$state" STUB_ROOT="$root" STUB_FIXTURE="$fixture" STUB_PKG="$pkg" \
        STUB_CONTAINER=0 STUB_SERVERS=snapshot PATH="$work/bin:$PATH" "$@" \
        bash "$subject" "${SNAPSHOT:-2026/10/02}" > "$log" 2>&1 || status=$?
}

assert_log() {
    grep -Fq -- "$1" "$log" || fail "$name: the log lacks: $1"
}

# assert_untouched: no pacman call ran and the image is as make_image left it.
assert_untouched() {
    [ ! -e "$state/calls" ] || fail "$name: pacman ran: $(paste -sd';' "$state/calls")"
    grep -Fxq "$pkg" "$state/registered" || fail "$name: $pkg left pacman's database"
    while IFS= read -r path; do
        [ -e "$root$path" ] || fail "$name: $path was deleted"
    done < "$fixture/$pkg.files"
}

# The stand-in must fail where the real image failed: the single
# pacman -Syyuu the recipe ran before gets the CI job's conflict.
make_image model openssl-3
if STUB_STATE="$state" STUB_ROOT="$root" STUB_FIXTURE="$fixture" STUB_PKG="$pkg" \
    "$work/bin/pacman" -Syyuu --noconfirm > "$log" 2>&1; then
    fail 'the stand-in downgraded an image that still registers openssl-3'
fi
grep -Fxq 'openssl: /usr/lib/libssl.so.3 exists in filesystem (owned by openssl-3)' "$log" || \
    fail 'the stand-in did not print the conflict the CI job printed'
echo 'ok the stand-in reproduces the conflict of a plain pacman -Syyuu'

make_image outside openssl-3
run_case STUB_CONTAINER=1
[ "$status" -ne 0 ] || fail 'outside: the subject ran outside a container'
assert_log 'error: downgrade-to-snapshot.sh refuses to run: it runs outside a container'
assert_untouched

make_image mirrors openssl-3
run_case STUB_SERVERS=mirrors
[ "$status" -ne 0 ] || fail 'mirrors: the subject ran against the image'"'"'s own mirrors'
assert_log "error: downgrade-to-snapshot.sh refuses to run: the repository core is served by 'https://fastly.mirror.pkgbuild.com/core/os/x86_64 https://geo.mirror.pkgbuild.com/core/os/x86_64', not by the Arch Linux Archive snapshot 2026/10/02 alone (https://archive.archlinux.org/repos/2026/10/02/core/os/x86_64)"
assert_untouched

make_image other-date openssl-3
SNAPSHOT=2026/10/03 run_case
[ "$status" -ne 0 ] || fail 'other-date: the subject ran against the snapshot of another date'
assert_log 'not by the Arch Linux Archive snapshot 2026/10/03 alone (https://archive.archlinux.org/repos/2026/10/03/core/os/x86_64)'
assert_untouched
echo 'ok outside a container, or with a repository that is not the snapshot of the given date alone, it refuses and touches nothing'

make_image downgrade openssl-3
run_case
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
grep -Fq '>> kept' "$log" && fail 'downgrade: a directory was kept although all of them were empty'
echo 'ok an image holding a package the snapshot lacks is downgraded, and what that package left is deleted'

make_image unowned openssl-3
mkdir -p "$root/usr/lib/openssl-3/ossl-modules"
echo user > "$root/usr/lib/openssl-3/ossl-modules/site.so"
run_case
[ "$status" -eq 0 ] || { cat "$log" >&2; fail "unowned: exit $status"; }
[ -f "$root/usr/lib/openssl-3/ossl-modules/site.so" ] || fail 'unowned: a file no package owns was deleted'
[ ! -e "$root/usr/lib/openssl-3/ossl-modules/legacy.so" ] || fail 'unowned: legacy.so of openssl-3 was left behind'
[ ! -e "$root/usr/lib/openssl-3/pkgconfig" ] || fail 'unowned: an empty directory of openssl-3 was left behind'
assert_log '>> deleted 157 path(s) of openssl-3 that no snapshot package took over'
assert_log ">> kept 2 of their directories, which hold files no package owns: $root/usr/lib/openssl-3/ossl-modules/ $root/usr/lib/openssl-3/"
echo 'ok a file no package owns stays, with the directories above it'

make_image escape dummy-compat
mkdir -p "$root/opt/data/state"
echo user > "$root/opt/data/state/user.db"
run_case
[ "$status" -eq 0 ] || { cat "$log" >&2; fail "escape: exit $status"; }
while IFS= read -r path; do
    [ -e "$root$path" ] || fail "escape: $path, which the snapshot's dummy owns, was deleted"
done < "$fixture/dummy-compat-owned.files"
[ ! -e "$root/opt/data/readme" ] || fail 'escape: /opt/data/readme of dummy-compat was left behind'
[ -f "$root/opt/data/state/user.db" ] || fail 'escape: a file no package owns was deleted'
assert_log ">> kept 1 of their directories, which hold files no package owns: $root/opt/data/"
assert_log ">> configuration the image keeps instead of the snapshot's: /etc/dummy-old.conf saved as /etc/dummy-old.conf.pacsave;/etc/shared.conf installed as /etc/shared.conf.pacnew"
echo 'ok files whose names hold glob characters or commas are overwritten, and kept configuration is reported'

make_image clean clean
run_case
[ "$status" -eq 0 ] || { cat "$log" >&2; fail "clean: exit $status"; }
grep -q -- '^-Rdd' "$state/calls" && fail 'clean: a package was removed from an image the snapshot fully carries'
grep -Fxq -- '-Suu --noconfirm' "$state/calls" || fail 'clean: the downgrade did not run plainly'
echo 'ok an image the snapshot fully carries is downgraded with nothing removed'

make_image upgrade-fails openssl-3
run_case STUB_UPGRADE_FAILS=1
[ "$status" -ne 0 ] || fail 'upgrade-fails: a failed pacman -Suu was accepted'
assert_log 'error: pacman -Suu could not downgrade the image to the Arch Linux Archive snapshot 2026/10/02'
assert_log "error: the snapshot lacks these installed packages, already dropped from pacman's database: openssl-3"

make_image deps openssl-3
run_case STUB_DEPS_BROKEN=1
[ "$status" -ne 0 ] || fail 'deps: an unmet dependency was accepted'
assert_log "error: after the downgrade to the Arch Linux Archive snapshot 2026/10/02, pacman -Dk: error: missing 'openssl-3' dependency for 'python'"
assert_log "error: the snapshot lacks these installed packages, dropped from pacman's database with their files left on disk: openssl-3"
while IFS= read -r path; do
    [ -e "$root$path" ] || fail "deps: $path was deleted before the dependencies were read"
done < "$fixture/openssl-3.files"

make_image drift openssl-3
run_case STUB_DRIFT_AFTER=1
[ "$status" -ne 0 ] || fail 'drift: a package off the snapshot version was accepted'
assert_log 'error: after the downgrade the image does not match the Arch Linux Archive snapshot 2026/10/02:'
assert_log "installed at another version than the snapshot's: core openssl 3.6.5-1 [installed: 4.1.0-1]"

make_image absent openssl-3
run_case STUB_ABSENT_AFTER=1
[ "$status" -ne 0 ] || fail 'absent: a package the snapshot lacks was accepted after the downgrade'
assert_log 'installed, absent from the snapshot: openssl-3'

make_image query-fails openssl-3
run_case STUB_QM_FAILS=1
[ "$status" -ne 0 ] || fail 'query-fails: a failed pacman -Qm read as no absent packages'
assert_log 'error: pacman -Qm failed (exit 1) listing the installed packages the snapshot 2026/10/02 lacks'
grep -q -- '^-Suu' "$state/calls" && fail 'query-fails: the downgrade ran after pacman -Qm failed'
echo 'ok a failed downgrade, an unmet dependency (before anything is deleted), a version off the snapshot, a package it lacks and a failed query each fail and name it'

# The root arm needs pacman and writes system configuration, so its call is
# pinned as source text.
grep -Fq 'bash "$SRC/packaging/distros/arch/downgrade-to-snapshot.sh" "$ARCH_SNAPSHOT"' \
    "$script_dir/build-in-container.sh" || fail 'build-in-container.sh does not downgrade through downgrade-to-snapshot.sh'
grep -Fq 'pacman -Syyuu' "$script_dir/build-in-container.sh" && \
    fail 'build-in-container.sh still downgrades with a plain pacman -Syyuu'
echo 'ok the root arm downgrades through downgrade-to-snapshot.sh'
