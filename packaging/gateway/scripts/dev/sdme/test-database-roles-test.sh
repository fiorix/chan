#!/usr/bin/env bash
# Contract test for the gateway database roles driver against a stand-in sdme:
# the verdict it takes from the suite, and what it does with its guest. No
# guest is started and no PostgreSQL runs.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_root="$(cd "$HERE/../../../../.." && pwd)"
relative=packaging/gateway/scripts/dev/sdme/database-roles-test.sh
container=chan-roles-contract
guest=/opt/chan-gateway-roles-test
suite_pass='PASS: exact database-role prepare/reconcile contract'

work="$(mktemp -d "${TMPDIR:-/var/tmp}/chan-roles-sdme-contract.XXXXXX")"
trap 'rm -rf "$work"' EXIT
repo="$work/repo"
state="$work/state"
bin="$work/bin"
mkdir -p "$repo/$(dirname "$relative")" "$repo/gateway/migrations" "$bin" "$state"
ln -s "$source_root/$relative" "$repo/$relative"
printf 'fixture\n' >"$repo/$(dirname "$relative")/chan-psql.sdme"
git init -q "$repo"
# The driver resolves its checkout through git, which answers the physical path.
repo_root="$(cd "$repo" && pwd -P)"

cat >"$bin/sdme" <<'STUB'
#!/usr/bin/env bash
# Stand-in sdme holding at most one guest under $STUB_STATE. It refuses what
# sdme refuses: grammar sdme does not have, a second guest of one name, and
# start, exec or rm against a guest that is absent or not started.
set -euo pipefail
. "${STUB_PARSER:?}"
sdme_stub_parse "$@" || exit $?
state="${STUB_STATE:?}"

refuse() {
    printf 'stub sdme: %s\n' "$1" >&2
    exit "${2:-1}"
}
registered() {
    [ -e "$state/container" ] && [ "$(cat "$state/container")" = "$1" ]
}

case "$SDME_STUB_COMMAND" in
    fs)
        case "${SDME_STUB_PAYLOAD[*]}" in
            ls)
                printf 'ubuntu ready\n'
                if [ "${STUB_ROOTFS:-present}" = present ] || [ -e "$state/rootfs-built" ]; then
                    printf 'chan-psql ready\n'
                fi
                ;;
            'build chan-psql chan-psql.sdme')
                [ -r chan-psql.sdme ] || refuse 'build config chan-psql.sdme not found'
                [ "${STUB_FS_BUILD_EXIT:-0}" -eq 0 ] || refuse 'rootfs build failed' "$STUB_FS_BUILD_EXIT"
                : >"$state/rootfs-built"
                ;;
            *) refuse "unsupported fs call: ${SDME_STUB_PAYLOAD[*]}" 2 ;;
        esac
        ;;
    ps)
        [ ${#SDME_STUB_PAYLOAD[@]} -eq 0 ] || refuse "unexpected argument ${SDME_STUB_PAYLOAD[0]}" 2
        printf 'NAME STATUS HEALTH USERNS ENABLED MOUNTS ADDRESSES OS\n'
        [ ! -e "$state/container" ] || printf '%s running ok no no yes - Ubuntu\n' "$(cat "$state/container")"
        ;;
    create)
        [ ! -e "$state/container" ] || refuse "container '$(cat "$state/container")' already exists"
        printf '%s\n' "${SDME_STUB_OPTIONS[@]}" >"$state/create-args"
        printf '%s\n' "$SDME_STUB_NAME" >"$state/container"
        # A create that is cut short after it registered the guest.
        [ "${STUB_CREATE_EXIT:-0}" -eq 0 ] || refuse 'create interrupted' "$STUB_CREATE_EXIT"
        ;;
    start)
        set -- ${SDME_STUB_PAYLOAD[@]+"${SDME_STUB_PAYLOAD[@]}"}
        while [ "$#" -gt 0 ]; do
            case "$1" in
                -t)
                    [ "$#" -ge 2 ] && [[ $2 =~ ^[0-9]+$ ]] || refuse '-t needs a number of seconds' 2
                    shift 2
                    ;;
                -*) refuse "unexpected argument $1" 2 ;;
                *) break ;;
            esac
        done
        [ "$#" -eq 1 ] || refuse 'start takes one name here' 2
        registered "$1" || refuse "no container found matching '$1'"
        : >"$state/started"
        ;;
    exec)
        registered "$SDME_STUB_NAME" && [ -e "$state/started" ] \
            || refuse "container '$SDME_STUB_NAME' is not running"
        payload="${SDME_STUB_PAYLOAD[*]}"
        case "$payload" in
            '/usr/bin/systemctl is-active chan-pg-bootstrap.service')
                printf '%s\n' "${STUB_BOOTSTRAP:-active}"
                [ "${STUB_BOOTSTRAP:-active}" = active ] || exit 3
                ;;
            '/usr/bin/journalctl '*) printf 'stub journal\n' ;;
            '/usr/bin/psql '*'SELECT version()')
                printf '%s\n' "$SDME_STUB_USER" >"$state/psql-user"
                printf 'PostgreSQL 18.0 (stand-in)\n'
                ;;
            '/usr/bin/psql '*'CREATE DATABASE chan_gateway_role_test')
                : >"$state/database-created"
                printf 'CREATE DATABASE\n'
                ;;
            '/usr/bin/env '*'/scripts/test-database-roles.sh')
                [ -e "$state/database-created" ] || refuse 'database "chan_gateway_role_test" does not exist'
                printf '%s\n' "$SDME_STUB_USER" >"$state/suite-user"
                printf '%s\n' "${SDME_STUB_PAYLOAD[@]}" >"$state/suite-args"
                cat "${STUB_SUITE_OUTPUT:?}"
                exit "${STUB_SUITE_EXIT:-0}"
                ;;
            *) refuse "unsupported exec payload: $payload" 2 ;;
        esac
        ;;
    rm)
        set -- ${SDME_STUB_PAYLOAD[@]+"${SDME_STUB_PAYLOAD[@]}"}
        force=0
        while [ "$#" -gt 0 ]; do
            case "$1" in
                -f) force=1; shift ;;
                -*) refuse "unexpected argument $1" 2 ;;
                *) break ;;
            esac
        done
        [ "$#" -eq 1 ] || refuse 'rm takes one name here' 2
        # Without -f sdme asks for confirmation, which a driver cannot answer.
        [ "$force" -eq 1 ] || refuse 'rm without -f waits for a confirmation'
        printf '%s\n' "$1" >>"$state/rm-calls"
        [ "${STUB_RM_FAIL:-0}" != 1 ] || refuse 'removal failed' 23
        registered "$1" || refuse "no container found matching '$1'"
        rm -f "$state/container" "$state/started"
        ;;
    *) refuse "unsupported call $SDME_STUB_COMMAND" 2 ;;
esac
STUB
chmod +x "$bin/sdme"

fail() {
    printf 'not ok - %s\n' "$1" >&2
    [ ! -e "$state/driver.log" ] || cat "$state/driver.log" >&2
    exit 1
}
assert_status() {
    [ "$1" -eq "$2" ] || fail "$3 (expected status $1, got $2)"
}
assert_line() {
    grep -Fxq -- "$1" "$2" || fail "$3"
}
assert_pair() {
    awk -v flag="$1" -v value="$2" 'last == flag && $0 == value { found = 1 } { last = $0 } END { exit !found }' "$state/create-args" \
        || fail "creating call omits $1 $2"
}
# The guest this run created is gone, removed by one forced rm.
assert_removed() {
    [ ! -e "$state/container" ] || fail "$1: the guest was left behind"
    [ -e "$state/rm-calls" ] && [ "$(cat "$state/rm-calls")" = "$container" ] \
        || fail "$1: the guest was not removed by exactly one rm"
}
assert_suite_never_ran() {
    [ ! -e "$state/suite-args" ] || fail "$1: the suite ran"
}
assert_no_log_left() {
    [ -z "$(ls -A "$work/tmp")" ] || fail "$1: the suite log was left in TMPDIR"
}
suite_prints() {
    printf '%s\n' "$@" >"$work/suite-output"
}
run_driver() {
    local existing="$1"
    shift
    rm -rf "$state" "$work/tmp"
    mkdir -p "$state" "$work/tmp"
    [ "$existing" != existing ] || printf '%s\n' "$container" >"$state/container"
    status=0
    env -u GATEWAY_ROLES_ROOTFS STUB_STATE="$state" \
        STUB_PARSER="$source_root/packaging/sdme/test-sdme-parser.sh" \
        STUB_SUITE_OUTPUT="$work/suite-output" \
        SDME="$bin/sdme --config $work/sdme.conf" \
        GATEWAY_ROLES_CONTAINER="$container" TMPDIR="$work/tmp" \
        "$@" "$repo/$relative" >"$state/driver.log" 2>&1 || status=$?
}

# Green: the suite exits 0 and ends on its final PASS line.
suite_prints 'PASS: identity user FOR UPDATE' "$suite_pass"
run_driver absent
assert_status 0 "$status" 'a suite that exits 0 on its final PASS line is green'
assert_line "database-roles-test: PASS in $container" "$state/driver.log" 'green names the guest'
assert_removed 'green run'
assert_no_log_left 'green run'
assert_pair --name "$container"
assert_pair -r chan-psql
assert_pair --storage btrfs
assert_pair --memory 1G
assert_pair -b "$repo_root/packaging/gateway/scripts:$guest/scripts:ro"
assert_pair -b "$repo_root/gateway/migrations:$guest/migrations:ro"
assert_line --private-network "$state/create-args" 'the guest has no private network'
if grep -Fxq -- --disk "$state/create-args"; then
    fail 'creating call carries a disk cap'
fi
assert_line postgres "$state/psql-user" 'the server probe does not run as postgres'
assert_line postgres "$state/suite-user" 'the suite does not run as postgres'
assert_line 'DATABASE_URL=postgres://chan:chan@127.0.0.1:5432/chan_gateway_role_test' "$state/suite-args" 'the suite is not pointed at the role test database'
assert_line "MIGRATIONS_DIR=$guest/migrations" "$state/suite-args" 'the suite does not read the bound migrations'
assert_line 'CHAN_GATEWAY_DATABASE_TEST_ALLOW_DESTRUCTIVE=yes' "$state/suite-args" 'the suite is not allowed to run'
assert_line "$guest/scripts/test-database-roles.sh" "$state/suite-args" 'the bound suite is not what runs'

# The suite's exit status is the driver's, whatever the suite printed.
suite_prints "$suite_pass"
run_driver absent STUB_SUITE_EXIT=7
assert_status 7 "$status" 'a suite that exits 7 after its PASS line fails with 7'
assert_line "database-roles-test: FAIL (status 7) in $container" "$state/driver.log" 'a failed suite names its status'
assert_removed 'failed suite'
assert_no_log_left 'failed suite'

# A FAIL line fails the run even when the suite exits 0 on its PASS line.
suite_prints 'FAIL: chan_gateway_identity lacks UPDATE on table public.api_tokens' "$suite_pass"
run_driver absent
assert_status 1 "$status" 'a FAIL line with exit 0 fails the run'
assert_line 'database-roles-test: the suite printed a FAIL line' "$state/driver.log" 'a FAIL line is named as the reason'
assert_removed 'FAIL line'

# So does a suite that exits 0 before its final PASS line.
suite_prints 'PASS: identity user FOR UPDATE'
run_driver absent
assert_status 1 "$status" 'a suite without its final PASS line fails the run'
assert_line 'database-roles-test: the suite did not reach its final PASS line' "$state/driver.log" 'the missing PASS line is named as the reason'
assert_removed 'missing PASS line'

# Only the whole line counts: a longer line that contains it is not the verdict.
suite_prints "$suite_pass (skipped)"
run_driver absent
assert_status 1 "$status" 'a line that only contains the PASS text fails the run'

# A guest that cannot be removed turns a green suite red and is named.
suite_prints "$suite_pass"
run_driver absent STUB_RM_FAIL=1
assert_status 1 "$status" 'a failing remove fails a green run'
assert_line "database-roles-test: could not remove sdme container $container" "$state/driver.log" 'a failing remove names the guest'
# A failed suite keeps its own status over the failing remove.
run_driver absent STUB_RM_FAIL=1 STUB_SUITE_EXIT=7
assert_status 7 "$status" 'a failing remove keeps a failed suite status'

# A guest of that name already exists: it may be someone else's, so the
# driver refuses before it creates anything and never removes it.
run_driver existing
assert_status 1 "$status" 'an existing guest name is refused'
grep -Fq "database-roles-test: an sdme container named $container already exists" "$state/driver.log" \
    || fail 'the refusal does not name the existing guest'
[ ! -e "$state/create-args" ] || fail 'a guest was created over an existing name'
[ ! -e "$state/rm-calls" ] || fail 'an existing guest was removed'
[ -e "$state/container" ] || fail 'an existing guest is gone'
assert_suite_never_ran 'existing guest name'

# A create cut short after it registered the guest still leaves nothing behind.
run_driver absent STUB_CREATE_EXIT=9
assert_status 9 "$status" 'an interrupted create fails with its status'
assert_removed 'interrupted create'
assert_suite_never_ran 'interrupted create'

# PostgreSQL never comes up: no suite, no guest left.
run_driver absent STUB_BOOTSTRAP=failed
assert_status 1 "$status" 'a failed PostgreSQL bootstrap fails the run'
assert_line "database-roles-test: PostgreSQL in $container did not become ready (chan-pg-bootstrap.service: failed)" "$state/driver.log" 'the failed bootstrap is named'
assert_removed 'failed bootstrap'
assert_suite_never_ran 'failed bootstrap'

# An absent rootfs is built from the recipe beside the driver, then used.
suite_prints "$suite_pass"
run_driver absent STUB_ROOTFS=absent
assert_status 0 "$status" 'an absent rootfs is built and the run is green'
[ -e "$state/rootfs-built" ] || fail 'the absent rootfs was not built'
assert_removed 'built rootfs'
run_driver absent STUB_ROOTFS=absent STUB_FS_BUILD_EXIT=5
assert_status 1 "$status" 'a failed rootfs build fails the run'
[ ! -e "$state/create-args" ] || fail 'a guest was created after a failed rootfs build'

printf 'ok - gateway database roles sdme driver contract\n'
