#!/usr/bin/env bash
# WL-17: a workspace root whose mount flaps under a live devserver.
#
# Proves the transient-transport contract end to end against a REAL FUSE
# mount: a mounted workspace whose filesystem dies reports `unavailable`
# rather than `running` or `error`, does not report its files as deleted, and
# recovers by itself once the mount is repaired -- including across a remount,
# which invalidates the capability handle the workspace was opened with.
#
# The mount is a local rclone `:memory:` remote. Nothing here touches a cloud
# account or the network; only the FUSE transport is real, which is the part
# that matters, because killing the daemon reproduces exactly the ENOTCONN
# state a stalled Google Drive mount leaves behind. NEVER point this at a real
# remote.
#
# Two arms:
#   A. idle workspace  -- the classification and remount-recovery contract.
#   B. busy workspace  -- the same kill while an index pass is walking a seeded
#      tree, which is the in-flight case that used to wedge the row
#      unopenable (`WorkspaceAlreadyOpen`) until the devserver restarted.
#
# Throwaway CHAN_HOME, port and mountpoint; tears down only what it started.
# Exit 0 all assertions held, 1 an assertion failed, 2 the environment cannot
# run the suite.
set -uo pipefail

FILES="${FLAKY_MOUNT_FILES:-4000}"
POLL_TIMEOUT="${FLAKY_MOUNT_POLL_TIMEOUT:-60}"
FAILURES=0

die_env() {
  echo "flaky-mount: SKIP (environment): $*" >&2
  exit 2
}
say()  { printf '\n== %s ==\n' "$*"; }
ok()   { printf '  ok   %s\n' "$*"; }
bad()  { printf '  FAIL %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

# --- environment ------------------------------------------------------------

RCLONE=""
for candidate in mclone rclone; do
  command -v "$candidate" >/dev/null 2>&1 && { RCLONE="$candidate"; break; }
done
[ -n "$RCLONE" ] || die_env "no mclone/rclone on PATH"
command -v curl >/dev/null 2>&1 || die_env "curl is required"
command -v python3 >/dev/null 2>&1 || die_env "python3 is required"
command -v mountpoint >/dev/null 2>&1 || die_env "mountpoint is required"
[ -e /dev/fuse ] || die_env "/dev/fuse is absent (an sdme container needs it passed in)"

CHAN_BIN="${CHAN_BIN:-}"
if [ -z "$CHAN_BIN" ]; then
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  CHAN_BIN="${CARGO_TARGET_DIR:-$repo_root/target}/debug/chan"
fi
[ -x "$CHAN_BIN" ] || die_env "no chan binary at $CHAN_BIN (set CHAN_BIN)"

COMMIT="$(git -C "$(dirname "$CHAN_BIN")" rev-parse HEAD 2>/dev/null \
  || git rev-parse HEAD 2>/dev/null || echo unknown)"
echo "flaky-mount: commit under test: $COMMIT"

WORK="$(mktemp -d "${TMPDIR:-/var/tmp}/chan-flaky-mount.XXXXXX")" || die_env "mktemp failed"
MNT="$WORK/mnt"
export CHAN_HOME="$WORK/chanhome"
WS="$MNT/notes"
RCLONE_PID=""
SERVER_PID=""
KEEP_ON_FAIL=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null
    sleep 1
    kill -9 "$SERVER_PID" 2>/dev/null
  fi
  [ -n "$RCLONE_PID" ] && kill -9 "$RCLONE_PID" 2>/dev/null
  sleep 1
  fusermount -u "$MNT" 2>/dev/null || fusermount3 -u "$MNT" 2>/dev/null \
    || umount -l "$MNT" 2>/dev/null
  sleep 1
  if [ -n "$KEEP_ON_FAIL" ]; then
    echo "flaky-mount: work dir kept for inspection: $WORK" >&2
    return
  fi
  # Only ever a path this script created with mktemp -d, matched literally.
  case "$WORK" in
    "${TMPDIR:-/var/tmp}"/chan-flaky-mount.??????) rm -rf -- "$WORK" ;;
    *) echo "flaky-mount: refusing to remove unexpected work dir: $WORK" >&2 ;;
  esac
}
trap cleanup EXIT

# --- helpers ----------------------------------------------------------------

mount_fuse() {
  mkdir -p "$MNT"
  "$RCLONE" mount :memory: "$MNT" --daemon --vfs-cache-mode full >/dev/null 2>&1
  for _ in $(seq 60); do
    mountpoint -q "$MNT" && break
    sleep 0.25
  done
  mountpoint -q "$MNT" || die_env "could not mount the :memory: remote at $MNT"
  RCLONE_PID="$(ps -eo pid,args | grep "[${RCLONE:0:1}]${RCLONE:1} mount :memory: $MNT" \
    | awk '{print $1}' | head -1)"
  [ -n "$RCLONE_PID" ] || die_env "mounted but could not find the daemon pid"
}

root_dev() { python3 -c "import os,sys;print(os.minor(os.stat(sys.argv[1]).st_dev))" "$1"; }

api() {
  curl -sS -m "${2:-20}" -H "Authorization: Bearer $TOKEN" \
    "http://127.0.0.1:$PORT$1" 2>&1
}

# Field of the `notes` row: on | status | error | token | prefix.
row_field() {
  api /api/devserver/workspaces 20 | python3 -c "
import sys, json
try:
    rows = json.load(sys.stdin)
except Exception:
    print('<unparseable>'); raise SystemExit
match = [r for r in rows if r['label'] == 'notes']
print(match[0].get('$1', '') if match else '<absent>')"
}

# Poll until the row's status equals $1, or time out. Echoes the final status.
await_status() {
  local want="$1" deadline=$((SECONDS + POLL_TIMEOUT)) seen=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    seen="$(row_field status)"
    [ "$seen" = "$want" ] && { echo "$seen"; return 0; }
    sleep 1
  done
  echo "$seen"
  return 1
}

start_devserver() {
  mkdir -p "$CHAN_HOME"
  PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
  "$CHAN_BIN" devserver run --bind=127.0.0.1 --port="$PORT" > "$WORK/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 120); do
    [ -f "$CHAN_HOME/devserver/config.json" ] && break
    sleep 0.5
  done
  [ -f "$CHAN_HOME/devserver/config.json" ] || die_env "devserver never wrote its config"
  sleep 2
  TOKEN="$(python3 -c "import json;print(json.load(open('$CHAN_HOME/devserver/config.json'))['devserver_token'])")"
}

turn_on_workspace() {
  curl -sS -m 120 -X POST -H "Authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' -d "{\"path\":\"$WS\"}" \
    "http://127.0.0.1:$PORT/api/devserver/workspaces" >/dev/null 2>&1
  for _ in $(seq 60); do
    [ "$(row_field status)" = "running" ] && break
    sleep 1
  done
  PREFIX="$(row_field prefix)"
  WSTOKEN="$(row_field token)"
}

# --- arm A: idle workspace ---------------------------------------------------

say "arm A: mount, seed, and turn a workspace on"
mount_fuse
DEV_BEFORE="$(root_dev "$MNT")"
mkdir -p "$WS"
printf '# Notes\n\nfirst line\n' > "$WS/note.md"
start_devserver
turn_on_workspace
[ "$(row_field status)" = "running" ] \
  && ok "workspace mounted and running (st_dev 0:$DEV_BEFORE)" \
  || bad "workspace did not reach running: $(row_field status) / $(row_field error)"

say "arm A: kill the FUSE daemon"
kill -9 "$RCLONE_PID"; RCLONE_PID=""; sleep 3
errno="$(python3 -c "
import os, errno
try:
    os.stat('$WS'); print('none')
except OSError as e: print(errno.errorcode.get(e.errno, e.errno))")"
[ "$errno" = "ENOTCONN" ] \
  && ok "root answers ENOTCONN, as a dead FUSE mount must" \
  || bad "expected ENOTCONN from the dead mount, got $errno"

status="$(await_status unavailable)"
[ "$status" = "unavailable" ] \
  && ok "row reports unavailable, not running and not error" \
  || bad "row should be unavailable while the mount is dead, got '$status'"

reason="$(row_field error)"
case "$reason" in
  *"not connected"*|*"unavailable"*|*"Transport"*)
    ok "row carries the transport reason" ;;
  *) bad "row should name the transport failure, got '$reason'" ;;
esac

# The classification that keeps an editor from being told its file was deleted.
read_body="$(curl -sS -m 20 "http://127.0.0.1:$PORT$PREFIX/api/fs?path=note.md&t=$WSTOKEN" 2>&1)"
case "$read_body" in
  *"does not exist"*) bad "unreachable mount reported as a missing root: $read_body" ;;
  *) ok "read fails without claiming the root is gone" ;;
esac

say "arm A: repair the mount with a fresh daemon at the same path"
fusermount -u "$MNT" 2>/dev/null || fusermount3 -u "$MNT" 2>/dev/null || umount -l "$MNT" 2>/dev/null
sleep 1
mount_fuse
DEV_AFTER="$(root_dev "$MNT")"
mkdir -p "$WS"
printf '# Notes\n\nfirst line\n' > "$WS/note.md"
[ "$DEV_BEFORE" != "$DEV_AFTER" ] \
  && ok "remount changed st_dev (0:$DEV_BEFORE -> 0:$DEV_AFTER), so the old handle is dead" \
  || echo "  note: st_dev was reused (0:$DEV_AFTER); the handle test below still holds"

status="$(await_status running)"
[ "$status" = "running" ] \
  && ok "row recovered to running with no restart and no user action" \
  || bad "row did not recover after the remount, got '$status' / $(row_field error)"

WSTOKEN="$(row_field token)"
body="$(curl -sS -m 20 "http://127.0.0.1:$PORT$PREFIX/api/fs?path=note.md&t=$WSTOKEN" 2>&1)"
case "$body" in
  *'"path":"note.md"'*) ok "recovered workspace serves a read through the refreshed handle" ;;
  *) bad "recovered workspace could not serve a read: $body" ;;
esac

# --- arm B: busy workspace (the wedge) ---------------------------------------

say "arm B: restart clean, seed $FILES files, kill the mount mid-index"
kill "$SERVER_PID" 2>/dev/null; sleep 1; kill -9 "$SERVER_PID" 2>/dev/null; SERVER_PID=""
[ -n "$RCLONE_PID" ] && kill -9 "$RCLONE_PID"
fusermount -u "$MNT" 2>/dev/null || fusermount3 -u "$MNT" 2>/dev/null || umount -l "$MNT" 2>/dev/null
sleep 1
rm -rf -- "$CHAN_HOME"
mount_fuse
mkdir -p "$WS"
python3 - "$WS" "$FILES" <<'PY'
import os, sys
ws, n = sys.argv[1], int(sys.argv[2])
for i in range(n):
    d = os.path.join(ws, f"d{i//100:03d}")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, f"n{i:05d}.md"), "w") as f:
        f.write(f"# Note {i}\n\n" + ("lorem ipsum dolor sit amet " * 40) +
                f"\n\nlink to [n{(i+1)%n:05d}](n{(i+1)%n:05d}.md)\n")
PY
start_devserver
turn_on_workspace
kill -9 "$RCLONE_PID"; RCLONE_PID=""; sleep 4

fusermount -u "$MNT" 2>/dev/null || fusermount3 -u "$MNT" 2>/dev/null || umount -l "$MNT" 2>/dev/null
sleep 1
mount_fuse
mkdir -p "$WS/d000"
printf '# Note 0\n\nback\n' > "$WS/d000/n00000.md"

status="$(await_status running)"
if [ "$status" = "running" ]; then
  ok "row recovered on its own after a mount death during an index pass"
else
  # Fall back to the explicit repair the launcher offers, and require that it
  # works: this is precisely where `WorkspaceAlreadyOpen` used to be terminal.
  curl -sS -m 60 -X POST -H "Authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' -d '{"on":false,"force":true}' \
    "http://127.0.0.1:$PORT/api/devserver/workspaces$PREFIX/on" >/dev/null 2>&1
  sleep 2
  on_body="$(curl -sS -m 120 -X POST -H "Authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' -d '{"on":true}' \
    "http://127.0.0.1:$PORT/api/devserver/workspaces$PREFIX/on" 2>&1)"
  case "$on_body" in
    *"already open"*)
      bad "WEDGED: turn-on still refused after the mount was repaired: $on_body" ;;
    *)
      status="$(await_status running)"
      [ "$status" = "running" ] \
        && ok "off->on recovered the row after the mount was repaired" \
        || bad "off->on did not recover the row: '$status' / $(row_field error)" ;;
  esac
fi

# --- verdict -----------------------------------------------------------------

say "verdict"
if [ "$FAILURES" -eq 0 ]; then
  echo "flaky-mount: PASS at $COMMIT"
  exit 0
fi
KEEP_ON_FAIL=1
echo "flaky-mount: FAIL ($FAILURES assertion(s)) at $COMMIT"
exit 1
