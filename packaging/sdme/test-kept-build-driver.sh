#!/usr/bin/env bash
# Contract test for the three build drivers that keep an sdme container.
set -euo pipefail

kind="${1:?usage: test-kept-build-driver.sh desktop|gateway|e2e}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "$kind" in
    desktop)
        key=DESKTOP
        relative=packaging/sdme/build-chan-desktop.sh
        template=packaging/sdme/chan-desktop-ubuntu.sdme
        build_mark='make chan-desktop'
        container=chan-desktop-build-ubuntu
        ;;
    gateway)
        key=GATEWAY
        relative=packaging/gateway/scripts/dev/sdme/build-gateway.sh
        template=packaging/gateway/scripts/dev/sdme/gateway-build.sdme
        build_mark='make gateway-build'
        container=chan-gw-build
        ;;
    e2e)
        key=E2E_BINS
        relative=packaging/gateway/scripts/dev/sdme/devserver-tunnel-e2e/build-bins.sh
        template=
        build_mark='make web'
        container=chan-e2e-build
        ;;
    *) printf 'unknown driver: %s\n' "$kind" >&2; exit 2 ;;
esac

source_root="$(cd "$HERE/../.." && pwd)"
tmp_base="${TMPDIR:-/var/tmp}"
work="$(mktemp -d "$tmp_base/chan-${kind}-sdme-contract.XXXXXX")"
trap 'rm -rf "$work"' EXIT
repo="$work/repo"
state="$work/state"
bin="$work/bin"
mkdir -p "$repo/$(dirname "$relative")" "$repo/packaging" "$bin" "$state"
ln -s "$source_root/$relative" "$repo/$relative"
ln -s "$source_root/packaging/sdme-build-policy.sh" "$repo/packaging/sdme-build-policy.sh"
if [ -n "$template" ]; then
    mkdir -p "$repo/$(dirname "$template")"
    printf 'fixture\n' >"$repo/$template"
fi
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
    fs)
        case "${SDME_STUB_PAYLOAD[*]}" in
            'ls') printf 'ubuntu ready\nchan-desktop-ubuntu ready\ngateway-build ready\n' ;;
            *) printf 'stub sdme: unsupported fs call\n' >&2; exit 2 ;;
        esac
        ;;
    ps) [ ! -e "$state/container" ] || printf '%s running\n' "$(cat "$state/container")" ;;
    rm)
        [ "${STUB_RM_FAIL:-0}" != 1 ] || { printf 'stub removal failure\n' >&2; exit 23; }
        rm -f "$state/container"
        ;;
    create)
        printf '%s\n' "${SDME_STUB_OPTIONS[@]}" >"$state/create-args"
        printf '%s\n' "$SDME_STUB_NAME" >"$state/container"
        ;;
    set)
        [ "${STUB_SET_FAIL:-0}" != 1 ] || { printf 'stub sdme: set failed for %s\n' "$SDME_STUB_NAME" >&2; exit 23; }
        if [ ! -e "$state/container" ] || [ "$(cat "$state/container")" != "$SDME_STUB_NAME" ]; then
            printf "no container found matching '%s'\n" "$SDME_STUB_NAME" >&2
            exit 1
        fi
        printf '%s\n' "${SDME_STUB_OPTIONS[@]}" >"$state/set-args"
        ;;
    cp)
        printf '%s\n' "${SDME_STUB_PAYLOAD[*]}" >>"$state/cp-calls"
        destination="${SDME_STUB_PAYLOAD[1]:?}"
        case "$destination" in
            *:*) ;;
            */) mkdir -p "$destination"; : >"$destination/$(basename "${SDME_STUB_PAYLOAD[0]}")" ;;
            *) mkdir -p "$(dirname "$destination")"; : >"$destination" ;;
        esac
        ;;
    exec)
        payload="${SDME_STUB_PAYLOAD[*]}"
        case "$payload" in
            *"${STUB_BUILD_MARK:?}"*)
                printf '%s\n' "${SDME_STUB_PAYLOAD[@]}" >"$state/build-args"
                exit "${STUB_BUILD_EXIT:-0}"
                ;;
            *'ls /root/chan/target/release/bundle/'*)
                printf '/root/chan/target/release/bundle/appimage/chan.AppImage\n/root/chan/target/release/bundle/deb/chan.deb\n/root/chan/target/release/bundle/rpm/chan.rpm\n'
                ;;
            *'ls /root/chan/gateway/release-artifacts/'*) printf '/root/chan/gateway/release-artifacts/chan.deb\n' ;;
            *) printf '%s\n' "${SDME_STUB_PAYLOAD[@]}" >"$state/seed-args" ;;
        esac
        ;;
    stop)
        printf '%s\n' "${SDME_STUB_PAYLOAD[*]}" >"$state/stopped"
        rm -f "$state/container"
        ;;
    *) printf 'stub sdme: unsupported call %s\n' "$SDME_STUB_COMMAND" >&2; exit 2 ;;
esac
STUB
chmod +x "$bin/sdme"

assert_status() {
    [ "$1" -eq "$2" ] || { printf 'not ok - %s (expected %s, got %s)\n' "$3" "$1" "$2" >&2; cat "$state/driver.log" >&2; exit 1; }
}
assert_pair() {
    awk -v flag="$1" -v value="$2" 'last == flag && $0 == value { found = 1 } { last = $0 } END { exit !found }' "$state/create-args" || {
        printf 'not ok - creating call omits %s %s\n' "$1" "$2" >&2; exit 1;
    }
}
assert_exact_set() {
    printf '%s\n' "$@" >"$work/expected-set-args"
    cmp -s "$work/expected-set-args" "$state/set-args" || {
        printf 'not ok - kept guest set arguments differ from this run\n' >&2
        exit 1
    }
}
assert_line() {
    grep -Fxq -- "$1" "$2" || { printf 'not ok - %s\n' "$3" >&2; exit 1; }
}
run_driver() {
    local existing="$1"
    shift
    rm -rf "$state"
    mkdir -p "$state"
    [ "$existing" != existing ] || printf '%s\n' "$container" >"$state/container"
    status=0
    env -u DISTRO -u LIMA_INSTANCE STUB_STATE="$state" STUB_PARSER="$source_root/packaging/sdme/test-sdme-parser.sh" \
        STUB_BUILD_MARK="$build_mark" CHAN_REPO="$repo" SDME="$bin/sdme --config $work/sdme.conf" \
        REBUILD_CONTAINER=0 \
        "SDME_BUILD_${key}_CPUS=1.5" "SDME_BUILD_${key}_MEMORY=1536M" \
        "SDME_BUILD_${key}_DISK=13G" "SDME_BUILD_${key}_JOBS=2" \
        "SDME_BUILD_${key}_TIMEOUT=7" "$@" "$repo/$relative" >"$state/driver.log" 2>&1 || status=$?
}

run_default_driver() {
    local existing="${1:-absent}"
    [ "$#" -eq 0 ] || shift
    rm -rf "$state"
    mkdir -p "$state"
    [ "$existing" != existing ] || printf '%s\n' "$container" >"$state/container"
    status=0
    env -u DISTRO -u LIMA_INSTANCE -u SDME_BUILD_DISK -u "SDME_BUILD_${key}_CPUS" -u "SDME_BUILD_${key}_MEMORY" \
        -u "SDME_BUILD_${key}_DISK" -u "SDME_BUILD_${key}_JOBS" \
        -u "SDME_BUILD_${key}_TIMEOUT" STUB_STATE="$state" \
        STUB_PARSER="$source_root/packaging/sdme/test-sdme-parser.sh" \
        STUB_BUILD_MARK="$build_mark" CHAN_REPO="$repo" \
        SDME="$bin/sdme --config $work/sdme.conf" OUT_DIR="$work/default-out" REBUILD_CONTAINER=0 \
        "$@" "$repo/$relative" >"$state/driver.log" 2>&1 || status=$?
}

run_one_limit() {
    rm -rf "$state"
    mkdir -p "$state"
    printf '%s\n' "$container" >"$state/container"
    status=0
    env -u DISTRO -u LIMA_INSTANCE -u SDME_BUILD_DISK -u "SDME_BUILD_${key}_MEMORY" -u "SDME_BUILD_${key}_DISK" \
        -u "SDME_BUILD_${key}_JOBS" -u "SDME_BUILD_${key}_TIMEOUT" \
        STUB_STATE="$state" STUB_PARSER="$source_root/packaging/sdme/test-sdme-parser.sh" \
        STUB_BUILD_MARK="$build_mark" CHAN_REPO="$repo" \
        SDME="$bin/sdme --config $work/sdme.conf" "SDME_BUILD_${key}_CPUS=1.5" \
        OUT_DIR="$work/one-limit-out" REBUILD_CONTAINER=0 "$@" "$repo/$relative" >"$state/driver.log" 2>&1 || status=$?
}

run_driver absent OUT_DIR="$work/out"
assert_status 0 "$status" 'configured build succeeds'
assert_pair --cpus 1.5
assert_pair --memory 1536M
assert_pair --disk 13G
[ ! -e "$state/set-args" ] || { printf 'not ok - absent guest was set\n' >&2; exit 1; }
assert_line CARGO_BUILD_JOBS=2 "$state/build-args" 'Cargo job cap is on the build exec'
assert_line timeout "$state/build-args" 'build exec has an in-guest timeout'
assert_line 7s "$state/build-args" 'build exec uses the configured timeout'
assert_line "limits: $key cpus=1.5 memory=1536M disk=13G jobs=2 timeout=7" "$state/driver.log" 'configured limits are logged at creation'
if grep -Eq '\$\{|\$\$' "$state/build-args"; then
    printf 'not ok - inline guest script contains expansion syntax sdme rewrites\n' >&2
    exit 1
fi
if ! grep -Fq 'HOME=/root' "$state/build-args"; then
    printf 'not ok - implicit root build user changed\n' >&2
    exit 1
fi

run_driver existing OUT_DIR="$work/configured-reuse-out"
assert_status 0 "$status" 'configured running guest succeeds'
[ ! -e "$state/create-args" ] || { printf 'not ok - configured running guest was recreated\n' >&2; exit 1; }
assert_line "limits: $key cpus=1.5 memory=1536M disk=13G jobs=2 timeout=7" "$state/driver.log" 'configured reuse limits are logged'
if [ "$kind" = desktop ]; then
    assert_exact_set --disk 13G --cpus 1.5 --memory 1536M
else
    assert_exact_set --cpus 1.5 --memory 1536M --disk 13G
fi

run_default_driver
assert_status 0 "$status" 'unconfigured build succeeds'
[ -e "$state/create-args" ] || { printf 'not ok - unconfigured absent guest was not created\n' >&2; exit 1; }
if [ "$kind" = desktop ]; then
    assert_pair --disk 44G
    assert_line "limits: $key cpus=absent memory=absent disk=44G jobs=absent timeout=absent" "$state/driver.log" 'unconfigured desktop limits are logged'
    expected_gaps=4
else
    if grep -Fxq -- --disk "$state/create-args"; then
        printf 'not ok - unconfigured gateway build carries a disk cap\n' >&2
        exit 1
    fi
    assert_line "limits: $key cpus=absent memory=absent disk=absent jobs=absent timeout=absent" "$state/driver.log" 'unconfigured gateway limits are logged'
    expected_gaps=5
fi
[ "$(grep -c 'has no measured default' "$state/driver.log")" -eq "$expected_gaps" ] || { printf 'not ok - unconfigured gap count\n' >&2; exit 1; }
if grep -Eq '^--(cpus|memory)$' "$state/create-args" || grep -Eq '^(CARGO_BUILD_JOBS=|timeout$)' "$state/build-args"; then
    printf 'not ok - unconfigured build carries a limit, job cap or timeout\n' >&2
    exit 1
fi

run_one_limit
assert_status 0 "$status" 'running guest with one limit succeeds'
[ ! -e "$state/create-args" ] || { printf 'not ok - running guest was recreated for one limit\n' >&2; exit 1; }
if [ "$kind" = desktop ]; then
    assert_line "limits: $key cpus=1.5 memory=absent disk=44G jobs=absent timeout=absent" "$state/driver.log" 'single-limit reuse limits are logged'
else
    assert_line "limits: $key cpus=1.5 memory=absent disk=absent jobs=absent timeout=absent" "$state/driver.log" 'single-limit reuse limits are logged'
fi
if [ "$kind" = desktop ]; then
    assert_exact_set --disk 44G --cpus 1.5
else
    assert_exact_set --cpus 1.5
fi

run_one_limit STUB_SET_FAIL=1
assert_status 23 "$status" 'failed set stops the run'
[ ! -e "$state/build-args" ] || { printf 'not ok - build ran after failed set\n' >&2; exit 1; }
[ ! -e "$state/seed-args" ] || { printf 'not ok - seed ran after failed set\n' >&2; exit 1; }
[ ! -e "$state/cp-calls" ] || { printf 'not ok - copy ran after failed set\n' >&2; exit 1; }
assert_line "error: could not set limits on kept container $container; REBUILD_CONTAINER=1 recreates it" "$state/driver.log" 'failed set names the guest and remedy'

run_default_driver existing
assert_status 0 "$status" 'unconfigured running guest succeeds'
[ ! -e "$state/create-args" ] || { printf 'not ok - unconfigured running guest was recreated\n' >&2; exit 1; }
if [ "$kind" = desktop ]; then
    assert_exact_set --disk 44G
    run_default_driver existing SDME_BUILD_DISK=48G
    assert_status 0 "$status" 'desktop policy disk change succeeds'
    [ ! -e "$state/create-args" ] || { printf 'not ok - desktop policy disk change recreated guest\n' >&2; exit 1; }
    assert_exact_set --disk 48G
else
    [ ! -e "$state/set-args" ] || { printf 'not ok - unconfigured gateway guest was set\n' >&2; exit 1; }
    assert_line "==> no cpu, memory or disk limit configured for this run; any limit already on kept container $container remains in force; REBUILD_CONTAINER=1 recreates it without them" "$state/driver.log" 'unconfigured reuse names retained limits and remedy'
    run_default_driver existing "SDME_BUILD_${key}_JOBS=2" "SDME_BUILD_${key}_TIMEOUT=7"
    assert_status 0 "$status" 'jobs and timeout only reuse succeeds'
    [ ! -e "$state/set-args" ] || { printf 'not ok - jobs and timeout only reuse set guest limits\n' >&2; exit 1; }
    assert_line "limits: $key cpus=absent memory=absent disk=absent jobs=2 timeout=7" "$state/driver.log" 'jobs and timeout only reuse limits are logged'
    assert_line CARGO_BUILD_JOBS=2 "$state/build-args" 'jobs and timeout only reuse caps Cargo'
    assert_line 7s "$state/build-args" 'jobs and timeout only reuse bounds the build'
fi

run_driver absent STUB_BUILD_EXIT=124 OUT_DIR="$work/timeout-out"
assert_status 124 "$status" 'timed-out build fails'
[ -s "$state/stopped" ] || { printf 'not ok - timed-out kept guest is not stopped\n' >&2; exit 1; }
if grep -Eq '^chan-.*:/root/chan/' "$state/cp-calls"; then
    printf 'not ok - timed-out build copied artifacts\n' >&2
    exit 1
fi

run_driver absent STUB_BUILD_EXIT=137 OUT_DIR="$work/killed-out"
assert_status 137 "$status" 'killed build fails'
[ -s "$state/stopped" ] || { printf 'not ok - killed kept guest is not stopped\n' >&2; exit 1; }

run_driver absent STUB_BUILD_EXIT=7 OUT_DIR="$work/fail-out"
assert_status 7 "$status" 'build failure stays non-green'
if grep -Eq '^chan-.*:/root/chan/' "$state/cp-calls"; then
    printf 'not ok - failed build copied artifacts\n' >&2
    exit 1
fi

run_driver existing STUB_RM_FAIL=1 REBUILD_CONTAINER=1 OUT_DIR="$work/cleanup-out"
assert_status 23 "$status" 'failed removal stays non-green'
[ ! -e "$state/create-args" ] || { printf 'not ok - created after failed removal\n' >&2; exit 1; }

run_driver absent "SDME_BUILD_${key}_MEMORY=2X" OUT_DIR="$work/invalid-out"
assert_status 2 "$status" 'own malformed policy value is refused'
assert_line "error: SDME_BUILD_${key}_MEMORY must be a positive M or G limit" "$state/driver.log" 'own policy key is named'
[ ! -e "$state/create-args" ] || { printf 'not ok - malformed value created a guest\n' >&2; exit 1; }

run_driver absent SDME_BUILD_AUR_MEMORY=2X OUT_DIR="$work/other-out"
assert_status 0 "$status" 'another driver malformed policy value is ignored'
assert_pair --memory 1536M

rm -rf "$state"
mkdir -p "$state"
missing_status=0
STUB_STATE="$state" STUB_PARSER="$source_root/packaging/sdme/test-sdme-parser.sh" \
    "$bin/sdme" --config "$work/sdme.conf" set "$container" --cpus 1 \
    >"$state/missing.log" 2>&1 || missing_status=$?
[ "$missing_status" -eq 1 ] || { printf 'not ok - set of absent guest did not return 1\n' >&2; exit 1; }
assert_line "no container found matching '$container'" "$state/missing.log" 'absent set names the guest'

printf 'ok - %s kept sdme build driver contract\n' "$kind"
