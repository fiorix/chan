#!/usr/bin/env bash
# Host-side contract for the AUR sdme driver; no package or guest runs.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_root="$(cd "$here/../../.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/var/tmp}/chan-aur-sdme-contract.XXXXXX")"
trap 'rm -rf "$work"' EXIT
repo="$work/repo"
state="$work/state"
bin="$work/bin"
mkdir -p "$repo/packaging/distros/arch" "$repo/packaging" "$state" "$bin"
ln -s "$source_root/packaging/distros/arch/build-with-sdme.sh" "$repo/packaging/distros/arch/build-with-sdme.sh"
ln -s "$source_root/packaging/snapshot-tracked-tree.sh" "$repo/packaging/snapshot-tracked-tree.sh"
ln -s "$source_root/packaging/sdme-build-policy.sh" "$repo/packaging/sdme-build-policy.sh"
printf '[workspace.package]\nversion = "0.106.0"\n' >"$repo/Cargo.toml"
git init -q "$repo"
git -C "$repo" add -- .
git -C "$repo" -c user.name=contract -c user.email=contract@example.invalid commit -qm baseline

cat >"$bin/sdme" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
. "${STUB_PARSER:?}"
sdme_stub_parse "$@" || exit $?
state="${STUB_STATE:?}"
case "$SDME_STUB_COMMAND" in
    fs) printf 'archlinux ready\n' ;;
    new)
        printf '%s\n' "${SDME_STUB_OPTIONS[@]}" >"$state/new-args"
        printf '%s\n' "${SDME_STUB_PAYLOAD[@]}" >"$state/guest-args"
        printf '%s\n' "$SDME_STUB_NAME" >"$state/created"
        printf '%s\n' "$SDME_STUB_NAME" >"$state/container"
        if [ "${STUB_BUILD_EXIT:-0}" -ne 0 ]; then
            rm -f "$state/container"
            exit "$STUB_BUILD_EXIT"
        fi
        ;;
    rm)
        printf '%s\n' "${SDME_STUB_PAYLOAD[@]}" >"$state/removed"
        [ "${STUB_RM_FAIL:-0}" != 1 ] || exit 23
        if [ ! -e "$state/container" ]; then
            name="${SDME_STUB_PAYLOAD[1]}"
            printf "error: %s: no container found matching '%s'\nError: some containers could not be removed\n" "$name" "$name" >&2
            exit 1
        fi
        rm -f "$state/container"
        ;;
    *) printf 'unsupported stub call: %s\n' "$SDME_STUB_COMMAND" >&2; exit 2 ;;
esac
STUB
chmod +x "$bin/sdme"

assert_status() {
    [ "$1" -eq "$2" ] || { printf 'not ok - %s (expected %s, got %s)\n' "$3" "$1" "$2" >&2; exit 1; }
}
assert_pair() {
    awk -v flag="$1" -v value="$2" 'last == flag && $0 == value { found = 1 } { last = $0 } END { exit !found }' "$state/new-args" || {
        printf 'not ok - new omits %s %s\n' "$1" "$2" >&2; exit 1;
    }
}
assert_arg() {
    grep -Fxq -- "$1" "$state/guest-args" || { printf 'not ok - guest omits %s\n' "$1" >&2; exit 1; }
}
run_driver() {
    rm -rf "$state"
    mkdir -p "$state"
    status=0
    env STUB_STATE="$state" STUB_PARSER="$source_root/packaging/sdme/test-sdme-parser.sh" \
        SDME="$bin/sdme --config $work/sdme.conf" OUT="$work/out" \
        SDME_BUILD_AUR_CPUS=1.5 SDME_BUILD_AUR_MEMORY=1536M SDME_BUILD_AUR_DISK=13G \
        SDME_BUILD_AUR_JOBS=2 SDME_BUILD_AUR_TIMEOUT=7 "$@" \
        "$repo/packaging/distros/arch/build-with-sdme.sh" >"$state/driver.log" 2>&1 || status=$?
}

run_default_driver() {
    rm -rf "$state"
    mkdir -p "$state"
    status=0
    env -u SDME_BUILD_DISK -u SDME_BUILD_AUR_CPUS -u SDME_BUILD_AUR_MEMORY \
        -u SDME_BUILD_AUR_DISK -u SDME_BUILD_AUR_JOBS -u SDME_BUILD_AUR_TIMEOUT \
        STUB_STATE="$state" STUB_PARSER="$source_root/packaging/sdme/test-sdme-parser.sh" \
        SDME="$bin/sdme --config $work/sdme.conf" OUT="$work/default-out" \
        "$repo/packaging/distros/arch/build-with-sdme.sh" >"$state/driver.log" 2>&1 || status=$?
}

run_driver
assert_status 0 "$status" 'configured AUR build succeeds'
assert_pair --cpus 1.5
assert_pair --memory 1536M
assert_pair --disk 13G
assert_arg CARGO_BUILD_JOBS=2
assert_arg AUR_BUILD_TIMEOUT=7
assert_arg bash
assert_arg /src/packaging/distros/arch/build-in-container.sh
grep -Fxq -- -f "$state/removed" || { printf 'not ok - AUR guest is not removed\n' >&2; exit 1; }
grep -Fxq 'limits: AUR cpus=1.5 memory=1536M disk=13G jobs=2 timeout=7' "$state/driver.log" || { printf 'not ok - configured limits are not logged\n' >&2; exit 1; }

run_default_driver
assert_status 0 "$status" 'unconfigured AUR build succeeds'
assert_pair --disk 44G
for field in CPUS MEMORY JOBS TIMEOUT; do
    grep -Fxq "gap: SDME_BUILD_AUR_${field} has no measured default" "$state/driver.log" || { printf 'not ok - %s gap is missing\n' "$field" >&2; exit 1; }
done
grep -Fxq 'limits: AUR cpus=absent memory=absent disk=44G jobs=absent timeout=absent' "$state/driver.log" || { printf 'not ok - unconfigured limits are not logged\n' >&2; exit 1; }
if grep -Eq '^--(cpus|memory)$' "$state/new-args" || grep -Eq '^(CARGO_BUILD_JOBS|AUR_BUILD_TIMEOUT)=' "$state/guest-args"; then
    printf 'not ok - unconfigured AUR build carries a limit, job cap or timeout\n' >&2
    exit 1
fi

guest_script="$source_root/packaging/distros/arch/build-in-container.sh"
grep -Fq 'if [ "$(id -u builder)" -eq 0 ]; then' "$guest_script" || { printf 'not ok - builder non-root check missing\n' >&2; exit 1; }
grep -Fq 'builder_command=(runuser -u builder -- env' "$guest_script" || { printf 'not ok - package build does not use builder account\n' >&2; exit 1; }
grep -Fq 'timeout -s TERM -k 30s "${AUR_BUILD_TIMEOUT}s" "${builder_command[@]}"' "$guest_script" || { printf 'not ok - builder arm lacks the in-guest bound\n' >&2; exit 1; }
grep -Fq 'chown -R "$HOST_UID:$HOST_GID" "$OUT"' "$guest_script" || { printf 'not ok - output handback missing after builder arm\n' >&2; exit 1; }

run_driver STUB_BUILD_EXIT=124
assert_status 124 "$status" 'timed-out builder fails'
grep -Fxq -- -f "$state/removed" || { printf 'not ok - timed-out AUR guest is not removed\n' >&2; exit 1; }

run_driver STUB_BUILD_EXIT=7
assert_status 7 "$status" 'builder failure stays non-green'
if grep -Fq 'could not remove sdme container' "$state/driver.log"; then
    printf 'not ok - absent guest was reported as a cleanup failure\n' >&2
    exit 1
fi
if grep -Fq 'no container found matching' "$state/driver.log"; then
    printf 'not ok - absent guest diagnostic leaked into the build failure\n' >&2
    exit 1
fi

run_driver STUB_RM_FAIL=1
assert_status 23 "$status" 'cleanup failure stays non-green'
grep -Fq 'could not remove sdme container' "$state/driver.log" || { printf 'not ok - real cleanup failure was not named\n' >&2; exit 1; }

run_driver SDME_BUILD_AUR_MEMORY=2X
assert_status 2 "$status" 'own malformed policy value is refused'
grep -Fq 'SDME_BUILD_AUR_MEMORY must be a positive M or G limit' "$state/driver.log" || { printf 'not ok - wrong policy diagnostic\n' >&2; exit 1; }
[ ! -e "$state/created" ] || { printf 'not ok - malformed policy created a guest\n' >&2; exit 1; }

run_driver SDME_BUILD_COPR_MEMORY=2X
assert_status 0 "$status" 'another driver malformed value is ignored'
assert_pair --memory 1536M

printf 'ok - AUR sdme driver contract\n'
