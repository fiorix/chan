#!/usr/bin/env bash
# Measure one Cargo package test selector repeatedly under a host-verified
# one-CPU sdme cap. Test failures are rate data; setup and instrument failures
# refuse the series instead of manufacturing an uncapped green result.

set -euo pipefail

readonly GUEST_TARGET=/var/tmp/chan-target

say() { printf 'one-cpu-series: %s\n' "$*" >&2; }
verbose() { [ "${VERBOSE:-0}" = 1 ] && say "$*" || true; }
die() { say "FAIL: $*"; exit 1; }
refuse() { say "REFUSED: $*"; exit 2; }

usage() {
    cat <<'EOF'
Usage: sudo scripts/e2e/one-cpu-test-series.sh [--verbose] [--sdme-config FILE] \
           --container NAME --package PACKAGE SELECTOR RUNS THREADS

Runs this fixed command shape inside an existing sdme container:

    cargo test -p PACKAGE SELECTOR -- --test-threads=THREADS

The container must be running on btrfs with a disk cap, expose a clean checkout
at /work/chan, and have an exact one-CPU cap visible from the host cgroup.
Without --sdme-config, the default sdme data directory is used.
Test-red runs contribute to the reported rate and do not make the script fail.
Refused or invalid instruments exit 2; other infrastructure failures exit 1.
EOF
}

state_value() {
    local file=$1 key=$2 line value='' found=0
    while IFS= read -r line; do
        case "$line" in
            "$key="*) value=${line#*=}; found=$((found + 1)) ;;
        esac
    done < "$file"
    [ "$found" -eq 1 ] || return 1
    printf '%s\n' "$value"
}

parse_datadir() {
    local output=$1 line value count=0
    PARSED_DATADIR=''
    DATADIR_ERROR=''
    while IFS= read -r line; do
        case "$line" in
            'datadir = '*)
                count=$((count + 1))
                value=${line#'datadir = '}
                if [[ "$value" == /* && "$value" != *[[:space:]]* && "$value" != *\"* && "$value" != *\'* ]]; then
                    PARSED_DATADIR=$value
                fi
                ;;
        esac
    done <<< "$output"
    if [ "$count" -ne 1 ] || [ -z "$PARSED_DATADIR" ]; then
        DATADIR_ERROR="sdme config get returned $count datadir lines; expected one unquoted 'datadir = /absolute/path' with no whitespace"
        return 1
    fi
}

state_file_for_datadir() {
    printf '%s/state/%s\n' "$1" "$2"
}

require_state_file() {
    local state=$1
    if [ ! -f "$state" ] || [ -L "$state" ]; then
        STORAGE_ERROR="missing exact sdme state: $state"
        return 1
    fi
}

configure_sdme() {
    local configured_file=$1 output
    SDME=(sdme)
    DATADIR=/var/lib/sdme
    STORAGE_ERROR=''
    if [ -n "$configured_file" ]; then
        if [ ! -f "$configured_file" ]; then
            STORAGE_ERROR='sdme configuration is not an existing regular file'
            return 1
        fi
        SDME=(sdme --config "$configured_file")
        if ! output=$("${SDME[@]}" config get 2>&1); then
            STORAGE_ERROR='sdme config get failed for the selected configuration'
            return 1
        fi
        if ! parse_datadir "$output"; then
            STORAGE_ERROR=$DATADIR_ERROR
            return 1
        fi
        DATADIR=$PARSED_DATADIR
    fi
    STATE=$(state_file_for_datadir "$DATADIR" "$CONTAINER")
    require_state_file "$STATE"
}

read_state_identity() {
    local state=$1 name=$2 state_name
    STATE_ERROR=''
    state_name=$(state_value "$state" NAME) || { STATE_ERROR='state has no unique NAME'; return 1; }
    STATE_BACKEND=$(state_value "$state" STORAGE) || { STATE_ERROR='state has no unique STORAGE'; return 1; }
    STATE_DISK=$(state_value "$state" DISK) || { STATE_ERROR='state has no unique DISK'; return 1; }
    [ "$state_name" = "$name" ] || { STATE_ERROR="state NAME does not match $name"; return 1; }
    [ "$STATE_BACKEND" = btrfs ] || { STATE_ERROR="container backend is '$STATE_BACKEND', expected btrfs"; return 1; }
    [ -n "$STATE_DISK" ] || { STATE_ERROR='container has no disk cap'; return 1; }
}

parse_unit_show() {
    local output=$1 name=$2 line active='' pid='' group='' active_count=0 pid_count=0 group_count=0
    IDENTITY_ERROR=''
    while IFS= read -r line; do
        case "$line" in
            ActiveState=*) active=${line#ActiveState=}; active_count=$((active_count + 1)) ;;
            MainPID=*) pid=${line#MainPID=}; pid_count=$((pid_count + 1)) ;;
            ControlGroup=*) group=${line#ControlGroup=}; group_count=$((group_count + 1)) ;;
        esac
    done <<< "$output"
    [ "$active_count" -eq 1 ] && [ "$active" = active ] || { IDENTITY_ERROR='unit ActiveState is not exactly one active value'; return 1; }
    [ "$pid_count" -eq 1 ] && [[ "$pid" =~ ^[1-9][0-9]*$ ]] || { IDENTITY_ERROR='unit MainPID is not one positive PID'; return 1; }
    if [ "$group_count" -ne 1 ] || [[ "$group" != /* ]] || [ "${group##*/}" != "sdme@$name.service" ] || [[ "$group" == *'/../'* || "$group" == *'/./'* || "$group" == *'//'* ]]; then
        IDENTITY_ERROR="unit ControlGroup is not an absolute path ending in sdme@$name.service"
        return 1
    fi
    UNIT_PID=$pid
    UNIT_CGROUP=$group
}

check_process_identity() {
    local cgroup_line=$1 group=$2 name=$3 datadir=$4 arg machine=0 directory=0
    shift 4
    IDENTITY_ERROR=''
    if [[ "$cgroup_line" != '0::/'* || "$cgroup_line" == *$'\n'* ]]; then
        IDENTITY_ERROR='main process has no single unified-hierarchy cgroup line'
        return 1
    fi
    local process_group=${cgroup_line#*::}
    if [ "$process_group" != "$group" ] && [[ "$process_group" != "$group/"* ]]; then
        IDENTITY_ERROR="main process is outside the unit ControlGroup $group"
        return 1
    fi
    for arg in "$@"; do
        [ "$arg" = "--machine=$name" ] && machine=$((machine + 1))
        [ "$arg" = "--directory=$datadir/btrfs/containers/$name" ] && directory=$((directory + 1))
    done
    [ "$machine" -eq 1 ] || { IDENTITY_ERROR="main process lacks exact --machine=$name argument"; return 1; }
    [ "$directory" -eq 1 ] || { IDENTITY_ERROR="main process lacks exact --directory=$datadir/btrfs/containers/$name argument"; return 1; }
}

read_running_guest() {
    local show cgroup_line
    local -a args=()
    if ! show=$(systemctl show --property=ActiveState,MainPID,ControlGroup "sdme@$CONTAINER.service" 2>&1); then
        IDENTITY_ERROR='cannot read unit ActiveState, MainPID and ControlGroup'
        return 1
    fi
    parse_unit_show "$show" "$CONTAINER" || return 1
    if [ ! -r "/proc/$UNIT_PID/cmdline" ] || [ ! -r "/proc/$UNIT_PID/cgroup" ]; then
        IDENTITY_ERROR='unit MainPID has no readable cmdline or cgroup'
        return 1
    fi
    if ! mapfile -d '' -t args < "/proc/$UNIT_PID/cmdline" || [ "${#args[@]}" -eq 0 ]; then
        IDENTITY_ERROR='unit MainPID has no readable NUL-delimited cmdline'
        return 1
    fi
    if ! cgroup_line=$(<"/proc/$UNIT_PID/cgroup"); then
        IDENTITY_ERROR='unit MainPID has no readable cgroup line'
        return 1
    fi
    check_process_identity "$cgroup_line" "$UNIT_CGROUP" "$CONTAINER" "$DATADIR" "${args[@]}" || return 1
    CGROUP=/sys/fs/cgroup$UNIT_CGROUP
}

read_one_cpu_cap() {
    local cgroup=$1 quota period extra
    [ -r "$cgroup/cpu.max" ] || return 1
    read -r quota period extra < "$cgroup/cpu.max" || return 1
    [ -z "${extra:-}" ] || return 1
    [[ "$quota" =~ ^[1-9][0-9]*$ ]] || return 1
    [[ "$period" =~ ^[1-9][0-9]*$ ]] || return 1
    [ "$quota" = "$period" ] || return 1
    printf '%s %s\n' "$quota" "$period"
}

read_nr_throttled() {
    local cgroup=$1 key value extra found=0 result=''
    [ -r "$cgroup/cpu.stat" ] || return 1
    while read -r key value extra; do
        if [ "$key" = nr_throttled ]; then
            [[ "$value" =~ ^[0-9]+$ ]] || return 1
            [ -z "${extra:-}" ] || return 1
            found=$((found + 1))
            result=$value
        fi
    done < "$cgroup/cpu.stat"
    [ "$found" -eq 1 ] || return 1
    printf '%s\n' "$result"
}

selected_test_count() {
    awk '/: test$/ { count++ } END { print count + 0 }' "$1"
}

has_selected_tests() {
    [ "$1" -gt 0 ]
}

same_revision() {
    [ "$1" = "$2" ]
}

guest_revision() {
    "${SDME[@]}" exec "$CONTAINER" -- env HOME=/root bash -lc '
        set -euo pipefail
        cd /work/chan
        status=$(git --no-optional-locks status --porcelain=v1)
        [ -z "$status" ] || {
            printf "tracked checkout is dirty:\n%s\n" "$status" >&2
            exit 2
        }
        git rev-parse --verify HEAD
    '
}

run_cargo() {
    # sdme exec drops some ${...} forms and rewrites $$ to $; ${@:2} passes intact.
    "${SDME[@]}" exec "$CONTAINER" -- env HOME=/root CARGO_TARGET_DIR="$GUEST_TARGET" \
        bash -lc 'cd /work/chan && exec cargo test -p "$1" "${@:2}"' \
        bash "$PACKAGE" "$@"
}

current_instrument() {
    local observed
    CHECK_ERROR=''
    configure_sdme "$CONFIG_PATH" || { CHECK_ERROR=$STORAGE_ERROR; return 1; }
    read_state_identity "$STATE" "$CONTAINER" || { CHECK_ERROR=$STATE_ERROR; return 1; }
    read_running_guest || { CHECK_ERROR=$IDENTITY_ERROR; return 1; }
    CURRENT_CPU_MAX=$(read_one_cpu_cap "$CGROUP") || {
        observed=$(cat "$CGROUP/cpu.max" 2>/dev/null || printf unreadable)
        CHECK_ERROR="host cpu.max is not exactly one CPU: ${observed:-unreadable}"
        return 1
    }
    CURRENT_REVISION=$(guest_revision) || { CHECK_ERROR='guest checkout is unavailable or dirty'; return 1; }
}

confirm_instrument() {
    current_instrument || return 1
    [ "$DATADIR" = "$INITIAL_DATADIR" ] && [ "$STATE" = "$INITIAL_STATE" ] || { CHECK_ERROR='selected sdme data directory or state path changed'; return 1; }
    [ "$STATE_BACKEND" = "$backend" ] && [ "$STATE_DISK" = "$disk_cap" ] || { CHECK_ERROR='state backend or disk cap changed'; return 1; }
    [ "$UNIT_PID" = "$INITIAL_PID" ] && [ "$UNIT_CGROUP" = "$INITIAL_CGROUP" ] || { CHECK_ERROR='unit MainPID or ControlGroup changed'; return 1; }
    [ "$CURRENT_CPU_MAX" = "$CPU_MAX" ] || { CHECK_ERROR='host one-CPU cap changed'; return 1; }
    same_revision "$CURRENT_REVISION" "$REVISION" || { CHECK_ERROR='guest revision changed'; return 1; }
}

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
    return 0
fi

VERBOSE=0
CONTAINER=''
PACKAGE=''
SDME_CONFIG_FILE=''
while [ "$#" -gt 0 ]; do
    case "$1" in
        -v | --verbose) VERBOSE=1; shift ;;
        --container)
            [ "$#" -ge 2 ] || { usage >&2; exit 64; }
            CONTAINER=$2
            shift 2
            ;;
        --package)
            [ "$#" -ge 2 ] || { usage >&2; exit 64; }
            PACKAGE=$2
            shift 2
            ;;
        --sdme-config)
            [ "$#" -ge 2 ] || { usage >&2; exit 64; }
            SDME_CONFIG_FILE=$2
            shift 2
            ;;
        -h | --help) usage; exit 0 ;;
        --) shift; break ;;
        -*) usage >&2; exit 64 ;;
        *) break ;;
    esac
done

[ -n "$CONTAINER" ] && [ -n "$PACKAGE" ] && [ "$#" -eq 3 ] || { usage >&2; exit 64; }
SELECTOR=$1
RUNS=$2
THREADS=$3
[[ "$CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]] || refuse "invalid container name"
[[ "$PACKAGE" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || refuse "invalid package name"
[[ "$SELECTOR" =~ ^[A-Za-z0-9_:.+-]+$ ]] || refuse "invalid test selector"
[[ "$RUNS" =~ ^[1-9][0-9]*$ ]] || refuse "run count must be a positive integer"
[[ "$THREADS" =~ ^[1-9][0-9]*$ ]] || refuse "thread count must be a positive integer"
[ "$EUID" -eq 0 ] || refuse "run through sudo so sdme and host cgroups are authoritative"
for command in awk flock grep mktemp realpath sdme systemctl; do
    command -v "$command" >/dev/null || refuse "missing host command: $command"
done

CONFIG_PATH=''
if [ -n "$SDME_CONFIG_FILE" ]; then
    CONFIG_PATH=$(realpath -e -- "$SDME_CONFIG_FILE") || refuse 'sdme configuration is not an existing regular file'
    [ -f "$CONFIG_PATH" ] || refuse 'sdme configuration is not an existing regular file'
fi

exec 9>"/run/lock/chan-one-cpu-$CONTAINER.lock"
flock -n 9 || refuse "another series owns container $CONTAINER"

current_instrument || refuse "$CHECK_ERROR"
INITIAL_DATADIR=$DATADIR
INITIAL_STATE=$STATE
INITIAL_PID=$UNIT_PID
INITIAL_CGROUP=$UNIT_CGROUP
backend=$STATE_BACKEND
disk_cap=$STATE_DISK
CPU_MAX=$CURRENT_CPU_MAX
REVISION=$CURRENT_REVISION
if ! THROTTLED_BEFORE=$(read_nr_throttled "$CGROUP"); then
    refuse "host cpu.stat has no valid nr_throttled"
fi

RESULT_DIR=$(mktemp -d /var/tmp/chan-one-cpu-series.XXXXXX)
STATUS_FILE=$RESULT_DIR/status.tsv
printf 'run\texit\tstatus\n' > "$STATUS_FILE"
verbose "result_dir=$RESULT_DIR"
say "container=$CONTAINER backend=$backend disk=$disk_cap cpu_max='$CPU_MAX' revision=$REVISION"

LIST_LOG=$RESULT_DIR/list.log
confirm_instrument || refuse "$CHECK_ERROR before selector validation"
if ! run_cargo "$SELECTOR" -- --list > "$LIST_LOG" 2>&1; then
    die "selector validation failed; log=$LIST_LOG"
fi
confirm_instrument || refuse "$CHECK_ERROR during selector validation"
selected=$(selected_test_count "$LIST_LOG")
has_selected_tests "$selected" || refuse "selector matched no tests; log=$LIST_LOG"
say "package=$PACKAGE selector=$SELECTOR selected_tests=$selected runs=$RUNS threads=$THREADS"

red=0
for ((run = 1; run <= RUNS; run++)); do
    confirm_instrument || refuse "$CHECK_ERROR before run $run"
    log=$RESULT_DIR/run-$run.log
    if run_cargo "$SELECTOR" -- "--test-threads=$THREADS" > "$log" 2>&1; then
        rc=0
        status=green
    else
        rc=$?
        if [ "$rc" -ne 101 ] || ! grep -q '^test result: FAILED\.' "$log"; then
            die "run $run failed outside the measured test result (exit $rc); log=$log"
        fi
        status=red
        red=$((red + 1))
    fi
    confirm_instrument || refuse "$CHECK_ERROR during run $run"
    printf '%d\t%d\t%s\n' "$run" "$rc" "$status" >> "$STATUS_FILE"
    say "run=$run/$RUNS status=$status exit=$rc"
done

THROTTLED_AFTER=$(read_nr_throttled "$CGROUP") || refuse "final nr_throttled is unavailable"
confirm_instrument || refuse "$CHECK_ERROR before the result was recorded"
throttled_delta=$((THROTTLED_AFTER - THROTTLED_BEFORE))
[ "$throttled_delta" -ge 0 ] || die "nr_throttled moved backwards"
green=$((RUNS - red))
summary="container=$CONTAINER backend=$backend disk=$disk_cap cpu_max='$CPU_MAX' threads=$THREADS revision=$REVISION package=$PACKAGE selector=$SELECTOR selected_tests=$selected red=$red runs=$RUNS rate=$red/$RUNS green=$green nr_throttled_delta=$throttled_delta output=$RESULT_DIR"
printf '%s\n' "$summary" > "$RESULT_DIR/result.txt"
printf '%s\n' "$summary"
