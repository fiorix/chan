#!/usr/bin/env bash
# End-to-end proof of chan-wireguard, the in-process WireGuard client,
# against a REAL kernel WireGuard peer reached over SSH: the peer's `wg`
# and `ip` build an interface for the run, the crate's `wg-connect` example
# and a real `chan devserver run --tunnel-wireguard` dial it from this host,
# and every claim is read back from the peer's `wg show`.
#
# What it proves, one verdict line and exit status per arm:
#   wrong-key   a client file naming a wrong peer public key never completes
#               a handshake: the connect times out, the peer's handshake
#               stamp does not move, and the peer's UDP counters show the
#               initiations did arrive and were refused (the control that
#               the positive arms are not vacuous).
#   get         an HTTP GET through the tunnel returns the peer's known
#               files byte for byte (a short text and a 1 MiB blob), and the
#               peer shows the handshake and the traffic.
#   rekey       a tunnel held idle past the protocol's 120 s rekey makes a
#               fresh handshake with the kernel (the peer's stamp moves, and
#               only once: the passive keepalive keeps the kernel from
#               re-handshaking on its own) and the GET after it still
#               returns the file.
#   keepalive   with PersistentKeepalive the peer's receive counter grows
#               while the tunnel carries no connection.
#   devserver   `chan devserver run --tunnel-wireguard` logs the tunnel start
#               and its h2 dial reaches a raw listener on the peer's tunnel
#               address with the HTTP/2 connection preface, through the
#               devserver, the connector, the stack and the kernel. The
#               dial then fails at the HTTP level, which is expected.
#   devserver-wrong-key
#               the same dial with the wrong peer key reaches nothing,
#               logs one session expiry at WARN within 100 s of tunnel
#               start, and logs no ERROR at the production warn filter.
#   dns         an initially absent endpoint recovers and follows a hosts
#               file change to a second UDP forwarding path (opt-in).
#
# What it cannot prove: a peer behind a real NAT or a changing address, a
# tunnel URL by name, and anything the gateway answers past the preface.
#
# Usage:
#   wireguard-kernel.sh [options] SSH_TARGET ENDPOINT PEER_ADDRESS
#     SSH_TARGET    user@host the peer is provisioned through
#     ENDPOINT      the peer's WireGuard UDP host:port as this host reaches it
#     PEER_ADDRESS  the peer's tunnel address with its prefix, e.g. 10.7.0.1/24
#   --ssh-opt OPT        an extra ssh option, repeatable (-p 2204, -i KEY, ...)
#   --client-address IP  the client's tunnel address (default: the peer's plus one)
#   --listen-port PORT   the peer's WireGuard listen port (default: ENDPOINT's)
#   --interface NAME     the peer interface the run creates (default chanwg0;
#                        refused when it already exists)
#   --hold SECS          the rekey arm's idle hold (default 130, past the 120 s rekey)
#   --arms LIST          comma separated arms to run (default: all, in the order above)
#   --dns-second-endpoint HOST:PORT  second forward to the same peer, for --arms dns
#   --dns-second-peer-port PORT      the peer port that second forward reaches,
#                        when it is not the listen port: the run redirects it
#                        to the listen port with nft and removes the rule at
#                        exit (refused when its table already exists)
#
# The dns arm needs two UDP paths from this host to the peer's WireGuard
# port, and checks first that each path answers from its own address. QEMU
# user networking (slirp) cannot give two forwards to one guest port: it
# sends every reply for a guest port out of the newest forward to it, so
# the first path is answered from the second's port. Forward the second
# path to a guest port of its own and let the run redirect that port, for
# the kernel peer VM on 51820:
#   (qemu) hostfwd_add udp:127.0.0.1:51821-:51822
#   wireguard-kernel.sh --arms dns --dns-second-endpoint 127.0.0.1:51821 \
#       --dns-second-peer-port 51822 SSH_TARGET 127.0.0.1:51820 PEER_ADDRESS
# The redirect needs nft on the peer.
#
# Prerequisites. On the peer: Linux with the wireguard module, wireguard-tools
# (`wg`), iproute2, python3 (serves the files and the raw listener), sha256sum,
# and passwordless sudo (`sudo -n`) for `ip` and `wg`; its firewall must
# admit the UDP port. On this host: ssh, python3, sha256sum, xxd, and a tree
# that builds `chan` and the example (or CHAN_BIN and WG_CONNECT_BIN naming
# built ones). Exits 2 when a prerequisite is missing rather than passing.
#
# Everything runs under a throwaway CHAN_HOME and work dir on this host and a
# per-run work dir on the peer; both are deleted on success and the host one
# is kept on failure. The kept work dir holds the run's client files with a
# private key that is worthless once the peer interface is deleted, which
# the exit path does, but treat it as a credential until it is gone.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHA="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
SSH_OPTS=()
CLIENT_IP=""
LISTEN_PORT=""
IFACE=chanwg0
HOLD=130
KEEPALIVE_HOLD=60
ARMS="wrong-key,get,rekey,keepalive,devserver,devserver-wrong-key"
HTTP_PORT=8080
RAW_PORT=4443
POSITIONAL=()
DNS_SECOND_ENDPOINT=""
DNS_SECOND_PEER_PORT=""
NFT_TABLE=chanwg_dns

log() { printf 'wireguard-kernel: %s\n' "$*" >&2; }
refuse() { log "cannot run: $*"; exit 2; }

while [ $# -gt 0 ]; do
    case "$1" in
        --ssh-opt) SSH_OPTS+=("$2"); shift 2 ;;
        --client-address) CLIENT_IP="$2"; shift 2 ;;
        --listen-port) LISTEN_PORT="$2"; shift 2 ;;
        --interface) IFACE="$2"; shift 2 ;;
        --hold) HOLD="$2"; shift 2 ;;
        --arms) ARMS="$2"; shift 2 ;;
        --dns-second-endpoint) DNS_SECOND_ENDPOINT="$2"; shift 2 ;;
        --dns-second-peer-port) DNS_SECOND_PEER_PORT="$2"; shift 2 ;;
        -h | --help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | cut -c3-; exit 0 ;;
        -*) refuse "unknown option $1" ;;
        *) POSITIONAL+=("$1"); shift ;;
    esac
done
[ "${#POSITIONAL[@]}" -eq 3 ] || refuse "usage: wireguard-kernel.sh [options] SSH_TARGET ENDPOINT PEER_ADDRESS"
SSH_TARGET="${POSITIONAL[0]}"
ENDPOINT="${POSITIONAL[1]}"
PEER_CIDR="${POSITIONAL[2]}"
case "$HOLD" in '' | *[!0-9]*) refuse "--hold takes a number of seconds" ;; esac
[ "$HOLD" -gt 120 ] || refuse "--hold must exceed the protocol's 120 s rekey time"
case ",$ARMS," in
    *,dns,*)
        [ -n "$DNS_SECOND_ENDPOINT" ] || refuse "--arms dns requires --dns-second-endpoint"
        command -v unshare >/dev/null 2>&1 || refuse "unshare is not installed"
        unshare --user --map-root-user --mount true || refuse "unprivileged mount namespaces unavailable"
        ;;
esac

for tool in ssh python3 sha256sum xxd timeout; do
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
NFT_PLANNED=""
if [ -n "$DNS_SECOND_PEER_PORT" ]; then
    case ",$ARMS," in *,dns,*) ;; *) refuse "--dns-second-peer-port is for --arms dns" ;; esac
    case "$DNS_SECOND_PEER_PORT" in '' | *[!0-9]*) refuse "--dns-second-peer-port takes a port number" ;; esac
    [ "$DNS_SECOND_PEER_PORT" != "$LISTEN_PORT" ] || refuse "--dns-second-peer-port is the listen port; leave it out"
    NFT_PLANNED="$NFT_TABLE"
fi

if [ -z "${CHAN_BIN:-}" ]; then
    log "building chan at $SHA"
    (cd "$REPO" && cargo build --locked -p chan >/dev/null) || refuse "cargo build -p chan failed"
    CHAN_BIN="$REPO/target/debug/chan"
fi
[ -x "$CHAN_BIN" ] || refuse "no chan binary at $CHAN_BIN"
if [ -z "${WG_CONNECT_BIN:-}" ]; then
    log "building the wg-connect example at $SHA"
    (cd "$REPO" && cargo build --locked -p chan-wireguard --example wg-connect >/dev/null) \
        || refuse "cargo build --example wg-connect failed"
    WG_CONNECT_BIN="$REPO/target/debug/examples/wg-connect"
fi
[ -x "$WG_CONNECT_BIN" ] || refuse "no wg-connect example at $WG_CONNECT_BIN"

peer() {
    # peer <command...>: run a command on the peer, bounded.
    timeout 60 ssh -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "${SSH_OPTS[@]}" "$SSH_TARGET" -- "$@"
}
peer_script() {
    # peer_script <args...>: run the script on stdin on the peer with the
    # arguments. ssh joins its arguments into one string the remote shell
    # splits again, so each is quoted first or a pid list would arrive as
    # several arguments and shift the rest.
    local args=""
    [ $# -eq 0 ] || args="$(printf ' %q' "$@")"
    timeout 60 ssh -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "${SSH_OPTS[@]}" "$SSH_TARGET" -- "bash -s --$args"
}

# Every prerequisite on the peer is probed before anything is created there.
NFT_PROBE=":"
[ -z "$NFT_PLANNED" ] || NFT_PROBE="sudo -n nft list tables >/dev/null 2>&1 || echo no-nft; sudo -n nft list table ip $NFT_PLANNED >/dev/null 2>&1 && echo nft-table-exists"
if ! PROBE="$(peer 'sudo -n wg --version >/dev/null 2>&1 || echo no-wg; sudo -n ip -V >/dev/null 2>&1 || echo no-ip; command -v python3 >/dev/null 2>&1 || echo no-python3; command -v sha256sum >/dev/null 2>&1 || echo no-sha256sum; sudo -n true 2>/dev/null || echo no-sudo; ip link show '"$IFACE"' >/dev/null 2>&1 && echo iface-exists; '"$NFT_PROBE"'; uname -sr' 2>&1)"; then
    refuse "ssh to $SSH_TARGET failed: $PROBE"
fi
for missing in no-wg no-ip no-python3 no-sha256sum no-sudo no-nft; do
    case "$PROBE" in *"$missing"*) refuse "the peer lacks ${missing#no-} (or sudo -n for it): $PROBE" ;; esac
done
case "$PROBE" in *iface-exists*) refuse "interface $IFACE already exists on the peer; this run creates and deletes its own" ;; esac
case "$PROBE" in *nft-table-exists*) refuse "nft table ip $NFT_PLANNED already exists on the peer; this run creates and deletes its own" ;; esac
PEER_KERNEL="$(printf '%s\n' "$PROBE" | tail -1)"

WORK="$(mktemp -d "${TMPDIR:-/var/tmp}/chan-wireguard-kernel.XXXXXX")"
chmod 700 "$WORK"
export CHAN_HOME="$WORK/chan-home"
mkdir -p "$CHAN_HOME"
# A run launched from inside a chan terminal must not inherit a tunnel
# token, URL or any other session state.
for v in $(compgen -v | grep -E '^CHAN_' | grep -vE '^CHAN_(HOME|BIN)$'); do unset "$v"; done
export CHAN_UPDATE_CHECK=0

HOST_PIDS=()
PEER_WORK=""
PEER_PIDS=""
IFACE_CREATED=""
NFT_CREATED=""
cleanup() {
    local pid
    for pid in "${HOST_PIDS[@]:-}"; do
        [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    done
    sleep 0.5
    for pid in "${HOST_PIDS[@]:-}"; do
        [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
    done
    # Only what the run made on the peer: its processes by recorded pid,
    # the interface it created, and its work dir, identified by the marker
    # the run wrote into it.
    if [ -n "$PEER_WORK" ] || [ -n "$IFACE_CREATED" ] || [ -n "$NFT_CREATED" ]; then
        peer_script "$PEER_WORK" "$PEER_PIDS" "$IFACE_CREATED" "$NFT_CREATED" <<'PEER' >/dev/null 2>&1 || log "peer cleanup did not finish; check $SSH_TARGET for $IFACE, nft table $NFT_TABLE and $PEER_WORK"
work="$1"; pids="$2"; iface="$3"; table="$4"
[ -n "$table" ] && sudo -n nft delete table ip "$table" 2>/dev/null || true
for pid in $pids; do kill "$pid" 2>/dev/null || true; done
[ -n "$iface" ] && sudo -n ip link del "$iface" 2>/dev/null || true
if [ -n "$work" ] && [ -f "$work/.chan-wireguard-kernel" ]; then rm -rf -- "${work:?}"; fi
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
        printf 'wireguard-kernel: %s rc=0 PASS %s\n' "$arm" "$*"
    else
        printf 'wireguard-kernel: %s rc=%s FAIL %s\n' "$arm" "$rc" "$*"
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
peer_udp_in() {
    # The peer's UDP datagrams delivered to sockets, which count a refused
    # handshake initiation where the interface's own counters do not.
    peer "awk '/^Udp:/ { n++; if (n == 2) print \$2 }' /proc/net/snmp"
}
peer_wg_show() { peer "sudo -n wg show $IFACE" | sed 's/^/    /'; }

log "work dir $WORK, chan $SHA, peer $SSH_TARGET ($PEER_KERNEL), endpoint $ENDPOINT, peer $PEER_CIDR, client $CLIENT_IP"

# 1. Keys, interface and the served files on the peer. The client's private
# key is made by the peer's `wg genkey` and carried back over SSH, so the
# public key the crate derives from it can be checked against `wg pubkey`.
if ! SETUP="$(peer_script "$IFACE" "$LISTEN_PORT" "$PEER_CIDR" "$CLIENT_IP" "$PEER_IP" "$HTTP_PORT" <<'PEER'
set -euo pipefail
iface="$1"; port="$2"; peer_cidr="$3"; client_ip="$4"; peer_ip="$5"; http_port="$6"
umask 077
work="$(mktemp -d /tmp/chan-wireguard-kernel.XXXXXX)"
touch "$work/.chan-wireguard-kernel"
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

# The dns arm's second path, when it reaches its own peer port: redirected
# to the listen port, so replies leave through that path's own forward.
# Recorded before the call, so the exit path removes a half-made table.
if [ -n "$NFT_PLANNED" ]; then
    NFT_CREATED="$NFT_PLANNED"
    peer_script "$NFT_PLANNED" "$DNS_SECOND_PEER_PORT" "$LISTEN_PORT" <<'PEER' || { log "the peer redirect for the dns arm failed"; exit 1; }
set -euo pipefail
table="$1"; from="$2"; to="$3"
sudo -n nft add table ip "$table"
sudo -n nft add chain ip "$table" prerouting '{ type nat hook prerouting priority -100; }'
sudo -n nft add rule ip "$table" prerouting udp dport "$from" redirect to :"$to"
PEER
    log "peer redirects UDP $DNS_SECOND_PEER_PORT to $LISTEN_PORT for the dns arm (nft table ip $NFT_PLANNED)"
fi

# 2. The client files, owner-only as the devserver demands.
write_client_file() {
    # write_client_file <path> <peer public key> [extra peer lines...]
    local path="$1" pub="$2"; shift 2
    (umask 077; {
        printf '[Interface]\nPrivateKey = %s\nAddress = %s/32\n\n[Peer]\nPublicKey = %s\nEndpoint = %s\nAllowedIPs = %s\n' \
            "$CLIENT_KEY" "$CLIENT_IP" "$pub" "$ENDPOINT" "$PEER_NET"
        for line in "$@"; do printf '%s\n' "$line"; done
    } > "$path")
}
write_client_file "$WORK/client.conf" "$SERVER_PUB"
write_client_file "$WORK/client-keepalive.conf" "$SERVER_PUB" "PersistentKeepalive = 25"
write_client_file "$WORK/client-wrong-key.conf" "$WRONG_PUB"

runs() { case ",$ARMS," in *",$1,"*) return 0 ;; esac; return 1; }
body_sha() { sed -n "s/^body $2: [0-9]* bytes, sha256 \([0-9a-f]*\)$/\1/p" "$1"; }
hello_body() {
    # hello_body <sha>: how a GET body compares with hello.txt.
    if [ -z "$1" ]; then echo "absent"
    elif [ "$1" = "$HELLO_SHA" ]; then echo "sha ${1:0:12}, hello.txt"
    else echo "sha ${1:0:12}, not hello.txt"; fi
}
run_example() {
    # run_example <log> <file> <args...>: the example, its rc recorded in the log.
    local out="$1" file="$2"; shift 2
    set +e
    timeout $((HOLD + 120)) "$WG_CONNECT_BIN" "$file" "$PEER_IP:$HTTP_PORT" "$@" > "$out" 2>&1
    echo "rc=$?" >> "$out"
    set -e
    sed -n 's/^rc=//p' "$out"
}

if runs dns; then
    arm_rc=0
    parent_mount_namespace="$(readlink /proc/self/ns/mnt)"
    unshare --user --map-root-user --mount --fork \
        python3 "$REPO/scripts/e2e/wireguard-dns.py" \
        "$WG_CONNECT_BIN" "$WORK/client.conf" "$PEER_IP:$HTTP_PORT" \
        "$ENDPOINT" "$DNS_SECOND_ENDPOINT" "$WORK/dns" "$HOLD" "$parent_mount_namespace" \
        > "$WORK/dns.log" 2>&1 || arm_rc=$?
    helper_rc="$arm_rc"
    sha1=""; sha2=""
    if [ -f "$WORK/dns/client.log" ]; then
        sha1="$(body_sha "$WORK/dns/client.log" 1)"; sha2="$(body_sha "$WORK/dns/client.log" 2)"
    fi
    if [ "$arm_rc" = 0 ] && { [ "$sha1" != "$HELLO_SHA" ] || [ "$sha2" != "$HELLO_SHA" ]; }; then
        arm_rc=1
    fi
    # The helper's own account, one line per stage it reached and its PASS
    # or FAIL line (first line only: the client log a FAIL carries is
    # printed below).
    stages="$(sed -n 's/^dns: //p' "$WORK/dns.log" | paste -sd '|' - | sed 's/|/; /g')"
    verdict dns "$arm_rc" "helper rc=$helper_rc (${stages:-no stage reached}); GET 1 $(hello_body "$sha1"), GET 2 $(hello_body "$sha2")"
    cat "$WORK/dns.log" >&2
fi

# wrong-key: the control. The peer's handshake stamp must not move, the
# connect must time out, and the peer must have taken UDP datagrams from
# the attempt (the initiations it refused), or the arm proves nothing.
if runs wrong-key; then
    before="$(peer_handshake)"; udp_before="$(peer_udp_in)"
    rc="$(run_example "$WORK/wrong-key.out" "$WORK/client-wrong-key.conf" /hello.txt --timeout 15)"
    after="$(peer_handshake)"; udp_after="$(peer_udp_in)"
    detail="connect rc=$rc, peer handshake stamp $before -> $after, peer UDP in +$((udp_after - udp_before))"
    arm_rc=0
    [ "$rc" = 2 ] && grep -q '^connect: timed out after 15s$' "$WORK/wrong-key.out" || arm_rc=1
    [ "$before" = "$after" ] || arm_rc=1
    [ $((udp_after - udp_before)) -ge 2 ] || arm_rc=1
    verdict wrong-key "$arm_rc" "$detail"
    [ "$arm_rc" = 0 ] || { cat "$WORK/wrong-key.out"; peer_wg_show; } >&2
fi

# get: the known files, byte for byte, and the peer's view of the session.
if runs get; then
    before="$(peer_handshake)"
    rc="$(run_example "$WORK/get.out" "$WORK/client.conf" /hello.txt)"
    rc_big="$(run_example "$WORK/get-big.out" "$WORK/client.conf" /big.bin)"
    after="$(peer_handshake)"
    arm_rc=0
    [ "$rc" = 0 ] && grep -q '^response 1: HTTP/1\.[01] 200 ' "$WORK/get.out" || arm_rc=1
    [ "$(body_sha "$WORK/get.out" 1)" = "$HELLO_SHA" ] || arm_rc=1
    grep -q "^tunnel: endpoint $ENDPOINT, public key $CLIENT_PUB," "$WORK/get.out" || arm_rc=1
    [ "$rc_big" = 0 ] && [ "$(body_sha "$WORK/get-big.out" 1)" = "$BIG_SHA" ] || arm_rc=1
    [ "$after" != "0" ] && [ "$after" != "$before" ] || arm_rc=1
    verdict get "$arm_rc" "hello rc=$rc sha $(body_sha "$WORK/get.out" 1 | cut -c1-12), big rc=$rc_big $(sed -n 's/^body 1: \([0-9]*\) bytes.*/\1/p' "$WORK/get-big.out") bytes sha $(body_sha "$WORK/get-big.out" 1 | cut -c1-12), peer handshake stamp $before -> $after"
    { grep '^status' "$WORK/get.out" "$WORK/get-big.out"; peer_wg_show; } >&2
    [ "$arm_rc" = 0 ] || cat "$WORK/get.out" "$WORK/get-big.out" >&2
fi

# The two hold arms sample the peer while the example idles. The sampler
# records this host's clock, then the peer's handshake stamp and receive
# counter, every 5 s.
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
    # run_hold_arm <name> <client file> <hold secs>: the example with a hold,
    # sampled on the peer until it ends; the example's rc lands in HOLD_RC.
    # Every client file carries the same key, so until this arm's first
    # handshake the peer still shows the previous arm's stamp; it is read
    # before the launch into HOLD_PRIOR, and samples showing it are not
    # this arm's.
    local name="$1" file="$2" hold="$3" example_pid sampler rc
    : > "$WORK/$name.samples"; : > "$WORK/$name.hold"
    # Stamps are whole seconds: one passes first, so this arm's first
    # handshake cannot carry the prior stamp.
    HOLD_PRIOR="$(peer_handshake)"; sleep 1
    set +e
    timeout $((hold + 120)) "$WG_CONNECT_BIN" "$file" "$PEER_IP:$HTTP_PORT" /hello.txt --hold "$hold" > "$WORK/$name.out" 2>&1 &
    example_pid=$!
    set -e
    HOST_PIDS+=("$example_pid")
    sample_peer_during "$example_pid" "$WORK/$name.samples" &
    sampler=$!
    wait_for 60 "the $name hold to begin" hold_started "$WORK/$name.out" "$WORK/$name.hold" || true
    set +e
    wait "$example_pid"; rc=$?
    wait "$sampler"
    set -e
    echo "rc=$rc" >> "$WORK/$name.out"
    HOLD_RC="$rc"
}

# rekey: idle past 120 s, the peer's stamp moves once, the second GET works.
if runs rekey; then
    run_hold_arm rekey "$WORK/client.conf" "$HOLD"
    rc="$HOLD_RC"
    # A sample taken before this arm's first handshake reads 0 or the prior
    # arm's stamp, and is not this arm's.
    first="$(awk -v prior="$HOLD_PRIOR" '$2 != 0 && $2 != prior { print $2; exit }' "$WORK/rekey.samples")"
    last="$(awk 'END { print $2 }' "$WORK/rekey.samples")"
    stamps="$(awk -v prior="$HOLD_PRIOR" '$2 != 0 && $2 != prior { print $2 }' "$WORK/rekey.samples" | sort -u | wc -l)"
    arm_rc=0
    [ "$rc" = 0 ] || arm_rc=1
    [ "$(body_sha "$WORK/rekey.out" 2)" = "$HELLO_SHA" ] || arm_rc=1
    [ -n "$first" ] && [ -n "$last" ] && [ "$first" != "0" ] && [ "$last" -gt "$first" ] || arm_rc=1
    # The fresh handshake is the rekey and nothing else: one change of
    # stamp, at least 100 s after the first, and the example saw it too.
    [ "$stamps" = 2 ] || arm_rc=1
    [ -n "$first" ] && [ -n "$last" ] && [ $((last - first)) -ge 100 ] || arm_rc=1
    ago="$(sed -n 's/^status after hold: handshake \([0-9.]*\)s ago.*/\1/p' "$WORK/rekey.out")"
    [ -n "$ago" ] && [ "${ago%.*}" -lt $((HOLD - 100)) ] || arm_rc=1
    verdict rekey "$arm_rc" "rc=$rc, peer handshake stamp $first -> $last (+$((${last:-0} - ${first:-0}))s, $stamps distinct after the prior arm's ${HOLD_PRIOR:-none}), client saw the handshake ${ago:-?}s before the second GET, second GET sha $(body_sha "$WORK/rekey.out" 2 | cut -c1-12)"
    { grep -E '^(status|hold|response)' "$WORK/rekey.out"; sed 's/^/    sample /' "$WORK/rekey.samples"; peer_wg_show; } >&2
    [ "$arm_rc" = 0 ] || cat "$WORK/rekey.out" >&2
fi

# keepalive: the peer's receive counter grows while nothing is connected.
if runs keepalive; then
    run_hold_arm keepalive "$WORK/client-keepalive.conf" "$KEEPALIVE_HOLD"
    rc="$HOLD_RC"
    hold_at="$(cat "$WORK/keepalive.hold" 2>/dev/null || echo 0)"
    # Receive counters at least 8 s into the hold (the first GET's bytes
    # have all landed) and before its last 5 s (the second GET is not yet
    # counted): the growth between them is keepalives alone.
    early="$(awk -v t="$((hold_at + 8))" '$1 >= t { print $3; exit }' "$WORK/keepalive.samples")"
    late="$(awk -v t="$((hold_at + KEEPALIVE_HOLD - 5))" '$1 <= t { v = $3 } END { print v }' "$WORK/keepalive.samples")"
    stamps="$(awk -v prior="$HOLD_PRIOR" '$2 != 0 && $2 != prior { print $2 }' "$WORK/keepalive.samples" | sort -u | wc -l)"
    arm_rc=0
    [ "$rc" = 0 ] && [ "$(body_sha "$WORK/keepalive.out" 2)" = "$HELLO_SHA" ] || arm_rc=1
    [ "$hold_at" != 0 ] && [ -n "$early" ] && [ -n "$late" ] && [ "$late" -ge $((early + 32)) ] || arm_rc=1
    [ "$stamps" = 1 ] || arm_rc=1
    verdict keepalive "$arm_rc" "rc=$rc, peer received $early -> $late bytes across the idle hold (+$((${late:-0} - ${early:-0})), a keepalive is 32), $stamps handshake stamp(s) seen after the prior arm's ${HOLD_PRIOR:-none}"
    { grep -E '^(status|hold|response)' "$WORK/keepalive.out"; sed 's/^/    sample /' "$WORK/keepalive.samples"; peer_wg_show; } >&2
    [ "$arm_rc" = 0 ] || cat "$WORK/keepalive.out" >&2
fi

# The devserver arms: a raw listener on the peer's tunnel address records
# the first 64 bytes of the one connection it accepts.
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
run_devserver() {
    # run_devserver <log> <client file>: a devserver dialing the raw
    # listener through the tunnel, its pid in DEVSERVER_PID.
    local out="$1" file="$2" port=$((20000 + RANDOM % 20000))
    RUST_LOG=warn "$CHAN_BIN" devserver run --bind 127.0.0.1 --port "$port" \
        --tunnel-wireguard "$file" --tunnel-url "http://$PEER_IP:$RAW_PORT/v1/tunnel" \
        --tunnel-token chan_pat_wireguard_kernel_e2e > "$out" 2>&1 &
    DEVSERVER_PID=$!
    HOST_PIDS+=("$DEVSERVER_PID")
}
tunnel_start_logged() { grep -q "^chan devserver: WireGuard tunnel started from $1: endpoint .*, public key $CLIENT_PUB$" "$2"; }
# tracing colours redirected stderr too; read levels only after stripping it.
devserver_log() { sed 's/\x1b\[[0-9;]*m//g' "$WORK/$1.log" > "$WORK/$1.clean.log"; }
session_warnings() {
    awk '$2 == "WARN" && $3 == "chan_wireguard::tunnel:" && $4 == "WireGuard" && $5 == "session" { n++ } END { print n+0 }' "$1"
}
session_expiry_logged() {
    devserver_log "$1" || return 1
    [ "$(session_warnings "$WORK/$1.clean.log")" -ge 1 ]
}

if runs devserver; then
    arm_rc=0
    if listener_pid="$(start_raw_listener devserver)"; then
        PEER_PIDS="$PEER_PIDS $listener_pid"
        before="$(peer_handshake)"
        run_devserver "$WORK/devserver.log" "$WORK/client.conf"
        wait_for 60 "the tunnel-start line" tunnel_start_logged "$WORK/client.conf" "$WORK/devserver.log" || arm_rc=1
        wait_for 60 "the raw listener to see the dial" peer_has_capture devserver || arm_rc=1
        capture="$(peer_capture devserver)"
        after="$(peer_handshake)"
        kill "$DEVSERVER_PID" 2>/dev/null || true
        case "$capture" in "$H2_PREFACE_HEX"*) ;; *) arm_rc=1 ;; esac
        [ "$after" != "0" ] && [ "$after" != "$before" ] || arm_rc=1
        verdict devserver "$arm_rc" "tunnel start logged, listener on $PEER_IP:$RAW_PORT got $(( ${#capture} / 2 )) bytes starting $(printf '%s' "$capture" | cut -c1-48 | xxd -r -p | tr '\r\n' '..'), peer handshake stamp $before -> $after"
        { grep 'WireGuard tunnel started' "$WORK/devserver.log"; echo "    capture: $capture"; peer_wg_show; } >&2
    else
        arm_rc=1
        verdict devserver 1 "the raw listener did not start on the peer"
    fi
    [ "$arm_rc" = 0 ] || cat "$WORK/devserver.log" >&2
fi

if runs devserver-wrong-key; then
    arm_rc=0
    if listener_pid="$(start_raw_listener devserver-wrong-key)"; then
        PEER_PIDS="$PEER_PIDS $listener_pid"
        before="$(peer_handshake)"
        run_devserver "$WORK/devserver-wrong-key.log" "$WORK/client-wrong-key.conf"
        wait_for 60 "the tunnel-start line" tunnel_start_logged "$WORK/client-wrong-key.conf" "$WORK/devserver-wrong-key.log" || arm_rc=1
        # The expiry warning proves the wrong-key attempt ran past 90 s.
        wait_for 100 "the session-expiry warning" session_expiry_logged devserver-wrong-key || arm_rc=1
        capture="$(peer_capture devserver-wrong-key)"
        after="$(peer_handshake)"
        kill "$DEVSERVER_PID" 2>/dev/null || true
        [ "$capture" = absent ] || arm_rc=1
        [ "$before" = "$after" ] || arm_rc=1
        ! grep -q 'tunnel connected' "$WORK/devserver-wrong-key.log" || arm_rc=1
        devserver_log devserver-wrong-key || arm_rc=1
        expiry_warns="$(session_warnings "$WORK/devserver-wrong-key.clean.log")"
        error_lines="$(awk '$2 == "ERROR" { n++ } END { print n+0 }' "$WORK/devserver-wrong-key.clean.log")"
        [ "$expiry_warns" = 1 ] && [ "$error_lines" = 0 ] || arm_rc=1
        verdict devserver-wrong-key "$arm_rc" "tunnel start logged, session warnings $expiry_warns (want 1), ERROR lines $error_lines (want 0), listener capture $capture (want absent), peer handshake stamp $before -> $after"
        { grep 'WireGuard tunnel started' "$WORK/devserver-wrong-key.log"; peer_wg_show; } >&2
    else
        arm_rc=1
        verdict devserver-wrong-key 1 "the raw listener did not start on the peer"
    fi
    [ "$arm_rc" = 0 ] || cat "$WORK/devserver-wrong-key.log" >&2
fi

if [ "$FAILED" != 0 ]; then
    log "FAIL: $FAILED arm(s) failed at $SHA; work dir kept at $WORK"
    exit 1
fi
log "PASS at $SHA against $SSH_TARGET ($PEER_KERNEL); work dir $WORK removed"
cleanup
trap - EXIT
rm -rf "${WORK:?}"
