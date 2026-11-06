#!/usr/bin/env bash
# End-to-end proof of wireguard-agent, the gateway's proxy-host peer-sync
# agent, against a REAL kernel WireGuard interface on a Linux machine reached
# over SSH. The run creates its own interface there, serves the agent's
# peer list from a stand-in identity (a Python server speaking
# `GET /internal/v1/wireguard/peers?host=` from a JSON file, with the bearer
# check, the quoted ETag and 304), and runs the agent under the packaged
# unit's own sandbox: every [Service] hardening line of
# chan-gateway-wireguard-agent.service, as a transient systemd-run unit with
# a dynamic user, so the arms also prove that `wg` works under it. Every
# claim is read back from the interface's `wg show`.
#
# What it proves, one verdict line and exit status per arm:
#   add           a peer written into the list appears on the interface with
#                 its allowed IPs within two polls.
#   remove        the same peer removed from the list disappears from the
#                 interface within two polls.
#   operator      a peer the run added by hand with `wg set`, never in the
#                 list, is still on the interface with its allowed IPs after
#                 the add and remove arms, and the agent's journal never
#                 names it as removed.
#   unauthorized  when the stand-in starts refusing the agent's bearer, the
#                 agent exits with status 1 at its next poll.
#
# What it cannot prove: the real identity and profile behind the list
# (their tests and the lead's integration proof cover them), a desktop
# handshaking through the peers it adds, or a long-running agent's restarts
# under the packaged unit's Restart= policy.
#
# Usage:
#   wireguard-agent.sh [options] SSH_TARGET
#     SSH_TARGET          user@host of a Linux machine with kernel WireGuard
#   --ssh-opt OPT         an extra ssh and scp option, repeatable (-p 2204,
#                         -i KEY, ...; a `-p PORT` pair is passed to scp as -P)
#   --agent PATH          a built wireguard-agent-service for the target
#                         (default: build it from this tree's gateway workspace)
#   --interface NAME      the interface the run creates (default chanwgagent0;
#                         refused when it already exists)
#   --identity-port PORT  the stand-in identity's loopback port on the target
#                         (default 18404)
#   --poll SECS           the agent's WIREGUARD_AGENT_POLL_SECS (default 1)
#   --show-properties     print the systemd-run properties the run applies
#                         (read from the packaged unit) and exit
#
# Prerequisites. On the target: Linux with the wireguard module,
# wireguard-tools (`wg`), iproute2, python3, systemd (`systemd-run`,
# `systemctl`, `journalctl`) and passwordless sudo (`sudo -n`). On this host:
# ssh, scp, timeout, and cargo when --agent is not given. Exits 2
# when a prerequisite or an option's value is missing rather than passing.
#
# Everything the run makes on the target is removed as it exits: the
# transient unit, the interface, the installed binary, the env file, the
# state directory and the work dir. A target setup that fails part way
# removes what it made before it reports, since the host learns the work
# dir and the interface only from a finished setup, so the next run does
# not meet a leftover interface. The host work dir is deleted on success
# and kept on failure with the agent's journal and the stand-in's request
# log. The stand-in's bearer is a throwaway the target generates; it stays
# there and reaches the agent through a root-only EnvironmentFile, never a
# command line.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHA="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
UNIT_FILE="$REPO/gateway/crates/wireguard-agent/packaging/chan-gateway-wireguard-agent.service"
SSH_OPTS=()
SCP_OPTS=()
AGENT_BIN=""
IFACE=chanwgagent0
ID_PORT=18404
POLL=1
POSITIONAL=()
SHOW_PROPERTIES=""
TAG="chan-wgagent-$$-$RANDOM"
HOST_ID=p1

log() { printf 'wireguard-agent: %s\n' "$*" >&2; }
refuse() { log "cannot run: $*"; exit 2; }

while [ $# -gt 0 ]; do
    case "$1" in
        --ssh-opt | --agent | --interface | --identity-port | --poll)
            [ $# -ge 2 ] || refuse "$1 needs a value" ;;
    esac
    case "$1" in
        --ssh-opt)
            # ssh's -p is scp's -P, in each spelling: `-p` then the port,
            # `-pPORT` or `-p PORT` as one argument.
            SSH_OPTS+=("$2")
            case "$2" in
                -p) SCP_OPTS+=("-P") ;;
                "-p "*) SCP_OPTS+=("-P" "${2#-p }") ;;
                -p*) SCP_OPTS+=("-P" "${2#-p}") ;;
                *) SCP_OPTS+=("$2") ;;
            esac
            shift 2
            ;;
        --agent) AGENT_BIN="$2"; shift 2 ;;
        --interface) IFACE="$2"; shift 2 ;;
        --identity-port) ID_PORT="$2"; shift 2 ;;
        --poll) POLL="$2"; shift 2 ;;
        --show-properties) SHOW_PROPERTIES=1; shift ;;
        -h | --help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | cut -c3-; exit 0 ;;
        -*) refuse "unknown option $1" ;;
        *) POSITIONAL+=("$1"); shift ;;
    esac
done
[ -f "$UNIT_FILE" ] || refuse "no packaged unit at $UNIT_FILE"
# The packaged unit's sandbox, as systemd-run properties: every [Service]
# line but the ones naming the packaged user, files and restart policy,
# which the transient unit replaces with a dynamic user, its own state
# directory and env file, and no restart.
UNIT_PROPS=()
while IFS= read -r line; do
    UNIT_PROPS+=("-p" "$line")
done < <(awk '
    /^\[/ { section = $0; next }
    section == "[Service]" && /^[A-Za-z]+=/ {
        split($0, kv, "=")
        if (kv[1] ~ /^(Type|User|Group|EnvironmentFile|ExecStart|Restart|RestartSec|StateDirectory|StateDirectoryMode)$/) next
        print
    }' "$UNIT_FILE")
[ "${#UNIT_PROPS[@]}" -gt 0 ] || refuse "no [Service] hardening lines read from $UNIT_FILE"
if [ -n "$SHOW_PROPERTIES" ]; then
    printf '%s\n' -p DynamicUser=yes -p 'StateDirectory=<run tag>' -p 'EnvironmentFile=/run/<run tag>.env' "${UNIT_PROPS[@]}" \
        | paste -sd ' \n' -
    exit 0
fi

[ "${#POSITIONAL[@]}" -eq 1 ] || refuse "usage: wireguard-agent.sh [options] SSH_TARGET"
SSH_TARGET="${POSITIONAL[0]}"
case "$POLL" in '' | *[!0-9]*) refuse "--poll takes a number of seconds" ;; esac
[ "$POLL" -ge 1 ] && [ "$POLL" -le 60 ] || refuse "--poll must be 1 to 60"
case "$ID_PORT" in '' | *[!0-9]*) refuse "--identity-port takes a port number" ;; esac
case "$IFACE" in '' | -* | *[!A-Za-z0-9_.-]*) refuse "--interface $IFACE is not an interface name" ;; esac
case "$IFACE" in all | interfaces) refuse "--interface $IFACE is a word wg show reads, not an interface name" ;; esac
[ "${#IFACE}" -le 15 ] || refuse "--interface $IFACE is longer than 15 characters"

for tool in ssh scp timeout; do
    command -v "$tool" >/dev/null 2>&1 || refuse "$tool is not installed"
done
if [ -z "$AGENT_BIN" ]; then
    command -v cargo >/dev/null 2>&1 || refuse "cargo is not installed and --agent was not given"
    log "building wireguard-agent at $SHA"
    (cd "$REPO/gateway" && cargo build --locked -p wireguard-agent >/dev/null) \
        || refuse "cargo build -p wireguard-agent failed"
    AGENT_BIN="$REPO/gateway/target/debug/wireguard-agent-service"
fi
[ -x "$AGENT_BIN" ] || refuse "no agent binary at $AGENT_BIN"

peer() {
    # peer <command...>: run a command on the target, bounded.
    timeout 60 ssh -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "${SSH_OPTS[@]}" "$SSH_TARGET" -- "$@"
}
peer_script() {
    # peer_script <args...>: run the script on stdin on the target with the
    # arguments, each quoted so the remote shell splits them back.
    local args=""
    [ $# -eq 0 ] || args="$(printf ' %q' "$@")"
    timeout 60 ssh -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "${SSH_OPTS[@]}" "$SSH_TARGET" -- "bash -s --$args"
}

# Every prerequisite on the target is probed before anything is created.
if ! PROBE="$(peer 'sudo -n wg --version >/dev/null 2>&1 || echo no-wg; sudo -n ip -V >/dev/null 2>&1 || echo no-ip; command -v python3 >/dev/null 2>&1 || echo no-python3; command -v systemd-run >/dev/null 2>&1 || echo no-systemd-run; command -v journalctl >/dev/null 2>&1 || echo no-journalctl; sudo -n true 2>/dev/null || echo no-sudo; ip link show '"$IFACE"' >/dev/null 2>&1 && echo iface-exists; sudo -n modprobe wireguard 2>/dev/null || echo no-module; uname -sr' 2>&1)"; then
    refuse "ssh to $SSH_TARGET failed: $PROBE"
fi
for missing in no-wg no-ip no-python3 no-systemd-run no-journalctl no-sudo no-module; do
    case "$PROBE" in *"$missing"*) refuse "the target lacks ${missing#no-} (or sudo -n for it): $PROBE" ;; esac
done
case "$PROBE" in *iface-exists*) refuse "interface $IFACE already exists on the target; this run creates and deletes its own" ;; esac
PEER_KERNEL="$(printf '%s\n' "$PROBE" | tail -1)"

WORK="$(mktemp -d "${TMPDIR:-/var/tmp}/chan-wireguard-agent.XXXXXX")"
chmod 700 "$WORK"

PEER_WORK=""
IFACE_CREATED=""
UNIT_STARTED=""
INSTALLED=""
cleanup() {
    local status=$?
    if [ -n "$UNIT_STARTED" ]; then
        peer "sudo -n journalctl --no-pager -o short-monotonic -u $TAG.service" > "$WORK/agent.journal" 2>&1 || true
    fi
    if [ -n "$PEER_WORK" ]; then
        peer "cat $PEER_WORK/identity.log" > "$WORK/identity.log" 2>/dev/null || true
    fi
    if [ -n "$PEER_WORK" ] || [ -n "$IFACE_CREATED" ] || [ -n "$UNIT_STARTED" ] || [ -n "$INSTALLED" ]; then
        peer_script "$PEER_WORK" "$IFACE_CREATED" "$UNIT_STARTED" "$INSTALLED" "$TAG" <<'PEER' >/dev/null 2>&1 || log "target cleanup did not finish; check $SSH_TARGET for unit $TAG, interface $IFACE, /usr/local/lib/$TAG and $PEER_WORK"
work="$1"; iface="$2"; unit="$3"; installed="$4"; tag="$5"
if [ -n "$unit" ]; then
    sudo -n systemctl stop "$tag.service" 2>/dev/null || true
    sudo -n systemctl reset-failed "$tag.service" 2>/dev/null || true
fi
if [ -n "$work" ] && [ -f "$work/identity.pid" ]; then kill "$(cat "$work/identity.pid")" 2>/dev/null || true; fi
[ -n "$iface" ] && sudo -n ip link del "$iface" 2>/dev/null || true
if [ -n "$installed" ]; then
    sudo -n rm -rf -- "/usr/local/lib/$tag" "/run/$tag.env" "/var/lib/private/$tag" "/var/lib/$tag"
fi
if [ -n "$work" ] && [ -f "$work/.chan-wireguard-agent" ]; then rm -rf -- "${work:?}"; fi
PEER
    fi
    if [ "$status" = 0 ]; then
        rm -rf -- "$WORK"
    else
        log "work dir kept at $WORK (agent.journal, identity.log)"
    fi
}
trap cleanup EXIT

FAILED=0
verdict() {
    # verdict <arm> <rc> <detail>: one line per arm, with the arm's own status.
    local arm="$1" rc="$2"; shift 2
    if [ "$rc" = 0 ]; then
        printf 'wireguard-agent: %s rc=0 PASS %s\n' "$arm" "$*"
    else
        printf 'wireguard-agent: %s rc=%s FAIL %s\n' "$arm" "$rc" "$*"
        FAILED=$((FAILED + 1))
    fi
}
wait_for() {
    # wait_for <seconds> <description> <command...>: poll until the command
    # succeeds; returns 1 at the bound instead of exiting, so an arm can
    # record the miss as its own failure.
    local secs="$1" what="$2"; shift 2
    local deadline=$((SECONDS + secs))
    until "$@"; do
        if [ "$SECONDS" -ge "$deadline" ]; then
            log "timed out after ${secs}s waiting for $what"
            return 1
        fi
        sleep 0.5
    done
}

log "work dir $WORK, agent $AGENT_BIN at $SHA, target $SSH_TARGET ($PEER_KERNEL), interface $IFACE, poll ${POLL}s, unit $TAG"

# 1. The work dir, the keys, the interface and the stand-in identity.
if ! SETUP="$(peer_script "$IFACE" "$ID_PORT" "$HOST_ID" <<'PEER'
set -euo pipefail
iface="$1"; port="$2"; host="$3"
umask 077
# A step that fails removes what the steps before it made: the host's
# cleanup learns the work dir and the interface only from a finished setup.
work=""
created=""
undo() {
    if [ -n "$work" ] && [ -f "$work/identity.pid" ]; then kill "$(cat "$work/identity.pid")" 2>/dev/null || true; fi
    if [ -n "$created" ]; then sudo -n ip link del "$iface" 2>/dev/null || true; fi
    if [ -n "$work" ]; then rm -rf -- "$work"; fi
}
trap undo EXIT
trap 'exit 1' HUP INT TERM
work="$(mktemp -d /tmp/chan-wireguard-agent.XXXXXX)"
touch "$work/.chan-wireguard-agent"
echo "work=$work"
wg genkey > "$work/iface.key"
echo "peer_pub=$(wg genkey | wg pubkey)"
echo "operator_pub=$(wg genkey | wg pubkey)"
sudo -n ip link add "$iface" type wireguard
created=1
echo "iface=$iface"
sudo -n wg set "$iface" private-key "$work/iface.key"
sudo -n ip link set "$iface" up
cat > "$work/identity.py" <<'PY'
# The stand-in identity: GET /internal/v1/wireguard/peers?host= behind the
# bearer in `token`, serving `peers.json` ({"KEY": ["CIDR", ...]}) as the
# gateway's body with the quoted hex SHA-256 ETag and 304 on a match.
import hashlib, http.server, json, os, sys, urllib.parse
work, port, host = sys.argv[1], int(sys.argv[2]), sys.argv[3]
def read(name):
    with open(os.path.join(work, name)) as f:
        return f.read()
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(url.query)
        if url.path != "/internal/v1/wireguard/peers":
            return self.answer(404)
        if self.headers.get("Authorization") != "Bearer " + read("token").strip():
            return self.answer(401)
        if query.get("host") != [host]:
            return self.answer(400)
        peers = json.loads(read("peers.json"))
        body = json.dumps({"host": host, "peers": [
            {"public_key": k, "allowed_ips": peers[k]} for k in sorted(peers)
        ]}, separators=(",", ":")).encode()
        etag = '"' + hashlib.sha256(body).hexdigest() + '"'
        if self.headers.get("If-None-Match") == etag:
            return self.answer(304, etag=etag)
        self.answer(200, body, etag)
    def answer(self, status, body=b"", etag=None):
        self.send_response(status)
        if etag:
            self.send_header("ETag", etag)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, fmt, *args):
        with open(os.path.join(work, "identity.log"), "a") as f:
            f.write("%s %s\n" % (self.log_date_time_string(), fmt % args))
http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
PY
printf '{}\n' > "$work/peers.json"
# The stand-in's bearer: a throwaway made here, which never leaves this
# machine or enters an argv.
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$work/token"
setsid nohup python3 "$work/identity.py" "$work" "$port" "$host" </dev/null >"$work/identity.out" 2>&1 &
echo $! > "$work/identity.pid"
for _ in $(seq 50); do
    ss -ltn 2>/dev/null | grep -q "127.0.0.1:$port " && break
    sleep 0.2
done
ss -ltn 2>/dev/null | grep -q "127.0.0.1:$port " || { echo "the stand-in identity did not bind 127.0.0.1:$port: $(cat "$work/identity.out")" >&2; exit 1; }
trap - EXIT HUP INT TERM
PEER
)"; then
    refuse "setting up the target failed: $SETUP"
fi
setup_field() { printf '%s\n' "$SETUP" | sed -n "s/^$1=//p"; }
PEER_WORK="$(setup_field work)"
IFACE_CREATED="$(setup_field iface)"
PEER_PUB="$(setup_field peer_pub)"
OPERATOR_PUB="$(setup_field operator_pub)"
[ -n "$PEER_WORK" ] && [ -n "$IFACE_CREATED" ] && [ -n "$PEER_PUB" ] && [ -n "$OPERATOR_PUB" ] \
    || refuse "the target setup did not report its work dir, interface and keys: $SETUP"
echo "$SETUP" > "$WORK/setup.txt"

# 2. The agent: installed where the sandbox can read it, its env file
# written as root from the target's own token, and started as a transient
# unit under the packaged unit's hardening with a dynamic user.
scp -q -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "${SCP_OPTS[@]}" \
    "$AGENT_BIN" "$SSH_TARGET:$PEER_WORK/wireguard-agent-service" \
    || refuse "copying the agent to $SSH_TARGET failed"
INSTALLED=1
if ! START="$(peer_script "$PEER_WORK" "$TAG" "$IFACE" "$ID_PORT" "$HOST_ID" "$POLL" "${UNIT_PROPS[@]}" <<'PEER'
set -euo pipefail
work="$1"; tag="$2"; iface="$3"; port="$4"; host="$5"; poll="$6"; shift 6
sudo -n install -D -m 0755 "$work/wireguard-agent-service" "/usr/local/lib/$tag/wireguard-agent-service"
sudo -n install -m 0600 /dev/null "/run/$tag.env"
{
    echo "IDENTITY_URL=http://127.0.0.1:$port"
    echo "WIREGUARD_AGENT_TOKEN=$(cat "$work/token")"
    echo "WIREGUARD_AGENT_HOST_ID=$host"
    echo "WIREGUARD_INTERFACE=$iface"
    echo "WIREGUARD_AGENT_POLL_SECS=$poll"
    echo "RUST_LOG=info"
} | sudo -n tee "/run/$tag.env" >/dev/null
sudo -n systemd-run --quiet --unit="$tag" \
    -p DynamicUser=yes -p "StateDirectory=$tag" -p "EnvironmentFile=/run/$tag.env" \
    "$@" "/usr/local/lib/$tag/wireguard-agent-service"
echo started
PEER
)"; then
    refuse "starting the agent on the target failed: $START"
fi
UNIT_STARTED=1
log "agent started as $TAG.service under ${#UNIT_PROPS[@]} hardening arguments from $(basename "$UNIT_FILE")"

# Helpers that read the interface and steer the stand-in.
# A peer's allowed IPs, sorted, so the kernel's print order does not matter.
allowed_ips_of() {
    peer "sudo -n wg show $IFACE allowed-ips" \
        | awk -v k="$1" '$1 == k { for (i = 2; i <= NF; i++) print $i }' | LC_ALL=C sort | paste -sd ' ' -
}
has_peer_with() {
    local want
    read -ra want <<<"$2"
    [ "$(allowed_ips_of "$1")" = "$(printf '%s\n' "${want[@]}" | LC_ALL=C sort | paste -sd ' ' -)" ]
}
# Absent only when `wg show` answered: a failed read is not an absence.
lacks_peer() {
    local peers
    peers="$(peer "sudo -n wg show $IFACE peers")" || return 1
    ! grep -qxF "$1" <<<"$peers"
}
set_list() { peer "cat > $PEER_WORK/peers.json.tmp && mv $PEER_WORK/peers.json.tmp $PEER_WORK/peers.json" <<<"$1"; }
unit_ended_with_1() {
    local state
    state="$(peer "systemctl show -p ActiveState -p ExecMainStatus $TAG.service")"
    case "$state" in *ExecMainStatus=1*) ! grep -q 'ActiveState=active' <<<"$state" ;; *) return 1 ;; esac
}
TWO_POLLS=$((2 * POLL + 2))

# The agent is up when the stand-in has answered it at least once.
wait_for 30 "the agent's first poll" peer "grep -q 'GET /internal/v1/wireguard/peers' $PEER_WORK/identity.log" \
    || refuse "the agent never polled the stand-in identity"

# 3. The operator's own peer, outside the list.
peer "sudo -n wg set $IFACE peer $OPERATOR_PUB allowed-ips 10.77.0.9/32"

# add: the list gains a peer.
set_list "{\"$PEER_PUB\": [\"10.77.0.2/32\", \"fd00:77::2/128\"]}"
if wait_for "$TWO_POLLS" "the listed peer on $IFACE" has_peer_with "$PEER_PUB" "10.77.0.2/32 fd00:77::2/128"; then
    verdict add 0 "$PEER_PUB on $IFACE with $(allowed_ips_of "$PEER_PUB") within ${TWO_POLLS}s"
else
    verdict add 1 "$PEER_PUB not on $IFACE with its allowed IPs (has: '$(allowed_ips_of "$PEER_PUB")')"
fi

# remove: the list loses it.
set_list '{}'
if wait_for "$TWO_POLLS" "the unlisted peer gone from $IFACE" lacks_peer "$PEER_PUB"; then
    verdict remove 0 "$PEER_PUB gone from $IFACE within ${TWO_POLLS}s"
else
    verdict remove 1 "$PEER_PUB still on $IFACE"
fi

# operator: the hand-made peer survives both, a few polls later too.
sleep "$TWO_POLLS"
JOURNAL="$(peer "sudo -n journalctl --no-pager -u $TAG.service" 2>&1 || true)"
# The journal search is shown able to see a removal first: the listed
# peer's own removal must be in it.
if ! grep -F "$PEER_PUB" <<<"$JOURNAL" | grep -q 'removed peer'; then
    verdict operator 1 "the agent's journal holds no removal of the listed peer, so it cannot show the operator's peer was never removed"
elif ! has_peer_with "$OPERATOR_PUB" "10.77.0.9/32"; then
    verdict operator 1 "$OPERATOR_PUB changed or removed (has: '$(allowed_ips_of "$OPERATOR_PUB")')"
elif grep -F "$OPERATOR_PUB" <<<"$JOURNAL" | grep -q 'removed peer'; then
    verdict operator 1 "the journal names $OPERATOR_PUB as removed"
else
    verdict operator 0 "$OPERATOR_PUB still on $IFACE with 10.77.0.9/32; the journal, which shows the listed peer's removal, never names it removed"
fi

# unauthorized: the stand-in stops accepting the agent's bearer.
peer "head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > $PEER_WORK/token"
if wait_for "$((POLL + 10))" "the agent to exit on a 401" unit_ended_with_1; then
    verdict unauthorized 0 "the agent exited with status 1 after the stand-in answered 401"
else
    verdict unauthorized 1 "the agent did not exit with status 1: $(peer "systemctl show -p ActiveState -p ExecMainStatus $TAG.service" | tr '\n' ' ')"
fi

if [ "$FAILED" -gt 0 ]; then
    log "$FAILED arm(s) failed"
    exit 1
fi
log "all arms passed"
