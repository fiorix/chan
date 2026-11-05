#!/usr/bin/env bash
# End-to-end proof of chan-wireguard, the in-process WireGuard client, as
# built for WINDOWS and run on a Windows machine reached over SSH, against a
# REAL kernel WireGuard peer reached over SSH. The peer's `wg` and `ip`
# build an interface for the run, the crate's `wg-connect` example and a
# real `chan.exe devserver run --tunnel-wireguard` dial it from the Windows
# machine, and every claim is read back from the peer's `wg show` and the
# kernel's own WireGuard log.
#
# What it proves, one verdict line and exit status per arm:
#   wrong-key   a client file naming a wrong peer public key never completes
#               a handshake: the connect times out, the peer's handshake
#               stamp does not move, and the peer's UDP counters show the
#               initiations did arrive and were refused (the control that
#               the positive arms are not vacuous).
#   get         an HTTP GET through the tunnel returns the peer's known
#               files byte for byte (a short text and a 1 MiB blob), the
#               public key the crate derives matches `wg pubkey`, and the
#               peer shows the handshake and the traffic.
#   crlf        the same GET from a client file written the way Windows
#               tools write text, CRLF line endings behind a UTF-8 byte
#               order mark, both read back from the file before the run.
#   rekey       a tunnel with PersistentKeepalive held idle past the
#               protocol's 120 s rekey: the peer's handshake stamp moves
#               exactly once (the client's rekey, on its clock), its receive
#               counter grows while nothing is connected (the keepalives),
#               the kernel's log holds no handshake retry of its own, and
#               the GET after the hold still returns the file.
#   devserver   `chan.exe devserver run --tunnel-wireguard` logs the tunnel
#               up and its h2 dial reaches a raw listener on the peer's
#               tunnel address with the HTTP/2 connection preface, through
#               the devserver, the connector, the stack and the kernel. The
#               dial then fails at the HTTP level, which is expected.
#   devserver-wrong-key
#               the same dial with the wrong peer key reaches nothing.
#
# What it cannot prove: a peer behind a real NAT or a changing address, a
# tunnel URL by name, anything the gateway answers past the preface, the
# Windows machine sleeping (an SSH session does not survive that), and a
# Windows build other than x86_64-pc-windows-gnu.
#
# Usage:
#   wireguard-windows.sh [options] PEER_SSH ENDPOINT PEER_ADDRESS CLIENT_SSH
#     PEER_SSH      user@host the kernel peer is provisioned through
#     ENDPOINT      the peer's WireGuard UDP host:port as the CLIENT reaches it
#     PEER_ADDRESS  the peer's tunnel address with its prefix, e.g. 10.7.0.1/24
#     CLIENT_SSH    user@host of the Windows machine the client runs on
#   --peer-ssh-opt OPT    an extra ssh option for the peer, repeatable
#   --client-ssh-opt OPT  an extra ssh option for the client, repeatable; a
#                         `-p PORT` pair is passed to scp as `-P PORT`
#   --client-address IP   the client's tunnel address (default: the peer's plus one)
#   --listen-port PORT    the peer's WireGuard listen port (default: ENDPOINT's)
#   --interface NAME      the peer interface the run creates (default chanwg0;
#                         refused when it already exists)
#   --hold SECS           the rekey arm's idle hold (default 130, past the 120 s rekey)
#   --arms LIST           comma separated arms to run (default: all, in the order above)
#
# Prerequisites. On the peer: Linux with the wireguard module and dynamic
# debug (`/sys/kernel/debug/dynamic_debug/control`; the run switches the
# module's messages on, and off again unless it found them on), wireguard-tools (`wg`), iproute2,
# python3 (serves the files and the raw listener), sha256sum, journalctl,
# and passwordless sudo (`sudo -n`) for `ip`, `wg`, the kernel log and the
# debug switch; its firewall must admit the UDP port. On the client: Windows
# with the OpenSSH server, key authentication for CLIENT_SSH, and
# `powershell.exe` on the PATH (the login shell may be PowerShell or cmd);
# outbound UDP must be allowed, which the Windows firewall does by default.
# On this host: ssh, scp, python3, sha256sum, xxd, timeout, and the two
# Windows binaries: either WG_CONNECT_EXE and CHAN_EXE name built ones, or
# the tree builds them with `cargo zigbuild --target x86_64-pc-windows-gnu`
# (cargo-zigbuild, zig and the rustup target installed, and the web bundles
# chan.exe embeds built by `make web`). Exits 2 when a prerequisite is
# missing rather than passing.
#
# Everything runs under a throwaway work dir on this host, a per-run
# directory under the client's TEMP and a per-run work dir on the peer. The
# client and peer directories are deleted as the run exits; the host one is
# deleted on success and kept on failure. The kept work dir holds the run's
# client files with a private key that is worthless once the peer interface
# is deleted, which the exit path does, but treat it as a credential until
# it is gone.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHA="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
PEER_SSH_OPTS=()
CLIENT_SSH_OPTS=()
CLIENT_IP=""
LISTEN_PORT=""
IFACE=chanwg0
HOLD=130
ARMS="wrong-key,get,crlf,rekey,devserver,devserver-wrong-key"
HTTP_PORT=8080
RAW_PORT=4443
WINDOWS_TARGET=x86_64-pc-windows-gnu
POSITIONAL=()

log() { printf 'wireguard-windows: %s\n' "$*" >&2; }
refuse() { log "cannot run: $*"; exit 2; }

while [ $# -gt 0 ]; do
    case "$1" in
        --peer-ssh-opt) PEER_SSH_OPTS+=("$2"); shift 2 ;;
        --client-ssh-opt) CLIENT_SSH_OPTS+=("$2"); shift 2 ;;
        --client-address) CLIENT_IP="$2"; shift 2 ;;
        --listen-port) LISTEN_PORT="$2"; shift 2 ;;
        --interface) IFACE="$2"; shift 2 ;;
        --hold) HOLD="$2"; shift 2 ;;
        --arms) ARMS="$2"; shift 2 ;;
        -h | --help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | cut -c3-; exit 0 ;;
        -*) refuse "unknown option $1" ;;
        *) POSITIONAL+=("$1"); shift ;;
    esac
done
[ "${#POSITIONAL[@]}" -eq 4 ] || refuse "usage: wireguard-windows.sh [options] PEER_SSH ENDPOINT PEER_ADDRESS CLIENT_SSH"
PEER_SSH="${POSITIONAL[0]}"
ENDPOINT="${POSITIONAL[1]}"
PEER_CIDR="${POSITIONAL[2]}"
CLIENT_SSH="${POSITIONAL[3]}"
case "$HOLD" in '' | *[!0-9]*) refuse "--hold takes a number of seconds" ;; esac
[ "$HOLD" -gt 120 ] || refuse "--hold must exceed the protocol's 120 s rekey time"

for tool in ssh scp python3 sha256sum xxd timeout; do
    command -v "$tool" >/dev/null 2>&1 || refuse "$tool is not installed"
done
runs() { case ",$ARMS," in *",$1,"*) return 0 ;; esac; return 1; }

# scp spells the port -P where ssh spells it -p; everything else is shared.
CLIENT_SCP_OPTS=()
for opt in "${CLIENT_SSH_OPTS[@]}"; do
    [ "$opt" = -p ] && opt=-P
    CLIENT_SCP_OPTS+=("$opt")
done

# The peer's address, its network (the client's AllowedIPs) and the client's
# default address all derive from PEER_ADDRESS.
PEER_IP="$(python3 -c 'import ipaddress,sys; print(ipaddress.ip_interface(sys.argv[1]).ip)' "$PEER_CIDR")" \
    || refuse "$PEER_CIDR is not an address with a prefix"
PEER_NET="$(python3 -c 'import ipaddress,sys; print(ipaddress.ip_interface(sys.argv[1]).network)' "$PEER_CIDR")"
[ -n "$CLIENT_IP" ] || CLIENT_IP="$(python3 -c 'import ipaddress,sys; print(ipaddress.ip_interface(sys.argv[1]).ip + 1)' "$PEER_CIDR")"
[ -n "$LISTEN_PORT" ] || LISTEN_PORT="${ENDPOINT##*:}"
case "$LISTEN_PORT" in '' | *[!0-9]*) refuse "no port in ENDPOINT $ENDPOINT" ;; esac

# The Windows binaries: named, or cross-built here with zig as the C
# compiler and linker, since ring's C sources need one and a MinGW is
# rarely at hand.
NEED_CHAN=""
if runs devserver || runs devserver-wrong-key; then NEED_CHAN=1; fi
zigbuild_ready() {
    command -v zig >/dev/null 2>&1 || refuse "zig is not installed (needed to cross-build the Windows binaries; or name them with WG_CONNECT_EXE and CHAN_EXE)"
    cargo zigbuild --help >/dev/null 2>&1 || refuse "cargo-zigbuild is not installed (cargo install cargo-zigbuild)"
    rustup target list --installed 2>/dev/null | grep -Fxq "$WINDOWS_TARGET" || refuse "the $WINDOWS_TARGET target is not installed (rustup target add $WINDOWS_TARGET)"
}
if [ -z "${WG_CONNECT_EXE:-}" ]; then
    zigbuild_ready
    log "cross-building the wg-connect example for $WINDOWS_TARGET at $SHA"
    (cd "$REPO" && cargo zigbuild --locked --release --target "$WINDOWS_TARGET" -p chan-wireguard --example wg-connect >/dev/null) \
        || refuse "cargo zigbuild --example wg-connect failed"
    WG_CONNECT_EXE="$REPO/target/$WINDOWS_TARGET/release/examples/wg-connect.exe"
fi
[ -f "$WG_CONNECT_EXE" ] || refuse "no wg-connect example at $WG_CONNECT_EXE"
if [ -n "$NEED_CHAN" ]; then
    if [ -z "${CHAN_EXE:-}" ]; then
        zigbuild_ready
        [ -f "$REPO/web/dist/index.html" ] && [ -f "$REPO/web-launcher/dist/index.html" ] \
            || refuse "chan.exe embeds web/dist and web-launcher/dist; build them with make web"
        log "cross-building chan for $WINDOWS_TARGET at $SHA"
        (cd "$REPO" && cargo zigbuild --locked --release --target "$WINDOWS_TARGET" -p chan >/dev/null) \
            || refuse "cargo zigbuild -p chan failed"
        CHAN_EXE="$REPO/target/$WINDOWS_TARGET/release/chan.exe"
    fi
    [ -f "$CHAN_EXE" ] || refuse "no chan binary at $CHAN_EXE"
fi

WORK="$(mktemp -d "${TMPDIR:-/var/tmp}/chan-wireguard-windows.XXXXXX")"
chmod 700 "$WORK"

peer() {
    # peer <command...>: run a command on the peer, bounded.
    timeout 60 ssh -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "${PEER_SSH_OPTS[@]}" "$PEER_SSH" -- "$@"
}
peer_script() {
    # peer_script <args...>: run the script on stdin on the peer with the
    # arguments. ssh joins its arguments into one string the remote shell
    # splits again, so each is quoted first or a pid list would arrive as
    # several arguments and shift the rest.
    local args=""
    [ $# -eq 0 ] || args="$(printf ' %q' "$@")"
    timeout 60 ssh -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "${PEER_SSH_OPTS[@]}" "$PEER_SSH" -- "bash -s --$args"
}
client_ps() {
    # client_ps <seconds> < script: run the PowerShell script on stdin on
    # the client, bounded, with the script's exit status. The script travels
    # as an encoded command, so no quoting survives two shells and a
    # `$LASTEXITCODE` reaches ssh as the status. PowerShell's progress
    # records and other noise on stderr go to a log in the work dir.
    local secs="$1" encoded
    encoded="$(python3 -c 'import base64,sys; print(base64.b64encode(sys.stdin.read().encode("utf-16-le")).decode())')"
    timeout "$secs" ssh -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "${CLIENT_SSH_OPTS[@]}" "$CLIENT_SSH" -- \
        powershell -NoProfile -NonInteractive -EncodedCommand "$encoded" 2>>"$WORK/client-stderr.log"
}
strip_cr() { sed -i 's/\r$//' "$1"; }

# Every prerequisite on the peer is probed before anything is created there.
if ! PROBE="$(peer 'sudo -n wg --version >/dev/null 2>&1 || echo no-wg; sudo -n ip -V >/dev/null 2>&1 || echo no-ip; command -v python3 >/dev/null 2>&1 || echo no-python3; command -v sha256sum >/dev/null 2>&1 || echo no-sha256sum; command -v journalctl >/dev/null 2>&1 || echo no-journalctl; sudo -n true 2>/dev/null || echo no-sudo; sudo -n test -w /sys/kernel/debug/dynamic_debug/control 2>/dev/null || echo no-dynamic-debug; sudo -n grep -q "\\[wireguard\\].* =p " /sys/kernel/debug/dynamic_debug/control 2>/dev/null && echo debug-already-on; ip link show '"$IFACE"' >/dev/null 2>&1 && echo iface-exists; uname -sr' 2>&1)"; then
    refuse "ssh to $PEER_SSH failed: $PROBE"
fi
for missing in no-wg no-ip no-python3 no-sha256sum no-journalctl no-sudo no-dynamic-debug; do
    case "$PROBE" in *"$missing"*) refuse "the peer lacks ${missing#no-} (or sudo -n for it): $PROBE" ;; esac
done
case "$PROBE" in *iface-exists*) refuse "interface $IFACE already exists on the peer; this run creates and deletes its own" ;; esac
# The module's debug messages are left as the run found them: a peer that
# already logs them (another run, an operator) keeps logging.
DEBUG_WAS_ON=""
case "$PROBE" in *debug-already-on*) DEBUG_WAS_ON=1 ;; esac
PEER_KERNEL="$(printf '%s\n' "$PROBE" | tail -1)"

# And on the client: Windows on x86-64, reached through PowerShell.
if ! CLIENT_PROBE="$(client_ps 60 <<'PS'
$ErrorActionPreference = 'Stop'
"platform=$([Environment]::OSVersion.Platform)"
"arch=$env:PROCESSOR_ARCHITECTURE"
"powershell=$($PSVersionTable.PSVersion)"
"os=$((Get-CimInstance Win32_OperatingSystem).Caption) build $([Environment]::OSVersion.Version.Build)"
PS
)"; then
    refuse "ssh to $CLIENT_SSH running PowerShell failed: $CLIENT_PROBE $(cat "$WORK/client-stderr.log")"
fi
CLIENT_PROBE="$(printf '%s\n' "$CLIENT_PROBE" | tr -d '\r')"
client_field() { printf '%s\n' "$CLIENT_PROBE" | sed -n "s/^$1=//p"; }
[ "$(client_field platform)" = Win32NT ] || refuse "$CLIENT_SSH is not Windows: $CLIENT_PROBE"
[ "$(client_field arch)" = AMD64 ] || refuse "$CLIENT_SSH is not x86-64, which the $WINDOWS_TARGET binaries need: $CLIENT_PROBE"
CLIENT_OS="$(client_field os), PowerShell $(client_field powershell)"

export CHAN_HOME="$WORK/chan-home"
mkdir -p "$CHAN_HOME"
# A run launched from inside a chan terminal must not inherit a tunnel
# token, URL or any other session state.
for v in $(compgen -v | grep -E '^CHAN_' | grep -vE '^CHAN_(HOME|EXE)$'); do unset "$v"; done

HOST_PIDS=()
PEER_WORK=""
PEER_PIDS=""
IFACE_CREATED=""
CLIENT_DIR=""
cleanup() {
    local pid
    for pid in "${HOST_PIDS[@]:-}"; do
        [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    done
    sleep 0.5
    for pid in "${HOST_PIDS[@]:-}"; do
        [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
    done
    # Only what the run made on the client: the processes running from its
    # directory, then the directory, which only this run's tag names.
    if [ -n "$CLIENT_DIR" ]; then
        client_ps 60 <<PS >/dev/null 2>&1 || log "client cleanup did not finish; check $CLIENT_SSH for $CLIENT_DIR"
Get-Process | Where-Object { \$_.Path -like '$CLIENT_DIR\*' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
if (Test-Path -LiteralPath '$CLIENT_DIR') { Remove-Item -LiteralPath '$CLIENT_DIR' -Recurse -Force }
PS
    fi
    # Only what the run made on the peer: its processes by recorded pid,
    # the interface it created, its work dir, identified by the marker the
    # run wrote into it, and the debug switch when this run turned it on.
    if [ -n "$PEER_WORK" ] || [ -n "$IFACE_CREATED" ]; then
        peer_script "$PEER_WORK" "$PEER_PIDS" "$IFACE_CREATED" "$DEBUG_WAS_ON" <<'PEER' >/dev/null 2>&1 || log "peer cleanup did not finish; check $PEER_SSH for $IFACE and $PEER_WORK"
work="$1"; pids="$2"; iface="$3"; debug_was_on="$4"
for pid in $pids; do kill "$pid" 2>/dev/null || true; done
[ -n "$iface" ] && sudo -n ip link del "$iface" 2>/dev/null || true
[ -n "$debug_was_on" ] || sudo -n sh -c 'echo module wireguard -p > /sys/kernel/debug/dynamic_debug/control' 2>/dev/null || true
if [ -n "$work" ] && [ -f "$work/.chan-wireguard-windows" ]; then rm -rf -- "${work:?}"; fi
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
        printf 'wireguard-windows: %s rc=0 PASS %s\n' "$arm" "$*"
    else
        printf 'wireguard-windows: %s rc=%s FAIL %s\n' "$arm" "$rc" "$*"
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
peer_journal() {
    # peer_journal <since epoch> <out>: the kernel's lines for the interface
    # since the stamp, into the file.
    peer "sudo -n journalctl -k --no-pager -o short-iso --since @$1" 2>/dev/null | grep -F "wireguard: $IFACE: " > "$2" || true
}

log "work dir $WORK, chan $SHA, peer $PEER_SSH ($PEER_KERNEL), client $CLIENT_SSH ($CLIENT_OS), endpoint $ENDPOINT, peer $PEER_CIDR, client $CLIENT_IP"

# 1. The client's directory under its TEMP, named by this run's tag, and the
# binaries copied into it, each checked by hash on arrival (so a quarantined
# or rewritten file is seen here and not as a mystery later).
CLIENT_TAG="chan-wireguard-windows.$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
if ! CLIENT_DIR="$(client_ps 60 <<PS
\$ErrorActionPreference = 'Stop'
\$dir = Join-Path \$env:TEMP '$CLIENT_TAG'
New-Item -ItemType Directory -Path \$dir | Out-Null
\$dir
PS
)"; then
    CLIENT_DIR=""
    log "creating the client directory failed: $(cat "$WORK/client-stderr.log")"
    exit 1
fi
CLIENT_DIR="$(printf '%s\n' "$CLIENT_DIR" | tr -d '\r' | tail -1)"
case "$CLIENT_DIR" in
    [A-Za-z]:\\*"\\$CLIENT_TAG") ;;
    *) log "the client directory is not the one asked for: $CLIENT_DIR"; CLIENT_DIR=""; exit 1 ;;
esac
CLIENT_SCP_DIR="${CLIENT_DIR//\\//}"
client_sha() {
    # client_sha <file name>: the SHA-256 of a file in the client directory.
    client_ps 60 <<PS | tr -d '\r' | tail -1
(Get-FileHash -Algorithm SHA256 -LiteralPath "$CLIENT_DIR\\$1").Hash.ToLower()
PS
}
copy_to_client() {
    # copy_to_client <local file> <name>: scp, then the hash read back.
    local local_sha
    local_sha="$(sha256sum "$1" | cut -d' ' -f1)"
    scp -q -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "${CLIENT_SCP_OPTS[@]}" "$1" "$CLIENT_SSH:$CLIENT_SCP_DIR/$2" \
        || { log "copying $1 to the client failed"; exit 1; }
    [ "$(client_sha "$2")" = "$local_sha" ] || { log "$2 on the client does not hash as $1 does"; exit 1; }
    log "copied $2 ($local_sha) to $CLIENT_DIR"
}
copy_to_client "$WG_CONNECT_EXE" wg-connect.exe
[ -z "$NEED_CHAN" ] || copy_to_client "$CHAN_EXE" chan.exe

# 2. Keys, interface, the kernel's debug messages and the served files on
# the peer. The client's private key is made by the peer's `wg genkey` and
# carried back over SSH, so the public key the crate derives from it can be
# checked against `wg pubkey`. The debug switch is thrown after the
# interface exists: the module is loaded by then, and a switch thrown
# before the module loads is dropped.
if ! SETUP="$(peer_script "$IFACE" "$LISTEN_PORT" "$PEER_CIDR" "$CLIENT_IP" "$PEER_IP" "$HTTP_PORT" <<'PEER'
set -euo pipefail
iface="$1"; port="$2"; peer_cidr="$3"; client_ip="$4"; peer_ip="$5"; http_port="$6"
umask 077
work="$(mktemp -d /tmp/chan-wireguard-windows.XXXXXX)"
touch "$work/.chan-wireguard-windows"
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
sudo -n sh -c 'echo module wireguard +p > /sys/kernel/debug/dynamic_debug/control'
echo "debug_sites=$(sudo -n grep -c '\[wireguard\].* =p ' /sys/kernel/debug/dynamic_debug/control)"
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
DEBUG_SITES="$(setup_field debug_sites)"
[ -n "$PEER_WORK" ] && [ -n "$SERVER_PUB" ] && [ -n "$CLIENT_KEY" ] && [ -n "$HELLO_SHA" ] || { log "peer setup returned an incomplete record"; exit 1; }
[ "${DEBUG_SITES:-0}" -gt 0 ] || { log "the peer's wireguard module has no debug messages switched on"; exit 1; }
log "peer interface $IFACE up at $PEER_CIDR, serving $PEER_IP:$HTTP_PORT, $DEBUG_SITES kernel debug sites on; client public key $CLIENT_PUB"

# 3. The client files: on the client, as UTF-8 without a byte order mark and
# with LF line endings, the shape `wg genkey` and an editor on the peer
# produce; and a copy in the work dir, owner-only, for the record.
client_file_text() {
    # client_file_text <peer public key> [extra peer lines...]
    local pub="$1"; shift
    printf '[Interface]\nPrivateKey = %s\nAddress = %s/32\n\n[Peer]\nPublicKey = %s\nEndpoint = %s\nAllowedIPs = %s\n' \
        "$CLIENT_KEY" "$CLIENT_IP" "$pub" "$ENDPOINT" "$PEER_NET"
    for line in "$@"; do printf '%s\n' "$line"; done
}
write_client_file() {
    # write_client_file <name> <peer public key> [extra peer lines...]
    local name="$1"; shift
    (umask 077; client_file_text "$@" > "$WORK/$name")
    client_ps 60 <<PS >/dev/null
\$ErrorActionPreference = 'Stop'
\$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$(base64 -w0 < "$WORK/$name")'))
[IO.File]::WriteAllText("$CLIENT_DIR\\$name", \$text, (New-Object Text.UTF8Encoding \$false))
PS
}
write_client_file client.conf "$SERVER_PUB"
write_client_file client-keepalive.conf "$SERVER_PUB" "PersistentKeepalive = 25"
write_client_file client-wrong-key.conf "$WRONG_PUB"

body_sha() { sed -n "s/^body $2: [0-9]* bytes, sha256 \([0-9a-f]*\)$/\1/p" "$1"; }
example_status() {
    # example_status <log> <ssh rc>: the example's exit status from the
    # sentinel line the session prints after it, or `ssh:<rc>` when the
    # session ended without one. The status cannot ride ssh's own: the
    # login shell is PowerShell, which answers 1 for any failing native
    # command whatever its code, so a connect that timed out (2) would read
    # as an unknown failure (1).
    local status
    status="$(sed -n 's/^wg-connect-status=//p' "$1" | tail -1)"
    [ -n "$status" ] && printf '%s\n' "$status" || printf 'ssh:%s\n' "$2"
}
run_example() {
    # run_example <log> <client file name> <args...>: the example on the
    # client, foreground, its exit status recorded in the log and printed.
    local out="$1" file="$2" rc; shift 2
    set +e
    client_ps $((HOLD + 120)) > "$out" <<PS
& "$CLIENT_DIR\wg-connect.exe" "$CLIENT_DIR\\$file" "$PEER_IP:$HTTP_PORT" $*
"wg-connect-status=\$LASTEXITCODE"
PS
    rc=$?
    set -e
    strip_cr "$out"
    rc="$(example_status "$out" "$rc")"
    echo "rc=$rc" >> "$out"
    echo "$rc"
}

# wrong-key: the control. The peer's handshake stamp must not move, the
# connect must time out, and the peer must have taken UDP datagrams from
# the attempt (the initiations it refused), or the arm proves nothing.
if runs wrong-key; then
    before="$(peer_handshake)"; udp_before="$(peer_udp_in)"
    rc="$(run_example "$WORK/wrong-key.out" client-wrong-key.conf /hello.txt --timeout 15)"
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
    { grep '^status' "$WORK/get.out" "$WORK/get-big.out"; peer_wg_show; } >&2
    [ "$arm_rc" = 0 ] || cat "$WORK/get.out" "$WORK/get-big.out" >&2
fi

# crlf: the file as Windows tools write it. PowerShell 5.1's `Out-File
# -Encoding utf8` and Notepad's "UTF-8 with BOM" put a byte order mark
# first and end lines with CRLF; the first sixteen bytes are read back so
# the arm is known to test that shape and not a copy of the LF file.
CRLF_HEAD="EF-BB-BF-5B-49-6E-74-65-72-66-61-63-65-5D-0D-0A"
if runs crlf; then
    head_bytes="$(client_ps 60 <<PS | tr -d '\r' | tail -1
\$ErrorActionPreference = 'Stop'
\$text = [IO.File]::ReadAllText("$CLIENT_DIR\client.conf").Replace("\`n", "\`r\`n")
[IO.File]::WriteAllText("$CLIENT_DIR\client-crlf.conf", \$text, (New-Object Text.UTF8Encoding \$true))
[BitConverter]::ToString([IO.File]::ReadAllBytes("$CLIENT_DIR\client-crlf.conf")[0..15])
PS
)" || head_bytes="unwritten"
    before="$(peer_handshake)"
    rc="$(run_example "$WORK/crlf.out" client-crlf.conf /hello.txt)"
    after="$(peer_handshake)"
    arm_rc=0
    [ "$head_bytes" = "$CRLF_HEAD" ] || arm_rc=1
    [ "$rc" = 0 ] && [ "$(body_sha "$WORK/crlf.out" 1)" = "$HELLO_SHA" ] || arm_rc=1
    grep -q "^tunnel: endpoint $ENDPOINT, public key $CLIENT_PUB, keepalive off$" "$WORK/crlf.out" || arm_rc=1
    [ "$after" != "0" ] && [ "$after" != "$before" ] || arm_rc=1
    verdict crlf "$arm_rc" "file starts $head_bytes (BOM, [Interface], CRLF), rc=$rc sha $(body_sha "$WORK/crlf.out" 1 | cut -c1-12), peer handshake stamp $before -> $after"
    [ "$arm_rc" = 0 ] || cat "$WORK/crlf.out" >&2
fi

# rekey: a tunnel with PersistentKeepalive held idle past the protocol's
# 120 s rekey. The sampler records this host's clock, then the peer's
# handshake stamp and receive counter, every 5 s, while the example idles.
# The initiator rekeys at REKEY_AFTER_TIME once it has sent data on the
# session; chan's connect sends its first data in the tick that established
# the session and equal stamps count, so the rekey is on the client's clock
# every time, not only when a tick split the first exchange. The kernel, the
# responder, never re-handshakes on its own: its log for the hold holds no
# retry, and the keepalives it received are counted.
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
if runs rekey; then
    : > "$WORK/rekey.samples"; : > "$WORK/rekey.hold"
    rekey_since=$(( $(date +%s) - 5 ))
    set +e
    client_ps $((HOLD + 120)) > "$WORK/rekey.out" <<PS &
& "$CLIENT_DIR\wg-connect.exe" "$CLIENT_DIR\client-keepalive.conf" "$PEER_IP:$HTTP_PORT" /hello.txt --hold $HOLD
"wg-connect-status=\$LASTEXITCODE"
PS
    example_pid=$!
    set -e
    HOST_PIDS+=("$example_pid")
    sample_peer_during "$example_pid" "$WORK/rekey.samples" &
    sampler=$!
    wait_for 60 "the rekey hold to begin" hold_started "$WORK/rekey.out" "$WORK/rekey.hold" || true
    set +e
    wait "$example_pid"; rc=$?
    wait "$sampler"
    set -e
    strip_cr "$WORK/rekey.out"
    rc="$(example_status "$WORK/rekey.out" "$rc")"
    echo "rc=$rc" >> "$WORK/rekey.out"
    # The kernel's lines for the interface across the whole hold: the
    # regression guard reads them for a retry it must not find.
    peer_journal "$rekey_since" "$WORK/rekey.journal"
    retries="$(grep -c 'Retrying handshake' "$WORK/rekey.journal" || true)"
    keepalives="$(grep -c 'Receiving keepalive packet' "$WORK/rekey.journal" || true)"
    hold_at="$(cat "$WORK/rekey.hold" 2>/dev/null || echo 0)"
    # A sample taken before the first handshake reads 0 and is not a stamp.
    first="$(awk '$2 != 0 { print $2; exit }' "$WORK/rekey.samples")"
    last="$(awk 'END { print $2 }' "$WORK/rekey.samples")"
    stamps="$(awk '$2 != 0 { print $2 }' "$WORK/rekey.samples" | sort -u | wc -l)"
    # Receive counters at least 8 s into the hold (the first GET's bytes
    # have all landed) and before its last 5 s (the second GET is not yet
    # counted): the growth between them is keepalives and the rekey alone.
    early="$(awk -v t="$((hold_at + 8))" '$1 >= t { print $3; exit }' "$WORK/rekey.samples")"
    late="$(awk -v t="$((hold_at + HOLD - 5))" '$1 <= t { v = $3 } END { print v }' "$WORK/rekey.samples")"
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
    # At least three 32-byte keepalives across the hold (one every 25 s).
    [ "$hold_at" != 0 ] && [ -n "$early" ] && [ -n "$late" ] && [ "$late" -ge $((early + 96)) ] || arm_rc=1
    # The kernel never retried a handshake, and it saw the keepalives.
    [ "$retries" = 0 ] && [ "$keepalives" -ge 3 ] || arm_rc=1
    verdict rekey "$arm_rc" "rc=$rc, peer handshake stamp $first -> $last (+$((${last:-0} - ${first:-0}))s, $stamps distinct), client saw the handshake ${ago:-?}s before the second GET, peer received $early -> $late bytes while idle (+$((${late:-0} - ${early:-0})), a keepalive is 32), kernel log: $retries handshake retries, $keepalives keepalives, second GET sha $(body_sha "$WORK/rekey.out" 2 | cut -c1-12)"
    { grep -E '^(status|hold|response)' "$WORK/rekey.out"; sed 's/^/    sample /' "$WORK/rekey.samples"; sed 's/^/    kernel /' "$WORK/rekey.journal"; peer_wg_show; } >&2
    [ "$arm_rc" = 0 ] || cat "$WORK/rekey.out" >&2
fi

# The devserver arms: a raw listener on the peer's tunnel address records
# the first 64 bytes of the one connection it accepts, and chan.exe runs on
# the client with its two streams in files there, read back after every
# poll. The devserver runs under a PowerShell session that starts it and
# then waits on it, kept open in the background on this host for the arm:
# Windows OpenSSH ends a session's child processes when the launching
# channel closes, so a devserver started and left by an ssh command that
# returns is killed before it dials. The run reads its pid from a file and
# stops it by pid, which lets the waiting session end.
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
    # start_devserver <name> <client file name>: a devserver on the client
    # dialing the raw listener through the tunnel, under a throwaway
    # CHAN_HOME in the client directory. The launching session starts it,
    # writes its pid to <name>.pid and waits on it, and is backgrounded on
    # this host for the arm; the pid is read back and left in DEVSERVER_PID.
    local name="$1" file="$2" port=$((20000 + RANDOM % 20000))
    DEVSERVER_SESSION_PID=""
    DEVSERVER_PID=""
    client_ps $((HOLD + 180)) >/dev/null 2>&1 <<PS &
\$ErrorActionPreference = 'Stop'
\$env:CHAN_HOME = "$CLIENT_DIR\\$name-home"
New-Item -ItemType Directory -Path \$env:CHAN_HOME -Force | Out-Null
\$env:CHAN_UPDATE_CHECK = '0'
\$p = Start-Process -FilePath "$CLIENT_DIR\chan.exe" -ArgumentList @('devserver', 'run', '--bind', '127.0.0.1', '--port', '$port', '--tunnel-wireguard', "$CLIENT_DIR\\$file", '--tunnel-url', 'http://$PEER_IP:$RAW_PORT/v1/tunnel', '--tunnel-token', 'chan_pat_wireguard_windows_e2e') -RedirectStandardOutput "$CLIENT_DIR\\$name.out" -RedirectStandardError "$CLIENT_DIR\\$name.err" -WindowStyle Hidden -PassThru
Set-Content -LiteralPath "$CLIENT_DIR\\$name.pid" -Value \$p.Id
Wait-Process -Id \$p.Id
PS
    DEVSERVER_SESSION_PID=$!
    HOST_PIDS+=("$DEVSERVER_SESSION_PID")
    # The pid file appears once Start-Process has launched the devserver.
    local deadline=$((SECONDS + 30))
    until DEVSERVER_PID="$(client_ps 30 <<PS | tr -d '\r' | tail -1
Get-Content -LiteralPath "$CLIENT_DIR\\$name.pid" -ErrorAction SilentlyContinue
PS
)"; [ -n "$DEVSERVER_PID" ]; do
        [ "$SECONDS" -ge "$deadline" ] && { log "the devserver did not record its pid on the client"; return 1; }
        kill -0 "$DEVSERVER_SESSION_PID" 2>/dev/null || { log "the devserver session ended before it started"; return 1; }
        sleep 1
    done
    case "$DEVSERVER_PID" in '' | *[!0-9]*) log "the devserver pid on the client is not a number: $DEVSERVER_PID"; DEVSERVER_PID=""; return 1 ;; esac
}
stop_devserver() {
    [ -n "${DEVSERVER_PID:-}" ] && client_ps 60 <<PS >/dev/null 2>&1 || true
Stop-Process -Id $DEVSERVER_PID -Force -ErrorAction SilentlyContinue
PS
    # The waiting session ends once its process is gone.
    [ -n "${DEVSERVER_SESSION_PID:-}" ] && wait "$DEVSERVER_SESSION_PID" 2>/dev/null || true
    DEVSERVER_PID=""
    DEVSERVER_SESSION_PID=""
}
devserver_log() {
    # devserver_log <name>: both of the devserver's streams, fetched into
    # the work dir.
    client_ps 60 > "$WORK/$1.log" <<PS || true
Get-Content -Raw -LiteralPath "$CLIENT_DIR\\$1.out" -ErrorAction SilentlyContinue
Get-Content -Raw -LiteralPath "$CLIENT_DIR\\$1.err" -ErrorAction SilentlyContinue
PS
    strip_cr "$WORK/$1.log"
}
tunnel_start_logged() {
    # tunnel_start_logged <name> <client file name>
    devserver_log "$1"
    grep -qF "chan devserver: WireGuard tunnel started from $CLIENT_DIR\\$2: endpoint " "$WORK/$1.log" \
        && grep -qF "public key $CLIENT_PUB" "$WORK/$1.log"
}

DEVSERVER_PID=""
if runs devserver; then
    arm_rc=0
    if listener_pid="$(start_raw_listener devserver)"; then
        PEER_PIDS="$PEER_PIDS $listener_pid"
        before="$(peer_handshake)"
        if start_devserver devserver client.conf; then
            wait_for 60 "the tunnel-start line" tunnel_start_logged devserver client.conf || arm_rc=1
            wait_for 60 "the raw listener to see the dial" peer_has_capture devserver || arm_rc=1
        else
            arm_rc=1
        fi
        capture="$(peer_capture devserver)"
        after="$(peer_handshake)"
        stop_devserver
        devserver_log devserver
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
        if start_devserver devserver-wrong-key client-wrong-key.conf; then
            wait_for 60 "the tunnel-start line" tunnel_start_logged devserver-wrong-key client-wrong-key.conf || arm_rc=1
            # The dial has 20 s to reach the listener; with a wrong key it must not.
            sleep 20
        else
            arm_rc=1
        fi
        capture="$(peer_capture devserver-wrong-key)"
        after="$(peer_handshake)"
        stop_devserver
        devserver_log devserver-wrong-key
        [ "$capture" = absent ] || arm_rc=1
        [ "$before" = "$after" ] || arm_rc=1
        ! grep -q 'tunnel connected' "$WORK/devserver-wrong-key.log" || arm_rc=1
        verdict devserver-wrong-key "$arm_rc" "tunnel start logged, listener accepted nothing in 20 s (capture $capture), peer handshake stamp $before -> $after"
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
log "PASS at $SHA: client $CLIENT_SSH ($CLIENT_OS) against $PEER_SSH ($PEER_KERNEL); work dir $WORK removed"
cleanup
trap - EXIT
rm -rf "${WORK:?}"
