#!/usr/bin/env bash
# Measure one chan-workspace test selector repeatedly under a host-verified
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
Usage: sudo scripts/e2e/one-cpu-test-series.sh [--verbose] \
           --container NAME SELECTOR RUNS THREADS

Runs this fixed command shape inside an existing sdme container:

    cargo test -p chan-workspace SELECTOR -- --test-threads=THREADS

The container must be running on btrfs with a disk cap, expose a clean checkout
at /work/chan, and have an exact one-CPU cap visible from the host cgroup.
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

guest_revision() {
    sdme exec "$CONTAINER" -- env HOME=/root bash -lc '
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
    sdme exec "$CONTAINER" -- env HOME=/root CARGO_TARGET_DIR="$GUEST_TARGET" \
        bash -lc 'cd /work/chan && exec cargo test -p chan-workspace "$@"' \
        bash "$@"
}

confirm_instrument() {
    local cap revision
    if ! cap=$(read_one_cpu_cap "$CGROUP"); then
        return 1
    fi
    [ "$cap" = "$CPU_MAX" ] || return 1
    if ! revision=$(guest_revision); then
        return 1
    fi
    [ "$revision" = "$REVISION" ]
}

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
    return 0
fi

VERBOSE=0
CONTAINER=''
while [ "$#" -gt 0 ]; do
    case "$1" in
        -v | --verbose) VERBOSE=1; shift ;;
        --container)
            [ "$#" -ge 2 ] || { usage >&2; exit 64; }
            CONTAINER=$2
            shift 2
            ;;
        -h | --help) usage; exit 0 ;;
        --) shift; break ;;
        -*) usage >&2; exit 64 ;;
        *) break ;;
    esac
done

[ -n "$CONTAINER" ] && [ "$#" -eq 3 ] || { usage >&2; exit 64; }
SELECTOR=$1
RUNS=$2
THREADS=$3
[[ "$CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]] || refuse "invalid container name"
[[ "$SELECTOR" =~ ^[A-Za-z0-9_:.+-]+$ ]] || refuse "invalid test selector"
[[ "$RUNS" =~ ^[1-9][0-9]*$ ]] || refuse "run count must be a positive integer"
[[ "$THREADS" =~ ^[1-9][0-9]*$ ]] || refuse "thread count must be a positive integer"
[ "$EUID" -eq 0 ] || refuse "run through sudo so sdme and host cgroups are authoritative"
for command in awk flock grep mktemp sdme systemctl tr; do
    command -v "$command" >/dev/null || refuse "missing host command: $command"
done

STATE=/var/lib/sdme/state/$CONTAINER
[ -f "$STATE" ] && [ ! -L "$STATE" ] || refuse "missing exact sdme state: $STATE"
state_name=$(state_value "$STATE" NAME) || refuse "state has no unique NAME"
backend=$(state_value "$STATE" STORAGE) || refuse "state has no unique STORAGE"
disk_cap=$(state_value "$STATE" DISK) || refuse "state has no unique DISK"
[ "$state_name" = "$CONTAINER" ] || refuse "state NAME does not match $CONTAINER"
[ "$backend" = btrfs ] || refuse "container backend is '$backend', expected btrfs"
[ -n "$disk_cap" ] || refuse "container has no disk cap"
systemctl is-active --quiet "sdme@$CONTAINER.service" || refuse "container is not running"

exec 9>"/run/lock/chan-one-cpu-$CONTAINER.lock"
flock -n 9 || refuse "another series owns container $CONTAINER"

CGROUP=/sys/fs/cgroup/machine.slice/sdme@$CONTAINER.service
if ! CPU_MAX=$(read_one_cpu_cap "$CGROUP"); then
    observed=$(tr '\n' ' ' < "$CGROUP/cpu.max" 2>/dev/null || printf unreadable)
    refuse "host cpu.max is not exactly one CPU: ${observed:-unreadable}"
fi
if ! THROTTLED_BEFORE=$(read_nr_throttled "$CGROUP"); then
    refuse "host cpu.stat has no valid nr_throttled"
fi
if ! REVISION=$(guest_revision); then
    refuse "guest checkout is unavailable or dirty"
fi

RESULT_DIR=$(mktemp -d /var/tmp/chan-one-cpu-series.XXXXXX)
STATUS_FILE=$RESULT_DIR/status.tsv
printf 'run\texit\tstatus\n' > "$STATUS_FILE"
verbose "result_dir=$RESULT_DIR"
say "container=$CONTAINER backend=$backend disk=$disk_cap cpu_max='$CPU_MAX' revision=$REVISION"

LIST_LOG=$RESULT_DIR/list.log
confirm_instrument || refuse "cap or revision changed before selector validation"
if ! run_cargo "$SELECTOR" -- --list > "$LIST_LOG" 2>&1; then
    die "selector validation failed; log=$LIST_LOG"
fi
confirm_instrument || refuse "cap or revision changed during selector validation"
selected=$(awk '/: test$/ { count++ } END { print count + 0 }' "$LIST_LOG")
[ "$selected" -gt 0 ] || refuse "selector matched no tests; log=$LIST_LOG"
say "selector=$SELECTOR selected_tests=$selected runs=$RUNS threads=$THREADS"

red=0
for ((run = 1; run <= RUNS; run++)); do
    confirm_instrument || refuse "cap or revision changed before run $run"
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
    confirm_instrument || refuse "cap or revision changed during run $run"
    printf '%d\t%d\t%s\n' "$run" "$rc" "$status" >> "$STATUS_FILE"
    say "run=$run/$RUNS status=$status exit=$rc"
done

THROTTLED_AFTER=$(read_nr_throttled "$CGROUP") || refuse "final nr_throttled is unavailable"
confirm_instrument || refuse "cap or revision changed before the result was recorded"
throttled_delta=$((THROTTLED_AFTER - THROTTLED_BEFORE))
[ "$throttled_delta" -ge 0 ] || die "nr_throttled moved backwards"
green=$((RUNS - red))
summary="container=$CONTAINER backend=$backend disk=$disk_cap cpu_max='$CPU_MAX' threads=$THREADS revision=$REVISION selector=$SELECTOR selected_tests=$selected red=$red runs=$RUNS rate=$red/$RUNS green=$green nr_throttled_delta=$throttled_delta output=$RESULT_DIR"
printf '%s\n' "$summary" > "$RESULT_DIR/result.txt"
printf '%s\n' "$summary"
