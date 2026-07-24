#!/usr/bin/env bash
# Manual storm check for the devserver rebuild-storm fixes (v0.76.0, levers
# 1-4; see team/roadmap/v0.76.0/devserver-rebuild-storm-and-livelock.md).
#
# Proves the kill-switch end to end against a real server:
#   1. a build torrent inside an EXCLUDED tree (buck-out/) produces ZERO
#      full rebuilds and an idle index, and
#   2. the same class of torrent inside the TRACKED tree (src/) indexes
#      per-file, again with zero full rebuilds.
#
# Not part of CI (wall-clock heavy). Run from the repo root:
#   scripts/e2e/storm-check.sh
# Env: CHAN_BIN (default target/debug/chan), TMPDIR override as needed
# (a stray /tmp/.git makes chan's vcs-parent check refuse the workspace).

set -euo pipefail

CHAN_BIN=${CHAN_BIN:-target/debug/chan}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/chan-storm-XXXXXX")
HOME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/chan-storm-home-XXXXXX")
LOG="$WORK/server.log"
PID=""

say() { printf '[storm] %s\n' "$*" >&2; }
die() { say "FAIL: $*"; exit 1; }

cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  [ -n "$PID" ] && wait "$PID" 2>/dev/null || true
  CHAN_HOME="$HOME_DIR" "$CHAN_BIN" workspace rm "$WORK/ws" >/dev/null 2>&1 || true
  rm -rf "$WORK" "$HOME_DIR"
}
trap cleanup EXIT

[ -x "$CHAN_BIN" ] || die "chan binary missing at $CHAN_BIN (build first)"

# ---- seed -------------------------------------------------------------
say "seeding workspace at $WORK/ws"
mkdir -p "$WORK/ws/buck-out/gen" "$WORK/ws/src"
for i in $(seq 1 2000); do
  printf 'artifact %d\n' "$i" >"$WORK/ws/buck-out/gen/a$(printf '%04d' "$i").txt"
done
for i in $(seq 1 50); do
  printf '# note %d\n' "$i" >"$WORK/ws/src/n$(printf '%02d' "$i").md"
done

# ---- serve ------------------------------------------------------------
say "starting server (logs: $LOG)"
CHAN_NO_DEVSERVER_HANDOFF=1 CHAN_HOME="$HOME_DIR" \
  "$CHAN_BIN" open --port 0 --no-browser "$WORK/ws" >"$LOG" 2>&1 &
PID=$!
URL=""
for _ in $(seq 1 60); do
  URL=$(grep -o 'http://[^ ]*' "$LOG" 2>/dev/null | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || die "server never printed its URL"
TOK=${URL##*t=}
BASE=${URL%%\?*}
BASE=${BASE%/}
say "server up: $BASE"

index_status() {
  curl -sf -H "Authorization: Bearer $TOK" "$BASE/api/index/status" || true
}
rebuild_warns() { grep -c 'requesting rebuild' "$LOG" || true; }

# Wait for the boot rebuild of src/ to settle.
for _ in $(seq 1 60); do
  if index_status | grep -q '"type":"idle"\|"idle"'; then break; fi
  sleep 1
done
say "boot settled: $(index_status)"

# ---- torrent inside the excluded tree ----------------------------------
say "torrent into buck-out/ (3 writers x 400 appends)"
writer_pids=()
for w in 1 2 3; do
  (
    for i in $(seq 1 400); do
      f=$(( (i * w) % 2000 + 1 ))
      printf 'storm %d\n' "$i" >>"$WORK/ws/buck-out/gen/a$(printf '%04d' "$f").txt"
    done
  ) &
  writer_pids+=($!)
done
# Only the writers: a bare `wait` would also park on the server itself.
wait "${writer_pids[@]}"
sleep 5
WARNS=$(rebuild_warns)
say "rebuild WARNs after excluded torrent: $WARNS"
[ "$WARNS" = "0" ] || die "excluded torrent triggered full rebuilds"
index_status | grep -q '"type":"idle"\|"idle"' ||
  die "index not idle after excluded torrent: $(index_status)"
say "PASS: excluded torrent produced zero rebuilds, index idle"

# ---- counter-test: torrent inside the tracked tree ---------------------
say "append to tracked src/ notes"
for i in $(seq 1 50); do
  printf 'more %d\n' "$i" >>"$WORK/ws/src/n$(printf '%02d' "$i").md"
done
sleep 8
WARNS=$(rebuild_warns)
say "rebuild WARNs after tracked append: $WARNS"
[ "$WARNS" = "0" ] || die "routine per-file indexing escalated to full rebuilds"
index_status | grep -q '"type":"idle"\|"idle"' ||
  die "index not idle after tracked append: $(index_status)"
say "PASS: tracked torrent stayed on the per-file path"

say "ALL GREEN"
