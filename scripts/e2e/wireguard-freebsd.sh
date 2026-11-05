#!/usr/bin/env bash
# End-to-end proof of chan-wireguard, the in-process WireGuard client, as
# built for and run on FreeBSD, against a REAL kernel WireGuard peer on
# Linux. Both machines are reached over SSH from this host: the peer's `wg`
# and `ip` build an interface for the run, the crate's `wg-connect` example
# and a real `chan devserver run --tunnel-wireguard`, built on the FreeBSD
# client, dial it from there, and every claim is read back from the peer's
# `wg show` and its kernel journal. The suite exists beside
# wireguard-kernel.sh because that one runs the client on this host, which
# proves the Linux build; the FreeBSD build has its own clock, its own
# socket buffer limit and its own file mode semantics to prove.
#
# What it proves, one verdict line and exit status per arm:
#   wrong-key   a client file naming a wrong peer public key never completes
#               a handshake: the connect times out, the peer's handshake
#               stamp does not move, and the peer's journal shows the
#               initiations arrived and were dropped for their MAC (the
#               control that the positive arms are not vacuous).
#   get         an HTTP GET through the tunnel returns the peer's known
#               files byte for byte (a short text and a 1 MiB blob), and the
#               peer shows the handshake and the traffic.
#   rekey       a tunnel held idle past the protocol's 120 s rekey time,
#               then a GET and a short settle: the GET returns the file and
#               by the end exactly one fresh handshake has been made with
#               the kernel, which the client's status and the peer's stamp
#               both show, with no retry in the kernel journal. When the
#               handshake happens is not asserted: the core rekeys an idle
#               session at 120 s only when its first data packet carried a
#               later timer stamp than the handshake, and the data this
#               GET sends sets it off otherwise, so either lands inside
#               the window.
#   keepalive   with PersistentKeepalive the peer's receive counter grows
#               while nothing is connected, and no fresh handshake happens
#               inside the hold: a keepalive is not a data packet, so it
#               does not set off the rekey either.
#   devserver   `chan devserver run --tunnel-wireguard` on the client logs
#               the tunnel start and its h2 dial reaches a raw listener on the
#               peer's tunnel address with the HTTP/2 connection preface.
#               The dial then fails at the HTTP level, which is expected.
#   mode        a client file readable by the group or others is refused by
#               `chan devserver run` before anything starts, naming the
#               mode and the chmod that fixes it.
#   rcvbuf      the 4 MiB SO_RCVBUF hint the tunnel socket asks for meets
#               FreeBSD's kern.ipc.maxsockbuf: when the cap is below the
#               hint the kernel refuses it with ENOBUFS, the crate logs the
#               refusal at debug and the tunnel still comes up.
#
# What it cannot prove: a peer behind a real NAT or a changing address, a
# tunnel URL by name, anything the gateway answers past the preface, and a
# clock that keeps counting through a suspend (the guest never sleeps).
#
# Usage:
#   wireguard-freebsd.sh [options] PEER_SSH CLIENT_SSH ENDPOINT PEER_ADDRESS
#     PEER_SSH      user@host of the Linux kernel peer, provisioned over SSH
#     CLIENT_SSH    user@host of the FreeBSD client, where the binaries are
#     ENDPOINT      the peer's WireGuard UDP host:port as the CLIENT reaches it
#     PEER_ADDRESS  the peer's tunnel address with its prefix, e.g. 10.8.0.1/24
#   --chan PATH          the chan binary on the client (required)
#   --wg-connect PATH    the wg-connect example on the client (required)
#   --peer-ssh-opt OPT   an extra ssh option for the peer, repeatable
#   --client-ssh-opt OPT an extra ssh option for the client, repeatable
#   --client-address IP  the client's tunnel address (default: the peer's plus one)
#   --listen-port PORT   the peer's WireGuard listen port (default: ENDPOINT's)
#   --interface NAME     the peer interface the run creates (default chanwg1,
#                        so a wireguard-kernel.sh run on the same peer keeps
#                        its chanwg0; refused when it already exists)
#   --hold SECS          the rekey arm's idle hold (default 130, past the 120 s rekey)
#   --arms LIST          comma separated arms to run (default: all, in the order above)
#   --keep               keep the work dir on success too
#
# Prerequisites. On the peer: Linux with the wireguard module, wireguard-tools
# (`wg`), iproute2, python3 (serves the files and the raw listener), sha256sum,
# journalctl, a mounted debugfs (the run turns the module's debug prints on
# with `module wireguard +p`), and passwordless sudo (`sudo -n`); its firewall
# must admit the UDP port. On the client: FreeBSD, `timeout`, and the two
# binaries built there from the commit under test (`cargo build --release -p
# chan-wireguard --example wg-connect` and `cargo build --release -p chan`),
# since nothing here cross-compiles. On this host: ssh, python3, xxd and
# timeout. Exits 2 when a prerequisite is missing rather than passing.
#
# Everything runs under a per-run work dir on each of the three machines;
# the peer's and the client's are deleted on exit, this host's on success.
# The kept work dir holds the run's client files with a private key that is
# worthless once the peer interface is deleted, which the exit path does,
# but treat it as a credential until it is gone.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHA="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
PEER_SSH_OPTS=()
CLIENT_SSH_OPTS=()
CLIENT_CHAN=""
CLIENT_WG_CONNECT=""
CLIENT_IP=""
LISTEN_PORT=""
IFACE=chanwg1
HOLD=130
KEEPALIVE_HOLD=60
KEEP=0
ARMS="wrong-key,get,rekey,keepalive,devserver,mode,rcvbuf"
HTTP_PORT=8080
RAW_PORT=4443
# What the crate asks of the kernel for the tunnel socket's buffers
# (`SOCKET_BUFFER_HINT` in crates/chan-wireguard/src/tunnel.rs).
SOCKET_BUFFER_HINT=4194304
POSITIONAL=()

log() { printf 'wireguard-freebsd: %s\n' "$*" >&2; }
refuse() { log "cannot run: $*"; exit 2; }

while [ $# -gt 0 ]; do
    case "$1" in
        --chan) CLIENT_CHAN="$2"; shift 2 ;;
        --wg-connect) CLIENT_WG_CONNECT="$2"; shift 2 ;;
        --peer-ssh-opt) PEER_SSH_OPTS+=("$2"); shift 2 ;;
        --client-ssh-opt) CLIENT_SSH_OPTS+=("$2"); shift 2 ;;
        --client-address) CLIENT_IP="$2"; shift 2 ;;
        --listen-port) LISTEN_PORT="$2"; shift 2 ;;
        --interface) IFACE="$2"; shift 2 ;;
        --hold) HOLD="$2"; shift 2 ;;
        --arms) ARMS="$2"; shift 2 ;;
        --keep) KEEP=1; shift ;;
        -h | --help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | cut -c3-; exit 0 ;;
        -*) refuse "unknown option $1" ;;
        *) POSITIONAL+=("$1"); shift ;;
    esac
done
[ "${#POSITIONAL[@]}" -eq 4 ] || refuse "usage: wireguard-freebsd.sh [options] PEER_SSH CLIENT_SSH ENDPOINT PEER_ADDRESS"
PEER_SSH="${POSITIONAL[0]}"
CLIENT_SSH="${POSITIONAL[1]}"
ENDPOINT="${POSITIONAL[2]}"
PEER_CIDR="${POSITIONAL[3]}"
[ -n "$CLIENT_CHAN" ] || refuse "--chan PATH names the chan binary on the client"
[ -n "$CLIENT_WG_CONNECT" ] || refuse "--wg-connect PATH names the wg-connect example on the client"
case "$HOLD" in '' | *[!0-9]*) refuse "--hold takes a number of seconds" ;; esac
[ "$HOLD" -gt 120 ] || refuse "--hold must exceed the protocol's 120 s rekey time"

for tool in ssh python3 xxd timeout; do
    command -v "$tool" >/dev/null 2>&1 || refuse "$tool is not installed"
done

# The peer's address, its network (the client's AllowedIPs) and the client's
# default address all derive from PEER_ADDRESS.
PEER_IP="$(python3 -c 'import ipaddress,sys; print(ipaddress.ip_interface(sys.argv[1]).ip)' "$PEER_CIDR")" \
    || refuse "$PEER_CIDR is not an address with a prefix"
PEER_NET="$(python3 -c 'import ipaddress,sys; print(ipaddress.ip_interface(sys.argv[1]).network)' "$PEER_CIDR")"
[ -n "$CLIENT_IP" ] || CLIENT_IP="$(python3 -c 'import ipaddress,sys; print(ipaddress.ip_interface(sys.argv[1]).ip + 1)' "$PEER_CIDR")"
[ -n "$LISTEN_PORT" ] || LISTEN_PORT="${ENDPOINT##*:}"
case "$LISTEN_PORT" in '' | *[!0-9]*) refuse "no port in ENDPOINT $ENDPOINT" ;; esac

ssh_to() {
    # ssh_to <seconds> <target> <ssh options array name> <command...>: one
    # bounded, non-interactive ssh.
    local secs="$1" target="$2" opts_name="$3"
    shift 3
    local -n opts="$opts_name"
    timeout "$secs" ssh -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "${opts[@]}" "$target" -- "$@"
}
peer() { ssh_to 60 "$PEER_SSH" PEER_SSH_OPTS "$@"; }
client() { ssh_to 60 "$CLIENT_SSH" CLIENT_SSH_OPTS "$@"; }
quoted() {
    # quoted <args...>: the arguments as one string a remote POSIX shell
    # splits back into the same words. ssh joins its arguments into one
    # string the remote shell splits again, so each is quoted first or a pid
    # list would arrive as several arguments and shift the rest.
    local out="" arg
    for arg in "$@"; do out="$out '${arg//\'/\'\\\'\'}'"; done
    printf '%s' "$out"
}
peer_script() {
    # peer_script <args...>: the script on stdin, on the peer, with the
    # arguments.
    ssh_to 60 "$PEER_SSH" PEER_SSH_OPTS "bash -s --$(quoted "$@")"
}
client_script() {
    # client_script <args...>: the script on stdin, on the client, in its
    # POSIX sh (a FreeBSD guest has no bash unless someone installed one).
    ssh_to 60 "$CLIENT_SSH" CLIENT_SSH_OPTS "sh -s --$(quoted "$@")"
}

# Every prerequisite on both machines is probed before anything is created
# on either.
if ! PROBE="$(peer 'sudo -n wg --version >/dev/null 2>&1 || echo no-wg; sudo -n ip -V >/dev/null 2>&1 || echo no-ip; command -v python3 >/dev/null 2>&1 || echo no-python3; command -v sha256sum >/dev/null 2>&1 || echo no-sha256sum; command -v journalctl >/dev/null 2>&1 || echo no-journalctl; sudo -n test -w /sys/kernel/debug/dynamic_debug/control 2>/dev/null || echo no-dynamic-debug; sudo -n true 2>/dev/null || echo no-sudo; ip link show '"$IFACE"' >/dev/null 2>&1 && echo iface-exists; uname -sr' 2>&1)"; then
    refuse "ssh to the peer $PEER_SSH failed: $PROBE"
fi
for missing in no-wg no-ip no-python3 no-sha256sum no-journalctl no-dynamic-debug no-sudo; do
    case "$PROBE" in *"$missing"*) refuse "the peer lacks ${missing#no-} (or sudo -n for it): $PROBE" ;; esac
done
case "$PROBE" in *iface-exists*) refuse "interface $IFACE already exists on the peer; this run creates and deletes its own" ;; esac
PEER_KERNEL="$(printf '%s\n' "$PROBE" | tail -1)"

if ! CLIENT_PROBE="$(client "uname -sr; command -v timeout >/dev/null 2>&1 || echo no-timeout; command -v mktemp >/dev/null 2>&1 || echo no-mktemp; test -x $(quoted "$CLIENT_CHAN") || echo no-chan; test -x $(quoted "$CLIENT_WG_CONNECT") || echo no-wg-connect; sysctl -n kern.ipc.maxsockbuf 2>/dev/null || echo no-maxsockbuf" 2>&1)"; then
    refuse "ssh to the client $CLIENT_SSH failed: $CLIENT_PROBE"
fi
case "$CLIENT_PROBE" in FreeBSD*) ;; *) refuse "the client is not FreeBSD: $CLIENT_PROBE" ;; esac
for missing in no-timeout no-mktemp no-chan no-wg-connect no-maxsockbuf; do
    case "$CLIENT_PROBE" in *"$missing"*) refuse "the client lacks ${missing#no-}: $CLIENT_PROBE" ;; esac
done
CLIENT_KERNEL="$(printf '%s\n' "$CLIENT_PROBE" | head -1)"
CLIENT_MAXSOCKBUF="$(printf '%s\n' "$CLIENT_PROBE" | tail -1)"
case "$CLIENT_MAXSOCKBUF" in '' | *[!0-9]*) refuse "kern.ipc.maxsockbuf on the client is not a number: $CLIENT_PROBE" ;; esac
CLIENT_CHAN_VERSION="$(client "$(quoted "$CLIENT_CHAN") --version" 2>&1 | head -1 || echo unknown)"

WORK="$(mktemp -d "${TMPDIR:-/var/tmp}/chan-wireguard-freebsd.XXXXXX")"
chmod 700 "$WORK"

HOST_PIDS=()
PEER_WORK=""
PEER_PIDS=""
IFACE_CREATED=""
CLIENT_WORK=""
CLIENT_PIDS=""
cleanup() {
    local pid
    for pid in "${HOST_PIDS[@]:-}"; do
        [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    done
    sleep 0.5
    for pid in "${HOST_PIDS[@]:-}"; do
        [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
    done
    # Only what the run made on each machine: its processes by recorded
    # pid, the interface it created, and its work dir, identified by the
    # marker the run wrote into it.
    if [ -n "$CLIENT_WORK" ] || [ -n "$CLIENT_PIDS" ]; then
        client_script "$CLIENT_WORK" "$CLIENT_PIDS" <<'CLIENT' >/dev/null 2>&1 || log "client cleanup did not finish; check $CLIENT_SSH for $CLIENT_WORK"
work="$1"; pids="$2"
for pid in $pids; do kill "$pid" 2>/dev/null || true; done
if [ -n "$work" ] && [ -f "$work/.chan-wireguard-freebsd" ]; then rm -rf -- "${work:?}"; fi
CLIENT
    fi
    if [ -n "$PEER_WORK" ] || [ -n "$IFACE_CREATED" ]; then
        peer_script "$PEER_WORK" "$PEER_PIDS" "$IFACE_CREATED" <<'PEER' >/dev/null 2>&1 || log "peer cleanup did not finish; check $PEER_SSH for $IFACE and $PEER_WORK"
work="$1"; pids="$2"; iface="$3"
for pid in $pids; do kill "$pid" 2>/dev/null || true; done
[ -n "$iface" ] && sudo -n ip link del "$iface" 2>/dev/null || true
if [ -n "$work" ] && [ -f "$work/.chan-wireguard-freebsd" ]; then rm -rf -- "${work:?}"; fi
PEER
    fi
}
trap cleanup EXIT
trap 'log "aborted: the command at line $LINENO failed; work dir kept at $WORK"' ERR

FAILED=0
verdict() {
    # verdict <arm> <rc> <detail>: one line per arm, with the arm's own status.
    local arm="$1" rc="$2"; shift 2
    if [ "$rc" = 0 ]; then
        printf 'wireguard-freebsd: %s rc=0 PASS %s\n' "$arm" "$*"
    else
        printf 'wireguard-freebsd: %s rc=%s FAIL %s\n' "$arm" "$rc" "$*"
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
        sleep 1
    done
}
peer_handshake() { peer "sudo -n wg show $IFACE latest-handshakes" | cut -f2; }
peer_now() { peer "date +%s.%N"; }
peer_wg_show() { peer "sudo -n wg show $IFACE" | tee "$WORK/$1.wg-show" | sed 's/^/    /'; }
peer_journal() {
    # peer_journal <name> <since>: the kernel's lines about the interface
    # after the peer's own clock read <since>, kept and printed indented.
    # journalctl's --since is whole seconds, so the previous arm's last
    # lines can share the second; the lines are cut at <since> itself.
    peer "sudo -n journalctl -k --since @${2%.*} -o short-unix --no-pager 2>/dev/null | awk -v s='$2' '\$1 > s && /wireguard: $IFACE: / { \$1 = strftime(\"%Y-%m-%dT%H:%M:%SZ\", \$1, 1); print }'" > "$WORK/$1.journal"
    sed 's/^/    /' "$WORK/$1.journal" >&2
}

log "work dir $WORK, chan $SHA, peer $PEER_SSH ($PEER_KERNEL), client $CLIENT_SSH ($CLIENT_KERNEL, $CLIENT_CHAN_VERSION, kern.ipc.maxsockbuf $CLIENT_MAXSOCKBUF), endpoint $ENDPOINT, peer $PEER_CIDR, client $CLIENT_IP"

# 1. Keys, interface, debug prints and the served files on the peer. The
# client's private key is made by the peer's `wg genkey` and carried over
# SSH to the client, so the public key the crate derives from it can be
# checked against `wg pubkey`.
if ! SETUP="$(peer_script "$IFACE" "$LISTEN_PORT" "$PEER_CIDR" "$CLIENT_IP" "$PEER_IP" "$HTTP_PORT" <<'PEER'
set -euo pipefail
iface="$1"; port="$2"; peer_cidr="$3"; client_ip="$4"; peer_ip="$5"; http_port="$6"
umask 077
work="$(mktemp -d /tmp/chan-wireguard-freebsd.XXXXXX)"
touch "$work/.chan-wireguard-freebsd"
echo "work=$work"
wg genkey > "$work/server.key"
echo "server_pub=$(wg pubkey < "$work/server.key")"
client_key="$(wg genkey)"
echo "client_key=$client_key"
echo "client_pub=$(printf '%s\n' "$client_key" | wg pubkey)"
echo "wrong_pub=$(wg genkey | wg pubkey)"
sudo -n ip link add "$iface" type wireguard
echo "iface=$iface"
sudo -n wg set "$iface" listen-port "$port" private-key "$work/server.key" \
    peer "$(printf '%s\n' "$client_key" | wg pubkey)" allowed-ips "$client_ip/32"
sudo -n ip address add "$peer_cidr" dev "$iface"
sudo -n ip link set "$iface" up
# The module's debug prints name every handshake, keepalive and dropped
# datagram in the kernel journal; harmless when already on.
echo 'module wireguard +p' | sudo -n tee /sys/kernel/debug/dynamic_debug/control >/dev/null
mkdir "$work/www"
printf 'kernel peer %s says %s\n' "$(uname -r)" "$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" > "$work/www/hello.txt"
head -c 1048576 /dev/urandom > "$work/www/big.bin"
echo "hello_sha=$(sha256sum "$work/www/hello.txt" | cut -d' ' -f1)"
echo "big_sha=$(sha256sum "$work/www/big.bin" | cut -d' ' -f1)"
setsid nohup python3 -m http.server --bind "$peer_ip" "$http_port" --directory "$work/www" \
    </dev/null >"$work/http.log" 2>&1 &
echo "http_pid=$!"
# Poll the listening port, not the server's banner: a redirected stdout is
# block-buffered, so the "Serving HTTP" line may not flush for a while.
for _ in $(seq 50); do
    ss -ltn 2>/dev/null | grep -q "$peer_ip:$http_port " && break
    sleep 0.2
done
ss -ltn 2>/dev/null | grep -q "$peer_ip:$http_port " || { echo "http.server did not bind $peer_ip:$http_port: $(cat "$work/http.log")" >&2; exit 1; }
PEER
)"; then
    log "peer setup failed: $(printf '%s\n' "$SETUP" | grep -v '^client_key=')"
    PEER_WORK="$(printf '%s\n' "$SETUP" | sed -n 's/^work=//p')"
    IFACE_CREATED="$(printf '%s\n' "$SETUP" | sed -n 's/^iface=//p')"
    PEER_PIDS="$(printf '%s\n' "$SETUP" | sed -n 's/^http_pid=//p')"
    exit 1
fi
setup_field() { printf '%s\n' "$SETUP" | sed -n "s/^$1=//p"; }
PEER_WORK="$(setup_field work)"
IFACE_CREATED="$(setup_field iface)"
PEER_PIDS="$(setup_field http_pid)"
SERVER_PUB="$(setup_field server_pub)"
CLIENT_KEY="$(setup_field client_key)"
CLIENT_PUB="$(setup_field client_pub)"
WRONG_PUB="$(setup_field wrong_pub)"
HELLO_SHA="$(setup_field hello_sha)"
BIG_SHA="$(setup_field big_sha)"
[ -n "$PEER_WORK" ] && [ -n "$SERVER_PUB" ] && [ -n "$CLIENT_KEY" ] && [ -n "$HELLO_SHA" ] || { log "peer setup returned an incomplete record"; exit 1; }
log "peer interface $IFACE up at $PEER_CIDR, serving $PEER_IP:$HTTP_PORT; client public key $CLIENT_PUB"

# 2. The client files on the client, owner-only as the devserver demands,
# plus one copy the group can read for the mode arm. Each file's text goes
# over the ssh channel's stdin, so the key is never an argument a `ps` on
# the client could show.
CLIENT_WORK="$(client 'umask 077; d="$(mktemp -d /tmp/chan-wireguard-freebsd.XXXXXX)" && touch "$d/.chan-wireguard-freebsd" && echo "$d"')"
[ -n "$CLIENT_WORK" ] || { log "no work dir on the client"; exit 1; }
write_client_file() {
    # write_client_file <name> <peer public key> [extra peer lines...]
    local name="$1" pub="$2"; shift 2
    {
        printf '[Interface]\nPrivateKey = %s\nAddress = %s/32\n\n[Peer]\nPublicKey = %s\nEndpoint = %s\nAllowedIPs = %s\n' \
            "$CLIENT_KEY" "$CLIENT_IP" "$pub" "$ENDPOINT" "$PEER_NET"
        for line in "$@"; do printf '%s\n' "$line"; done
    } | client "umask 077 && cat > $(quoted "$CLIENT_WORK/$name")"
}
write_client_file client.conf "$SERVER_PUB"
write_client_file client-keepalive.conf "$SERVER_PUB" "PersistentKeepalive = 25"
write_client_file client-wrong-key.conf "$WRONG_PUB"
client "cp $(quoted "$CLIENT_WORK/client.conf" "$CLIENT_WORK/client-shared.conf") && chmod 644 $(quoted "$CLIENT_WORK/client-shared.conf")"
CLIENT_MODES="$(client "stat -f '%Sp %N' $(quoted "$CLIENT_WORK/client.conf" "$CLIENT_WORK/client-keepalive.conf" "$CLIENT_WORK/client-wrong-key.conf" "$CLIENT_WORK/client-shared.conf")")"
printf '%s\n' "$CLIENT_MODES" | sed 's/^/    /' >&2

runs() { case ",$ARMS," in *",$1,"*) return 0 ;; esac; return 1; }
body_sha() { sed -n "s/^body $2: [0-9]* bytes, sha256 \([0-9a-f]*\)$/\1/p" "$1"; }
run_example() {
    # run_example <log> <file> <args...>: the example on the client, bounded
    # there, its rc recorded in the log.
    local out="$1" file="$2"; shift 2
    ssh_to $((HOLD + 150)) "$CLIENT_SSH" CLIENT_SSH_OPTS \
        "timeout $((HOLD + 120)) $(quoted "$CLIENT_WG_CONNECT" "$CLIENT_WORK/$file" "$PEER_IP:$HTTP_PORT" "$@"); echo rc=\$?" > "$out" 2>&1 || true
    sed -n 's/^rc=//p' "$out" | tail -1
}

# wrong-key: the control. The peer's handshake stamp must not move, the
# connect must time out, and the peer's journal must show the initiations
# arriving and being dropped for their MAC (mac1 is keyed by the responder's
# public key, so a wrong one fails it), or the arm proves nothing.
if runs wrong-key; then
    before="$(peer_handshake)"; since="$(peer_now)"
    rc="$(run_example "$WORK/wrong-key.out" client-wrong-key.conf /hello.txt --timeout 15)"
    after="$(peer_handshake)"
    peer_journal wrong-key "$since"
    dropped="$(grep -c 'Invalid MAC of handshake' "$WORK/wrong-key.journal" || true)"
    arm_rc=0
    [ "$rc" = 2 ] && grep -q '^connect: timed out after 15s$' "$WORK/wrong-key.out" || arm_rc=1
    [ "$before" = "$after" ] || arm_rc=1
    [ "$dropped" -ge 2 ] || arm_rc=1
    verdict wrong-key "$arm_rc" "connect rc=$rc, peer handshake stamp $before -> $after, peer dropped $dropped initiation(s) for their MAC"
    [ "$arm_rc" = 0 ] || { cat "$WORK/wrong-key.out"; peer_wg_show wrong-key; } >&2
fi

# get: the known files, byte for byte, and the peer's view of the session.
if runs get; then
    before="$(peer_handshake)"; since="$(peer_now)"
    rc="$(run_example "$WORK/get.out" client.conf /hello.txt)"
    rc_big="$(run_example "$WORK/get-big.out" client.conf /big.bin)"
    after="$(peer_handshake)"
    arm_rc=0
    [ "$rc" = 0 ] && grep -q '^response 1: HTTP/1\.[01] 200 ' "$WORK/get.out" || arm_rc=1
    [ "$(body_sha "$WORK/get.out" 1)" = "$HELLO_SHA" ] || arm_rc=1
    grep -q "^tunnel: endpoint $ENDPOINT, public key $CLIENT_PUB," "$WORK/get.out" || arm_rc=1
    [ "$rc_big" = 0 ] && [ "$(body_sha "$WORK/get-big.out" 1)" = "$BIG_SHA" ] || arm_rc=1
    [ "$after" != "0" ] && [ "$after" != "$before" ] || arm_rc=1
    verdict get "$arm_rc" "hello rc=$rc sha $(body_sha "$WORK/get.out" 1 | cut -c1-12), big rc=$rc_big $(sed -n 's/^body 1: \([0-9]*\) bytes.*/\1/p' "$WORK/get-big.out") bytes sha $(body_sha "$WORK/get-big.out" 1 | cut -c1-12), peer handshake stamp $before -> $after"
    { grep '^status' "$WORK/get.out" "$WORK/get-big.out"; peer_wg_show get; peer_journal get "$since"; } >&2
    [ "$arm_rc" = 0 ] || cat "$WORK/get.out" "$WORK/get-big.out" >&2
fi

# The two hold arms idle the example on the client while the peer is
# sampled from here every 5 s: this host's clock, then the peer's handshake
# stamp and its receive counter.
sample_peer_during() {
    # sample_peer_during <pid> <samples file>: until the pid ends.
    local pid="$1" out="$2" sample
    while kill -0 "$pid" 2>/dev/null; do
        if sample="$(peer "echo \$(sudo -n wg show $IFACE latest-handshakes | cut -f2) \$(sudo -n wg show $IFACE transfer | cut -f2)" 2>/dev/null)"; then
            echo "$(date +%s) $sample" >> "$out"
        fi
        sleep 5
    done
}
hold_started() {
    # hold_started <log> <stamp file>: records the host clock when the
    # example reported the idle hold began.
    [ -s "$2" ] && return 0
    grep -q '^hold:' "$1" || return 1
    date +%s > "$2"
}
run_hold_arm() {
    # run_hold_arm <name> <client file> <hold secs> <since> [example
    # args...]: the example on the client with an idle hold, sampled on the
    # peer until it ends, the peer's journal captured after. Sets HOLD_RC
    # and HOLD_AT.
    local name="$1" file="$2" hold="$3" since="$4" example_pid sampler
    shift 4
    : > "$WORK/$name.samples"; : > "$WORK/$name.hold"
    ssh_to $((hold + 150)) "$CLIENT_SSH" CLIENT_SSH_OPTS \
        "timeout $((hold + 120)) $(quoted "$CLIENT_WG_CONNECT" "$CLIENT_WORK/$file" "$PEER_IP:$HTTP_PORT" /hello.txt --hold "$hold" "$@"); echo rc=\$?" > "$WORK/$name.out" 2>&1 &
    example_pid=$!
    HOST_PIDS+=("$example_pid")
    sample_peer_during "$example_pid" "$WORK/$name.samples" &
    sampler=$!
    wait_for 60 "the $name hold to begin" hold_started "$WORK/$name.out" "$WORK/$name.hold" || true
    set +e
    wait "$example_pid"
    wait "$sampler"
    set -e
    HOLD_RC="$(sed -n 's/^rc=//p' "$WORK/$name.out" | tail -1)"
    HOLD_AT="$(cat "$WORK/$name.hold" 2>/dev/null || echo 0)"
    peer_journal "$name" "$since"
}

# rekey: idle past 120 s on the plain file, a GET, a short settle. By the
# end exactly one fresh handshake has been made: the peer's stamp moved
# once, at least 100 s after the first, the client's final status shows a
# handshake younger than the hold, and the journal names the initiations
# and no retry, which a lost or refused handshake would have logged. The
# core rekeys an idle initiator session at 120 s only when the stamp of its
# first data packet is later than the handshake's (both have the 250 ms
# tick's resolution, so that is which side of a tick the first exchange
# fell on); when it is not, the second GET's data sets the rekey off and
# the settle gives it time to complete. The arm accepts both. A sample
# taken before the first handshake reads 0 and is not a stamp.
SETTLE=3
if runs rekey; then
    run_hold_arm rekey client.conf "$HOLD" "$(peer_now)" --settle "$SETTLE"
    rc="$HOLD_RC"
    first="$(awk '$2 != 0 { print $2; exit }' "$WORK/rekey.samples")"
    last="$(awk 'END { print $2 }' "$WORK/rekey.samples")"
    stamps="$(awk '$2 != 0 { print $2 }' "$WORK/rekey.samples" | sort -u | wc -l)"
    received="$(grep -c 'Receiving handshake initiation' "$WORK/rekey.journal" || true)"
    retries="$(grep -c 'Retrying handshake' "$WORK/rekey.journal" || true)"
    ago="$(sed -n 's/^status after hold: handshake \([0-9.]*\)s ago.*/\1/p' "$WORK/rekey.out")"
    fresh="$(sed -n 's/^status after settle: handshake \([0-9.]*\)s ago.*/\1/p' "$WORK/rekey.out")"
    arm_rc=0
    [ "$rc" = 0 ] || arm_rc=1
    [ "$(body_sha "$WORK/rekey.out" 2)" = "$HELLO_SHA" ] || arm_rc=1
    [ -n "$first" ] && [ -n "$last" ] && [ "$first" != "0" ] && [ "$last" -gt "$first" ] || arm_rc=1
    [ "$stamps" = 2 ] || arm_rc=1
    [ -n "$first" ] && [ -n "$last" ] && [ $((last - first)) -ge 100 ] || arm_rc=1
    [ -n "$fresh" ] && [ "${fresh%.*}" -lt $((HOLD - 100)) ] || arm_rc=1
    [ "$received" -ge 2 ] && [ "$retries" = 0 ] || arm_rc=1
    verdict rekey "$arm_rc" "rc=$rc, peer handshake stamp $first -> $last (+$((${last:-0} - ${first:-0}))s, $stamps distinct), handshake ${ago:-?}s old at the second GET and ${fresh:-?}s old at exit, journal: $received initiation(s), $retries retry, second GET sha $(body_sha "$WORK/rekey.out" 2 | cut -c1-12)"
    { grep -E '^(status|hold|settle|response)' "$WORK/rekey.out"; sed 's/^/    sample /' "$WORK/rekey.samples"; peer_wg_show rekey; } >&2
    [ "$arm_rc" = 0 ] || cat "$WORK/rekey.out" >&2
fi

# keepalive: with PersistentKeepalive the peer's receive counter grows while
# nothing is connected, and no fresh handshake happens inside the hold.
if runs keepalive; then
    run_hold_arm keepalive client-keepalive.conf "$KEEPALIVE_HOLD" "$(peer_now)"
    rc="$HOLD_RC"; hold_at="$HOLD_AT"
    # Receive counters at least 8 s into the hold (the first GET's bytes have
    # all landed) and before its last 5 s (the second GET is not yet
    # counted): the growth between them is keepalives alone, 32 bytes each.
    early="$(awk -v t="$((hold_at + 8))" '$1 >= t { print $3; exit }' "$WORK/keepalive.samples")"
    late="$(awk -v t="$((hold_at + KEEPALIVE_HOLD - 5))" '$1 <= t { v = $3 } END { print v }' "$WORK/keepalive.samples")"
    stamps="$(awk '$2 != 0 { print $2 }' "$WORK/keepalive.samples" | sort -u | wc -l)"
    keepalives="$(grep -c 'Receiving keepalive packet' "$WORK/keepalive.journal" || true)"
    arm_rc=0
    [ "$rc" = 0 ] && [ "$(body_sha "$WORK/keepalive.out" 2)" = "$HELLO_SHA" ] || arm_rc=1
    [ "$hold_at" != 0 ] && [ -n "$early" ] && [ -n "$late" ] && [ "$late" -ge $((early + 32)) ] || arm_rc=1
    [ "$stamps" = 1 ] || arm_rc=1
    [ "$keepalives" -ge 1 ] || arm_rc=1
    verdict keepalive "$arm_rc" "rc=$rc, peer received $early -> $late bytes across the idle hold (+$((${late:-0} - ${early:-0})), a keepalive is 32), $stamps handshake stamp(s), journal: $keepalives keepalive(s)"
    { grep -E '^(status|hold|response)' "$WORK/keepalive.out"; sed 's/^/    sample /' "$WORK/keepalive.samples"; peer_wg_show keepalive; } >&2
    [ "$arm_rc" = 0 ] || cat "$WORK/keepalive.out" >&2
fi

# The devserver arms: a raw listener on the peer's tunnel address records
# the first 64 bytes of the one connection it accepts, and a devserver on
# the client dials it through the tunnel on a throwaway CHAN_HOME with
# every CHAN_* variable of the client's login shell scrubbed first.
H2_PREFACE_HEX="505249202a20485454502f322e300d0a0d0a534d0d0a0d0a"
start_raw_listener() {
    # start_raw_listener <capture name>: prints the listener's pid.
    peer_script "$PEER_WORK" "$PEER_IP" "$RAW_PORT" "$1" <<'PEER'
work="$1"; addr="$2"; port="$3"; name="$4"
rm -f -- "${work:?}/${name:?}.hex"
cat > "$work/listener.py" <<'PY'
import socket, sys
addr, port, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind((addr, port))
s.listen(1)
c, _ = s.accept()
c.settimeout(5)
data = b""
try:
    while len(data) < 64:
        chunk = c.recv(4096)
        if not chunk:
            break
        data += chunk
except socket.timeout:
    pass
with open(out, "w") as f:
    f.write(data.hex() + "\n")
c.close()
PY
setsid nohup python3 "$work/listener.py" "$addr" "$port" "$work/$name.hex" </dev/null >"$work/$name.log" 2>&1 &
echo $!
for _ in $(seq 50); do
    ss -ltn 2>/dev/null | grep -q ":$port " && exit 0
    sleep 0.2
done
echo "listener did not bind $addr:$port: $(cat "$work/$name.log")" >&2
exit 1
PEER
}
peer_capture() {
    # peer_capture <name>: the captured bytes as hex, or the word `absent`
    # when no connection has been accepted yet; an ssh failure is neither
    # and ends the run.
    peer "if [ -f $PEER_WORK/$1.hex ]; then cat $PEER_WORK/$1.hex; else echo absent; fi"
}
peer_has_capture() {
    local capture
    capture="$(peer_capture "$1")"
    [ -n "$capture" ] && [ "$capture" != absent ]
}
start_devserver() {
    # start_devserver <name> <client file> <RUST_LOG or empty>: a devserver
    # on the client dialing the raw listener through the tunnel, its log at
    # $CLIENT_WORK/<name>.log there; prints its pid.
    local port=$((20000 + RANDOM % 20000))
    client_script "$CLIENT_WORK" "$CLIENT_CHAN" "$CLIENT_WORK/$2" "$port" "$PEER_IP" "$RAW_PORT" "$1" "$3" <<'CLIENT'
work="$1"; chan="$2"; file="$3"; port="$4"; peer_ip="$5"; raw_port="$6"; name="$7"; rust_log="$8"
for v in $(env | sed -n 's/^\(CHAN_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
CHAN_HOME="$work/chan-home-$name"
mkdir -p "$CHAN_HOME"
export CHAN_HOME CHAN_UPDATE_CHECK=0
if [ -n "$rust_log" ]; then export RUST_LOG="$rust_log"; fi
nohup "$chan" devserver run --bind 127.0.0.1 --port "$port" \
    --tunnel-wireguard "$file" --tunnel-url "http://$peer_ip:$raw_port/v1/tunnel" \
    --tunnel-token chan_pat_wireguard_freebsd_e2e </dev/null >"$work/$name.log" 2>&1 &
echo $!
CLIENT
}
fetch_client_log() { client "cat $(quoted "$CLIENT_WORK/$1.log")" > "$WORK/$1.log" 2>/dev/null || true; }
tunnel_start_logged() {
    # tunnel_start_logged <name> <client file>: the devserver's line, read from
    # the client's log, which is copied here on every poll.
    fetch_client_log "$1"
    grep -q "^chan devserver: WireGuard tunnel started from $CLIENT_WORK/$2: endpoint .*, public key $CLIENT_PUB$" "$WORK/$1.log"
}

if runs devserver; then
    arm_rc=0
    if listener_pid="$(start_raw_listener devserver)"; then
        PEER_PIDS="$PEER_PIDS $listener_pid"
        before="$(peer_handshake)"; since="$(peer_now)"
        devserver_pid="$(start_devserver devserver client.conf "")"
        CLIENT_PIDS="$CLIENT_PIDS $devserver_pid"
        wait_for 60 "the tunnel-start line" tunnel_start_logged devserver client.conf || arm_rc=1
        wait_for 60 "the raw listener to see the dial" peer_has_capture devserver || arm_rc=1
        capture="$(peer_capture devserver)"
        after="$(peer_handshake)"
        client "kill $devserver_pid" 2>/dev/null || true
        fetch_client_log devserver
        case "$capture" in "$H2_PREFACE_HEX"*) ;; *) arm_rc=1 ;; esac
        [ "$after" != "0" ] && [ "$after" != "$before" ] || arm_rc=1
        verdict devserver "$arm_rc" "tunnel start logged, listener on $PEER_IP:$RAW_PORT got $(( ${#capture} / 2 )) bytes starting $(printf '%s' "$capture" | cut -c1-48 | xxd -r -p | tr '\r\n' '..'), peer handshake stamp $before -> $after"
        { grep 'WireGuard tunnel started' "$WORK/devserver.log"; echo "    capture: $capture"; peer_wg_show devserver; peer_journal devserver "$since"; } >&2
    else
        arm_rc=1
        verdict devserver 1 "the raw listener did not start on the peer"
    fi
    [ "$arm_rc" = 0 ] || cat "$WORK/devserver.log" >&2
fi

# mode: the shared copy is refused before anything starts. The command is
# bounded on the client so a devserver that wrongly started is ended too.
if runs mode; then
    client_script "$CLIENT_WORK" "$CLIENT_CHAN" "$CLIENT_WORK/client-shared.conf" "$PEER_IP" "$RAW_PORT" $((20000 + RANDOM % 20000)) <<'CLIENT' > "$WORK/mode.out" 2>&1 || true
work="$1"; chan="$2"; file="$3"; peer_ip="$4"; raw_port="$5"; port="$6"
for v in $(env | sed -n 's/^\(CHAN_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
CHAN_HOME="$work/chan-home-mode"
mkdir -p "$CHAN_HOME"
export CHAN_HOME CHAN_UPDATE_CHECK=0
timeout 30 "$chan" devserver run --bind 127.0.0.1 --port "$port" \
    --tunnel-wireguard "$file" --tunnel-url "http://$peer_ip:$raw_port/v1/tunnel" \
    --tunnel-token chan_pat_wireguard_freebsd_e2e
echo "rc=$?"
CLIENT
    rc="$(sed -n 's/^rc=//p' "$WORK/mode.out" | tail -1)"
    arm_rc=0
    [ "$rc" = 1 ] || arm_rc=1
    grep -q "^Error: chan devserver: --tunnel-wireguard $CLIENT_WORK/client-shared.conf is readable by the group or others (mode 644); it holds the tunnel's private key, so narrow it first: chmod 600 $CLIENT_WORK/client-shared.conf$" "$WORK/mode.out" || arm_rc=1
    ! grep -q 'WireGuard tunnel started' "$WORK/mode.out" || arm_rc=1
    ! grep -q 'PrivateKey' "$WORK/mode.out" || arm_rc=1
    verdict mode "$arm_rc" "rc=$rc, $(grep -c 'mode 644' "$WORK/mode.out" || true) refusal naming the mode and the chmod, no tunnel-start line, no key echoed"
    sed 's/^/    /' "$WORK/mode.out" >&2
fi

# rcvbuf: the hint against the client's cap, read from the crate's own
# debug line. Below the cap nothing is logged and the tunnel comes up;
# above it the kernel refuses the size, the crate says so at debug and the
# tunnel comes up all the same.
if runs rcvbuf; then
    arm_rc=0
    devserver_pid="$(start_devserver rcvbuf client.conf chan_wireguard=debug)"
    CLIENT_PIDS="$CLIENT_PIDS $devserver_pid"
    wait_for 60 "the tunnel-start line" tunnel_start_logged rcvbuf client.conf || arm_rc=1
    client "kill $devserver_pid" 2>/dev/null || true
    fetch_client_log rcvbuf
    refused="$(grep -c 'tunnel socket receive buffer left at the default' "$WORK/rcvbuf.log" || true)"
    if [ "$CLIENT_MAXSOCKBUF" -lt "$SOCKET_BUFFER_HINT" ]; then
        expected="refused"
        [ "$refused" = 1 ] && grep -q 'receive buffer left at the default.*No buffer space available' "$WORK/rcvbuf.log" || arm_rc=1
    else
        expected="granted"
        [ "$refused" = 0 ] || arm_rc=1
    fi
    verdict rcvbuf "$arm_rc" "kern.ipc.maxsockbuf $CLIENT_MAXSOCKBUF, hint $SOCKET_BUFFER_HINT, expected $expected, $refused refusal(s) logged, tunnel start logged"
    grep -E 'receive buffer|send buffer|WireGuard tunnel started' "$WORK/rcvbuf.log" | sed 's/^/    /' >&2
    [ "$arm_rc" = 0 ] || cat "$WORK/rcvbuf.log" >&2
fi

if [ "$FAILED" != 0 ]; then
    log "FAIL: $FAILED arm(s) failed at $SHA; work dir kept at $WORK"
    exit 1
fi
if [ "$KEEP" = 1 ]; then
    log "PASS at $SHA: client $CLIENT_SSH ($CLIENT_KERNEL) against $PEER_SSH ($PEER_KERNEL); work dir kept at $WORK"
    exit 0
fi
log "PASS at $SHA: client $CLIENT_SSH ($CLIENT_KERNEL) against $PEER_SSH ($PEER_KERNEL); work dir $WORK removed"
cleanup
trap - EXIT
rm -rf "${WORK:?}"
