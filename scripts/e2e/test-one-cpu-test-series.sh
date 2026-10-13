#!/usr/bin/env bash
# Exercise the series helper's decisions without a root-owned cgroup or pool.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER=${ONE_CPU_HELPER:-$SCRIPT_DIR/one-cpu-test-series.sh}
# shellcheck source=scripts/e2e/one-cpu-test-series.sh
source "$HELPER"

WORK=$(mktemp -d /var/tmp/chan-one-cpu-selftest.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
FAILURES=0
pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

expect_invocation() {
    local expected_rc=$1 expected_text=$2 output rc
    shift 2
    if output=$("$HELPER" "$@" 2>&1); then rc=0; else rc=$?; fi
    if [ "$rc" -eq "$expected_rc" ] && grep -Fq "$expected_text" <<< "$output"; then
        pass "invocation exits $expected_rc with: $expected_text"
    else
        fail "invocation exited $rc without: $expected_text"
    fi
}

mkdir -p "$WORK/bin" "$WORK/pool/state" "$WORK/default/state"
cat > "$WORK/bin/sdme" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$SDME_CALLS"
config=''
if [ "${1:-}" = --config ]; then config=$2; shift 2; fi
case "${1:-}" in
    config)
        [ "${2:-}" = get ] || exit 2
        [ "$config" = "$SDME_EXPECT_CONFIG" ] || exit 2
        printf 'interactive = false\ndocker_token = ONECPU_TOKEN_CANARY\n'
        case "$SDME_CONFIG_CASE" in
            normal) printf 'datadir = %s\n' "$SDME_DATADIR" ;;
            zero) : ;;
            two) printf 'datadir = %s\ndatadir = %s\n' "$SDME_DATADIR" "$SDME_DATADIR" ;;
            relative) printf 'datadir = relative/path\n' ;;
            quoted) printf 'datadir = "%s"\n' "$SDME_DATADIR" ;;
            fail) printf 'Error: config read failed; docker_token = ONECPU_TOKEN_CANARY\n' >&2; exit 1 ;;
            *) exit 2 ;;
        esac
        ;;
    exec)
        name=${2:-}
        if { [ "$config" = "$SDME_EXPECT_CONFIG" ] && [ "$name" = "$SDME_CONFIGURED_NAME" ]; } ||
           { [ -z "$config" ] && [ "$name" = "$SDME_DEFAULT_NAME" ]; }; then
            if [ "$SDME_EXEC_MODE" = dirty ]; then
                printf 'tracked checkout is dirty\n' >&2
                exit 2
            fi
            printf '0123456789abcdef0123456789abcdef01234567\n'
        else
            printf "Error: no container found matching '%s'\n" "$name" >&2
            exit 1
        fi
        ;;
    *) exit 2 ;;
esac
STUB
chmod +x "$WORK/bin/sdme"
export PATH="$WORK/bin:$PATH"
export SDME_CALLS="$WORK/sdme-calls.log" SDME_DATADIR="$WORK/pool"
export SDME_EXPECT_CONFIG="$WORK/sdme.conf" SDME_CONFIG_CASE=normal SDME_EXEC_MODE=clean
export SDME_CONFIGURED_NAME=rig SDME_DEFAULT_NAME="default-rig-selftest-$$"
: > "$SDME_CALLS"
: > "$SDME_EXPECT_CONFIG"
cat > "$WORK/pool/state/rig" <<'STATE'
NAME=rig
STORAGE=btrfs
DISK=44G
STATE

CONTAINER=rig
PACKAGE=chan-workspace
if configure_sdme "$SDME_EXPECT_CONFIG" > "$WORK/configured.log" 2>&1 &&
   [ "$DATADIR" = "$WORK/pool" ] && [ "$STATE" = "$WORK/pool/state/rig" ] &&
   [ "${SDME[*]}" = "sdme --config $SDME_EXPECT_CONFIG" ] &&
   [ "$(guest_revision)" = 0123456789abcdef0123456789abcdef01234567 ] &&
   run_cargo selected_test -- --list > "$WORK/configured-cargo.log" 2>&1 &&
   grep -Fq -- "--config $SDME_EXPECT_CONFIG config get" "$SDME_CALLS" &&
   grep -Fq -- "--config $SDME_EXPECT_CONFIG exec rig" "$SDME_CALLS" &&
   grep -Fq 'CARGO_TARGET_DIR=/var/tmp/chan-target' "$SDME_CALLS"; then
    pass 'configured pool lookup and every sdme call use the option'
else
    fail "configured pool lookup and every sdme call use the option: ${STORAGE_ERROR:-unknown}"
fi
if grep -Fq ONECPU_TOKEN_CANARY "$WORK/configured.log"; then fail 'configured lookup leaked the token canary'; else pass 'configured lookup hides the token canary'; fi

for mode in zero two relative quoted fail; do
    SDME_CONFIG_CASE=$mode
    if configure_sdme "$SDME_EXPECT_CONFIG" > "$WORK/$mode.log" 2>&1; then
        fail "config $mode was accepted"
    elif [ "$mode" = fail ] && [ "$STORAGE_ERROR" != 'sdme config get failed for the selected configuration' ]; then
        fail "config $mode named the wrong failure"
    elif [ "$mode" != fail ] && [[ "$STORAGE_ERROR" != *"expected one unquoted 'datadir = /absolute/path'"* ]]; then
        fail "config $mode did not name the accepted form"
    else
        pass "config $mode refuses"
    fi
    if grep -Fq ONECPU_TOKEN_CANARY "$WORK/$mode.log" || [[ "$STORAGE_ERROR" == *ONECPU_TOKEN_CANARY* ]]; then
        fail "config $mode leaked the token canary"
    else
        pass "config $mode hides the token canary"
    fi
done
SDME_CONFIG_CASE=normal
for malformed in 'datadir = relative/path' 'datadir = "/quoted/path"' 'datadir = /path"quoted' 'datadir = /path with space'; do
    if parse_datadir "$malformed"; then
        fail "$malformed parse was accepted"
    else
        pass "$malformed parse refuses"
    fi
done

cp "$WORK/pool/state/rig" "$WORK/default/state/rig"
mv "$WORK/pool/state/rig" "$WORK/held-state"
if configure_sdme "$SDME_EXPECT_CONFIG" > "$WORK/no-fallback.log" 2>&1; then
    fail 'configured pool missing state fell back to a same-name default state'
elif [ "$STORAGE_ERROR" = "missing exact sdme state: $WORK/pool/state/rig" ]; then
    pass 'configured pool missing state refuses at its selected path'
else
    fail 'configured pool missing state named the wrong path'
fi
if grep -Fq ONECPU_TOKEN_CANARY "$WORK/no-fallback.log"; then fail 'missing-state refusal leaked the token canary'; else pass 'missing-state refusal hides the token canary'; fi
mv "$WORK/held-state" "$WORK/pool/state/rig"

CONTAINER=$SDME_DEFAULT_NAME
if configure_sdme '' > "$WORK/default.log" 2>&1; then
    fail 'default lookup unexpectedly found a state in the host pool'
elif [ "$STORAGE_ERROR" = "missing exact sdme state: /var/lib/sdme/state/$CONTAINER" ] &&
     [ "${SDME[*]}" = sdme ] &&
     [ "$(guest_revision)" = 0123456789abcdef0123456789abcdef01234567 ] &&
     run_cargo selected_test -- --list > "$WORK/default-cargo.log" 2>&1 &&
     grep -Fq 'CARGO_TARGET_DIR=/var/tmp/chan-target' "$SDME_CALLS" &&
     grep -Fq "exec $CONTAINER" "$SDME_CALLS"; then
    pass 'default layout keeps the fixed state path and bare sdme routing'
else
    fail 'default layout path or bare sdme routing changed'
fi
CONTAINER=rig
configure_sdme "$SDME_EXPECT_CONFIG" > "$WORK/reconfigured.log" 2>&1 || fail 'could not restore configured stand-in'
SDME_EXEC_MODE=dirty
if guest_revision > "$WORK/dirty.log" 2>&1; then
    fail 'dirty guest checkout returned a revision'
elif grep -Fq 'tracked checkout is dirty' "$WORK/dirty.log"; then
    pass 'dirty guest checkout refuses under the option'
else
    fail 'dirty guest checkout refusal was not observed'
fi
SDME_EXEC_MODE=clean

state_case() {
    local label=$1 expected=$2 contents=$3
    printf '%s\n' "$contents" > "$WORK/state-case"
    if read_state_identity "$WORK/state-case" rig; then
        fail "$label was accepted"
    elif [[ "$STATE_ERROR" == *"$expected"* ]]; then
        pass "$label refuses"
    else
        fail "$label refused for another reason: $STATE_ERROR"
    fi
}
if read_state_identity "$WORK/pool/state/rig" rig && [ "$STATE_BACKEND" = btrfs ] && [ "$STATE_DISK" = 44G ]; then
    pass 'reads the selected btrfs state and disk cap'
else
    fail 'reads the selected btrfs state and disk cap'
fi
state_case 'non-btrfs backend' 'expected btrfs' $'NAME=rig\nSTORAGE=overlay\nDISK=44G'
state_case 'uncapped state' 'no disk cap' $'NAME=rig\nSTORAGE=btrfs\nDISK='
state_case 'wrong state name' 'does not match rig' $'NAME=other\nSTORAGE=btrfs\nDISK=44G'
state_case 'duplicate backend' 'no unique STORAGE' $'NAME=rig\nSTORAGE=btrfs\nSTORAGE=btrfs\nDISK=44G'
ln -s "$WORK/pool/state/rig" "$WORK/pool/state/symlink-rig"
if require_state_file "$WORK/pool/state/symlink-rig"; then fail 'symlink state was accepted'; else pass 'symlink state refuses'; fi

cap_case() {
    local value=$1 expected=$2 actual
    printf '%s\n' "$value" > "$WORK/cpu.max"
    if [ "$expected" = refuse ]; then
        if read_one_cpu_cap "$WORK" >/dev/null; then fail "accepted invalid cap: $value"; else pass "rejects invalid cap: $value"; fi
    elif actual=$(read_one_cpu_cap "$WORK") && [ "$actual" = "$expected" ]; then
        pass "accepts one CPU: $value"
    else
        fail "rejected one CPU: $value"
    fi
}
cap_case '100000 100000' '100000 100000'
cap_case '50000 50000' '50000 50000'
cap_case 'max 100000' refuse
cap_case '200000 100000' refuse
cap_case '50000 100000' refuse
cap_case '0 100000' refuse
cap_case '100000 100000 extra' refuse
cap_case 'not-a-cap' refuse
rm -f "$WORK/cpu.max"
if read_one_cpu_cap "$WORK" >/dev/null; then fail 'accepted a missing cpu.max'; else pass 'rejects a missing cpu.max'; fi

cat > "$WORK/cpu.stat" <<'STAT'
usage_usec 20
nr_periods 7
nr_throttled 5
STAT
if [ "$(read_nr_throttled "$WORK")" = 5 ]; then pass 'reads one exact nr_throttled field'; else fail 'did not read nr_throttled'; fi
printf 'nr_throttled 6\n' >> "$WORK/cpu.stat"
if read_nr_throttled "$WORK" >/dev/null; then fail 'accepted duplicate nr_throttled fields'; else pass 'rejects duplicate nr_throttled fields'; fi

GROUP=/machine.slice/sdme@rig.service
SHOW=$(printf 'ActiveState=active\nMainPID=42\nControlGroup=%s\n' "$GROUP")
if parse_unit_show "$SHOW" rig && [ "$UNIT_PID" = 42 ] && [ "$UNIT_CGROUP" = "$GROUP" ]; then
    pass 'active unit names one PID and its own ControlGroup'
else
    fail 'active unit names one PID and its own ControlGroup'
fi
unit_case() {
    local label=$1 expected=$2 output=$3
    if parse_unit_show "$output" rig; then fail "$label was accepted"
    elif [[ "$IDENTITY_ERROR" == *"$expected"* ]]; then pass "$label refuses"
    else fail "$label refused for another reason: $IDENTITY_ERROR"; fi
}
unit_case 'inactive unit' ActiveState "${SHOW/ActiveState=active/ActiveState=inactive}"
unit_case 'zero MainPID' MainPID "${SHOW/MainPID=42/MainPID=0}"
unit_case 'wrong unit ControlGroup' ControlGroup "${SHOW/sdme@rig.service/sdme@other.service}"
unit_case 'relative unit ControlGroup' ControlGroup "${SHOW/ControlGroup=\/machine.slice/ControlGroup=machine.slice}"
unit_case 'duplicate unit property' MainPID "$SHOW"$'\nMainPID=43'

ARGS=("--machine=rig" "--directory=$WORK/pool/btrfs/containers/rig")
if check_process_identity "0::$GROUP/supervisor" "$GROUP" rig "$WORK/pool" "${ARGS[@]}"; then
    pass 'main process in a delegated child belongs to the selected pool'
else
    fail "valid delegated main process refused: $IDENTITY_ERROR"
fi
process_case() {
    local label=$1 expected=$2 cgroup_line=$3
    shift 3
    if check_process_identity "$cgroup_line" "$GROUP" rig "$WORK/pool" "$@"; then fail "$label was accepted"
    elif [[ "$IDENTITY_ERROR" == *"$expected"* ]]; then pass "$label refuses"
    else fail "$label refused for another reason: $IDENTITY_ERROR"; fi
}
process_case 'foreign cgroup' ControlGroup '0::/machine.slice/sdme@other.service' "${ARGS[@]}"
process_case 'multiple cgroup lines' unified $'0::/machine.slice/sdme@rig.service\n1:name=/other' "${ARGS[@]}"
process_case 'wrong cgroup hierarchy' unified "1::$GROUP" "${ARGS[@]}"
process_case 'wrong machine argument' '--machine=rig' "0::$GROUP" '--machine=other' "${ARGS[1]}"
process_case 'wrong directory argument' '--directory=' "0::$GROUP" '--machine=rig' '--directory=/var/lib/sdme/btrfs/containers/rig'
process_case 'duplicate machine argument' '--machine=rig' "0::$GROUP" "${ARGS[@]}" '--machine=rig'

: > "$WORK/empty-list"
printf 'one::case: test\n' > "$WORK/one-list"
if [ "$(selected_test_count "$WORK/empty-list")" = 0 ] && ! has_selected_tests 0; then pass 'selector with no tests refuses'; else fail 'selector with no tests refuses'; fi
if [ "$(selected_test_count "$WORK/one-list")" = 1 ] && has_selected_tests 1; then pass 'selector with one test is accepted'; else fail 'selector with one test is accepted'; fi
if same_revision fixed fixed && ! same_revision moving fixed; then pass 'moving guest revision refuses'; else fail 'moving guest revision refuses'; fi

expect_invocation 64 'Usage:' --container rig selector 1 1
expect_invocation 64 'Usage:' --container rig --package
expect_invocation 2 'REFUSED: invalid package name' --container rig --package 'bad/name' selector 1 1

if [ "${ONE_CPU_MUTANT_CHILD:-0}" != 1 ]; then
    mutant_expect_red() {
        local label=$1 expected_fail=$2 needle=$3 replacement=$4 expected_text=${5:-} mutant log rc
        mutant="$WORK/mutant-$label.sh"
        log="$WORK/mutant-$label.log"
        python3 - "$HELPER" "$mutant" "$needle" "$replacement" <<'PY'
import pathlib
import sys
source = pathlib.Path(sys.argv[1]).read_text()
needle, replacement = sys.argv[3:]
if source.count(needle) != 1:
    raise SystemExit(f"mutation target occurs {source.count(needle)} times")
pathlib.Path(sys.argv[2]).write_text(source.replace(needle, replacement, 1))
PY
        chmod +x "$mutant"
        if [ -n "${ONE_CPU_MUTANT_ARTIFACTS:-}" ]; then
            mkdir -p "$ONE_CPU_MUTANT_ARTIFACTS"
            diff -u "$HELPER" "$mutant" > "$ONE_CPU_MUTANT_ARTIFACTS/$label.diff" || [ "$?" -eq 1 ]
        fi
        if ONE_CPU_HELPER="$mutant" ONE_CPU_MUTANT_CHILD=1 "$0" > "$log" 2>&1; then rc=0; else rc=$?; fi
        if [ "$rc" -ne 0 ] && grep -Fq "FAIL $expected_fail" "$log" &&
           { [ -z "$expected_text" ] || grep -Fq "$expected_text" "$log"; }; then
            pass "mutant $label red on $expected_fail (exit $rc)"
        else
            fail "mutant $label did not go red on $expected_fail (exit $rc)"
        fi
        if [ -n "${ONE_CPU_MUTANT_ARTIFACTS:-}" ]; then
            cp "$log" "$ONE_CPU_MUTANT_ARTIFACTS/$label.log"
            printf 'rc=%s\n' "$rc" > "$ONE_CPU_MUTANT_ARTIFACTS/$label.status"
        fi
    }
    mutant_expect_red ignore_option 'configured pool lookup' 'if [ -n "$configured_file" ]; then' 'if [ -n "" ]; then' 'missing exact sdme state: /var/lib/sdme/state/rig'
    mutant_expect_red duplicate_datadir 'config two was accepted' 'if [ "$count" -ne 1 ] || [ -z "$PARSED_DATADIR" ]; then' 'if [ -z "$PARSED_DATADIR" ]; then'
    mutant_expect_red relative_datadir 'datadir = relative/path parse was accepted' 'if [[ "$value" == /* &&' 'if [[ "$value" != "" &&'
    mutant_expect_red quoted_datadir 'datadir = /path"quoted parse was accepted' '&& "$value" != *\"*' ''
    mutant_expect_red spaced_datadir 'datadir = /path with space parse was accepted' '"$value" != *[[:space:]]* &&' ''
    mutant_expect_red token_leak 'config zero leaked the token canary' 'STORAGE_ERROR=$DATADIR_ERROR' 'STORAGE_ERROR=$output'
    mutant_expect_red state_symlink 'symlink state was accepted' '[ -L "$state" ]' 'false'
    mutant_expect_red state_name 'wrong state name was accepted' '[ "$state_name" = "$name" ] ||' ': ||'
    mutant_expect_red state_duplicate 'duplicate backend was accepted' $'    done < "$file"\n    [ "$found" -eq 1 ] || return 1' $'    done < "$file"\n    : # mutant skips unique state key'
    mutant_expect_red backend 'non-btrfs backend was accepted' '[ "$STATE_BACKEND" = btrfs ] || { STATE_ERROR=' ': || { STATE_ERROR='
    mutant_expect_red disk 'uncapped state was accepted' '[ -n "$STATE_DISK" ] || { STATE_ERROR=' ': || { STATE_ERROR='
    mutant_expect_red cap 'accepted invalid cap: 200000 100000' '[ "$quota" = "$period" ] || return 1' ': # mutant skips quota equality'
    mutant_expect_red active 'inactive unit was accepted' '[ "$active_count" -eq 1 ] && [ "$active" = active ] ||' ': ||'
    mutant_expect_red main_pid 'zero MainPID was accepted' '[ "$pid_count" -eq 1 ] && [[ "$pid" =~ ^[1-9][0-9]*$ ]] ||' ': ||'
    mutant_expect_red unit_group 'wrong unit ControlGroup was accepted' '|| [ "${group##*/}" != "sdme@$name.service" ]' ''
    mutant_expect_red hierarchy 'wrong cgroup hierarchy was accepted' 'if [[ "$cgroup_line" != '\''0::/'\''* || "$cgroup_line" == *$'\''\n'\''* ]]; then' 'if false; then'
    mutant_expect_red cgroup 'foreign cgroup was accepted' 'if [ "$process_group" != "$group" ] && [[ "$process_group" != "$group/"* ]]; then' 'if false; then'
    mutant_expect_red machine 'wrong machine argument was accepted' '[ "$machine" -eq 1 ] ||' ': ||'
    mutant_expect_red directory 'wrong directory argument was accepted' '[ "$directory" -eq 1 ] ||' ': ||'
    mutant_expect_red selector 'selector with no tests refuses' '[ "$1" -gt 0 ]' 'true'
    mutant_expect_red revision 'moving guest revision refuses' '[ "$1" = "$2" ]' 'true'
fi

if [ "$FAILURES" -ne 0 ]; then
    printf 'RESULT: %d assertion(s) failed\n' "$FAILURES"
    exit 1
fi
printf 'RESULT: all assertions passed\n'
