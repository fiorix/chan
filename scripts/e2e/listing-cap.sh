#!/usr/bin/env bash
# A workspace over the index's listing cap, end to end against a devserver.
#
# The index's listing cap (LIST_TREE_LIMIT, 500,000) counts the files the
# index reads, not every entry in the tree, and a listing over it is a
# failure the window can live with. Two arms, each a fresh workspace
# generated here, a fresh CHAN_HOME and a fresh `chan devserver run`:
#
#   large: about 520,000 entries the index never reads (JSON and PNG files
#          under 260 evidence directories) beside 300 Markdown notes. The
#          index reaches idle with the workspace ready, preflight reads
#          ready and unlocked with no error, and a content search finds a
#          note by a word only it holds.
#   over:  501,000 Markdown notes, more indexable files than the cap. The
#          index status reads error and names the excluded directories
#          setting; preflight reads a failed index step and stays unlocked;
#          the workspace reads ready, not recovering; for two minutes no
#          rebuild runs again (no status sample reads building or
#          recovering); and a note created through the files API, as the
#          editor saves one, is found by a search while the status keeps
#          its error.
#
# What it cannot see: the window itself. The cover, the chip, a terminal
# and an editor are the page's; preflight's `locked` is the one signal the
# cover keys on, and the index status is what the chip shows.
#
# What each arm catches: `large`, a rebuild whose cap counts entries the
# index never reads (the status reads error, preflight locks); `over`, a
# failed index that locks preflight, a listing error that does not name its
# fix, a pass requeued on a cooldown (a building or recovering sample in
# the watch), and an error a later apply clears. The `large` arm fails at
# once on an error status rather than waiting out the timeout.
#
# Run it only inside a container (an sdme guest): it starts a devserver,
# and each arm writes about half a million files (roughly 2 GiB on a
# filesystem with 4 KiB blocks). Each arm's tree is removed once the arm
# ends, passed or failed, so no more than one is on disk; its logs and
# readings stay in the work dir. Needs curl and python3.
#
# Env:
#   CHAN_BIN                       chan binary (default target/debug/chan)
#   LISTING_CAP_ARMS               "large over" (default), or one of them
#   LISTING_CAP_TIMEOUT            seconds each wait may take (default 1200)
#   LISTING_CAP_RERUN_SECONDS      the rerun watch (default 120)
#   TMPDIR                         where the work dir goes (default /var/tmp)
#
# Exit 0 every check held, 1 a check failed, 2 the environment cannot run
# the suite. A failed run keeps its work dir (logs, readings, CHAN_HOME and
# no tree); its CHAN_HOME holds the devserver's bearer token, so delete it
# once the failure is read.
set -uo pipefail

ARMS="${LISTING_CAP_ARMS:-large over}"
TIMEOUT="${LISTING_CAP_TIMEOUT:-1200}"
RERUN_SECONDS="${LISTING_CAP_RERUN_SECONDS:-120}"
FAILURES=0

die_env() {
  echo "listing-cap: SKIP (environment): $*" >&2
  exit 2
}
say() { printf '\n== %s ==\n' "$*"; }
ok() { printf '  PASS %s\n' "$*"; }
bad() {
  printf '  FAIL %s\n' "$*"
  FAILURES=$((FAILURES + 1))
}

# --- environment ------------------------------------------------------------

command -v curl >/dev/null 2>&1 || die_env "curl is required"
command -v python3 >/dev/null 2>&1 || die_env "python3 is required"
if ! command -v systemd-detect-virt >/dev/null 2>&1 ||
  ! systemd-detect-virt --container >/dev/null 2>&1; then
  die_env "not inside a container; run this in an sdme guest, never beside a live devserver"
fi
for arm in $ARMS; do
  case "$arm" in
    large | over) ;;
    *) die_env "unknown arm '$arm' (expected large, over)" ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHAN_BIN="${CHAN_BIN:-${CARGO_TARGET_DIR:-$REPO/target}/debug/chan}"
[ -x "$CHAN_BIN" ] || die_env "no chan binary at $CHAN_BIN (set CHAN_BIN)"
if ! VERSION="$("$CHAN_BIN" --version 2>&1)"; then
  die_env "chan --version failed: $VERSION"
fi
COMMIT="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
echo "listing-cap: $VERSION, checkout $COMMIT, binary $CHAN_BIN"

BASE="${TMPDIR:-/var/tmp}"
WORK="$(mktemp -d "$BASE/chan-listing-cap.XXXXXX")" || die_env "mktemp failed"
# The devserver's discovery socket goes in XDG_RUNTIME_DIR, whose path must
# stay short enough for a Unix socket address.
RUNTIME="$(mktemp -d /tmp/lcap.XXXXXX)" || die_env "mktemp failed"
chmod 700 "$RUNTIME"
SERVER_PID=""
KEEP=""

stop_server() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null
    for _ in $(seq 20); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
    SERVER_PID=""
  fi
}

# ShellCheck does not trace cleanup through `trap cleanup EXIT`.
# shellcheck disable=SC2329
cleanup() {
  stop_server
  case "$RUNTIME" in
    /tmp/lcap.??????) rm -rf -- "$RUNTIME" ;;
  esac
  if [ -n "$KEEP" ]; then
    echo "listing-cap: work dir kept for inspection: $WORK" >&2
    return
  fi
  # Only ever the path this script created with mktemp -d, matched literally.
  case "$WORK" in
    "$BASE"/chan-listing-cap.??????) rm -rf -- "$WORK" ;;
    *) echo "listing-cap: refusing to remove unexpected work dir: $WORK" >&2 ;;
  esac
}
trap cleanup EXIT

# --- helpers ----------------------------------------------------------------

# Write an arm's tree under $1. Prints the note paths a search must find.
generate() {
  python3 - "$1" "$2" <<'PY'
import os
import sys

root, arm = sys.argv[1], sys.argv[2]

def word(n):
    # A search word only note n holds: letters, so no tokenizer splits it.
    letters = ""
    for _ in range(4):
        letters = chr(ord("a") + n % 26) + letters
        n //= 26
    return "capnote" + letters

def put(rel, body):
    path = os.path.join(root, rel)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        os.write(fd, body)
    finally:
        os.close(fd)

if arm == "large":
    for d in range(260):
        rel = f"evidence/run{d:03d}"
        os.makedirs(os.path.join(root, rel))
        for f in range(1000):
            put(f"{rel}/trace{f:04d}.json", b"{}\n")
            put(f"{rel}/shot{f:04d}.png", b"png\n")
    for n in range(300):
        rel = f"notes/topic{n // 10:02d}"
        os.makedirs(os.path.join(root, rel), exist_ok=True)
        put(f"{rel}/note{n:03d}.md", f"# Note {n}\n\n{word(n)} shared\n".encode())
    print(f"notes/topic15/note150.md {word(150)}")
else:
    for d in range(501):
        rel = f"over/d{d:03d}"
        os.makedirs(os.path.join(root, rel))
        for f in range(1000):
            put(f"{rel}/n{f:04d}.md", b"# n\n")
PY
}

api() {
  curl -sS -m 30 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT$1" 2>&1
}

# A field of the workspace's devserver row.
row_field() {
  api /api/devserver/workspaces | python3 -c "
import json, sys
try:
    rows = json.load(sys.stdin)
except Exception:
    print('<unparseable>'); raise SystemExit
match = [r for r in rows if r.get('label') == sys.argv[1]]
print(match[0].get(sys.argv[2], '') if match else '<absent>')" "$LABEL" "$1"
}

# GET a workspace route as the window does, through the row's prefix.
ws_get() {
  local sep="?"
  case "$1" in *\?*) sep="&" ;; esac
  curl -sS -m 30 "http://127.0.0.1:$PORT$PREFIX$1${sep}t=$WSTOKEN" 2>&1
}

# Read a JSON document from stdin and print the value of a Python expression
# over it, named `j`: `<unparseable>` when stdin is not JSON, and the error
# when the expression fails on it (a field the document lacks).
jq_py() {
  python3 -c "
import json, sys
try:
    j = json.load(sys.stdin)
except Exception:
    print('<unparseable>'); raise SystemExit
try:
    print($1)
except Exception as error:
    print(f'<{error!r}>')"
}

start_devserver() {
  # One devserver at a time: an arm that returned early left its own.
  stop_server
  export CHAN_HOME="$WORK/$1/chanhome"
  mkdir -p "$CHAN_HOME"
  PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
  CHAN_NO_DEVSERVER_HANDOFF=1 XDG_RUNTIME_DIR="$RUNTIME" \
    "$CHAN_BIN" devserver run --bind=127.0.0.1 --port="$PORT" >"$WORK/$1/server.log" 2>&1 &
  SERVER_PID=$!
  local config="$CHAN_HOME/devserver/config.json"
  for _ in $(seq 120); do
    [ -f "$config" ] && break
    kill -0 "$SERVER_PID" 2>/dev/null || die_env "devserver exited: $(tail -5 "$WORK/$1/server.log")"
    sleep 0.5
  done
  [ -f "$config" ] || die_env "devserver never wrote its config"
  TOKEN="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['devserver_token'])" "$config")"
  for _ in $(seq 60); do
    curl -fsS -m 5 -o /dev/null -H "Authorization: Bearer $TOKEN" \
      "http://127.0.0.1:$PORT/api/devserver/workspaces" 2>/dev/null && return 0
    sleep 0.5
  done
  die_env "devserver never answered on port $PORT"
}

turn_on() {
  local body
  body="$(python3 -c "import json,sys;print(json.dumps({'path': sys.argv[1]}))" "$WS")"
  curl -sS -m "$TIMEOUT" -X POST -H "Authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' -d "$body" \
    "http://127.0.0.1:$PORT/api/devserver/workspaces" >"$WORK/$ARM/turn-on.json" 2>&1
  local deadline=$((SECONDS + TIMEOUT)) status=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    status="$(row_field status)"
    [ "$status" = "running" ] && break
    sleep 1
  done
  [ "$status" = "running" ] || return 1
  PREFIX="$(row_field prefix)"
  WSTOKEN="$(row_field token)"
}

# Poll the index status until the Python predicate $1 over it (named `j`)
# holds. Leaves the last status in $STATUS; fails after the timeout, or at
# once when the predicate $2, if given, holds instead.
await_index() {
  local deadline=$((SECONDS + TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    STATUS="$(ws_get /api/index/status)"
    [ "$(jq_py "bool($1)" <<<"$STATUS")" = "True" ] && return 0
    if [ -n "${2:-}" ] && [ "$(jq_py "bool($2)" <<<"$STATUS")" = "True" ]; then
      return 1
    fi
    sleep 1
  done
  return 1
}

# --- arms -------------------------------------------------------------------

arm_large() {
  say "large: 520,000 entries the index never reads beside 300 notes"
  WS="$WORK/large/ws"
  mkdir -p "$WS"
  local found expect_path expect_word
  found="$(generate "$WS" large)" || die_env "could not generate the workspace"
  read -r expect_path expect_word <<<"$found"
  echo "  generated $(find "$WS" -mindepth 1 | wc -l) entries"
  start_devserver large
  turn_on || {
    bad "the workspace never reached running: $(row_field status) / $(row_field error)"
    return
  }

  if await_index 'j.get("state") == "idle" and j.get("readiness", {}).get("state") == "ready"' \
    'j.get("state") == "error"'; then
    ok "the index reaches idle and the workspace ready"
  else
    bad "the index did not reach idle: $STATUS"
  fi
  local docs
  docs="$(jq_py 'j.get("indexed_docs", 0)' <<<"$STATUS")"
  if [ "${docs:-0}" -ge 300 ] 2>/dev/null; then
    ok "the index holds the notes ($docs documents)"
  else
    bad "the index holds $docs documents, fewer than the 300 notes"
  fi

  local preflight
  preflight="$(ws_get /api/preflight)"
  echo "$preflight" >"$WORK/large/preflight.json"
  if [ "$(jq_py 'j["phase"] == "ready" and j["locked"] is False and not j.get("error")' <<<"$preflight")" = "True" ]; then
    ok "preflight reads ready and unlocked with no error"
  else
    bad "preflight is not ready and unlocked: $preflight"
  fi

  local search
  search="$(ws_get "/api/search/content?q=$expect_word")"
  echo "$search" >"$WORK/large/search.json"
  if [ "$(jq_py "[h['path'] for h in j.get('hits', [])] == ['$expect_path']" <<<"$search")" = "True" ]; then
    ok "a search for $expect_word finds $expect_path alone"
  else
    bad "a search for $expect_word did not find $expect_path alone: $search"
  fi
  stop_server
}

arm_over() {
  say "over: 501,000 notes, more indexable files than the cap"
  WS="$WORK/over/ws"
  mkdir -p "$WS"
  generate "$WS" over >/dev/null || die_env "could not generate the workspace"
  echo "  generated $(find "$WS" -mindepth 1 | wc -l) entries"
  start_devserver over
  turn_on || {
    bad "the workspace never reached running: $(row_field status) / $(row_field error)"
    return
  }

  if await_index 'j.get("state") == "error"'; then
    ok "the index status reads error"
  else
    bad "the index status never read error: $STATUS"
  fi
  local message
  message="$(jq_py 'j.get("message", "")' <<<"$STATUS")"
  case "$message" in
    *"Excluded directories"*) ok "the error names its fix: $message" ;;
    *) bad "the error does not name the excluded directories setting: $message" ;;
  esac

  local preflight
  preflight="$(ws_get /api/preflight)"
  echo "$preflight" >"$WORK/over/preflight.json"
  if [ "$(jq_py '[s["state"] for s in j["steps"] if s["id"] == "index"] == ["failed"] and j["locked"] is False and j.get("error", {}).get("step") == "index"' <<<"$preflight")" = "True" ]; then
    ok "preflight reports the failed index step and stays unlocked"
  else
    bad "preflight does not report an unlocked failed index step: $preflight"
  fi
  if [ "$(jq_py 'j.get("readiness", {}).get("state")' <<<"$STATUS")" = "ready" ]; then
    ok "the workspace reads ready, not recovering"
  else
    bad "the workspace is still recovering: $STATUS"
  fi

  # Every rebuild sets the status to building first, and a requeued pass
  # keeps the workspace recovering, so a sample at twice a second sees a
  # rerun of the half-million-file walk.
  local samples="$WORK/over/rerun-watch.jsonl" deadline=$((SECONDS + RERUN_SECONDS))
  : >"$samples"
  while [ "$SECONDS" -lt "$deadline" ]; do
    ws_get /api/index/status >>"$samples"
    echo >>"$samples"
    sleep 0.5
  done
  local reruns
  reruns="$(python3 -c "
import json, sys
seen = bad = 0
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    seen += 1
    try:
        j = json.loads(line)
    except Exception:
        bad += 1
        continue
    if j.get('state') != 'error' or j.get('readiness', {}).get('state') != 'ready':
        bad += 1
print(f'{seen} {bad}')" "$samples")"
  local seen=${reruns% *} off=${reruns#* }
  if [ "$seen" -ge $((RERUN_SECONDS)) ] && [ "$off" = "0" ]; then
    ok "no rebuild ran again in ${RERUN_SECONDS}s ($seen samples, every one error and ready)"
  else
    bad "the failed index did not stay put: $off of $seen samples read another state ($samples)"
  fi

  # An editor save of a new note: the watcher applies it, a search finds it,
  # and the status keeps the error the failed pass left.
  local body word=capnoteedit
  body="$(python3 -c "import json;print(json.dumps({'path': 'edited.md', 'is_dir': False, 'content': '# Edited\n\ncapnoteedit\n'}))")"
  curl -sS -m 30 -X POST -H 'content-type: application/json' -d "$body" \
    "http://127.0.0.1:$PORT$PREFIX/api/fs?t=$WSTOKEN" >"$WORK/over/create.json" 2>&1
  local found="" search="" deadline2=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline2" ]; do
    search="$(ws_get "/api/search/content?q=$word")"
    if [ "$(jq_py "[h['path'] for h in j.get('hits', [])] == ['edited.md']" <<<"$search")" = "True" ]; then
      found=1
      break
    fi
    sleep 0.5
  done
  if [ -n "$found" ]; then
    ok "a note saved beside the failed index is searchable"
  else
    bad "a search never found the saved note: $search"
  fi
  local after="" changed=""
  for _ in $(seq 20); do
    after="$(ws_get /api/index/status)"
    [ "$(jq_py 'j.get("state")' <<<"$after")" = "error" ] || {
      changed=1
      break
    }
    sleep 0.5
  done
  if [ -z "$changed" ] && [ "$(jq_py 'j.get("message", "")' <<<"$after")" = "$message" ]; then
    ok "the status keeps its error after the save"
  else
    bad "the save changed the status: $after"
  fi
  stop_server
}

for ARM in $ARMS; do
  LABEL=ws
  mkdir -p "$WORK/$ARM"
  failures_before=$FAILURES
  case "$ARM" in
    large) arm_large ;;
    over) arm_over ;;
  esac
  stop_server
  [ "$FAILURES" -gt "$failures_before" ] && KEEP=1
  # The tree goes whatever the verdict; the readings and logs stay.
  case "$WORK/$ARM/ws" in
    "$WORK"/large/ws | "$WORK"/over/ws) rm -rf -- "$WORK/$ARM/ws" ;;
  esac
done

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "listing-cap: ALL GREEN ($ARMS) at $COMMIT"
  exit 0
fi
echo "listing-cap: $FAILURES FAILURE(S) at $COMMIT"
exit 1
