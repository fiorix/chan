#!/usr/bin/env bash
# Owner-run 2 GiB close-after-write proof for cs tunnel.
#
# This wrapper is the only entry point for the ignored Rust scenario. It keeps
# the large fixture outside /tmp, serves it with Python's HTTP/1.0-style close,
# records the exact commit, and preserves the complete sandbox on failure.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$SCRIPT_DIR/../.." && pwd)
ITERATIONS=${CHAN_REVTUNNEL_LARGE_ITERATIONS:-3}
PYTHON_PID=""
RUN_DIR=""
SUCCESS=0

say() { printf '[revtunnel-large] %s\n' "$*" >&2; }
die() { say "FAIL: $*"; exit 1; }

for command in awk cargo curl date git python3 seq sha256sum sleep stat timeout truncate; do
  command -v "$command" >/dev/null || die "missing required command: $command"
done
# GNU time, not the shell builtin, which reports no resident-set figure.
[ -x /usr/bin/time ] || die "missing required command: /usr/bin/time (GNU time)"

case "$ITERATIONS" in
  '' | *[!0-9]*) die "CHAN_REVTUNNEL_LARGE_ITERATIONS must be a positive integer" ;;
esac
[ "$ITERATIONS" -gt 0 ] || die "CHAN_REVTUNNEL_LARGE_ITERATIONS must be positive"

: "${TMPDIR:?export TMPDIR to a directory under HOME before running}"
case "$TMPDIR" in
  /tmp | /tmp/*) die "TMPDIR must not use the shared /tmp tmpfs" ;;
esac
mkdir -p "$TMPDIR"

[ -z "$(git -C "$REPO" status --porcelain)" ] ||
  die "worktree must be clean so the recorded commit is the exact code under test"

cleanup() {
  if [ -n "$PYTHON_PID" ]; then
    kill "$PYTHON_PID" 2>/dev/null || true
    wait "$PYTHON_PID" 2>/dev/null || true
    PYTHON_PID=""
  fi
  if [ "$SUCCESS" -eq 1 ] && [ -n "$RUN_DIR" ]; then
    case "$RUN_DIR" in
      "$TMPDIR"/chan-revtunnel-large.*) rm -rf "$RUN_DIR" ;;
      *) say "refusing to remove unexpected run directory: $RUN_DIR" ;;
    esac
  elif [ -n "$RUN_DIR" ]; then
    say "failure artifacts preserved at $RUN_DIR"
  fi
}
trap cleanup EXIT

RUN_DIR=$(mktemp -d "$TMPDIR/chan-revtunnel-large.XXXXXX")
FIXTURE="$RUN_DIR/payload.bin"
OUTPUT_DIR="$RUN_DIR/output"
PYTHON_LOG="$RUN_DIR/python-http.log"
BUILD_LOG="$RUN_DIR/cargo-build.log"
CARGO_LOG="$RUN_DIR/cargo-test.log"
RSS_LOG="$RUN_DIR/peak-rss.txt"
mkdir -p "$OUTPUT_DIR"
truncate -s 2G "$FIXTURE"

COMMIT=$(git -C "$REPO" rev-parse HEAD)
FIXTURE_BYTES=$(stat -c %s "$FIXTURE")
FIXTURE_HASH=$(sha256sum "$FIXTURE" | awk '{print $1}')
say "commit=$COMMIT"
say "run_dir=$RUN_DIR"
say "fixture_bytes=$FIXTURE_BYTES fixture_sha256=$FIXTURE_HASH iterations=$ITERATIONS"
df -h / >&2

python3 -m http.server 18501 --bind 127.0.0.1 --directory "$RUN_DIR" \
  >"$PYTHON_LOG" 2>&1 &
PYTHON_PID=$!
READY=0
for _ in $(seq 1 100); do
  kill -0 "$PYTHON_PID" 2>/dev/null || break
  if curl --fail --silent --show-error --head \
    http://127.0.0.1:18501/payload.bin >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.1
done
[ "$READY" -eq 1 ] || die "python origin did not become ready; see $PYTHON_LOG"

export CHAN_REVTUNNEL_LARGE_FIXTURE="$FIXTURE"
export CHAN_REVTUNNEL_LARGE_OUTPUT="$OUTPUT_DIR"
export CHAN_REVTUNNEL_LARGE_ITERATIONS="$ITERATIONS"

# Build before measuring. A compile inside the measured region would report
# rustc's resident set rather than the transfer's, and rustc's is larger by
# enough to swamp the number entirely. This also makes elapsed_seconds describe
# the transfer, which is what it was always meant to mean.
cargo test -p chan --test revtunnel_e2e --no-run >"$BUILD_LOG" 2>&1 ||
  die "building the e2e scenario failed; see $BUILD_LOG"

STARTED=$(date +%s)
set +e
# Peak RSS is the largest resident set reached by any single process in the
# tree, which for this scenario is the test binary moving the fixture. It is
# the number that says whether a multi-gigabyte transfer streams or buffers:
# a whole-file read shows up here as a figure near fixture_bytes, and flat
# memory shows up as a figure that does not track the fixture size at all.
/usr/bin/time -f '%M' -o "$RSS_LOG" \
  timeout --signal=TERM --kill-after=10s 900s \
    cargo test -p chan --test revtunnel_e2e \
      tunnel_preserves_two_gib_close_after_write -- \
      --ignored --exact --nocapture >"$CARGO_LOG" 2>&1
STATUS=$?
set -e
ELAPSED=$(( $(date +%s) - STARTED ))
# The last all-digit line, not the first: on a non-zero exit GNU time writes a
# "Command exited with non-zero status" line ahead of the format output, and a
# failing run is exactly when the figure is worth having.
PEAK_RSS_KB=$(awk '/^[0-9]+$/ { value = $1 } END { print value }' "$RSS_LOG")
[ -n "$PEAK_RSS_KB" ] || PEAK_RSS_KB=unknown

cat "$CARGO_LOG"
say "cargo_status=$STATUS elapsed_seconds=$ELAPSED peak_rss_kb=$PEAK_RSS_KB"
[ "$STATUS" -eq 0 ] || exit "$STATUS"

SUCCESS=1
say "PASS: 2 GiB close-after-write transfer preserved for $ITERATIONS iterations"
