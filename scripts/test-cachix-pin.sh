#!/usr/bin/env bash
# Contract test for cachix-pin.sh, which never reaches Cachix: `pin` runs a
# stand-in `cachix` from a throwaway PATH that records each call and refuses
# anything but `pin CACHE NAME STORE_PATH --keep-revisions N`, the grammar of
# cachix 1.13's `pin` command with the one retention flag the helper uses.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$SCRIPT_DIR/cachix-pin.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/chan-cachix-pin-contract.XXXXXX")"
BIN="$TMP/bin"
CALLS="$TMP/calls"
OUT="$TMP/out"
CHAN=/nix/store/0123456789abcdfghijklmnpqrsvwxyz-chan-0.121.0
DESKTOP=/nix/store/zyxwvsrqpnmlkjihgfdcba9876543210-chan-desktop-0.121.0
STATUS=
failures=0

cleanup() {
    rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
    echo "not ok - $*" >&2
    failures=$((failures + 1))
}

mkdir -p "$BIN"
cat >"$BIN/cachix" <<'EOF'
#!/usr/bin/env bash
# Stand-in cachix: record the call, then hold it to the pin grammar.
printf '%s\n' "$*" >>"$CACHIX_CALLS"
[ "$#" -eq 6 ] && [ "$1" = pin ] && [ "$5" = --keep-revisions ] || {
    echo "stand-in cachix: unexpected call: $*" >&2
    exit 64
}
[[ "$6" =~ ^[1-9][0-9]*$ ]] || { echo "stand-in cachix: bad --keep-revisions $6" >&2; exit 64; }
[[ "$4" == /nix/store/* ]] || { echo "stand-in cachix: bad store path $4" >&2; exit 64; }
if [ -n "${CACHIX_FAIL_ON:-}" ] && [ "$3" = "$CACHIX_FAIL_ON" ]; then
    echo "stand-in cachix: refusing $3" >&2
    exit 1
fi
EOF
chmod +x "$BIN/cachix"

# Run the helper with the stand-in first on PATH, ahead of any real cachix.
run() {
    : >"$CALLS"
    set +e
    CACHIX_CALLS="$CALLS" PATH="$BIN:$PATH" "$HELPER" "$@" >"$OUT" 2>"$OUT.err"
    STATUS=$?
    set -e
}

assert_status() {
    [ "$STATUS" -eq "$1" ] || fail "$2 (expected status $1, got $STATUS): $(cat "$OUT" "$OUT.err")"
}

assert_stdout() {
    local want="$1" message="$2"
    [ "$(cat "$OUT")" = "$want" ] || fail "$message: got $(cat "$OUT")"
}

assert_calls() {
    local want="$1" message="$2"
    [ "$(cat "$CALLS")" = "$want" ] || fail "$message: called $(cat "$CALLS")"
}

assert_err() {
    grep -Eq -- "$1" "$OUT.err" || fail "$2: $(cat "$OUT.err")"
}

# The stand-in is only a check if it refuses what the real pin command would
# not be asked: a pin with no retention, and a retention it does not take.
set +e
CACHIX_CALLS="$CALLS" "$BIN/cachix" pin chan chan-x86_64-linux "$CHAN" >/dev/null 2>&1
no_retention=$?
CACHIX_CALLS="$CALLS" "$BIN/cachix" pin chan chan-x86_64-linux "$CHAN" --keep-days 10 >/dev/null 2>&1
other_retention=$?
set -e
[ "$no_retention" -eq 64 ] || fail "the stand-in accepts a pin with no retention"
[ "$other_retention" -eq 64 ] || fail "the stand-in accepts --keep-days"

PLAN="cachix pin chan chan-x86_64-linux $CHAN --keep-revisions 10
cachix pin chan chan-desktop-x86_64-linux $DESKTOP --keep-revisions 10"

# plan: the commands, one a line, under the stable names, and nothing run.
run plan chan 10 x86_64-linux "chan=$CHAN" "chan-desktop=$DESKTOP"
assert_status 0 "plan succeeds"
assert_stdout "$PLAN" "plan prints a pin per package under its stable name"
assert_calls "" "plan runs no cachix command"

# pin: the same commands, run in order, echoed to stderr, stdout left empty.
run pin chan 10 x86_64-linux "chan=$CHAN" "chan-desktop=$DESKTOP"
assert_status 0 "pin succeeds"
assert_calls "pin chan chan-x86_64-linux $CHAN --keep-revisions 10
pin chan chan-desktop-x86_64-linux $DESKTOP --keep-revisions 10" "pin runs what plan prints"
assert_stdout "" "pin keeps stdout empty"
[ "$(cat "$OUT.err")" = "$PLAN" ] || fail "pin echoes each command to stderr: $(cat "$OUT.err")"

# The name carries the system, and KEEP passes through as given.
run plan chan 3 aarch64-linux "chan-desktop=$DESKTOP"
assert_status 0 "plan on aarch64 with KEEP 3 succeeds"
assert_stdout "cachix pin chan chan-desktop-aarch64-linux $DESKTOP --keep-revisions 3" "the aarch64 name and KEEP 3"

# A failed pin is red, names the pin, and runs nothing after it.
CACHIX_FAIL_ON=chan-x86_64-linux run pin chan 10 x86_64-linux "chan=$CHAN" "chan-desktop=$DESKTOP"
assert_status 1 "a failed pin fails the helper"
assert_err "^cachix pin: pinning failed: cachix pin chan chan-x86_64-linux " "the failed pin is named"
assert_calls "pin chan chan-x86_64-linux $CHAN --keep-revisions 10" "nothing runs after the failed pin"

# Refusals: each before any command, with the reason on stderr.
refused() {
    local message="$1"
    shift
    run pin "$@"
    assert_status 1 "$message"
    assert_calls "" "$message runs no cachix command"
    assert_stdout "" "$message prints no command"
}
for keep in 0 -1 01 1.5 ten "" 10000 " 10"; do
    refused "KEEP '$keep' is refused" chan "$keep" x86_64-linux "chan=$CHAN"
    assert_err "revisions to keep must be a whole number from 1 to 9999" "KEEP '$keep' names the rule"
done
refused "a cache with a space is refused" "chan cache" 10 x86_64-linux "chan=$CHAN"
refused "a malformed system is refused" chan 10 x86_64 "chan=$CHAN"
refused "a pair without = is refused" chan 10 x86_64-linux "$CHAN"
refused "an upper-case package is refused" chan 10 x86_64-linux "Chan=$CHAN"
refused "a path outside the store is refused" chan 10 x86_64-linux "chan=/tmp/chan"
refused "a store path with a short hash is refused" chan 10 x86_64-linux "chan=/nix/store/abc-chan"
refused "a store path with a space is refused" chan 10 x86_64-linux "chan=$CHAN extra"
# The second pair is checked before the first is pinned.
refused "a bad second pair stops the first pin" chan 10 x86_64-linux "chan=$CHAN" "chan-desktop=/tmp/x"

# Usage errors.
run bogus chan 10 x86_64-linux "chan=$CHAN"
assert_status 2 "an unknown mode is a usage error"
assert_err "^usage: " "the unknown mode prints the usage"
run plan chan 10 x86_64-linux
assert_status 2 "no PACKAGE=STORE_PATH is a usage error"
assert_calls "" "a usage error runs no cachix command"

if [ "$failures" -ne 0 ]; then
    echo "FAIL: $failures contract assertion(s) failed" >&2
    exit 1
fi
echo "ok - scripts/cachix-pin.sh contract"
