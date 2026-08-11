#!/usr/bin/env bash
# Focused parser tests for the host cgroup and sdme state refusal boundary.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/one-cpu-test-series.sh
source "$SCRIPT_DIR/one-cpu-test-series.sh"

WORK=$(mktemp -d /var/tmp/chan-one-cpu-selftest.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
FAILURES=0

pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

accept_cap() {
    local value=$1 expected=$2 actual
    printf '%s\n' "$value" > "$WORK/cpu.max"
    : > "$WORK/cpu.stat"
    if actual=$(read_one_cpu_cap "$WORK") && [ "$actual" = "$expected" ]; then
        pass "accepts one CPU: $value"
    else
        fail "rejected one CPU: $value"
    fi
}

reject_cap() {
    local value=$1
    printf '%s\n' "$value" > "$WORK/cpu.max"
    if read_one_cpu_cap "$WORK" >/dev/null; then
        fail "accepted invalid cap: $value"
    else
        pass "rejects invalid cap: $value"
    fi
}

accept_cap '100000 100000' '100000 100000'
accept_cap '50000 50000' '50000 50000'
reject_cap 'max 100000'
reject_cap '200000 100000'
reject_cap '50000 100000'
reject_cap '0 100000'
reject_cap '100000 100000 extra'
reject_cap 'not-a-cap'
rm -f "$WORK/cpu.max"
if read_one_cpu_cap "$WORK" >/dev/null; then
    fail 'accepted a missing cpu.max'
else
    pass 'rejects a missing cpu.max'
fi

cat > "$WORK/state" <<'EOF'
NAME=rig
STORAGE=btrfs
DISK=44G
EOF
if [ "$(state_value "$WORK/state" STORAGE)" = btrfs ]; then
    pass 'reads one exact state key'
else
    fail 'did not read one exact state key'
fi
printf 'STORAGE=overlay\n' >> "$WORK/state"
if state_value "$WORK/state" STORAGE >/dev/null; then
    fail 'accepted a duplicate state key'
else
    pass 'rejects duplicate state keys'
fi

cat > "$WORK/cpu.stat" <<'EOF'
usage_usec 20
nr_periods 7
nr_throttled 5
EOF
if [ "$(read_nr_throttled "$WORK")" = 5 ]; then
    pass 'reads one exact nr_throttled field'
else
    fail 'did not read nr_throttled'
fi
printf 'nr_throttled 6\n' >> "$WORK/cpu.stat"
if read_nr_throttled "$WORK" >/dev/null; then
    fail 'accepted duplicate nr_throttled fields'
else
    pass 'rejects duplicate nr_throttled fields'
fi

if [ "$FAILURES" -ne 0 ]; then
    printf 'RESULT: %d assertion(s) failed\n' "$FAILURES"
    exit 1
fi
printf 'RESULT: all assertions passed\n'
