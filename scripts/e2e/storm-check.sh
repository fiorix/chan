#!/usr/bin/env bash
# End-to-end rebuild-storm and convergence check.
#
# The default is reduced enough for a CI/manual gate while still overflowing
# the host's real inotify queue. Owner acceptance scales to 180k excluded
# files, four writers, and a ten-minute torrent:
#
#   CHAN_STORM_ACCEPTANCE=1 scripts/e2e/storm-check.sh
#
# Editor session-restart durability adds a re-attach assertion on top of the
# core convergence run. It costs a server restart, so it is opt-in:
#
#   CHAN_STORM_ASSERT_SESSION_RESTART=1 scripts/e2e/storm-check.sh
#
# Env:
#   CHAN_BIN                 chan binary (default target/debug/chan)
#   CHAN_STORM_ACCEPTANCE    1 for 180k / 4 writers / 10 minutes
#   CHAN_STORM_LOSS_EVENTS   override unique events used for loss injection
#   CHAN_STORM_ASSERT_SESSION_RESTART
#                            1 to assert authority after server restart
#   TMPDIR                   use a path outside any accidental parent repo

set -euo pipefail

CHAN_BIN=${CHAN_BIN:-target/debug/chan}
ACCEPTANCE=${CHAN_STORM_ACCEPTANCE:-0}
ASSERT_SESSION_RESTART=${CHAN_STORM_ASSERT_SESSION_RESTART:-0}

case "$ACCEPTANCE:$ASSERT_SESSION_RESTART" in
  0:0 | 0:1 | 1:0 | 1:1) ;;
  *) printf '[storm] FAIL: storm knobs must be 0 or 1\n' >&2; exit 1 ;;
esac

if [ "$ACCEPTANCE" = "1" ]; then
  EXCLUDED_FILES=180000
  TRACKED_FILES=200
  WRITERS=4
  APPENDS_PER_WRITER=0
  STORM_SECONDS=600
  CONVERGE_ATTEMPTS=300
else
  EXCLUDED_FILES=2000
  TRACKED_FILES=50
  WRITERS=3
  APPENDS_PER_WRITER=400
  STORM_SECONDS=0
  CONVERGE_ATTEMPTS=120
fi

if [ -r /proc/sys/fs/inotify/max_queued_events ]; then
  read -r INOTIFY_QUEUE < /proc/sys/fs/inotify/max_queued_events
else
  INOTIFY_QUEUE=16384
fi
DEFAULT_LOSS_EVENTS=$((INOTIFY_QUEUE + 2048))
if [ "$ACCEPTANCE" = "1" ] && [ "$DEFAULT_LOSS_EVENTS" -lt 180000 ]; then
  DEFAULT_LOSS_EVENTS=180000
fi
LOSS_EVENTS=${CHAN_STORM_LOSS_EVENTS:-$DEFAULT_LOSS_EVENTS}

WORK=$(mktemp -d "${TMPDIR:-/tmp}/chan-storm-XXXXXX")
HOME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/chan-storm-home-XXXXXX")
LOG="$WORK/server.log"
PID=""
SESSION_PID=""
SESSION_ERROR=""
BASE=""
TOK=""

MAIN_CONTENT=$(printf '# Authority\nmain-generation-token\n[Main](rename-me.md)')
BRANCH_CONTENT=$(printf '# Authority\nbranch-generation-token\n[Renamed](renamed.md)')
RENAMED_CONTENT=$(printf '# Renamed\nfinal-index-token')
REPORT_CONTENT=$(printf 'fn branch_value() -> &'"'"'static str {\n    "storm-alt"\n}')

say() { printf '[storm] %s\n' "$*" >&2; }
die() { say "FAIL: $*"; exit 1; }

stop_session() {
  if [ -n "$SESSION_PID" ]; then
    kill "$SESSION_PID" 2>/dev/null || true
    wait "$SESSION_PID" 2>/dev/null || true
    SESSION_PID=""
  fi
}

stop_server() {
  if [ -n "$PID" ]; then
    kill -CONT "$PID" 2>/dev/null || true
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
    PID=""
  fi
}

cleanup() {
  stop_session
  stop_server
  CHAN_HOME="$HOME_DIR" "$CHAN_BIN" workspace forget "$WORK/ws" >/dev/null 2>&1 || true
  rm -rf "$WORK" "$HOME_DIR"
}
trap cleanup EXIT

for command in curl find git jq node sort; do
  command -v "$command" >/dev/null || die "missing required command: $command"
done
[ -x "$CHAN_BIN" ] || die "chan binary missing at $CHAN_BIN (build first)"
[ "$LOSS_EVENTS" -gt "$INOTIFY_QUEUE" ] ||
  die "loss injection must exceed the inotify queue ($INOTIFY_QUEUE)"

auth_get() {
  curl -fsS -H "Authorization: Bearer $TOK" "$BASE$1"
}

index_status() {
  auth_get "/api/index/status" 2>/dev/null || true
}

rebuild_warns() {
  grep -c 'requesting rebuild' "$LOG" || true
}

wait_index_idle() {
  local status
  for ((attempt = 1; attempt <= CONVERGE_ATTEMPTS; attempt++)); do
    status=$(index_status)
    if jq -e \
      '.state == "idle" and .readiness.state == "ready"' \
      >/dev/null 2>&1 <<<"$status"; then
      return 0
    fi
    sleep 1
  done
  die "index did not settle: $(index_status)"
}

start_server() {
  local log_start url
  log_start=$(( $(wc -l <"$LOG" 2>/dev/null || printf '0') + 1 ))
  say "starting server (logs: $LOG)"
  CHAN_NO_DEVSERVER_HANDOFF=1 CHAN_HOME="$HOME_DIR" \
    "$CHAN_BIN" serve --port 0 --no-browser "$WORK/ws" >>"$LOG" 2>&1 &
  PID=$!
  url=""
  for ((attempt = 1; attempt <= 60; attempt++)); do
    url=$(sed -n "${log_start},\$p" "$LOG" |
      grep -m1 -o 'http://[^ ]*' || true)
    [ -n "$url" ] && break
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
  done
  [ -n "$url" ] || die "server never printed its URL"
  TOK=${url##*t=}
  BASE=${url%%\?*}
  BASE=${BASE%/}
  say "server up: $BASE"
}

api_file_content() {
  auth_get "/api/fs/$1" | jq -r '.content'
}

start_authority_session() {
  local expected=$1 ready_file error_file ws_url
  stop_session
  ready_file="$WORK/session.ready"
  error_file="$WORK/session.error"
  SESSION_ERROR=$error_file
  rm -f "$ready_file" "$error_file"
  ws_url="${BASE/http:/ws:}/api/doc/ws?path=src%2Fauthority.md&w=storm&t=$TOK"
  NODE_NO_WARNINGS=1 node --experimental-websocket -e '
    const fs = require("node:fs");
    const [url, ready, error, expected] = process.argv.slice(1);
    const socket = new WebSocket(url);
    let failed = false;
    let initialSnapshot = false;
    const fail = (message) => {
      if (failed) return;
      failed = true;
      fs.writeFileSync(error, String(message));
      try { socket.close(); } catch {}
      process.exit(1);
    };
    socket.addEventListener("message", (event) => {
      let frame;
      try { frame = JSON.parse(String(event.data)); }
      catch (cause) { fail(cause); return; }
      if (frame.type === "error") {
        fail(frame.message || frame.reason || "session error");
      } else if (frame.type === "snapshot" && !initialSnapshot) {
        if (frame.doc !== `${expected}\n`) {
          fail(`snapshot mismatch: ${JSON.stringify(frame.doc)}`);
        } else {
          fs.writeFileSync(ready, JSON.stringify(frame));
          initialSnapshot = true;
        }
      }
    });
    socket.addEventListener("error", () => fail("websocket error"));
    socket.addEventListener("close", () => fail("websocket closed"));
    setInterval(() => {}, 1000);
  ' "$ws_url" "$ready_file" "$error_file" "$expected" &
  SESSION_PID=$!

  for ((attempt = 1; attempt <= 30; attempt++)); do
    if [ -s "$error_file" ]; then
      die "document authority attach failed: $(<"$error_file")"
    fi
    [ -s "$ready_file" ] && return 0
    kill -0 "$SESSION_PID" 2>/dev/null ||
      die "document authority probe exited before its snapshot"
    sleep 1
  done
  die "document authority did not return a snapshot"
}

wait_authority_content() {
  local expected=$1 response
  for ((attempt = 1; attempt <= CONVERGE_ATTEMPTS; attempt++)); do
    if [ -s "$SESSION_ERROR" ]; then
      die "held document authority session failed: $(<"$SESSION_ERROR")"
    fi
    kill -0 "$SESSION_PID" 2>/dev/null ||
      die "held document authority session exited"
    response=$(auth_get "/api/fs/src/authority.md" 2>/dev/null || true)
    if jq -e --arg expected "$expected" '
      .content == ($expected + "\n")
      and .authority_version != null
      and .disk_conflicted == false
    ' >/dev/null 2>&1 <<<"$response"; then
      return 0
    fi
    sleep 1
  done
  die "live document authority did not converge: $response"
}

capture_expected_tree() {
  (
    cd "$WORK/ws"
    find . \
      -path './.git' -prune -o \
      -path './.chan' -prune -o \
      -path './buck-out' -prune -o \
      -type f -print |
      sed 's#^\./##' |
      LC_ALL=C sort
  ) >"$WORK/expected-tree"
}

core_converged() {
  local report_bytes expected_report_files
  capture_expected_tree
  auth_get "/api/fs" >"$WORK/tree.json" 2>/dev/null || return 1
  jq -r '.[] | select(.is_dir == false) | .path' "$WORK/tree.json" |
    LC_ALL=C sort >"$WORK/actual-tree" || return 1
  cmp -s "$WORK/expected-tree" "$WORK/actual-tree" || return 1

  [ "$(api_file_content src/authority.md 2>/dev/null)" = "$BRANCH_CONTENT" ] ||
    return 1
  [ "$(api_file_content src/renamed.md 2>/dev/null)" = "$RENAMED_CONTENT" ] ||
    return 1

  auth_get "/api/graph" >"$WORK/graph.json" 2>/dev/null || return 1
  jq -e '
    any(.nodes[]; .kind == "file" and .path == "src/authority.md")
    and any(.nodes[]; .kind == "file" and .path == "src/renamed.md")
    and (any(.nodes[]; .kind == "file" and .path == "src/rename-me.md") | not)
    and any(.edges[];
      .kind == "link"
      and .source == "src/authority.md"
      and .target == "src/renamed.md")
  ' "$WORK/graph.json" >/dev/null || return 1

  auth_get "/api/search/content?q=final-index-token&limit=20" \
    >"$WORK/search-new.json" 2>/dev/null || return 1
  jq -e '
    .ready == true
    and .readiness.state == "ready"
    and ([.hits[].path] | unique) == ["src/renamed.md"]
  ' "$WORK/search-new.json" >/dev/null || return 1
  auth_get "/api/search/content?q=retired-index-token&limit=20" \
    >"$WORK/search-old.json" 2>/dev/null || return 1
  jq -e '.ready == true and .hits == []' \
    "$WORK/search-old.json" >/dev/null || return 1

  report_bytes=$(wc -c <"$WORK/ws/src/report.rs")
  auth_get "/api/report/file?path=src/report.rs" \
    >"$WORK/report-file.json" 2>/dev/null || return 1
  jq -e --argjson bytes "$report_bytes" '
    .path == "src/report.rs"
    and .language == "Rust"
    and .bytes == $bytes
    and .code == 3
    and .comments == 0
    and .blanks == 0
  ' "$WORK/report-file.json" >/dev/null || return 1

  expected_report_files=$((TRACKED_FILES + 3))
  auth_get "/api/report/prefix?path=" \
    >"$WORK/report-root.json" 2>/dev/null || return 1
  jq -e --argjson files "$expected_report_files" \
    '.totals.files == $files' "$WORK/report-root.json" >/dev/null || return 1
}

wait_core_convergence() {
  for ((attempt = 1; attempt <= CONVERGE_ATTEMPTS; attempt++)); do
    if core_converged; then
      say "tree, graph, index, and report match the final branch"
      return 0
    fi
    sleep 1
  done
  diff -u "$WORK/expected-tree" "$WORK/actual-tree" >&2 || true
  say "last index status: $(index_status)"
  die "tree/graph/index/report did not converge"
}

storm_writer() {
  local worker=$1 i=0 file_index name deadline
  if [ "$STORM_SECONDS" -gt 0 ]; then
    deadline=$((SECONDS + STORM_SECONDS))
    while [ "$SECONDS" -lt "$deadline" ]; do
      i=$((i + 1))
      file_index=$(( (i * worker) % EXCLUDED_FILES + 1 ))
      printf -v name 'a%06d.txt' "$file_index"
      printf 'storm %d\n' "$i" >>"$WORK/ws/buck-out/gen/$name"
    done
  else
    for ((i = 1; i <= APPENDS_PER_WRITER; i++)); do
      file_index=$(( (i * worker) % EXCLUDED_FILES + 1 ))
      printf -v name 'a%06d.txt' "$file_index"
      printf 'storm %d\n' "$i" >>"$WORK/ws/buck-out/gen/$name"
    done
  fi
}

# ---- seed two real Git generations ------------------------------------
say "seeding $EXCLUDED_FILES excluded and $TRACKED_FILES tracked files"
mkdir -p "$WORK/ws/buck-out/gen" "$WORK/ws/src"
for ((i = 1; i <= EXCLUDED_FILES; i++)); do
  printf -v name 'a%06d.txt' "$i"
  printf 'artifact %d\n' "$i" >"$WORK/ws/buck-out/gen/$name"
done
for ((i = 1; i <= TRACKED_FILES; i++)); do
  printf -v name 'n%04d.md' "$i"
  printf '# note %d\n' "$i" >"$WORK/ws/src/$name"
done
printf 'buck-out/\n' >"$WORK/ws/.gitignore"
printf '%s\n' "$MAIN_CONTENT" >"$WORK/ws/src/authority.md"
printf '# Rename me\nretired-index-token\n' >"$WORK/ws/src/rename-me.md"
printf 'fn branch_value() -> &'"'"'static str {\n    "main"\n}\n' \
  >"$WORK/ws/src/report.rs"

git -C "$WORK/ws" init -q
git -C "$WORK/ws" checkout -q -b main
git -C "$WORK/ws" config user.name "chan storm"
git -C "$WORK/ws" config user.email "storm@chan.invalid"
git -C "$WORK/ws" add .
git -C "$WORK/ws" commit -qm "main fixture"
git -C "$WORK/ws" checkout -q -b storm-alt
printf '%s\n' "$BRANCH_CONTENT" >"$WORK/ws/src/authority.md"
git -C "$WORK/ws" mv src/rename-me.md src/renamed.md
printf '%s\n' "$RENAMED_CONTENT" >"$WORK/ws/src/renamed.md"
printf '%s\n' "$REPORT_CONTENT" >"$WORK/ws/src/report.rs"
git -C "$WORK/ws" add .
git -C "$WORK/ws" commit -qm "alternate fixture"
git -C "$WORK/ws" checkout -q main

# ---- boot + ordinary storms -------------------------------------------
: >"$LOG"
start_server
wait_index_idle
say "boot settled: $(index_status)"
start_authority_session "$MAIN_CONTENT"
wait_authority_content "$MAIN_CONTENT"

say "torrent into excluded buck-out/ ($WRITERS writers)"
writer_pids=()
for ((worker = 1; worker <= WRITERS; worker++)); do
  storm_writer "$worker" &
  writer_pids+=("$!")
done
wait "${writer_pids[@]}"
sleep 3
WARNS=$(rebuild_warns)
[ "$WARNS" = "0" ] || die "excluded torrent triggered full rebuilds: $WARNS"
wait_index_idle
say "PASS: excluded torrent produced zero rebuilds"

say "append to tracked src/ notes"
for ((i = 1; i <= TRACKED_FILES; i++)); do
  printf -v name 'n%04d.md' "$i"
  printf 'tracked-update %d\n' "$i" >>"$WORK/ws/src/$name"
done
wait_index_idle
WARNS=$(rebuild_warns)
[ "$WARNS" = "0" ] ||
  die "routine per-file indexing escalated to full rebuilds: $WARNS"
say "PASS: tracked torrent stayed on the per-file path"

# ---- real Git operations + loss while the process is stopped ----------
say "dirty edit, reset, rename, and branch flips"
printf 'dirty-transient-token\n' >>"$WORK/ws/src/authority.md"
git -C "$WORK/ws" reset --hard -q HEAD
git -C "$WORK/ws" mv src/rename-me.md src/transient.md
git -C "$WORK/ws" reset --hard -q HEAD
git -C "$WORK/ws" checkout -q storm-alt
git -C "$WORK/ws" checkout -q main

say "injecting watcher loss with $LOSS_EVENTS unique events"
kill -STOP "$PID"
git -C "$WORK/ws" checkout -q storm-alt
for ((i = 1; i <= LOSS_EVENTS; i++)); do
  printf -v name 'storm-loss-%06d.md' "$i"
  printf '# transient %d\n' "$i" >"$WORK/ws/src/$name"
done
find "$WORK/ws/src" -maxdepth 1 -type f -name 'storm-loss-*.md' -delete
kill -CONT "$PID"

for ((attempt = 1; attempt <= CONVERGE_ATTEMPTS; attempt++)); do
  grep -q 'provider-error\|watch error:.*overflow' "$LOG" && break
  sleep 1
done
grep -q 'provider-error\|watch error:.*overflow' "$LOG" ||
  die "event torrent did not surface watcher loss"
wait_core_convergence
wait_authority_content "$BRANCH_CONTENT"
say "PASS: checkout plus watcher loss converged disk and live authority"

# ---- restart ----------------------------------------------------------
say "restarting server over the converged workspace"
stop_session
stop_server
start_server
if [ "$ASSERT_SESSION_RESTART" = "1" ]; then
  start_authority_session "$BRANCH_CONTENT"
fi
wait_core_convergence
if [ "$ASSERT_SESSION_RESTART" = "1" ]; then
  wait_authority_content "$BRANCH_CONTENT"
  say "PASS: session authority converged after restart"
else
  say "session-restart assertion skipped (set CHAN_STORM_ASSERT_SESSION_RESTART=1)"
fi

say "ALL GREEN"
