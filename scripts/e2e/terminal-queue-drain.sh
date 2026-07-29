#!/usr/bin/env bash
set -euo pipefail

# Live validation for chronological `cs terminal write` batching. Run from a
# chan terminal whose CHAN_CONTROL_SOCKET targets the server build under test.
# That server must serve a workspace the agent under test already trusts:
# codex and claude both park on a first-run trust prompt in an unfamiliar
# directory and never print their ready pattern, so a probe over a fresh
# random path fails every run on the ready-pattern timeout instead.
# Each probe agent is spawned directly through a one-member team config so
# the target session is born with the server-derived agent identity that
# `--submit` requires. The hidden team materialization is owned by this run
# and removed on exit.
# Diagnostics go to stderr; one result row per run goes to stdout.
#
# Every run gets its OWN tab inside one probe group, so every scrollback read
# below is scoped to the run that made it. The group is closed on exit,
# including on failure.
#
# Two kinds of oracle appear below, and only one of them can fail a run:
#
#   LOAD-BEARING  The polled queue depth (`cs terminal list --json`, server
#                 state, not the screen) and the agent's own OUTPUT. The agent
#                 BUILDS each sentinel out of what it received
#                 (`QUEUE_DRAIN_BATCH_<blocks>` from the number of notification
#                 blocks it counted), so no literal in its input can satisfy
#                 one and an echo cannot fake a batch.
#   ADVISORY      Anything read out of the scrollback ring. That ring holds PTY
#                 OUTPUT only, so a framed envelope shows up there only if the
#                 agent renders the pasted body verbatim -- Claude prints
#                 `[Pasted text #1 +16 lines]` instead at these payload sizes.
#                 Advisory observations are recorded in the result row and
#                 never fail a run.
#
# What each case proves:
#
#   batch       Five notifications enqueued while the agent is provably
#               generating drain as ONE turn. Depth is 5 with nothing reaching
#               the busy compose box, then reaches 0 without the poller ever
#               seeing an intermediate 1..4, and the agent answers ONCE for all
#               five: it emits `QUEUE_DRAIN_BATCH_5` followed by the five tail
#               tokens in order, and never a `QUEUE_DRAIN_BATCH_0..4` (which is
#               what a per-message drain would produce).
#   boundaries  Raw no-submit writes END the batch prefix. Five alternating
#               submitted/raw messages must drain ONE AT A TIME, so the poller
#               has to observe EVERY intermediate depth 4, 3, 2 and 1, the
#               agent must never emit a `QUEUE_DRAIN_BATCH_2..5`, and the tail
#               tokens still arrive in FIFO order, so nothing was skipped to
#               batch a later message. Runtime-override boundaries are pinned
#               in the chan-library selector tests because overrides resolve in
#               the server process and cannot be toggled by this client.
#   late        A sixth notification enqueued once the batch has drained gets
#               its OWN turn: the agent emits the batch sentinel and then a
#               separate `QUEUE_DRAIN_LATE_<token>` it builds from that
#               message alone, which proves the queue keeps draining after a
#               batch delivery.
#   cap         A 4096-byte raw write is accepted while the agent is busy;
#               4097-byte raw and submitted writes are both refused by the
#               client and never change the server-side queue depth.
#
# NOT covered here:
#
#   The enqueue-after-selection race. Required Behavior item 4 (a message
#   enqueued after the prefix is SELECTED waits for the next turn) is not
#   reachable from outside the server: selection and pop happen under one
#   queue lock inside a drainer tick, so an external enqueue lands either
#   before selection, where joining the batch is correct, or after the pop,
#   where a shell cannot tell the two apart. It is pinned by
#   `enqueue_after_atomic_batch_selection_stays_for_the_next_turn` in
#   crates/chan-library/src/terminal_sessions.rs, which drives the selector
#   directly.
#
#   The Rich Prompt boundary. Rich Prompt enters the queue over the terminal
#   WebSocket, which `cs` does not speak, so no shell harness can place one
#   between notifications. That boundary is pinned by the chan-library and
#   chan-server unit tests and by a browser smoke.

agent="codex"
size_kib=16
runs=3
timeout_secs=180
case_name="batch"
gap_ms=50
max_message_bytes=4096
# Mirrors `WRITE_QUEUE_BATCH_MAX_BYTES` in
# crates/chan-library/src/terminal_sessions.rs. The payload is sized against
# THIS number rather than a hand-picked headroom, and a framing change that
# pushes the last notification past the ceiling shows up as the agent counting
# four blocks instead of five.
max_batch_bytes=$((64 * 1024))
cs_bin=${CS_BIN:-cs}
# Mirrors `WRITE_QUEUE_QUIET_MS` and `WRITE_QUEUE_INPUT_GAP` in
# crates/chan-library/src/terminal_sessions.rs: `parse_input_gap` accepts only
# 1..WRITE_QUEUE_QUIET_MS ms and falls back to the built-in gap for anything
# else, so a raw string comparison here would certify a gap the server never
# used.
write_queue_quiet_ms=800
default_gap_ms=50

usage() {
  cat >&2 <<'EOF'
usage: terminal-queue-drain.sh [--agent codex|claude|gemini|opencode] [--case gap|batch|boundaries|late|cap|all]
                               [--size-kib N] [--runs N] [--timeout-secs N]
                               [--gap MS] [--max-batch-bytes N]

Environment:
  CS_BIN                      cs-compatible binary (default: cs). A development
                              chan binary must be invoked through a symlink
                              named cs so it enters that command surface.
  CHAN_TERMINAL_INPUT_GAP_MS  The SERVER's multi-part input gap. --gap
                              only asserts this matches; the value is read once
                              per server process, so sweeping it means
                              restarting the server under test with the new
                              value exported. The server IGNORES a value
                              outside 1..799 ms and runs its built-in 50 ms, so
                              --gap takes the same range and the env value is
                              put through the same clamp before it is compared.
  CHAN_GEMINI_ATOMIC_PROBE    Must be 1 for --case gap. It acknowledges that
                              the server is a scratch candidate where built-in
                              Gemini bypasses message_parts' Body/Chord split
                              and drains as one atomic InputSequence. The final
                              boundary build deliberately does not do this.
  CHAN_WORKSPACE_PATH         Workspace served by the test server. The harness
                              creates one hidden team directory there and
                              removes that exact owned directory on exit.

--size-kib targets the whole five-message batch. Every logical message remains
at or below the production 4096-byte cap.
EOF
}

while (($#)); do
  case "$1" in
    --agent)
      agent=$2
      shift 2
      ;;
    --case)
      case_name=$2
      shift 2
      ;;
    --size-kib)
      size_kib=$2
      shift 2
      ;;
    --runs)
      runs=$2
      shift 2
      ;;
    --timeout-secs)
      timeout_secs=$2
      shift 2
      ;;
    --gap)
      gap_ms=$2
      shift 2
      ;;
    --max-batch-bytes)
      max_batch_bytes=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

case "$agent" in
  codex)
    launch='codex -c check_for_update_on_startup=false --sandbox read-only -a never --no-alt-screen'
    ready_pattern='Codex'
    ;;
  claude)
    launch='claude --permission-mode plan --tools ""'
    ready_pattern='plan mode on'
    ;;
  gemini)
    launch='gemini --approval-mode plan'
    ready_pattern='Type your message'
    ;;
  opencode)
    launch='opencode --agent plan --model opencode/deepseek-v4-flash-free --mini --no-replay'
    ready_pattern='Ask anything'
    ;;
  *)
    echo "unsupported agent: $agent" >&2
    exit 2
    ;;
esac

case "$case_name" in
  gap | batch | boundaries | late | cap | all) ;;
  *)
    echo "unsupported case: $case_name" >&2
    exit 2
    ;;
esac

if [[ $case_name == gap && ${CHAN_GEMINI_ATOMIC_PROBE:-} != 1 ]]; then
  echo "--case gap requires CHAN_GEMINI_ATOMIC_PROBE=1 and a scratch atomic-Gemini server build" >&2
  exit 2
fi

[[ $size_kib =~ ^[1-9][0-9]*$ ]] || { echo "--size-kib must be positive" >&2; exit 2; }
[[ $runs =~ ^[1-9][0-9]*$ ]] || { echo "--runs must be positive" >&2; exit 2; }
[[ $timeout_secs =~ ^[1-9][0-9]*$ ]] || { echo "--timeout-secs must be positive" >&2; exit 2; }
[[ $gap_ms =~ ^[1-9][0-9]*$ ]] && ((gap_ms < write_queue_quiet_ms)) \
  || { echo "--gap must be in 1..$((write_queue_quiet_ms - 1))ms; the server ignores anything else" >&2; exit 2; }
[[ $max_batch_bytes =~ ^[1-9][0-9]*$ ]] || { echo "--max-batch-bytes must be positive" >&2; exit 2; }
: "${CHAN_CONTROL_SOCKET:?run from a chan terminal or export the test server control socket}"
: "${CHAN_WINDOW_ID:?run from a chan terminal or export the test browser window id}"
: "${CHAN_WORKSPACE_PATH:?run from a chan terminal or export the test server workspace path}"

# The gap `parse_input_gap` derives from this env value: trimmed digits inside
# 1..WRITE_QUEUE_QUIET_MS, otherwise the built-in default.
effective_gap_ms() {
  local raw=$1
  if [[ $raw =~ ^[[:space:]]*([0-9]+)[[:space:]]*$ ]]; then
    local ms=$((10#${BASH_REMATCH[1]}))
    if ((ms > 0 && ms < write_queue_quiet_ms)); then
      printf '%s' "$ms"
      return
    fi
  fi
  printf '%s' "$default_gap_ms"
}

# A chan terminal inherits the server's environment, so this reads the gap the
# server under test actually uses. Asserting it here is what makes a gap sweep
# reproducible from committed code instead of a rebuild nobody can repeat.
server_gap_ms=$(effective_gap_ms "${CHAN_TERMINAL_INPUT_GAP_MS:-}")
if [[ $server_gap_ms != "$gap_ms" ]]; then
  echo "server split gap is ${server_gap_ms}ms, --gap asked for ${gap_ms}ms" >&2
  if [[ -n ${CHAN_TERMINAL_INPUT_GAP_MS:-} && $server_gap_ms == "$default_gap_ms" ]]; then
    echo "CHAN_TERMINAL_INPUT_GAP_MS=${CHAN_TERMINAL_INPUT_GAP_MS} is outside 1..$((write_queue_quiet_ms - 1))ms, so the server uses ${default_gap_ms}ms" >&2
  fi
  echo "restart the server under test with CHAN_TERMINAL_INPUT_GAP_MS=$gap_ms" >&2
  exit 2
fi

stamp="$(date +%s)-$$"
group="queue-drain-probe-$stamp"
tab=""
workspace_path=""
probe_root=""
probe_rel=""
created_groups=()

cleanup() {
  local probe_group
  for probe_group in "${created_groups[@]}"; do
    "$cs_bin" terminal close --tab-group="$probe_group" >/dev/null 2>&1 || true
  done
  if [[ -n $probe_root
    && -d $probe_root
    && $probe_root == "$workspace_path"/.chan-queue-drain.*
    && -f $probe_root/.owner
    && $(<"$probe_root/.owner") == "$stamp" ]]; then
    rm -rf -- "$probe_root"
  fi
}
trap cleanup EXIT INT TERM

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

workspace_path=$(cd -- "$CHAN_WORKSPACE_PATH" && pwd -P)
[[ $workspace_path == /* && $workspace_path != / ]] \
  || fail "unsafe CHAN_WORKSPACE_PATH for probe materialization: $workspace_path"
probe_root=$(mktemp -d "$workspace_path/.chan-queue-drain.XXXXXX")
probe_rel=${probe_root#"$workspace_path"/}
[[ $probe_rel != "$probe_root" && $probe_rel == .chan-queue-drain.* ]] \
  || fail "probe directory escaped the workspace: $probe_root"
printf '%s\n' "$stamp" > "$probe_root/.owner"

# Scrollback with ANSI escapes removed and newlines folded away, so an
# assertion is not defeated by a TUI wrapping a line at the pane width.
#
# Every stage is checked, because a stage that dies leaves the empty string,
# and empty text silently satisfies every negative assertion below.
#
# The C locale is not optional: the CSI pattern is written in ASCII byte
# ranges, and a UTF-8 collation order rejects [0-?] as an invalid range. It is
# scoped to sed alone so that rg, awk, sort and wc keep the caller's locale.
flat_scrollback() {
  local raw flat
  raw=$("$cs_bin" terminal scrollback --tab-name="$tab" 2>/dev/null) || {
    echo "cs terminal scrollback failed for $tab (exit $?)" >&2
    return 1
  }
  flat=$(LC_ALL=C sed -E $'s|\x1b\\[[0-?]*[ -/]*[@-~]||g' <<<"$raw" | tr -d '\r\n') || {
    echo "stripping ANSI escapes from the $tab scrollback failed (exit $?)" >&2
    return 1
  }
  printf '%s' "$flat"
}

flat_contains() {
  local flat
  flat=$(flat_scrollback) || fail "cannot read the scrollback for $tab"
  rg -a -F -q -e "$1" <<<"$flat"
}

wait_for_flat() {
  local needle=$1
  local deadline=$((SECONDS + timeout_secs))
  until flat_contains "$needle"; do
    if ((SECONDS >= deadline)); then
      fail "timed out waiting for '$needle' in $tab"
    fi
    sleep 0.1
  done
}

wait_for_flat_for() {
  local needle=$1 seconds=$2
  local deadline=$((SECONDS + seconds))
  until flat_contains "$needle"; do
    ((SECONDS < deadline)) || return 1
    sleep 0.1
  done
}

wait_for_session() {
  local deadline=$((SECONDS + timeout_secs))
  until "$cs_bin" terminal scrollback --tab-name="$tab" >/dev/null 2>&1; do
    if ((SECONDS >= deadline)); then
      fail "timed out waiting for terminal session $tab"
    fi
    sleep 0.1
  done
}

# Pending logical messages for this tab. `cs terminal list --json` reports the
# same count the SPA queue badge shows.
queue_depth() {
  "$cs_bin" terminal list --json 2>/dev/null | python3 -c '
import json, sys
want = sys.argv[1]
try:
    groups = json.load(sys.stdin).get("groups", {})
except ValueError:
    print("-1")
    sys.exit(0)
for sessions in groups.values():
    for session in sessions:
        if session.get("name") == want:
            print(session.get("queue_depth", -1))
            sys.exit(0)
print("-1")
' "$tab"
}

require_depth() {
  local want=$1 now
  now=$(queue_depth)
  [[ $now == "$want" ]] || fail "expected queue depth $want, got $now"
}

wait_for_depth() {
  local want=$1
  local deadline=$((SECONDS + timeout_secs))
  until [[ $(queue_depth) == "$want" ]]; do
    if ((SECONDS >= deadline)); then
      fail "timed out waiting for queue depth $want (now $(queue_depth))"
    fi
    sleep 0.05
  done
}

# Sample the depth until it reaches 0 and print the observed sequence, one
# sample per line. Sampling can only FALSIFY a drain shape, never prove one:
# every case below states which shape it falsifies, and every result row
# carries the run-length-encoded trace so a sparse sample is visible instead of
# implied.
sample_depth_to_zero() {
  local deadline=$((SECONDS + timeout_secs))
  local depth
  while :; do
    depth=$(queue_depth)
    ((depth >= 0)) || fail "queue depth lookup failed for $tab (got $depth)"
    printf '%s\n' "$depth"
    [[ $depth == 0 ]] && return 0
    if ((SECONDS >= deadline)); then
      fail "timed out sampling queue depth (now $depth)"
    fi
    sleep 0.05
  done
}

# Run-length encode a trace for the result row: "5x87:0x1" is 87 samples at
# depth 5 followed by one at 0.
compact_trace() {
  awk 'NR == 1 { prev = $1; n = 1; next }
       $1 == prev { n++; next }
       { printf "%s%sx%d", sep, prev, n; sep = ":"; prev = $1; n = 1 }
       END { printf "%s%sx%d\n", sep, prev, n }'
}

# Which depths in 1..total-1 the trace never contains. Messages that each end
# the batch prefix leave the queue one at a time, so every level between the
# enqueued count and 0 has to be observed, and the 800 ms idle gate between
# deliveries against the 50 ms poll interval is what makes each level
# observable. Asking only whether SOME intermediate sample exists would also
# accept a partial batch: an Override boundary that let messages 3, 4 and 5
# batch traces 5 -> 4 -> 3 -> 0, which has intermediate samples and is still
# the exact regression the boundaries case exists to catch.
missing_depth_levels() {
  local total=$1 trace=$2 level depth seen missing=""
  for ((level = total - 1; level >= 1; level--)); do
    seen=no
    for depth in $trace; do
      if ((depth == level)); then
        seen=yes
        break
      fi
    done
    [[ $seen == yes ]] || missing+="${missing:+ }$level"
  done
  printf '%s' "$missing"
}

# How many samples of the trace landed strictly between 0 and the enqueued
# count, i.e. how often the queue was caught PART WAY through draining.
intermediate_samples() {
  local total=$1 trace=$2 depth count=0
  for depth in $trace; do
    if ((depth > 0 && depth < total)); then
      count=$((count + 1))
    fi
  done
  printf '%s' "$count"
}

paste_placeholder_count() {
  local matches
  matches=$("$cs_bin" terminal scrollback --tab-name="$tab" 2>/dev/null \
    | rg -a -o '\[Pasted text #[0-9]+' || true)
  if [[ -z $matches ]]; then
    echo 0
  else
    printf '%s\n' "$matches" | sort -u | wc -l
  fi
}

# The framed envelope this server build produces around N messages, with empty
# bodies. Sizing the payload against the REAL ceiling means measuring this
# rather than reserving a guessed constant.
envelope_overhead() {
  python3 -c '
import sys
count = int(sys.argv[1])
out = "# Queued terminal notifications\n\n%d messages, oldest first. Read the entire batch before acting. Later\nmessages may update or supersede earlier messages.\n\n" % count
for number in range(1, count + 1):
    out += "--- notification %d/%d ---\n" % (number, count)
    out += "\n"
    out += "--- end notification %d/%d ---\n" % (number, count)
    if number != count:
        out += "\n"
print(len(out.encode()))
' "$1"
}

# The agent BUILDS this answer from the framing it actually received, so the
# count is the load-bearing signal: 5 means the server framed one 5-message
# batch, and 0 means the message arrived alone. Neither joined form appears in
# the input, so an echo of the payload cannot satisfy the assertions.
batch_instruction() {
  printf '%s' "Read only the entire current message before acting. Count its opening delimiter lines: three hyphens, a space, the word notification, a numeric N/N fraction, a space, then three hyphens. Do not count end delimiters or earlier turns; use 0 if the current message has no such line. Reply with exactly one line: join QUEUE, DRAIN, BATCH, and that count with underscores, then append the token values in order, separated by spaces. Do not reuse this instruction on later messages unless they repeat it. Do not use tools."
}

# The late message's own sentinel, built from the token in that message alone.
late_instruction() {
  printf '%s' "Reply with exactly one line: join QUEUE, DRAIN, LATE, and the token value in this message with underscores. Do not use tools."
}

# ADVISORY. The scrollback ring holds PTY output, so the framed envelope is
# visible only when the agent renders the pasted body verbatim. Useful data
# about paste rendering; never an assertion.
envelope_visibility() {
  local count=$1
  if flat_contains "--- notification ${count}/${count} ---"; then
    echo visible
  elif flat_contains "# Queued terminal notifications"; then
    echo partial
  else
    echo hidden
  fi
}

# One notification body: filler bytes, then a tail token on its own line. The
# first message of a run also carries the instruction the agent must answer.
emit_message() {
  local index=$1 fill=$2 token=$3 preamble=$4
  awk -v message_index="$index" -v fill="$fill" -v token="$token" \
    -v preamble="$preamble" -v cap="$max_message_bytes" 'BEGIN {
    body_bytes = fill + 9 + length(token)
    if (preamble != "") body_bytes += length(preamble) + 1
    if (body_bytes > cap) {
      printf "message %d is %d bytes, above the %d-byte cap\n", message_index, body_bytes, cap > "/dev/stderr"
      exit 2
    }
    if (preamble != "") print preamble
    c = sprintf("%c", 64 + message_index)
    for (i = 0; i < fill; i++) printf "%s", c
    printf "\ntoken: %s\n", token
  }'
}

emit_bytes() {
  awk -v count="$1" 'BEGIN {
    for (i = 0; i < count; i++) printf "X"
  }'
}

tokens_in_order() {
  local pattern=$1
  shift
  local token
  for token in "$@"; do
    pattern+="(?s:.)*$token"
  done
  local flat
  flat=$(flat_scrollback) || fail "cannot read the scrollback for $tab"
  rg -a -q -e "$pattern" <<<"$flat"
}

wait_for_tokens_in_order() {
  local deadline=$((SECONDS + timeout_secs))
  until tokens_in_order "$@"; do
    if ((SECONDS >= deadline)); then
      fail "timed out waiting for '$*' in order in $tab"
    fi
    sleep 0.1
  done
}

# Fail on any forbidden agent-built block count. The sentinel is the agent's
# OUTPUT, so this cannot be satisfied by an echo of the payload, and it CAN
# fail: a regression that batches differently makes the agent count
# differently.
forbid_batch_counts() {
  local why=$1 count
  shift
  for count in "$@"; do
    if flat_contains "QUEUE_DRAIN_BATCH_${count}"; then
      fail "the agent answered a ${count}-block turn: $why"
    fi
  done
}

# A fresh tab per run keeps every scrollback assertion scoped to its own run.
start_terminal() {
  local run=$1 probe_case=$2
  local probe_group="${group}-${probe_case}-${run}"
  local team_dir="${probe_root}/${probe_case}-${run}"
  tab="QueueDrain-${agent}-${stamp}-${probe_case}-${run}"
  created_groups+=("$probe_group")
  [[ $launch != *"'"* ]] || fail "agent launch cannot be represented in the probe TOML"
  printf '%s\n' \
    "team_name = \"$probe_group\"" \
    'host_name = "Queue Drain"' \
    'host_handle = "@@QueueDrainHost"' \
    "tab_group = \"$probe_group\"" \
    'auto_prefix_at = false' \
    'mcp_env = false' \
    '' \
    '[[members]]' \
    "handle = \"$tab\"" \
    "command = '$launch'" \
    'is_lead = true' \
    | "$cs_bin" terminal team new "$team_dir" --stdin --window "$CHAN_WINDOW_ID" >/dev/null
  wait_for_session
  wait_for_flat "$ready_pattern"
}

# Make the agent generate for long enough that the notifications below are
# provably enqueued against a BUSY agent. The start marker is BUILT by the
# agent, so it cannot be satisfied by the echo of this instruction.
warmup_until_busy() {
  local run=$1
  "$cs_bin" terminal write --submit="$agent" --tab-name="$tab" \
    "Without using tools: first print one line joining WARMUP, START, $run, and $$ with underscores, then count from 1 to 400 with one number per line, then print one line joining WARMUP, DONE, $run, and $$ with underscores. Each joined line must contain exactly three underscores; do not omit the underscore immediately before $run." >/dev/null
  wait_for_flat "WARMUP_START_${run}_$$"
}

instruction=$(batch_instruction)
agent_version=$("$agent" --version 2>&1)
echo "starting $agent probe version=$agent_version group=$group case=$case_name size=${size_kib}KiB gap=${gap_ms}ms runs=$runs" >&2

# Every byte of the framed batch is accounted for: the measured envelope, the
# instruction the first message carries, one "token: <token>" line per message,
# and a small rounding margin. Nothing here is a guessed headroom, so a wording
# change moves the filler instead of silently pushing a notification out.
target_bytes=$((size_kib * 1024))
((target_bytes <= max_batch_bytes)) || target_bytes=$max_batch_bytes
overhead=$(envelope_overhead 5)
instruction_bytes=$(( ${#instruction} + 1 ))
token_line_bytes=$((5 * 48))
margin=64
budget=$((target_bytes - overhead - instruction_bytes - token_line_bytes - margin))
((budget > 0)) || fail "size ${size_kib}KiB leaves no room for five bodies (envelope ${overhead}B)"
filler_bytes=$((budget / 5))
first_message_filler_cap=$((max_message_bytes - instruction_bytes - 48))
((first_message_filler_cap > 0)) || fail "batch instruction leaves no room under the ${max_message_bytes}B message cap"
((filler_bytes <= first_message_filler_cap)) || filler_bytes=$first_message_filler_cap
((filler_bytes > 0)) || filler_bytes=1
echo "payload: batch_ceiling=${max_batch_bytes}B message_cap=${max_message_bytes}B target=${target_bytes}B envelope=${overhead}B instruction=${instruction_bytes}B filler=${filler_bytes}B/message" >&2

run_batch_case() {
  local run=$1
  local tokens=("a${run}x$$" "b${run}x$$" "c${run}x$$" "d${run}x$$" "e${run}x$$")
  local index token preamble trace placeholder=no

  start_terminal "$run" batch
  warmup_until_busy "$run"
  for ((index = 1; index <= 5; index++)); do
    token=${tokens[index - 1]}
    preamble=""
    if ((index == 1)); then
      preamble=$instruction
    fi
    emit_message "$index" "$filler_bytes" "$token" "$preamble" \
      | "$cs_bin" terminal write --stdin --submit="$agent" --tab-name="$tab" >/dev/null
  done
  # Nothing may reach a busy compose box: all five must still be pending.
  require_depth 5

  # Depth was 5 one call ago, so ANY later sample in 1..4 proves the five
  # drained per message rather than as one prefix.
  trace=$(sample_depth_to_zero)
  if (($(intermediate_samples 5 "$trace") > 0)); then
    fail "depth stepped through 1..4 ($(printf '%s\n' "$trace" | compact_trace)); the batch drained per message"
  fi

  # The agent counted 5 notification blocks and answered all five in one line.
  wait_for_tokens_in_order 'QUEUE_DRAIN_BATCH_5' "${tokens[@]}"
  forbid_batch_counts "the five notifications did not arrive as one batch" 0 1 2 3 4

  if (($(paste_placeholder_count) > 0)); then
    placeholder=yes
  fi
  printf 'agent=%s case=batch run=%d size_kib=%d gap_ms=%d sentinel=QUEUE_DRAIN_BATCH_5 tokens=ok depth_trace=%s envelope=%s paste_placeholder=%s\n' \
    "$agent" "$run" "$size_kib" "$gap_ms" \
    "$(printf '%s\n' "$trace" | compact_trace)" "$(envelope_visibility 5)" "$placeholder"
}

# Measure whether the first CR in a Gemini body/chord sequence submits or is
# converted into Shift+Enter. On a miss, a later bare CR is the control: if it
# produces the requested sentinel, the first CR retained the body as a draft
# rather than submitting it. A fresh server process is required for each
# --gap value because the controller reads the gap once at startup.
run_gap_case() {
  local run=$1
  local sentinel="GAP_OK_${run}_$$"
  local probe_instruction probe_bytes probe_filler probe_target_bytes
  [[ $agent == gemini ]] || fail "the gap case is specific to gemini"

  start_terminal "$run" gap
  probe_instruction="Reply with exactly one line built by joining GAP, OK, $run, and $$ with underscores. Use exactly three underscores, including one immediately before $run. Do not use tools."
  probe_bytes=${#probe_instruction}
  probe_target_bytes=$target_bytes
  ((probe_target_bytes <= max_message_bytes)) || probe_target_bytes=$max_message_bytes
  probe_filler=$((probe_target_bytes - probe_bytes - 1))
  ((probe_filler >= 0)) || fail "size ${size_kib}KiB is too small for the gap instruction"
  awk -v instruction="$probe_instruction" -v fill="$probe_filler" 'BEGIN {
    print instruction
    for (i = 0; i < fill; i++) printf "G"
  }' | "$cs_bin" terminal write --stdin --submit="$agent" --tab-name="$tab" >/dev/null
  if wait_for_flat_for "$sentinel" 15; then
    printf 'agent=%s case=gap run=%d size_kib=%d gap_ms=%d first_cr=submitted recovery=not_needed\n' \
      "$agent" "$run" "$size_kib" "$gap_ms"
    return
  fi

  "$cs_bin" terminal write --tab-name="$tab" $'\r' >/dev/null
  wait_for_flat "$sentinel" \
    || fail "the delayed recovery CR did not submit the retained draft"
  printf 'agent=%s case=gap run=%d size_kib=%d gap_ms=%d first_cr=shift_enter recovery=separate_cr\n' \
    "$agent" "$run" "$size_kib" "$gap_ms"
}

run_boundaries_case() {
  local run=$1
  # Every neighbour is a boundary: submitted, raw, submitted, raw,
  # submitted. Nothing may batch, and nothing may be skipped to reach a later
  # batchable message, so the tokens must still arrive in FIFO order.
  local tokens=("p${run}x$$" "q${run}x$$" "r${run}x$$" "s${run}x$$" "t${run}x$$")
  local trace missing

  start_terminal "$run" boundaries
  warmup_until_busy "$run"
  emit_message 1 32 "${tokens[0]}" "$instruction" \
    | "$cs_bin" terminal write --stdin --submit="$agent" --tab-name="$tab" >/dev/null
  # A no-submit write parks in the compose box: it is a boundary AND it must
  # not be reordered behind the submitted messages around it.
  emit_message 2 32 "${tokens[1]}" "" \
    | "$cs_bin" terminal write --stdin --tab-name="$tab" >/dev/null
  emit_message 3 32 "${tokens[2]}" "" \
    | "$cs_bin" terminal write --stdin --submit="$agent" --tab-name="$tab" >/dev/null
  # A second raw write proves the later submitted pair cannot batch past the
  # same no-submit boundary.
  emit_message 4 32 "${tokens[3]}" "" \
    | "$cs_bin" terminal write --stdin --tab-name="$tab" >/dev/null
  emit_message 5 32 "${tokens[4]}" "" \
    | "$cs_bin" terminal write --stdin --submit="$agent" --tab-name="$tab" >/dev/null

  require_depth 5
  # Boundary-separated messages drain ONE AT A TIME, so the poller has to
  # catch the queue at all four intermediate depths. A missing level is a
  # prefix that spanned a boundary, whether it swallowed the whole queue in
  # one step or only part of it.
  trace=$(sample_depth_to_zero)
  missing=$(missing_depth_levels 5 "$trace")
  [[ -z $missing ]] \
    || fail "depth never reached $missing ($(printf '%s\n' "$trace" | compact_trace)); messages were batched across a boundary"
  # These bodies are 32 bytes, small enough that both agents render them
  # inline, so the ordered tokens read the echoed input: a delivery-order
  # check, not a batching oracle. Waiting for it first also means every
  # message has landed before the batch-count check below reads scrollback.
  wait_for_tokens_in_order "${tokens[@]}"
  # A wrongly batched prefix makes the agent count blocks and answer
  # QUEUE_DRAIN_BATCH_2..5; correct behavior gives it one message at a time.
  forbid_batch_counts "messages separated by boundaries were framed together" 2 3 4 5

  printf 'agent=%s case=boundaries run=%d order=ok depth_trace=%s envelope=%s\n' \
    "$agent" "$run" "$(printf '%s\n' "$trace" | compact_trace)" "$(envelope_visibility 5)"
}

run_late_case() {
  local run=$1
  local tokens=("f${run}x$$" "g${run}x$$" "h${run}x$$" "i${run}x$$" "j${run}x$$")
  local late="k${run}x$$"
  local index token preamble trace

  start_terminal "$run" late
  warmup_until_busy "$run"
  for ((index = 1; index <= 5; index++)); do
    token=${tokens[index - 1]}
    preamble=""
    if ((index == 1)); then
      preamble=$instruction
    fi
    emit_message "$index" 32 "$token" "$preamble" \
      | "$cs_bin" terminal write --stdin --submit="$agent" --tab-name="$tab" >/dev/null
  done
  require_depth 5
  trace=$(sample_depth_to_zero)
  if (($(intermediate_samples 5 "$trace") > 0)); then
    fail "depth stepped through 1..4 ($(printf '%s\n' "$trace" | compact_trace)); the batch drained per message"
  fi

  # The batch has left the queue and the agent is answering it. The sixth
  # message therefore CANNOT join it, which is why no `6/6` assertion appears
  # here: it could not fail. What this proves instead is that the queue keeps
  # draining after a batch delivery and hands the late message its own turn,
  # with its own agent-built sentinel. The unreachable
  # enqueued-after-selection race is pinned by the chan-library unit test named
  # at the top of this file.
  emit_message 6 32 "$late" "$(late_instruction)" \
    | "$cs_bin" terminal write --stdin --submit="$agent" --tab-name="$tab" >/dev/null
  wait_for_depth 0
  wait_for_tokens_in_order 'QUEUE_DRAIN_BATCH_5' "${tokens[@]}" "QUEUE_DRAIN_LATE_${late}"

  printf 'agent=%s case=late run=%d sentinel=QUEUE_DRAIN_BATCH_5 late_sentinel=QUEUE_DRAIN_LATE_%s depth_trace=%s envelope=%s\n' \
    "$agent" "$run" "$late" "$(printf '%s\n' "$trace" | compact_trace)" "$(envelope_visibility 5)"
}

run_cap_case() {
  local run=$1
  local error

  start_terminal "$run" cap
  warmup_until_busy "$run"

  emit_bytes "$max_message_bytes" \
    | "$cs_bin" terminal write --stdin --tab-name="$tab" >/dev/null
  require_depth 1

  if error=$(emit_bytes "$((max_message_bytes + 1))" \
    | "$cs_bin" terminal write --stdin --tab-name="$tab" 2>&1 >/dev/null); then
    fail "a $((max_message_bytes + 1))-byte raw write exited 0"
  fi
  [[ $error == *"max ${max_message_bytes} bytes"* ]] \
    || fail "raw over-cap refusal lost the byte limit: $error"
  require_depth 1

  if error=$(emit_bytes "$((max_message_bytes + 1))" \
    | "$cs_bin" terminal write --stdin --submit="$agent" --tab-name="$tab" 2>&1 >/dev/null); then
    fail "a $((max_message_bytes + 1))-byte submitted write exited 0"
  fi
  [[ $error == *"max ${max_message_bytes} bytes"* ]] \
    || fail "submitted over-cap refusal lost the byte limit: $error"
  require_depth 1

  printf 'agent=%s case=cap run=%d accepted=%d refused=%d raw=ok submit=ok depth=1\n' \
    "$agent" "$run" "$max_message_bytes" "$((max_message_bytes + 1))"
}

for ((run = 1; run <= runs; run++)); do
  case "$case_name" in
    gap) run_gap_case "$run" ;;
    batch) run_batch_case "$run" ;;
    boundaries) run_boundaries_case "$run" ;;
    late) run_late_case "$run" ;;
    cap) run_cap_case "$run" ;;
    all)
      run_batch_case "$run"
      run_boundaries_case "$run"
      run_late_case "$run"
      run_cap_case "$run"
      ;;
  esac
done
