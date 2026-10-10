#!/usr/bin/env bash
# Terminal replay across devserver restarts, against a REAL `systemctl --user`
# unit.
#
# Two terminals in their own windows, one focused and one not, each running
# `tail -f` on a file the run appends to, so what the terminal was sent is
# known byte for byte (the PTY runs with -opost -echo, so the file IS the
# output). The run writes output, restarts the devserver with each shape in
# CHAN_REPLAY_E2E_RESTARTS (default "cli crash": `chan devserver restart`,
# then a kill -9 crash restart) while a writer appends across the restart
# window, writes more output, and after each restart asserts, per terminal:
#   1. a client that stayed attached (terminal-replay-client.mjs --mode keep,
#      redialing from its byte cursor across the restart) holds exactly the
#      file, byte for byte, and printed nothing of its own. These are verdicts
#      on the server's attach contract. A graceful restart sends
#      closed{parked}, retaining the PTY for the next process to adopt under
#      the same id; the keep client redials silently from its cursor. It also
#      redials on closed{shutdown} from a drain, recording the actual reason;
#   2. a fresh attach (since=0, no generation, --mode fresh) reports the
#      session's seq as the file's length, replays the file's tail, accounts
#      for every byte it does not replay in missed_bytes, and reports none
#      missed. A fresh attach is what a window the SPA reloads after a
#      restart makes for a terminal it has no cached snapshot for, and the
#      SPA prints "terminal replay missed N bytes" for a nonzero count.
# Terminal A writes less than the 128 KiB replay tail the restart manifest
# carries and terminal B more, while both stay inside the 2 MiB live ring.
#
# Every assertion runs; the run fails at the end if any did, and keeps its
# work dir. The unit handling is devserver-fdstore.sh's: the fixed user unit
# chan-devserver.service is snapshotted and restored on exit, an ACTIVE unit
# is refused unless CHAN_FDSTORE_E2E_ALLOW_TAKEOVER=1, and the suite refuses
# to run outside a container, because restarting that unit ends every PTY it
# carries. Throwaway CHAN_HOME and port. `chan devserver restart` prints the
# devserver token on stdout, and a restart that fails prints the unit's
# journal, which holds it, on stderr; the script masks both, so a run's log
# never carries a token.
#
# Status cases run separately from the continuous writer: an at-rest report,
# a report paused across adoption, crash invalidation, and a parked survey.
# CHAN_REPLAY_E2E_CASES selects cases (default: all); CHAN_REPLAY_E2E_EVIDENCE
# names a new directory in which to retain their logs and observations.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UNIT_NAME="chan-devserver.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/$UNIT_NAME"
DROPIN_DIR="$UNIT_FILE.d"
RESTARTS="${CHAN_REPLAY_E2E_RESTARTS:-cli crash}"
CASES="${CHAN_REPLAY_E2E_CASES:-replay status-rest status-partial status-crash status-owned}"
EVIDENCE="${CHAN_REPLAY_E2E_EVIDENCE:-}"

log() { printf 'devserver-terminal-replay: %s\n' "$*" >&2; }
fail() {
    log "FAIL: $*"
    log "work dir kept at $WORK"
    exit 1
}

for kind in $RESTARTS; do
    case "$kind" in
        cli|crash) ;;
        *) log "REFUSE: unknown restart shape '$kind' (want cli or crash)"; exit 1 ;;
    esac
done
for name in $CASES; do
    case "$name" in
        replay|status-rest|status-partial|status-crash|status-owned) ;;
        *) log "REFUSE: unknown case '$name'"; exit 1 ;;
    esac
done
[ -n "$CASES" ] || { log 'REFUSE: no cases selected'; exit 1; }

command -v systemctl >/dev/null || { log "SKIP: no systemctl"; exit 2; }
command -v systemd-detect-virt >/dev/null \
    || { log "REFUSE: systemd-detect-virt is required to prove container isolation"; exit 1; }
systemd-detect-virt --container >/dev/null 2>&1 \
    || { log "REFUSE: this destructive fixed-unit suite must run inside a container"; exit 1; }
systemctl --user show-environment >/dev/null 2>&1 \
    || { log "SKIP: no systemd user session"; exit 2; }
command -v python3 >/dev/null || { log "SKIP: python3 required"; exit 2; }
command -v node >/dev/null || { log "SKIP: node required"; exit 2; }
command -v curl >/dev/null || { log "SKIP: curl required"; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/chan-replay-e2e.XXXXXX")"
export CHAN_HOME="$WORK/home"
mkdir -p "$CHAN_HOME"
OUT="$WORK/out"
mkdir -p "$OUT"
if [ -n "$EVIDENCE" ]; then
    mkdir "$EVIDENCE"
fi
PORT=$((18950 + RANDOM % 250))
BASE="http://127.0.0.1:$PORT"
SHA="$(git -C "$REPO" rev-parse HEAD)"
log "commit under test: $SHA"
log "work dir: $WORK  port: $PORT  restarts: $RESTARTS"

# ---- snapshot the pre-existing unit state; refuse unprovable restores ----
SNAP="$WORK/unit-snapshot"
mkdir -p "$SNAP"
HAD_UNIT=0 HAD_DROPIN=0 WAS_ENABLED=0 WAS_ACTIVE=0
if [ -e "$UNIT_FILE" ]; then
    HAD_UNIT=1
    cp -a "$UNIT_FILE" "$SNAP/unit"
fi
if [ -e "$DROPIN_DIR" ]; then
    HAD_DROPIN=1
    cp -a "$DROPIN_DIR" "$SNAP/dropins"
fi
if systemctl --user is-enabled --quiet "$UNIT_NAME" 2>/dev/null; then
    WAS_ENABLED=1
fi
if systemctl --user is-active --quiet "$UNIT_NAME" 2>/dev/null; then
    WAS_ACTIVE=1
fi
if [ "$HAD_UNIT" = 1 ] && [ ! -r "$SNAP/unit" ]; then
    log "REFUSE: cannot snapshot $UNIT_FILE; restoration would be unprovable"
    rm -rf "$WORK"
    exit 1
fi
if [ "$WAS_ACTIVE" = 1 ] && [ "${CHAN_FDSTORE_E2E_ALLOW_TAKEOVER:-0}" != 1 ]; then
    log "REFUSE: $UNIT_NAME is ACTIVE; stopping it kills its live terminals."
    log "Re-run with CHAN_FDSTORE_E2E_ALLOW_TAKEOVER=1 to take the unit over."
    rm -rf "$WORK"
    exit 1
fi

CLIENT_PID=""
WRITER_PID=""
SURVEY_PID=""
restore_unit_state() {
    set +e
    for pid in $CLIENT_PID $WRITER_PID $SURVEY_PID; do
        kill "$pid" >/dev/null 2>&1
    done
    systemctl --user stop "$UNIT_NAME" >/dev/null 2>&1
    systemctl --user disable "$UNIT_NAME" >/dev/null 2>&1
    rm -f "$UNIT_FILE"
    rm -rf "$DROPIN_DIR"
    if [ "$HAD_UNIT" = 1 ]; then
        cp -a "$SNAP/unit" "$UNIT_FILE"
    fi
    if [ "$HAD_DROPIN" = 1 ]; then
        cp -a "$SNAP/dropins" "$DROPIN_DIR"
    fi
    systemctl --user daemon-reload >/dev/null 2>&1
    if [ "$WAS_ENABLED" = 1 ]; then
        systemctl --user enable "$UNIT_NAME" >/dev/null 2>&1
    fi
    if [ "$WAS_ACTIVE" = 1 ]; then
        systemctl --user restart "$UNIT_NAME" >/dev/null 2>&1
    fi
    # The run's own shells, identified by the work dir they tail.
    pkill -f "tail -c \\+1 -f $WORK/" >/dev/null 2>&1
    set -e
}
CLEANUP_RAN=0
on_exit() {
    [ "$CLEANUP_RAN" = 1 ] && return
    CLEANUP_RAN=1
    restore_unit_state
    if [ -n "$EVIDENCE" ]; then
        cp -a "$OUT/." "$EVIDENCE/"
    fi
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---- helpers ----
FAILURES=0
check_fail() {
    FAILURES=$((FAILURES + 1))
    log "CHECK FAILED: $*"
}

wait_until() { # seconds description cmd...
    local deadline=$(( $(date +%s) + $1 )) what="$2"
    shift 2
    until "$@"; do
        [ "$(date +%s)" -lt "$deadline" ] || fail "timed out waiting for $what"
        sleep 0.5
    done
}

# Like wait_until, but a timeout is returned to the caller instead of ending
# the run, so the comparison that follows still reports what it saw.
wait_quietly() { # seconds cmd...
    local deadline=$(( $(date +%s) + $1 ))
    shift
    until "$@"; do
        [ "$(date +%s)" -lt "$deadline" ] || return 1
        sleep 0.5
    done
}

unit_prop() { systemctl --user show "$UNIT_NAME" --property="$1" --value; }

ready() { curl -fsS -m 2 "$BASE/api/devserver/info" >/dev/null 2>&1; }

devserver_token() {
    python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["devserver_token"])' \
        "$CHAN_HOME/devserver/config.json"
}

json_field() { # field  (stdin: json object)
    python3 -c 'import json,sys;print(json.load(sys.stdin)[sys.argv[1]])' "$1"
}

state_field() { # client name field
    python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])' \
        "$OUT/$1/$2.state" "$3"
}

# Mint a terminal window whose shell tails FILE with output post-processing
# and echo off, so the PTY emits exactly the file's bytes. Prints "sid wid".
spawn_tail_terminal() { # name file
    local name="$1" file="$2" token window prefix ttoken wid sid payload
    token="$(devserver_token)"
    window="$(curl -fsS -m 10 -X POST -H "Authorization: Bearer $token" \
        -H 'Content-Type: application/json' \
        -d '{"kind":"terminal"}' "$BASE/api/library/windows")"
    wid="$(printf '%s' "$window" | json_field window_id)"
    prefix="$(printf '%s' "$window" | json_field prefix)"
    ttoken="$(printf '%s' "$window" | json_field token)"
    payload="$(python3 -c '
import json, sys
name, wid, path = sys.argv[1:]
print(json.dumps({
    "name": name,
    "window_id": wid,
    "command": f"stty -opost -echo; exec tail -c +1 -f {path}",
}))' "$name" "$wid" "$file")"
    sid="$(curl -fsS -m 10 -X POST -H "Authorization: Bearer $ttoken" \
        -H 'Content-Type: application/json' -d "$payload" \
        "$BASE$prefix/api/terminals" | json_field session)"
    wait_until 15 "tail child for $name" \
        sh -c "pgrep -f 'tail -c \\+1 -f $file' >/dev/null"
    printf '%s %s\n' "$sid" "$wid"
}

# Append deterministic output: numbered lines carrying SGR colour and
# multi-byte UTF-8, so a replay cut inside a sequence or a character shows.
append_output() { # file label bytes
    python3 - "$1" "$2" "$3" <<'PY'
import sys
path, label, want = sys.argv[1], sys.argv[2], int(sys.argv[3])
out = bytearray()
n = 0
while len(out) < want:
    out += f"\x1b[3{n % 8}m{label} line {n:06d} é✓ü\x1b[0m {'x' * (n % 40)}\n".encode()
    n += 1
with open(path, "ab") as handle:
    handle.write(out)
PY
}

start_keep_client() {
    NODE_NO_WARNINGS=1 node --experimental-websocket \
        "$REPO/scripts/e2e/terminal-replay-client.mjs" \
        --base "$BASE" --chan-home "$CHAN_HOME" --out "$OUT/keep" --mode keep \
        --term "A:$SID_A:$WID_A:1" --term "B:$SID_B:$WID_B:0" \
        > "$OUT/keep.client.log" 2>&1 &
    CLIENT_PID=$!
}

client_ready() { # mode name min-readies
    [ -f "$OUT/$1/$2.state" ] || return 1
    python3 -c '
import json, sys
state = json.load(open(sys.argv[1]))
ok = state["connected"] and state["readies"] >= int(sys.argv[2]) and not state["replay_active"]
raise SystemExit(0 if ok else 1)' "$OUT/$1/$2.state" "$3"
}

screen_caught_up() { # mode name file
    [ "$(stat -c %s "$OUT/$1/$2.screen")" -ge "$(stat -c %s "$3")" ]
}

# Byte comparison with the first differing offset named.
compare_bytes() { # label want-file got-file
    python3 - "$@" <<'PY'
import sys
label, want_path, got_path = sys.argv[1:]
want = open(want_path, "rb").read()
got = open(got_path, "rb").read()
if want == got:
    print(f"{label}: equal, {len(want)} bytes")
    raise SystemExit(0)
at = next((i for i, (a, b) in enumerate(zip(want, got)) if a != b), min(len(want), len(got)))
print(f"{label}: DIFFER, want {len(want)} bytes, got {len(got)}, first difference at offset {at}")
print(f"  want[{at}:+80] = {want[at:at + 80]!r}")
print(f"  got [{at}:+80] = {got[at:at + 80]!r}")
raise SystemExit(1)
PY
}

# The keep client's screen must equal the file, with nothing printed.
assert_keep_screen() { # phase name file
    local phase="$1" name="$2" file="$3" printed
    wait_quietly 30 screen_caught_up keep "$name" "$file" \
        || log "note: keep $name screen did not reach the file size within 30s"
    sleep 1
    if ! compare_bytes "keep $name screen after $phase" "$file" "$OUT/keep/$name.screen" >&2; then
        check_fail "keep $name screen differs from what was written after $phase"
    fi
    printed="$(state_field keep "$name" printed)"
    [ "$printed" = "[]" ] || check_fail "keep $name printed $printed after $phase"
}

# A fresh attach replays the file's tail, accounts for the rest, and misses
# nothing the live ring held.
assert_fresh_attach() { # phase name file sid wid
    local phase="$1" name="$2" file="$3" sid="$4" wid="$5" dir
    dir="$OUT/fresh-$phase"
    if ! NODE_NO_WARNINGS=1 node --experimental-websocket \
        "$REPO/scripts/e2e/terminal-replay-client.mjs" \
        --base "$BASE" --chan-home "$CHAN_HOME" --out "$dir" --mode fresh \
        --term "$name:$sid:$wid:0" > "$dir.$name.log" 2>&1; then
        check_fail "fresh attach to $name after $phase did not complete ($(cat "$dir.$name.log"))"
        return
    fi
    if ! python3 - "$phase" "$name" "$file" "$dir/$name.screen" "$dir/$name.events" >&2 <<'PY'
import json, sys
phase, name, file_path, screen_path, events_path = sys.argv[1:]
want = open(file_path, "rb").read()
replay = open(screen_path, "rb").read()
session = [json.loads(line) for line in open(events_path) if '"session"' in line][-1]
seq, missed = session["seq"], session["missed_bytes"]
problems = []
if seq != len(want):
    problems.append(f"session seq {seq}, want {len(want)} (the bytes written)")
if missed + len(replay) != len(want):
    problems.append(f"missed {missed} + replay {len(replay)} = {missed + len(replay)}, want {len(want)}")
if not want.endswith(replay):
    at = len(want) - len(replay)
    problems.append(f"replay is not the file's tail (tail would start at offset {at})")
if missed:
    problems.append(f"the SPA prints: terminal replay missed {missed} bytes")
print(f"fresh {name} after {phase}: seq {seq}, missed {missed}, replay {len(replay)} bytes, file {len(want)} bytes")
for problem in problems:
    print(f"  {problem}")
raise SystemExit(1 if problems else 0)
PY
    then
        check_fail "fresh attach to $name after $phase does not account for what was written"
    fi
}

main_pid() {
    local pid
    pid="$(unit_prop MainPID)"
    [ -n "$pid" ] && [ "$pid" != 0 ] || fail "unit has no MainPID"
    printf '%s' "$pid"
}

wait_restarted() { # old-nrestarts old-mainpid why
    local old_restarts="$1" old_pid="$2" why="$3"
    wait_until 90 "restart evidence after $why" sh -c "
        n=\$(systemctl --user show $UNIT_NAME --property=NRestarts --value)
        p=\$(systemctl --user show $UNIT_NAME --property=MainPID --value)
        [ \"\$n\" != \"$old_restarts\" ] || { [ \"\$p\" != \"$old_pid\" ] && [ \"\$p\" != 0 ]; }
    "
    wait_until 90 "active unit after $why" \
        systemctl --user is-active --quiet "$UNIT_NAME"
    wait_until 90 "readiness after $why" ready
}

# Appends small chunks to both files for a few seconds, so output lands while
# the old process seals its manifest, while no process holds the PTYs, and as
# the new one adopts them.
start_restart_window_writer() { # label
    (
        for i in $(seq 1 60); do
            append_output "$FILE_A" "$1-a$i" 300
            append_output "$FILE_B" "$1-b$i" 900
            sleep 0.05
        done
    ) &
    WRITER_PID=$!
}

# Each probe uses a fresh authoritative attach. The output barrier waits for
# the server's ring cursor, not for the writer's local write to finish.
cat > "$WORK/status-probe.mjs" <<'JS'
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {isDeepStrictEqual} from "node:util";

const [base, home, mode, sid, wid, output, expected] = process.argv.slice(2);
function savedReport(manifest, id, before) {
  const meta = manifest.sessions.find(row => row.meta.session_id === id)?.meta;
  return manifest.sealed === false && meta?.seq === before.seq &&
    isDeepStrictEqual(meta.program_status?.records, before.program_status.records.map(
      ({source, ...record}) => record));
}
function verify(frame, mode, expected) {
  const records = frame.program_status.records;
  if (mode === "read") {
    assert.equal(frame.observed_seq, Number(expected), "read acknowledgement reaches exact prefix end");
  } else if (mode === "empty") {
    assert.deepEqual(records, [], "restart contains no status records");
  } else if (mode === "same") {
    const before = expected;
    assert.deepEqual(records, before.program_status.records, "at-rest report survives graceful restart");
    assert.equal(frame.seq, before.seq, "at-rest reporter emitted no additional bytes");
  } else if (mode === "owned") {
    assert.equal(records.length, 1, "parked survey has one owned record");
    const row = records[0];
    assert.equal(row.source, "chan");
    assert.match(row.id, /^survey\//);
    assert.equal(row.state, "blocked");
    assert.equal(row.kind, "question");
    assert.equal(row.title, "Parked survey");
  } else if (mode === "report") {
    assert.equal(records.length, 1, "completed report has one record");
    const row = records[0];
    assert.equal(row.source, "program");
    assert.equal(row.id, expected);
    assert.equal(row.state, "blocked");
    assert.equal(row.kind, "permission");
    assert.equal(row.title, "EU West");
    assert.equal(row.msg, "Approve deploy to eu-west (production)?");
    assert.equal(row.seen, false);
  } else {
    throw new Error(`unknown probe mode: ${mode}`);
  }
}

if (base === "--self-test") {
  const row = {source: "program", id: "eu-west", state: "blocked", kind: "permission",
    title: "EU West", msg: "Approve deploy to eu-west (production)?", seen: false};
  const good = {seq: 10, observed_seq: 10, program_status: {records: [row]}};
  verify(good, "report", "eu-west");
  verify(good, "read", "10");
  verify(good, "same", good);
  const {source, ...saved} = row;
  const manifest = {sealed: false, sessions: [{meta: {session_id: "s", seq: 10,
    program_status: {records: [saved]}}}]};
  assert.equal(savedReport(manifest, "s", good), true);
  assert.equal(savedReport({...manifest, sealed: true}, "s", good), false);
  assert.equal(savedReport(manifest, "missing", good), false);
  assert.equal(savedReport(manifest, "s", {...good, seq: 11}), false);
  assert.equal(savedReport(manifest, "s", {...good, program_status: {records: []}}), false);
  verify({program_status: {records: []}}, "empty", "");
  for (const field of Object.keys(row)) {
    const bad = structuredClone(good);
    bad.program_status.records[0][field] = field === "seen" ? true : "wrong";
    assert.throws(() => verify(bad, "report", "eu-west"), assert.AssertionError, field);
  }
  assert.throws(() => verify(good, "empty", ""), assert.AssertionError);
  assert.throws(() => verify(good, "read", "11"), assert.AssertionError);
  assert.throws(() => verify({...good, seq: 11}, "same", good), assert.AssertionError);
  assert.throws(() => verify({...good, program_status: {records: []}}, "same", good), assert.AssertionError);
  const own = {program_status: {records: [{source: "chan", id: "survey/1", state: "blocked",
    kind: "question", title: "Parked survey"}]}};
  verify(own, "owned", "");
  for (const field of Object.keys(own.program_status.records[0])) {
    const bad = structuredClone(own);
    bad.program_status.records[0][field] = "wrong";
    assert.throws(() => verify(bad, "owned", ""), assert.AssertionError, field);
  }
  console.log("status reader controls: positives and corrupted record/cursor negatives passed");
  process.exit(0);
}

const deadline = setTimeout(() => {
  console.error(`status probe ${mode}: protocol deadline expired`);
  process.exit(1);
}, 30_000);
const config = JSON.parse(fs.readFileSync(path.join(home, "devserver/config.json")));
const response = await fetch(`${base}/api/library/windows`, {
  headers: { Authorization: `Bearer ${config.devserver_token}` },
  signal: AbortSignal.timeout(10_000),
});
assert.ok(response.ok, `windows response ${response.status}`);
const route = (await response.json()).find(row => row.window_id === wid);
assert.ok(route, "the original window survives");

async function inspect() {
  const query = new URLSearchParams({session: sid, window_id: wid, since: "0",
    cols: "80", rows: "24", t: route.token});
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}${route.prefix}/api/terminal/ws?${query}`);
  ws.binaryType = "arraybuffer";
  return await new Promise((resolve, reject) => {
    let session, seq, ready = false, done = false;
    const finish = () => {
      if (!ready || (mode === "read" && seq < Number(expected))) return;
      done = true;
      ws.close();
      resolve({...session, observed_seq: seq});
    };
    ws.addEventListener("error", () => reject(new Error("terminal socket error")));
    ws.addEventListener("close", () => {
      if (!done) reject(new Error("terminal closed before read acknowledgement"));
    });
    ws.addEventListener("message", event => {
      try {
        if (typeof event.data !== "string") {
          if (ready) seq += event.data.byteLength;
        } else {
          const frame = JSON.parse(event.data);
          if (frame.type === "session") {
            assert.equal(frame.id, sid, "adoption retains the original session id");
            session = frame;
            seq = frame.seq;
          } else if (frame.type === "ready") {
            assert.ok(session, "session precedes ready");
            ready = true;
          } else if (frame.type === "error" || frame.type === "closed" || frame.type === "exit") {
            throw new Error(`terminal ended: ${JSON.stringify(frame)}`);
          }
        }
        finish();
      } catch (error) { reject(error); ws.close(); }
    });
  });
}

if (mode === "manifest") {
  const before = JSON.parse(fs.readFileSync(expected));
  const manifestPath = path.join(home, "devserver/fdstore-restart.json");
  await new Promise((resolve, reject) => {
    const check = () => {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath));
        if (savedReport(manifest, sid, before)) {
          fs.writeFileSync(output, JSON.stringify({sealed: manifest.sealed,
            meta: manifest.sessions.find(row => row.meta.session_id === sid).meta}, null, 2));
          watcher.close();
          resolve();
        }
      } catch (error) { watcher.close(); reject(error); }
    };
    const watcher = fs.watch(path.dirname(manifestPath), check);
    check();
  });
  console.log("crash barrier: unsealed manifest contains the exact report and ring cursor");
} else if (mode === "survey") {
  // Holding the target's event socket makes the survey dispatch observable;
  // its control write half stays open until the devserver restart ends it.
  const events = new WebSocket(`${base.replace(/^http/, "ws")}${route.prefix}/ws?w=${wid}&t=${route.token}`);
  await new Promise((resolve, reject) => {
    events.addEventListener("open", resolve, {once: true});
    events.addEventListener("error", reject, {once: true});
  });
  const request = {type: "term_survey", session_id: sid, tab_name: expected,
    spec: {surveyId: "", title: "Parked survey", bodyMarkdown: "Continue?", options: ["yes"]},
    timeout_secs: 120, cancel_on_eof: true};
  const socket = net.createConnection(fs.readFileSync(`${output}.socket`, "utf8").trim());
  socket.on("error", error => { console.error(error.message); process.exit(1); });
  socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  events.addEventListener("message", event => {
    const frame = JSON.parse(event.data);
    if (frame.command === "open_survey") {
      fs.writeFileSync(`${output}.ready`, JSON.stringify({command: frame.command}));
      clearTimeout(deadline);
    }
  });
  socket.on("data", () => {});
  socket.on("end", () => { events.close(); socket.end(); });
  await new Promise(resolve => socket.on("close", resolve));
} else {
  const frame = await inspect();
  fs.writeFileSync(output, JSON.stringify(frame, null, 2));
  verify(frame, mode, mode === "same" ? JSON.parse(fs.readFileSync(expected)) : expected);
  console.log(`${mode}: session ${sid}, seq ${frame.observed_seq}, records ${JSON.stringify(frame.program_status.records)}`);
}
clearTimeout(deadline);
JS
node "$WORK/status-probe.mjs" --self-test

status_probe() { # mode sid wid output expected
    NODE_NO_WARNINGS=1 node "$WORK/status-probe.mjs" "$BASE" "$CHAN_HOME" "$@"
}

status_read_barrier() { # sid wid file output
    status_probe read "$1" "$2" "$4" "$(stat -c %s "$3")"
}

graceful_status_restart() {
    local old_pid
    old_pid="$(main_pid)"
    restart_devserver
    wait_until 60 'status restart readiness' ready
    [ "$(main_pid)" != "$old_pid" ] || fail 'graceful restart did not replace the devserver'
}

run_status_case() { # case name
    local name="$1" file="$WORK/$1.output" dir="$OUT/$1" sid wid old_pid old_restarts socket
    mkdir "$dir"
    : > "$file"
    read -r sid wid <<<"$(spawn_tail_terminal "$name" "$file")"
    status_probe empty "$sid" "$wid" "$dir/initial.json" ''
    case "$name" in
        status-rest)
            printf '\033]7501;state=blocked:kind=permission:id=eu-west:title=RVUgV2VzdA==:msg=QXBwcm92ZSBkZXBsb3kgdG8gZXUtd2VzdCAocHJvZHVjdGlvbik/\033\134' >> "$file"
            status_read_barrier "$sid" "$wid" "$file" "$dir/read-before.json"
            status_probe report "$sid" "$wid" "$dir/before.json" eu-west
            graceful_status_restart
            status_probe same "$sid" "$wid" "$dir/after.json" "$dir/before.json"
            ;;
        status-partial)
            mkfifo "$WORK/suffix.gate"
            (
                IFS= read -r _ < "$WORK/suffix.gate"
                printf 'RVUgV2VzdA==:msg=QXBwcm92ZSBkZXBsb3kgdG8gZXUtd2VzdCAocHJvZHVjdGlvbik/\033\134' >> "$file"
            ) &
            WRITER_PID=$!
            printf '\033]7501;state=blocked:kind=permission:id=eu-west:title=' >> "$file"
            status_read_barrier "$sid" "$wid" "$file" "$dir/prefix-read.json"
            status_probe empty "$sid" "$wid" "$dir/before.json" ''
            graceful_status_restart
            status_probe empty "$sid" "$wid" "$dir/adopted.json" ''
            python3 - "$dir/prefix-read.json" "$dir/adopted.json" <<'PY'
import json, sys
prefix, adopted = [json.load(open(p)) for p in sys.argv[1:]]
assert prefix["observed_seq"] > 0, "the prefix must be read before sealing"
assert adopted["seq"] == prefix["observed_seq"], "adoption must precede suffix release"
print(f"prefix read and adopted at seq {adopted['seq']}; releasing suffix")
PY
            printf 'release\n' > "$WORK/suffix.gate"
            wait "$WRITER_PID"
            WRITER_PID=''
            status_read_barrier "$sid" "$wid" "$file" "$dir/suffix-read.json"
            status_probe report "$sid" "$wid" "$dir/after.json" eu-west
            ;;
        status-crash)
            printf '\033]7501;state=blocked:kind=permission:id=eu-west:title=RVUgV2VzdA==:msg=QXBwcm92ZSBkZXBsb3kgdG8gZXUtd2VzdCAocHJvZHVjdGlvbik/\033\134' >> "$file"
            status_read_barrier "$sid" "$wid" "$file" "$dir/read-before.json"
            status_probe report "$sid" "$wid" "$dir/before.json" eu-west
            # Parking another live PTY rewrites the active manifest. Observe
            # the report in that unsealed snapshot before killing its writer.
            : > "$WORK/crash-manifest-barrier.output"
            spawn_tail_terminal crash-manifest-barrier "$WORK/crash-manifest-barrier.output" > "$dir/barrier-terminal"
            status_probe manifest "$sid" "$wid" "$dir/unsealed.json" "$dir/before.json"
            old_restarts="$(unit_prop NRestarts)"
            old_pid="$(main_pid)"
            kill -9 "$old_pid"
            wait_restarted "$old_restarts" "$old_pid" 'status crash'
            status_probe empty "$sid" "$wid" "$dir/after.json" ''
            ;;
        status-owned)
            # The caller's runtime has only this suite's stable control sockets.
            socket="$(python3 - "$XDG_RUNTIME_DIR" <<'PY'
import glob, json, socket, sys
matches = []
for candidate in glob.glob(sys.argv[1] + "/chan-control-s*.sock"):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(5)
        connection.connect(candidate)
        connection.sendall(b'{"type":"identify"}\n')
        connection.shutdown(socket.SHUT_WR)
        response = json.load(connection.makefile())
    assert response["status"] == "ok", response
    identity = json.loads(response["message"])
    if identity.get("workspace_root") is None:
        matches.append(candidate)
assert len(matches) == 1, matches
print(matches[0])
PY
)"
            printf '%s\n' "$socket" > "$dir/survey.socket"
            status_probe survey "$sid" "$wid" "$dir/survey" "$name" &
            SURVEY_PID=$!
            wait_until 15 'parked survey dispatch acknowledgement' test -f "$dir/survey.ready"
            status_probe owned "$sid" "$wid" "$dir/before.json" ''
            graceful_status_restart
            status_probe empty "$sid" "$wid" "$dir/after.json" ''
            wait "$SURVEY_PID"
            SURVEY_PID=''
            ;;
    esac
}

# ---- build the exact commit under test ----
log "building chan (debug) at $SHA"
cargo build --locked -q -p chan --manifest-path "$REPO/Cargo.toml"
TARGET_DIR="${CARGO_TARGET_DIR:-$REPO/target}"
case "$TARGET_DIR" in
    /*) ;;
    *) TARGET_DIR="$REPO/$TARGET_DIR" ;;
esac
CHAN="$TARGET_DIR/debug/chan"

# Mask the devserver's token in the lines on stdin: what follows the
# CHAN_DEVSERVER_TOKEN= marker, wherever on its line the marker sits (the
# unit's journal puts its own columns before it), and the t= of a URL's
# query.
mask_token() {
    sed -E -e 's/(CHAN_DEVSERVER_TOKEN=).*/\1<redacted>/' \
        -e 's/([?&]t=)[^&[:space:]]*/\1<redacted>/g'
}

# `chan devserver restart` prints the token on stdout as a
# CHAN_DEVSERVER_TOKEN=<token> line, and a restart whose unit does not come
# up ends on stderr with the unit's recent journal, which holds the
# devserver's banner: the launch URL with ?t=<token> and that same marker
# line. Each stream is masked on its own descriptor (3 carries stdout past
# the filter of stderr), so the log a run leaves behind never holds a live
# token and stdout stays what the command printed there; pipefail keeps a
# failed restart failing.
restart_devserver() {
    {
        "$CHAN" devserver restart --service=systemd --bind=127.0.0.1 --port="$PORT" \
            2>&1 >&3 3>&- | mask_token >&2 3>&-
    } 3>&1 | mask_token
}

log "starting the devserver unit"
restart_devserver
wait_until 60 "first readiness" ready

run_replay() {
FILE_A="$WORK/out-a"
FILE_B="$WORK/out-b"
: > "$FILE_A"
: > "$FILE_B"
read -r SID_A WID_A <<<"$(spawn_tail_terminal replay-a "$FILE_A")"
read -r SID_B WID_B <<<"$(spawn_tail_terminal replay-b "$FILE_B")"
log "terminal A (focused) $SID_A window $WID_A"
log "terminal B (not focused) $SID_B window $WID_B"

start_keep_client
for name in A B; do
    wait_until 30 "keep client $name attached" client_ready keep "$name" 1
done

append_output "$FILE_A" "boot" $((64 * 1024))
append_output "$FILE_B" "boot" $((192 * 1024))
assert_keep_screen boot A "$FILE_A"
assert_keep_screen boot B "$FILE_B"
assert_fresh_attach boot A "$FILE_A" "$SID_A" "$WID_A"
assert_fresh_attach boot B "$FILE_B" "$SID_B" "$WID_B"

n=0
for kind in $RESTARTS; do
    n=$((n + 1))
    phase="restart$n-$kind"
    keep_a="$(state_field keep A preludes)"
    keep_b="$(state_field keep B preludes)"
    log "$phase: restarting"
    start_restart_window_writer "$phase"
    case "$kind" in
        cli)
            restart_devserver
            wait_until 60 "readiness after $phase" ready
            ;;
        crash)
            old_restarts="$(unit_prop NRestarts)"
            old_main="$(main_pid)"
            kill -9 "$old_main"
            wait_restarted "$old_restarts" "$old_main" "$phase"
            ;;
    esac
    wait "$WRITER_PID" || fail "the restart-window writer failed"
    WRITER_PID=""
    wait_until 60 "keep client A re-attached after $phase" \
        sh -c "[ \"\$(python3 -c 'import json;print(json.load(open(\"$OUT/keep/A.state\"))[\"preludes\"])')\" -gt $keep_a ]"
    wait_until 60 "keep client B re-attached after $phase" \
        sh -c "[ \"\$(python3 -c 'import json;print(json.load(open(\"$OUT/keep/B.state\"))[\"preludes\"])')\" -gt $keep_b ]"
    for name in A B; do
        wait_until 30 "keep client $name ready after $phase" client_ready keep "$name" 1
    done
    append_output "$FILE_A" "$phase-after" $((16 * 1024))
    append_output "$FILE_B" "$phase-after" $((48 * 1024))
    assert_keep_screen "$phase" A "$FILE_A"
    assert_keep_screen "$phase" B "$FILE_B"
    assert_fresh_attach "$phase" A "$FILE_A" "$SID_A" "$WID_A"
    assert_fresh_attach "$phase" B "$FILE_B" "$SID_B" "$WID_B"
done

for name in A B; do
    log "keep $name dials $(state_field keep "$name" dials), failed $(state_field keep "$name" failed_dials), preludes $(state_field keep "$name" preludes)"
done
if [ "$FAILURES" -gt 0 ]; then
    fail "$FAILURES replay check(s) failed at $SHA (restarts: $RESTARTS)"
fi
}

for name in $CASES; do
    log "case $name"
    set +e
    (
        set -e
        trap 'for pid in $CLIENT_PID $WRITER_PID $SURVEY_PID; do kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done' EXIT
        case "$name" in
            replay) run_replay ;;
            *) run_status_case "$name" ;;
        esac
    ) > "$OUT/$name.log" 2>&1
    case_rc=$?
    set -e
    printf 'rc=%s\n' "$case_rc" > "$OUT/$name.status"
    cat "$OUT/$name.log" >&2
    if [ "$case_rc" -ne 0 ]; then
        check_fail "$name exited $case_rc"
    fi
done
if [ "$FAILURES" -gt 0 ]; then
    fail "$FAILURES case(s) failed at $SHA"
fi
log "PASS: terminal replay/status cases ($CASES) at $SHA"
on_exit
rm -rf "$WORK"
