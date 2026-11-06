#!/usr/bin/env bash
# End-to-end proof of the desktop's WireGuard fabric on WINDOWS: a
# chan-desktop NSIS installer installed on a Windows machine reached over
# SSH, a gateway row naming a wg-quick file whose peer is a REAL kernel
# WireGuard peer reached over SSH, and a WebView2 window driven over the
# remote debugging port to an origin on the peer's tunnel address. The
# desktop's tunnel, its loopback proxy, its HTTP legs and its WebView2
# webviews are the real ones; the gateway is a logging HTTP listener on the
# peer that answers 404 to everything but a test page, its beacon and a
# WebSocket.
#
# WebView2 (Chromium) never sends loopback through a proxy, so the webview
# arms need a destination inside AllowedIPs; the peer's tunnel address is
# one, and the probes arm shows it is unreachable from the client without
# the proxy, so a page that loads from it came through the tunnel.
#
# What it proves, one verdict line and exit status per arm:
#   tunnel        the desktop starts the tunnel from the row's file, and the
#                 peer shows a handshake (the file's keepalive makes it happen
#                 at start, before any connection).
#   proxy         the desktop binds its loopback proxy over the tunnel.
#   webview-args  the desktop's WebView2 browser process carries
#                 `--proxy-server=http://<that proxy>`, added by wry from the
#                 fabric's proxy, next to the run's remote debugging port.
#   discovery     the gateway connect's discovery GET reaches the peer from
#                 the client's tunnel address, and the desktop reads the 404.
#   probes        a plain forward and a CONNECT through the proxy reach the
#                 peer (curl.exe on the client), and the same address without
#                 the proxy does not answer (the control that it is only
#                 reachable through the tunnel).
#   webview       the desktop's window, navigated to the peer origin, loads
#                 the page through the proxy (its document's remote address
#                 is the proxy), the peer logs the request from the client's
#                 tunnel address with WebView2's user agent, and the page's
#                 own fetch reaches the peer too.
#   webview-ws    the page's WebSocket to the peer, which a browser sends to
#                 a proxy as CONNECT, is answered 101 and delivers the peer's
#                 frame; the proxy logged a CONNECT through the tunnel past
#                 the probes arm's.
#   loopback      nothing on loopback entered the proxy, in a log that holds
#                 the proxy's tunnel forwards: the local window's own origin
#                 is direct on Windows.
#   config        the gateway row and its file survive the desktop's rewrite
#                 of its config at start.
#   refusals      the proxy refused nothing in the positive run, in a log
#                 that holds its forwards and CONNECTs.
#   wrong-key     the desktop restarted on a file naming a wrong peer key:
#                 the window's navigation ends in the proxy's 504, the peer
#                 logs no request and its handshake stamp does not move, and
#                 the initiations the desktop logs sending arrive at the peer
#                 as UDP datagrams (the control that the positive arms are
#                 not vacuous). One session expiry logs at WARN within
#                 100 s of tunnel start, and no ERROR-level line appears.
#
# What it cannot prove: a real gateway's TLS and identity behind the proxy,
# the window feed's WebSocket (the stand-in has no roster), the launcher
# webview (its navigation handler keeps it on its own origin), and a peer
# behind NAT or at a changing address.
#
# Usage:
#   desktop-wireguard-windows.sh [options] PEER_SSH ENDPOINT PEER_ADDRESS CLIENT_SSH INSTALLER
#     PEER_SSH      user@host the kernel peer is provisioned through
#     ENDPOINT      the peer's WireGuard UDP address:port as the CLIENT reaches
#                   it; an IP literal, so the run does not depend on the
#                   Windows resolver (a name works since the desktop looks it
#                   up on each handshake, but this suite has not run one)
#     PEER_ADDRESS  the peer's tunnel address with its prefix, e.g. 10.7.0.1/24
#     CLIENT_SSH    user@host of the Windows machine, with a logged-on desktop
#                   session for that user
#     INSTALLER     the chan-desktop NSIS installer (Chan_<version>_x64-setup.exe);
#                   its Authenticode status is logged, not required
#   --peer-ssh-opt OPT    an extra ssh option for the peer, repeatable; a
#                         `-p PORT` pair is passed to scp as `-P PORT`
#   --client-ssh-opt OPT  an extra ssh option for the client, repeatable, the same
#   --client-address IP   the client's tunnel address (default: the peer's plus one)
#   --listen-port PORT    the peer's WireGuard listen port (default: ENDPOINT's)
#   --interface NAME      the peer interface the run creates (default chanwg0;
#                         refused when it already exists)
#   --cdp-port PORT       WebView2's remote debugging port on the client (default
#                         9222; refused when something listens there)
#   --keep                keep the host work dir (screenshots, records, logs) on success
#
# Prerequisites. On the peer: Linux with the wireguard module,
# wireguard-tools, iproute2, python3, and passwordless sudo (`sudo -n`) for
# `ip` and `wg`; its firewall must admit the UDP port. On the client:
# Windows on x86-64 with the OpenSSH server, key authentication, PowerShell,
# curl.exe, the WebView2 runtime, the SSH user logged on to the desktop (the
# desktop is started there by a one-shot scheduled task, since a program
# started from an SSH session never reaches it), and none of the state the
# run makes: no chan-desktop install or uninstall entry, `~/.chan`, app or
# WebView2 data, installer registry key, shortcut, or the desktop's
# `%LOCALAPPDATA%\chan\bin` on the user Path. The run installs, then
# uninstalls and deletes all of it, and puts the user Path back as it found
# it. On this host: ssh, scp, python3, sha256sum, base64, timeout and Node 22
# or later. Exits 2 when a prerequisite is missing rather than passing.
#
# Everything runs under a throwaway work dir on this host, a per-run
# directory under the client's TEMP and a per-run work dir on the peer. The
# client and peer directories, the install, the scheduled task and the peer
# interface are removed as the run exits, and a cleanup that leaves any of
# them behind names what it left and fails the run. The host work dir is
# deleted on success (kept with --keep) and kept on failure. It holds no
# private key: the client files are written on the client from the peer's
# record, carried on the ssh channel's stdin so the key is never part of a
# command line or a script PowerShell may log, and only redacted copies are
# kept.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPERS="$HERE/desktop-wireguard-windows"
SHA="$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo unknown)"
PEER_SSH_OPTS=()
CLIENT_SSH_OPTS=()
CLIENT_IP=""
LISTEN_PORT=""
IFACE=chanwg0
CDP_PORT=9222
KEEP=""
HTTP_PORT=8080
GATEWAY_ID="gw-e2e00002"
POSITIONAL=()

log() { printf 'desktop-wireguard-windows: %s\n' "$*" >&2; }
refuse() {
    # Nothing exists on either machine yet, and the work dir holds only the
    # probes' stderr, which a failed probe's message carries.
    log "cannot run: $*"
    [ -z "${WORK:-}" ] || rm -rf "${WORK:?}"
    exit 2
}

while [ $# -gt 0 ]; do
    case "$1" in
        --peer-ssh-opt) PEER_SSH_OPTS+=("$2"); shift 2 ;;
        --client-ssh-opt) CLIENT_SSH_OPTS+=("$2"); shift 2 ;;
        --client-address) CLIENT_IP="$2"; shift 2 ;;
        --listen-port) LISTEN_PORT="$2"; shift 2 ;;
        --interface) IFACE="$2"; shift 2 ;;
        --cdp-port) CDP_PORT="$2"; shift 2 ;;
        --keep) KEEP=1; shift ;;
        -h | --help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | cut -c3-; exit 0 ;;
        -*) refuse "unknown option $1" ;;
        *) POSITIONAL+=("$1"); shift ;;
    esac
done
[ "${#POSITIONAL[@]}" -eq 5 ] || refuse "usage: desktop-wireguard-windows.sh [options] PEER_SSH ENDPOINT PEER_ADDRESS CLIENT_SSH INSTALLER"
PEER_SSH="${POSITIONAL[0]}"
ENDPOINT="${POSITIONAL[1]}"
PEER_CIDR="${POSITIONAL[2]}"
CLIENT_SSH="${POSITIONAL[3]}"
INSTALLER="${POSITIONAL[4]}"

for tool in ssh scp python3 sha256sum base64 timeout node; do
    command -v "$tool" >/dev/null 2>&1 || refuse "$tool is not installed"
done
node -e 'process.exit(typeof WebSocket === "function" && typeof fetch === "function" ? 0 : 1)' \
    || refuse "node $(node --version) has no global WebSocket; Node 22 or later is needed"
[ -f "$INSTALLER" ] || refuse "no installer at $INSTALLER"
[ -f "$HELPERS/peer-http.py" ] && [ -f "$HELPERS/cdp.mjs" ] || refuse "the helpers are missing from $HELPERS"
case "$CDP_PORT" in '' | *[!0-9]*) refuse "--cdp-port takes a port number" ;; esac
python3 -I -c 'import ipaddress,sys; ipaddress.ip_address(sys.argv[1].rsplit(":", 1)[0].strip("[]"))' "$ENDPOINT" 2>/dev/null \
    || refuse "ENDPOINT $ENDPOINT is not an address:port literal; this suite runs against a literal only"

# scp spells the port -P where ssh spells it -p; everything else is shared.
CLIENT_SCP_OPTS=()
for opt in "${CLIENT_SSH_OPTS[@]}"; do
    [ "$opt" = -p ] && opt=-P
    CLIENT_SCP_OPTS+=("$opt")
done
PEER_SCP_OPTS=()
for opt in "${PEER_SSH_OPTS[@]}"; do
    [ "$opt" = -p ] && opt=-P
    PEER_SCP_OPTS+=("$opt")
done

PEER_IP="$(python3 -I -c 'import ipaddress,sys; print(ipaddress.ip_interface(sys.argv[1]).ip)' "$PEER_CIDR")" \
    || refuse "$PEER_CIDR is not an address with a prefix"
PEER_NET="$(python3 -I -c 'import ipaddress,sys; print(ipaddress.ip_interface(sys.argv[1]).network)' "$PEER_CIDR")"
[ -n "$CLIENT_IP" ] || CLIENT_IP="$(python3 -I -c 'import ipaddress,sys; print(ipaddress.ip_interface(sys.argv[1]).ip + 1)' "$PEER_CIDR")"
[ -n "$LISTEN_PORT" ] || LISTEN_PORT="${ENDPOINT##*:}"
case "$LISTEN_PORT" in '' | *[!0-9]*) refuse "no port in ENDPOINT $ENDPOINT" ;; esac
PEER_ORIGIN="http://$PEER_IP:$HTTP_PORT"

WORK="$(mktemp -d "${TMPDIR:-/var/tmp}/chan-desktop-wireguard-windows.XXXXXX")"
chmod 700 "$WORK"
TAG="chan-dwgw.$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
NONCE="${TAG#chan-dwgw.}"
INSTALLER_SHA="$(sha256sum "$INSTALLER" | cut -d' ' -f1)"

peer() {
    # peer <command...>: run a command on the peer, bounded.
    timeout 60 ssh -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "${PEER_SSH_OPTS[@]}" "$PEER_SSH" -- "$@"
}
peer_script() {
    # peer_script <args...>: the script on stdin on the peer, each argument
    # quoted, since ssh joins its arguments into one string the remote shell
    # splits again.
    local args=""
    [ $# -eq 0 ] || args="$(printf ' %q' "$@")"
    timeout 60 ssh -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "${PEER_SSH_OPTS[@]}" "$PEER_SSH" -- "bash -s --$args"
}
ps_encode() {
    # The script on stdin as PowerShell's -EncodedCommand wants it, with the
    # progress records that would otherwise flood stderr switched off.
    (echo "\$ProgressPreference = 'SilentlyContinue'"; cat) \
        | python3 -I -c 'import base64,sys; print(base64.b64encode(sys.stdin.read().encode("utf-16-le")).decode())'
}
client_ps() {
    # client_ps <seconds> < script: the PowerShell script on stdin on the
    # client, as an encoded command so no quoting survives two shells, with
    # CR stripped from its output and its stderr in a log in the work dir.
    local secs="$1" encoded
    encoded="$(ps_encode)"
    timeout "$secs" ssh -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "${CLIENT_SSH_OPTS[@]}" "$CLIENT_SSH" -- \
        powershell -NoProfile -NonInteractive -EncodedCommand "$encoded" 2>>"$WORK/client-stderr.log" | tr -d '\r'
}
client_ps_data() {
    # client_ps_data <seconds> <script> < data: the script run as client_ps
    # runs one, with this function's stdin carried to it on the channel as
    # data. A secret travels this way: on a command line it is readable by
    # other processes on both ends, and a script PowerShell judges
    # suspicious is written to its event log.
    local secs="$1" encoded
    encoded="$(printf '%s\n' "$2" | ps_encode)"
    timeout "$secs" ssh -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "${CLIENT_SSH_OPTS[@]}" "$CLIENT_SSH" -- \
        powershell -NoProfile -NonInteractive -EncodedCommand "$encoded" 2>>"$WORK/client-stderr.log" | tr -d '\r'
}

# The peer: tools, and no interface of the run's name.
if ! PROBE="$(peer 'sudo -n wg --version >/dev/null 2>&1 || echo no-wg; sudo -n ip -V >/dev/null 2>&1 || echo no-ip; command -v python3 >/dev/null 2>&1 || echo no-python3; command -v ss >/dev/null 2>&1 || echo no-ss; ip link show '"$IFACE"' >/dev/null 2>&1 && echo iface-exists; uname -sr' 2>&1)"; then
    refuse "ssh to $PEER_SSH failed: $PROBE"
fi
for missing in no-wg no-ip no-python3 no-ss; do
    case "$PROBE" in *"$missing"*) refuse "the peer lacks ${missing#no-} (or sudo -n for it): $PROBE" ;; esac
done
case "$PROBE" in *iface-exists*) refuse "interface $IFACE already exists on the peer; this run creates and deletes its own" ;; esac
PEER_KERNEL="$(printf '%s\n' "$PROBE" | tail -1)"

# The client: Windows on x86-64, a logged-on session, curl.exe, WebView2, a
# free debugging port, and none of the state the run makes and deletes. The
# user Path is recorded as found, so the cleanup can put it back exactly.
if ! CLIENT_PROBE="$({ printf '$cdp = %s\n' "$CDP_PORT"; cat <<'PS'; } | client_ps 60
"platform=$([Environment]::OSVersion.Platform)"
"arch=$env:PROCESSOR_ARCHITECTURE"
"os=$((Get-CimInstance Win32_OperatingSystem).Caption) build $([Environment]::OSVersion.Version.Build)"
"session=$(@(Get-Process explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -gt 0 }).Count)"
"curl=$([bool](Get-Command curl.exe -ErrorAction SilentlyContinue))"
"webview2=$((Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue).pv)"
"cdp_listeners=$(@(Get-NetTCPConnection -State Listen -LocalPort $cdp -ErrorAction SilentlyContinue).Count)"
"running=$(@(Get-Process chan-desktop -ErrorAction SilentlyContinue).Count)"
$state = @()
foreach ($p in "$env:LOCALAPPDATA\Chan", "$env:USERPROFILE\.chan", "$env:LOCALAPPDATA\app.chan.desktop", "$env:APPDATA\app.chan.desktop", 'HKCU:\Software\chan\Chan', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Chan', "$([Environment]::GetFolderPath('Programs'))\Chan.lnk", "$([Environment]::GetFolderPath('Desktop'))\Chan.lnk") {
    if (Test-Path -LiteralPath $p) { $state += $p }
}
$path = (Get-Item HKCU:\Environment).GetValue('Path', $null, 'DoNotExpandEnvironmentNames')
$bin = (Join-Path $env:LOCALAPPDATA 'chan\bin').ToLower()
if (@(([string]$path).Split(';') | Where-Object { [Environment]::ExpandEnvironmentVariables($_.Trim()).TrimEnd('\', '/').ToLower() -eq $bin }).Count) { $state += "$bin on the user Path" }
"state=$($state -join '; ')"
"userpath_had=$($null -ne $path)"
"userpath_b64=$([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$path)))"
PS
)"; then
    refuse "ssh to $CLIENT_SSH running PowerShell failed: $CLIENT_PROBE $(cat "$WORK/client-stderr.log" 2>/dev/null)"
fi
client_field() { printf '%s\n' "$CLIENT_PROBE" | sed -n "s/^$1=//p"; }
[ "$(client_field platform)" = Win32NT ] || refuse "$CLIENT_SSH is not Windows: $CLIENT_PROBE"
[ "$(client_field arch)" = AMD64 ] || refuse "$CLIENT_SSH is not x86-64: $CLIENT_PROBE"
[ "$(client_field session)" != 0 ] || refuse "no logged-on desktop session on $CLIENT_SSH"
[ "$(client_field curl)" = True ] || refuse "no curl.exe on $CLIENT_SSH"
[ -n "$(client_field webview2)" ] || refuse "no WebView2 runtime on $CLIENT_SSH"
[ "$(client_field cdp_listeners)" = 0 ] || refuse "something already listens on port $CDP_PORT on $CLIENT_SSH (--cdp-port)"
[ "$(client_field running)" = 0 ] || refuse "chan-desktop is running on $CLIENT_SSH"
[ -z "$(client_field state)" ] || refuse "chan has state on $CLIENT_SSH that this run would delete: $(client_field state)"
USERPATH_HAD="$(client_field userpath_had)"
USERPATH_B64="$(client_field userpath_b64)"
case "$USERPATH_HAD" in True | False) ;; *) refuse "the user Path on $CLIENT_SSH could not be read: $CLIENT_PROBE" ;; esac
CLIENT_OS="$(client_field os), WebView2 $(client_field webview2)"

HOST_PIDS=()
PEER_STAGED=""
PEER_WORK=""
PEER_PIDS=""
IFACE_CREATED=""
CLIENT_DIR=""
INSTALLED=""
DESKTOP_PID=""
CLEANUP_LEFT=""
cleanup() {
    # Only what the run made, each piece checked after its removal: what is
    # still there lands in CLEANUP_LEFT, which fails a run that passed.
    local pid out left
    CLEANUP_LEFT=""
    for pid in "${HOST_PIDS[@]:-}"; do
        [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    done
    # On the client: the task, the desktop and its webviews, the install by
    # its own uninstaller and then what a silent uninstall keeps (the app
    # data, the installer's registry key, the bin dir the desktop put on the
    # user Path), and the run's directory, which holds the client files.
    if [ -n "$CLIENT_DIR" ]; then
        if out="$(client_ps 300 <<PS
\$left = @()
Unregister-ScheduledTask -TaskName '$TAG' -Confirm:\$false -ErrorAction SilentlyContinue
Get-Process chan-desktop -ErrorAction SilentlyContinue | Where-Object { \$_.Path -like "\$env:LOCALAPPDATA\Chan\*" } | Stop-Process -Force -ErrorAction SilentlyContinue
for (\$i = 0; \$i -lt 40; \$i++) { if (-not (Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { \$_.CommandLine -like '*app.chan.desktop*' })) { break }; Start-Sleep -Milliseconds 250 }
if ('$INSTALLED') {
    \$un = "\$env:LOCALAPPDATA\Chan\uninstall.exe"
    if (Test-Path -LiteralPath \$un) {
        \$u = Start-Process -FilePath \$un -ArgumentList '/S' -PassThru -Wait
        "uninstall=exit \$(\$u.ExitCode), chan-desktop.exe still there: \$(Test-Path "\$env:LOCALAPPDATA\Chan\chan-desktop.exe")"
    } else {
        "uninstall=no uninstaller"
    }
    foreach (\$p in "\$env:USERPROFILE\.chan", "\$env:LOCALAPPDATA\app.chan.desktop", "\$env:APPDATA\app.chan.desktop", "\$env:LOCALAPPDATA\Chan") {
        if (Test-Path -LiteralPath \$p) { Remove-Item -LiteralPath \$p -Recurse -Force -ErrorAction SilentlyContinue }
    }
    Remove-Item -LiteralPath 'HKCU:\Software\chan\Chan' -Recurse -Force -ErrorAction SilentlyContinue
    \$manu = Get-Item -LiteralPath 'HKCU:\Software\chan' -ErrorAction SilentlyContinue
    if (\$manu -and \$manu.SubKeyCount -eq 0 -and \$manu.ValueCount -eq 0) { Remove-Item -LiteralPath 'HKCU:\Software\chan' -Force -ErrorAction SilentlyContinue }
    foreach (\$p in "\$env:LOCALAPPDATA\Chan", "\$env:USERPROFILE\.chan", "\$env:LOCALAPPDATA\app.chan.desktop", "\$env:APPDATA\app.chan.desktop", 'HKCU:\Software\chan\Chan', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Chan', "\$([Environment]::GetFolderPath('Programs'))\Chan.lnk", "\$([Environment]::GetFolderPath('Desktop'))\Chan.lnk") {
        if (Test-Path -LiteralPath \$p) { \$left += \$p }
    }
    # The desktop appends its bin dir to the user Path the way
    # path_with_dir_appended does; only that exact value is put back, and
    # any other is left alone and reported.
    \$bin = Join-Path \$env:LOCALAPPDATA 'chan\bin'
    \$orig = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$USERPATH_B64'))
    \$envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', \$true)
    \$cur = \$envKey.GetValue('Path', \$null, 'DoNotExpandEnvironmentNames')
    if ('$USERPATH_HAD' -eq 'True') {
        \$added = if (\$orig -eq '') { \$bin } elseif (\$orig.EndsWith(';')) { "\$orig\$bin" } else { "\$orig;\$bin" }
        if (\$cur -ceq \$added) { \$envKey.SetValue('Path', \$orig, \$envKey.GetValueKind('Path')) }
        if (\$envKey.GetValue('Path', \$null, 'DoNotExpandEnvironmentNames') -cne \$orig) { \$left += 'the user Path' }
    } else {
        if (\$cur -ceq \$bin) { \$envKey.DeleteValue('Path') }
        if (\$null -ne \$envKey.GetValue('Path', \$null, 'DoNotExpandEnvironmentNames')) { \$left += 'the user Path' }
    }
}
if (Get-Process chan-desktop -ErrorAction SilentlyContinue) { \$left += 'a chan-desktop process' }
if (Get-ScheduledTask -TaskName '$TAG' -ErrorAction SilentlyContinue) { \$left += 'the $TAG task' }
if (Test-Path -LiteralPath '$CLIENT_DIR') { Remove-Item -LiteralPath '$CLIENT_DIR' -Recurse -Force -ErrorAction SilentlyContinue }
if (Test-Path -LiteralPath '$CLIENT_DIR') { \$left += '$CLIENT_DIR' }
"left=\$(\$left -join '; ')"
PS
)"; then
            ! grep -q '^uninstall=' <<<"$out" || log "client cleanup: $(sed -n 's/^uninstall=/uninstaller /p' <<<"$out")"
            left="$(sed -n 's/^left=//p' <<<"$out")"
            if ! grep -q '^left=' <<<"$out"; then
                CLEANUP_LEFT="$CLEANUP_LEFT; on $CLIENT_SSH, an unknown part (the cleanup did not report)"
            elif [ -n "$left" ]; then
                CLEANUP_LEFT="$CLEANUP_LEFT; on $CLIENT_SSH, $left"
            fi
        else
            CLEANUP_LEFT="$CLEANUP_LEFT; on $CLIENT_SSH, an unknown part (the cleanup did not finish: check $CLIENT_DIR, the Chan install and the $TAG task)"
        fi
    fi
    # On the peer: its processes by recorded pid, the interface it created,
    # the staged helper, and its work dir, identified by the marker the run
    # wrote into it.
    if [ -n "$PEER_STAGED" ] || [ -n "$PEER_WORK" ] || [ -n "$IFACE_CREATED" ]; then
        if out="$(peer_script "$PEER_WORK" "$PEER_PIDS" "$IFACE_CREATED" "$TAG" <<'PEER'
work="$1"; pids="$2"; iface="$3"; tag="$4"
for pid in $pids; do kill "$pid" 2>/dev/null || true; done
[ -n "$iface" ] && sudo -n ip link del "$iface" 2>/dev/null || true
rm -f -- "/tmp/$tag-peer-http.py"
if [ -n "$work" ] && [ -f "$work/.chan-dwgw" ]; then rm -rf -- "${work:?}"; fi
sleep 1
left=""
for pid in $pids; do kill -0 "$pid" 2>/dev/null && left="$left; pid $pid"; done
[ -n "$iface" ] && ip link show "$iface" >/dev/null 2>&1 && left="$left; interface $iface"
[ -n "$work" ] && [ -e "$work" ] && left="$left; $work"
[ -e "/tmp/$tag-peer-http.py" ] && left="$left; /tmp/$tag-peer-http.py"
echo "left=${left#; }"
PEER
)"; then
            left="$(sed -n 's/^left=//p' <<<"$out")"
            if ! grep -q '^left=' <<<"$out"; then
                CLEANUP_LEFT="$CLEANUP_LEFT; on $PEER_SSH, an unknown part (the cleanup did not report)"
            elif [ -n "$left" ]; then
                CLEANUP_LEFT="$CLEANUP_LEFT; on $PEER_SSH, $left"
            fi
        else
            CLEANUP_LEFT="$CLEANUP_LEFT; on $PEER_SSH, an unknown part (the cleanup did not finish: check $IFACE and $PEER_WORK)"
        fi
    fi
    CLEANUP_LEFT="${CLEANUP_LEFT#; }"
    [ -z "$CLEANUP_LEFT" ] || log "cleanup left: $CLEANUP_LEFT"
}
trap cleanup EXIT
trap 'log "aborted: the command at line $LINENO failed; work dir kept at $WORK"' ERR

FAILED=0
verdict() {
    # verdict <arm> <rc> <detail>: one line per arm, with the arm's own status.
    local arm="$1" rc="$2"; shift 2
    if [ "$rc" = 0 ]; then
        printf 'desktop-wireguard-windows: %s rc=0 PASS %s\n' "$arm" "$*"
    else
        printf 'desktop-wireguard-windows: %s rc=%s FAIL %s\n' "$arm" "$rc" "$*"
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

log "work dir $WORK, suite at $SHA, tag $TAG, installer $(basename "$INSTALLER") $INSTALLER_SHA, peer $PEER_SSH ($PEER_KERNEL), client $CLIENT_SSH ($CLIENT_OS), endpoint $ENDPOINT, peer $PEER_CIDR, client $CLIENT_IP"

# 1. The peer: keys, the interface with the client as its one peer, and the
# logging listener on the tunnel address.
PEER_STAGED=1
scp -q -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "${PEER_SCP_OPTS[@]}" "$HELPERS/peer-http.py" "$PEER_SSH:/tmp/$TAG-peer-http.py" \
    || { log "copying peer-http.py to the peer failed"; exit 1; }
if ! SETUP="$(peer_script "$IFACE" "$LISTEN_PORT" "$PEER_CIDR" "$CLIENT_IP" "$PEER_IP" "$HTTP_PORT" "$NONCE" "$TAG" <<'PEER'
set -euo pipefail
iface="$1"; port="$2"; peer_cidr="$3"; client_ip="$4"; peer_ip="$5"; http_port="$6"; nonce="$7"; tag="$8"
umask 077
work="$(mktemp -d "/tmp/$tag.XXXXXX")"
touch "$work/.chan-dwgw"
echo "work=$work"
mv "/tmp/$tag-peer-http.py" "$work/peer-http.py"
wg genkey > "$work/server.key"
echo "server_pub=$(wg pubkey < "$work/server.key")"
client_key="$(wg genkey)"
echo "client_key=$client_key"
echo "wrong_pub=$(wg genkey | wg pubkey)"
sudo -n ip link add "$iface" type wireguard
echo "iface=$iface"
sudo -n wg set "$iface" listen-port "$port" private-key "$work/server.key" \
    peer "$(printf '%s\n' "$client_key" | wg pubkey)" allowed-ips "$client_ip/32"
sudo -n ip address add "$peer_cidr" dev "$iface"
sudo -n ip link set "$iface" up
setsid nohup python3 -u "$work/peer-http.py" "$peer_ip" "$http_port" "$work/requests.log" "$nonce" \
    </dev/null >"$work/http.out" 2>&1 &
echo "http_pid=$!"
for _ in $(seq 50); do
    ss -ltn 2>/dev/null | grep -q "$peer_ip:$http_port " && break
    sleep 0.2
done
ss -ltn 2>/dev/null | grep -q "$peer_ip:$http_port " || { echo "the listener did not bind $peer_ip:$http_port: $(cat "$work/http.out")" >&2; exit 1; }
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
WRONG_PUB="$(setup_field wrong_pub)"
[ -n "$PEER_WORK" ] && [ -n "$SERVER_PUB" ] && [ -n "$CLIENT_KEY" ] && [ -n "$WRONG_PUB" ] || { log "peer setup returned an incomplete record"; exit 1; }
unset SETUP
log "peer interface $IFACE up at $PEER_CIDR, listener on $PEER_IP:$HTTP_PORT"

peer_handshake() {
    # The peer's handshake stamp for the client, 0 before the first; one
    # that cannot be read is a failure, never a value an arm compares.
    local hs
    hs="$(peer "sudo -n wg show $IFACE latest-handshakes" | cut -f2)" || return 1
    case "$hs" in '' | *[!0-9]*) return 1 ;; esac
    printf '%s\n' "$hs"
}
peer_udp_in() {
    # The peer's UDP datagrams delivered to sockets, which count a refused
    # handshake initiation where the interface's own counters do not.
    local n
    n="$(peer "awk '/^Udp:/ { n++; if (n == 2) print \$2 }' /proc/net/snmp")" || return 1
    case "$n" in '' | *[!0-9]*) return 1 ;; esac
    printf '%s\n' "$n"
}
peer_requests() {
    # The listener's log, fetched whole. A fetch that fails, or a log
    # without the listener's ready line, is a failure and never reads as a
    # log with no requests in it.
    peer "cat $PEER_WORK/requests.log" > "$WORK/peer-requests.log" && grep -q '^ready: ' "$WORK/peer-requests.log"
}
peer_logged() { peer_requests && grep -qE -- "$1" "$WORK/peer-requests.log"; }
peer_absent() { peer_requests && ! grep -qE -- "$1" "$WORK/peer-requests.log"; }
peer_count() {
    if peer_requests; then grep -cE -- "$1" "$WORK/peer-requests.log" || true; else echo unread; fi
}

# 2. The client directory, the installer checked by hash on arrival, and the
# install, checked by its exit status and the desktop binary.
if ! CLIENT_DIR="$(client_ps 60 <<PS
\$ErrorActionPreference = 'Stop'
\$dir = Join-Path \$env:TEMP '$TAG'
New-Item -ItemType Directory -Path \$dir | Out-Null
\$dir
PS
)"; then
    CLIENT_DIR=""
    log "creating the client directory failed: $(cat "$WORK/client-stderr.log")"
    exit 1
fi
CLIENT_DIR="$(printf '%s\n' "$CLIENT_DIR" | tail -1)"
case "$CLIENT_DIR" in
    [A-Za-z]:\\*"\\$TAG") ;;
    *) log "the client directory is not the one asked for: $CLIENT_DIR"; CLIENT_DIR=""; exit 1 ;;
esac
scp -q -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "${CLIENT_SCP_OPTS[@]}" "$INSTALLER" "$CLIENT_SSH:${CLIENT_DIR//\\//}/setup.exe" \
    || { log "copying the installer to the client failed"; exit 1; }
INSTALLED=1
INSTALL="$(client_ps 300 <<PS
\$inst = "$CLIENT_DIR\setup.exe"
"sha=\$((Get-FileHash -Algorithm SHA256 -LiteralPath \$inst).Hash.ToLower())"
"signature=\$((Get-AuthenticodeSignature \$inst).Status)"
if ((Get-FileHash -Algorithm SHA256 -LiteralPath \$inst).Hash.ToLower() -ne '$INSTALLER_SHA') { 'hash-mismatch'; exit 1 }
\$p = Start-Process -FilePath \$inst -ArgumentList '/S' -PassThru -Wait
"exit=\$(\$p.ExitCode)"
\$exe = "\$env:LOCALAPPDATA\Chan\chan-desktop.exe"
"desktop=\$(Test-Path \$exe)"
if (Test-Path \$exe) { "version=\$((Get-Item \$exe).VersionInfo.ProductVersion)"; "desktop_sha=\$((Get-FileHash -Algorithm SHA256 \$exe).Hash.ToLower())" }
PS
)" || true
install_field() { printf '%s\n' "$INSTALL" | sed -n "s/^$1=//p"; }
[ "$(install_field sha)" = "$INSTALLER_SHA" ] && [ "$(install_field exit)" = 0 ] && [ "$(install_field desktop)" = True ] \
    || { log "the install failed: $INSTALL"; exit 1; }
log "installed chan-desktop $(install_field version) ($(install_field desktop_sha)), installer signature $(install_field signature)"

# 3. The client files, written on the client from the peer's record (UTF-8,
# no byte order mark), the text on the channel's stdin; only redacted copies
# stay on this host.
write_client_file() {
    # write_client_file <name> <peer public key>
    local text
    text="$(printf '[Interface]\nPrivateKey = %s\nAddress = %s/32\n\n[Peer]\nPublicKey = %s\nEndpoint = %s\nAllowedIPs = %s\nPersistentKeepalive = 25\n' \
        "$CLIENT_KEY" "$CLIENT_IP" "$2" "$ENDPOINT" "$PEER_NET")"
    printf '%s\n' "$text" | sed 's/^PrivateKey = .*/PrivateKey = (redacted)/' > "$WORK/$1.redacted"
    printf '%s\n' "$text" | base64 -w0 | client_ps_data 60 "\$ErrorActionPreference = 'Stop'
\$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))
[IO.File]::WriteAllText('$CLIENT_DIR\\$1', \$text, (New-Object Text.UTF8Encoding \$false))" >/dev/null \
        || { log "writing $1 on the client failed: $(tail -3 "$WORK/client-stderr.log")"; exit 1; }
}
write_client_file client.conf "$SERVER_PUB"
write_client_file client-wrong-key.conf "$WRONG_PUB"
unset CLIENT_KEY

# The launcher script the scheduled task runs in the logged-on session: the
# installed desktop with the update check off, the WireGuard and desktop
# logs at debug, the remote debugging port, and both streams in files.
client_ps 60 <<PS >/dev/null
\$ErrorActionPreference = 'Stop'
\$text = @'
param([string]\$Name)
\$env:CHAN_UPDATE_CHECK = '0'
\$env:CHAN_LOG = 'chan_desktop=debug,chan_wireguard=debug,warn'
\$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=$CDP_PORT'
\$p = Start-Process -FilePath "\$env:LOCALAPPDATA\Chan\chan-desktop.exe" -RedirectStandardError "$CLIENT_DIR\\\$Name.err" -RedirectStandardOutput "$CLIENT_DIR\\\$Name.out" -PassThru
Set-Content -LiteralPath "$CLIENT_DIR\\\$Name.pid" -Value \$p.Id
'@
[IO.File]::WriteAllText("$CLIENT_DIR\launch.ps1", \$text, (New-Object Text.UTF8Encoding \$false))
PS

start_desktop() {
    # start_desktop <name> <client file name>: the desktop config naming the
    # file, then the desktop started in the logged-on session; DESKTOP_PID.
    local name="$1" file="$2" json
    json="$(printf '{"gateways":[{"id":"%s","url":"%s","label":"wg","enabled":true,"added_at":0,"native_trust":[],"wireguard":"%s"}]}' \
        "$GATEWAY_ID" "$PEER_ORIGIN" "$(printf '%s' "$CLIENT_DIR\\$file" | sed 's/\\/\\\\/g')")"
    DESKTOP_PID="$(client_ps 90 <<PS | tail -1
\$ErrorActionPreference = 'Stop'
\$dir = "\$env:USERPROFILE\.chan\desktop"
New-Item -ItemType Directory -Force \$dir | Out-Null
[IO.File]::WriteAllText("\$dir\config.json", [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$(printf '%s' "$json" | base64 -w0)')), (New-Object Text.UTF8Encoding \$false))
\$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$CLIENT_DIR\launch.ps1" -Name $name'
\$pr = New-ScheduledTaskPrincipal -UserId \$env:USERNAME -LogonType Interactive
Register-ScheduledTask -TaskName '$TAG' -Action \$a -Principal \$pr -Force | Out-Null
Start-ScheduledTask -TaskName '$TAG'
for (\$i = 0; \$i -lt 80 -and -not (Test-Path "$CLIENT_DIR\\$name.pid"); \$i++) { Start-Sleep -Milliseconds 250 }
Get-Content -LiteralPath "$CLIENT_DIR\\$name.pid"
PS
)" || DESKTOP_PID=""
    case "$DESKTOP_PID" in '' | *[!0-9]*) log "the desktop did not start: $DESKTOP_PID"; DESKTOP_PID=""; return 1 ;; esac
}
stop_desktop() {
    [ -n "$DESKTOP_PID" ] || return 0
    client_ps 60 <<PS >/dev/null || true
Stop-Process -Id $DESKTOP_PID -Force -ErrorAction SilentlyContinue
for (\$i = 0; \$i -lt 40; \$i++) { if (-not (Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { \$_.CommandLine -like '*app.chan.desktop*' })) { break }; Start-Sleep -Milliseconds 250 }
PS
    DESKTOP_PID=""
}
# tracing colours stderr even into a file; every read goes through a
# stripped copy. A fetch that fails is a failure, never an empty log.
desktop_log() {
    # desktop_log <name>: the desktop's stderr, colours stripped, into the work dir.
    client_ps 60 <<PS | sed 's/\x1b\[[0-9;]*m//g' > "$WORK/$1.log"
Get-Content -Raw -LiteralPath "$CLIENT_DIR\\$1.err" -ErrorAction SilentlyContinue
PS
}
logged() { desktop_log "$1" && grep -qE -- "$2" "$WORK/$1.log"; }
count() { grep -cE -- "$2" "$WORK/$1.log" || true; }
session_warnings() {
    awk '$2 == "WARN" && $3 == "chan_wireguard::tunnel:" && $4 == "WireGuard" && $5 == "session" { n++ } END { print n+0 }' "$1"
}
session_expiry_logged() {
    desktop_log "$1" || return 1
    [ "$(session_warnings "$WORK/$1.log")" -ge 1 ]
}

# The remote debugging port, forwarded to a free port on this host for the run.
LOCAL_CDP="$(python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
ssh -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
    "${CLIENT_SSH_OPTS[@]}" -N -L "127.0.0.1:$LOCAL_CDP:127.0.0.1:$CDP_PORT" "$CLIENT_SSH" 2>"$WORK/cdp-forward.log" &
HOST_PIDS+=("$!")
page_target() {
    # A window's page target, PAGE, and its URL without the query, which
    # carries the window's token, PAGE_URL.
    local line
    line="$(node "$HELPERS/cdp.mjs" page "$LOCAL_CDP" 2>/dev/null)" || return 1
    PAGE="${line%% *}"
    PAGE_URL="${line#* }"
    [ -n "$PAGE" ] && [ "$PAGE" != "$line" ]
}
navigate() {
    # navigate <out prefix> <url> [wait ms]: the window to the URL; the record in <out prefix>.json.
    node "$HELPERS/cdp.mjs" nav "$LOCAL_CDP" "$PAGE" "$2" "$1" "${3:-8000}" >/dev/null 2>"$1.err" || true
}
jfield() { python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {}, {"r": r}))' "$@" 2>/dev/null || echo "?"; }

# 4. The positive run.
HS_BEFORE="$(peer_handshake)"
start_desktop pos client.conf || exit 1
log "desktop pid $DESKTOP_PID"

# tunnel: the start line in the desktop and a fresh handshake at the peer.
arm_rc=0
wait_for 60 "the tunnel start line" logged pos "gateway WireGuard tunnel started gateway=$GATEWAY_ID file=.*client\\.conf endpoint=$ENDPOINT" || arm_rc=1
handshake_moved() {
    local hs
    hs="$(peer_handshake)" || return 1
    [ "$hs" != 0 ] && [ "$hs" != "$HS_BEFORE" ]
}
wait_for 30 "the handshake at the peer" handshake_moved || arm_rc=1
HS_POS="$(peer_handshake)"
[ "$HS_POS" != 0 ] && [ "$HS_POS" != "$HS_BEFORE" ] || arm_rc=1
verdict tunnel "$arm_rc" "start line $(count pos 'gateway WireGuard tunnel started'), peer handshake stamp $HS_BEFORE -> $HS_POS"

# proxy: the listening line names the address every later arm uses.
arm_rc=0
wait_for 30 "the proxy line" logged pos 'gateway WireGuard proxy listening' || arm_rc=1
PROXY="$(sed -n 's/.*gateway WireGuard proxy listening.*proxy=\(127\.0\.0\.1:[0-9]*\).*/\1/p' "$WORK/pos.log" | head -1)"
[ -n "$PROXY" ] || arm_rc=1
verdict proxy "$arm_rc" "at ${PROXY:-none}"
[ -n "$PROXY" ] || { log "FAIL: no proxy address: every later arm needs it; work dir kept at $WORK"; exit 1; }

# webview-args: the WebView2 browser process the desktop started, the one
# without a --type, and the two arguments it must carry.
browser_args() {
    BROWSER_ARGS="$(client_ps 60 <<PS | tail -1
\$b = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { \$_.ParentProcessId -eq $DESKTOP_PID -and \$_.CommandLine -notmatch '--type=' } | Select-Object -First 1
\$b.CommandLine
PS
)" && [ -n "$BROWSER_ARGS" ]
}
arm_rc=0
BROWSER_ARGS=""
wait_for 30 "the WebView2 browser process" browser_args || arm_rc=1
printf '%s\n' "$BROWSER_ARGS" > "$WORK/webview2-browser-cmdline.txt"
case "$BROWSER_ARGS" in *"--proxy-server=http://$PROXY "*) ;; *) arm_rc=1 ;; esac
case "$BROWSER_ARGS" in *"--remote-debugging-port=$CDP_PORT"*) ;; *) arm_rc=1 ;; esac
verdict webview-args "$arm_rc" "browser process: $(printf '%s' "$BROWSER_ARGS" | grep -oE -- '--(proxy-server|remote-debugging-port)=[^ ]*' | tr '\n' ' ')"

# discovery: the connect at start asks the peer for the gateway document
# through the proxy and the tunnel, and reads the 404.
arm_rc=0
wait_for 60 "the discovery request at the peer" peer_logged "^request: .* from=$CLIENT_IP:[0-9]+ line=GET_/\\.well-known/chan-gateway" || arm_rc=1
wait_for 30 "the desktop to read the 404" logged pos 'gateway discovery returned HTTP 404' || arm_rc=1
verdict discovery "$arm_rc" "peer saw $(peer_count "from=$CLIENT_IP:.*GET_/\\.well-known/chan-gateway") discovery request(s) from $CLIENT_IP, desktop read 404: $(count pos 'discovery returned HTTP 404')"

# probes: the proxy from outside the desktop, both request shapes, and the
# peer's address without the proxy, which must not answer.
arm_rc=0
PROBES="$(client_ps 90 <<PS
"forward=\$(& curl.exe -sS -o NUL -m 30 -w '%{http_code}' -x http://$PROXY $PEER_ORIGIN/forward-probe 2>&1)"
"connect=\$(& curl.exe -sS -o NUL -m 30 -p -w '%{http_code}' -x http://$PROXY $PEER_ORIGIN/connect-probe 2>&1)"
"direct=\$(& curl.exe -sS -o NUL -m 5 -w '%{http_code}' $PEER_ORIGIN/direct-probe 2>&1)"
PS
)" || true
probe_field() { printf '%s\n' "$PROBES" | sed -n "s/^$1=//p"; }
[ "$(probe_field forward)" = 404 ] && [ "$(probe_field connect)" = 404 ] || arm_rc=1
case "$(probe_field direct)" in *000) ;; *) arm_rc=1 ;; esac
peer_logged "from=$CLIENT_IP:.*GET_/forward-probe" && peer_logged "from=$CLIENT_IP:.*GET_/connect-probe" || arm_rc=1
peer_absent 'GET_/direct-probe' || arm_rc=1
verdict probes "$arm_rc" "forward answered $(probe_field forward), CONNECT answered $(probe_field connect), both logged at the peer; without the proxy: $(probe_field direct | tail -c 60)"

# webview: the desktop's own window, navigated to the peer origin. Its
# local URL is read first, for the loopback arm, and the tunnel CONNECTs so
# far, for the webview-ws arm.
TUNNEL_CONNECT="CONNECT established .*target=$PEER_IP:$HTTP_PORT route=\"tunnel\""
arm_rc=0
PAGE=""
PAGE_URL=""
wait_for 60 "a window's page target on the debugging port" page_target || arm_rc=1
LOCAL_URL="${PAGE_URL:-?}"
if desktop_log pos; then CONNECTS_BEFORE="$(count pos "$TUNNEL_CONNECT")"; else CONNECTS_BEFORE=unread; fi
navigate "$WORK/webview" "$PEER_ORIGIN/?arm=webview-$NONCE"
doc="$(jfield "$WORK/webview.json" '(r["documents"][0]["status"], r["documents"][0]["remote"])')"
title="$(jfield "$WORK/webview.json" 'r["page"]["title"]')"
PAGE_RE="from=$CLIENT_IP:[0-9]+ line=GET_/\\?arm=webview-${NONCE}_HTTP/1\\.1 status=200 .*Edg/"
BEACON_RE="from=$CLIENT_IP:[0-9]+ line=GET_/beacon\\?nonce=$NONCE&kind=fetch"
[ "$doc" = "(200, '$PROXY')" ] || arm_rc=1
[ "$title" = "wg-webview $NONCE" ] || arm_rc=1
peer_logged "$PAGE_RE" || arm_rc=1
peer_logged "$BEACON_RE" || arm_rc=1
[ -s "$WORK/webview.png" ] || arm_rc=1
verdict webview "$arm_rc" "document $doc, title '$title', peer logged from $CLIENT_IP with WebView2's user agent: page $(peer_count "$PAGE_RE") beacon $(peer_count "$BEACON_RE"), screenshot $(stat -c %s "$WORK/webview.png" 2>/dev/null || echo 0) bytes"

# webview-ws: the page's WebSocket, as the page, the debugger, the peer and
# the proxy each saw it.
arm_rc=0
ws_text="$(jfield "$WORK/webview.json" 'r["page"]["text"].split("websocket: ")[1].split(chr(10))[0]')"
[ "$ws_text" = "hello-from-peer-$NONCE" ] || arm_rc=1
[ "$(jfield "$WORK/webview.json" 'r["wsHandshakes"]')" = "[101]" ] || arm_rc=1
peer_logged "from=$CLIENT_IP:[0-9]+ line=GET_/ws\\?nonce=${NONCE}_HTTP/1\\.1 status=101 .*upgrade=websocket" || arm_rc=1
connects_grew() { desktop_log pos && [ "$CONNECTS_BEFORE" != unread ] && [ "$(count pos "$TUNNEL_CONNECT")" -gt "$CONNECTS_BEFORE" ]; }
connects_grew || arm_rc=1
verdict webview-ws "$arm_rc" "page read '$ws_text', handshake $(jfield "$WORK/webview.json" 'r["wsHandshakes"]'), proxy CONNECTs through the tunnel $CONNECTS_BEFORE -> $(count pos "$TUNNEL_CONNECT")"

# loopback: no loopback target in the proxy's log, read in the same fetch
# that shows its tunnel forwards, so an empty log cannot pass.
arm_rc=0
desktop_log pos || arm_rc=1
LOOPBACK="$(count pos '(forwarding|CONNECT established).*target=(127\.|\[::1\])')"
TUNNEL_FORWARDS="$(count pos 'forwarding .*route="tunnel"')"
[ "$LOOPBACK" = 0 ] || arm_rc=1
[ "$TUNNEL_FORWARDS" -ge 1 ] || arm_rc=1
case "$LOCAL_URL" in http://127.0.0.1:*) ;; *) arm_rc=1 ;; esac
verdict loopback "$arm_rc" "the local window loaded $LOCAL_URL; through the proxy: $LOOPBACK loopback requests, $TUNNEL_FORWARDS tunnel forwards in the same log"

# config: the desktop rewrites its config at start (the embedded port is
# its addition); the row and the file must come through.
arm_rc=0
CONFIG="$(client_ps 60 <<'PS'
Get-Content -Raw "$env:USERPROFILE\.chan\desktop\config.json"
PS
)" || CONFIG=""
printf '%s\n' "$CONFIG" > "$WORK/config-after-start.json"
grep -q "\"$GATEWAY_ID\"" <<<"$CONFIG" || arm_rc=1
grep -qF 'client.conf"' <<<"$CONFIG" || arm_rc=1
grep -q '"embedded_port"' <<<"$CONFIG" || arm_rc=1
verdict config "$arm_rc" "row $GATEWAY_ID and its file in the rewritten config"

# refusals: nothing refused, in the loopback arm's read, which must hold the
# proxy's forwards and CONNECTs.
REFUSED="$(count pos 'proxy request refused')"
FORWARDED="$(count pos 'proxy: forwarding')"
CONNECTS="$(count pos 'CONNECT established')"
arm_rc=0
[ "$REFUSED" = 0 ] || arm_rc=1
[ "$FORWARDED" -ge 1 ] && [ "$CONNECTS" -ge 1 ] || arm_rc=1
verdict refusals "$arm_rc" "refused $REFUSED, forwarded $FORWARDED, CONNECT $CONNECTS"

# 5. The control: the desktop restarted on the wrong peer key.
stop_desktop
HS_BEFORE="$(peer_handshake)"
UDP_BEFORE="$(peer_udp_in)"
REQ_BEFORE="$(peer_count '^request: ')"
arm_rc=0
start_desktop neg client-wrong-key.conf || arm_rc=1
wait_for 60 "the wrong-key tunnel start line" logged neg "gateway WireGuard tunnel started gateway=$GATEWAY_ID file=.*client-wrong-key\\.conf" || arm_rc=1
expiry_deadline=$((SECONDS + 100))
PAGE=""
wait_for 60 "a window's page target on the debugging port" page_target || arm_rc=1
navigate "$WORK/wrong-key" "$PEER_ORIGIN/?arm=wrong-key-$NONCE" 5000
# Navigation spends part of the bound that starts at the tunnel-start line.
expiry_wait=$((expiry_deadline - SECONDS))
[ "$expiry_wait" -ge 0 ] || expiry_wait=0
wait_for "$expiry_wait" "the session-expiry warning" session_expiry_logged neg || arm_rc=1
doc="$(jfield "$WORK/wrong-key.json" '(r["documents"][0]["status"] if r["documents"] else None, r["errorText"])')"
text="$(jfield "$WORK/wrong-key.json" 'r["page"]["text"].replace(chr(10), " ")')"
HS_AFTER="$(peer_handshake)"
UDP_AFTER="$(peer_udp_in)"
REQ_AFTER="$(peer_count '^request: ')"
desktop_log neg || arm_rc=1
INITIATIONS="$(count neg 'Sending handshake_initiation')"
[ "$doc" = "(504, 'net::ERR_HTTP_RESPONSE_CODE_FAILURE')" ] || arm_rc=1
[ "$REQ_AFTER" != unread ] && [ "$REQ_AFTER" = "$REQ_BEFORE" ] || arm_rc=1
[ "$HS_AFTER" = "$HS_BEFORE" ] || arm_rc=1
[ "$INITIATIONS" -ge 2 ] && [ $((UDP_AFTER - UDP_BEFORE)) -ge 2 ] || arm_rc=1
grep -qE 'proxy request refused .*status=504' "$WORK/neg.log" || arm_rc=1
expiry_warns="$(session_warnings "$WORK/neg.log")"
error_lines="$(awk '$2 == "ERROR" { n++ } END { print n+0 }' "$WORK/neg.log")"
[ "$expiry_warns" = 1 ] && [ "$error_lines" = 0 ] || arm_rc=1
verdict wrong-key "$arm_rc" "document and error $doc after $(jfield "$WORK/wrong-key.json" 'r["navigateMs"]') ms, page '$(printf '%s' "$text" | cut -c1-70)', peer requests $REQ_BEFORE -> $REQ_AFTER, handshake stamp $HS_BEFORE -> $HS_AFTER, desktop sent $INITIATIONS initiations, peer UDP in +$((UDP_AFTER - UDP_BEFORE)), session warnings $expiry_warns (want 1), ERROR lines $error_lines (want 0)"
stop_desktop

if [ "$FAILED" != 0 ]; then
    log "FAIL: $FAILED arm(s) failed (suite at $SHA); work dir kept at $WORK"
    exit 1
fi
cleanup
trap - EXIT
if [ -n "$CLEANUP_LEFT" ]; then
    log "FAIL: every arm passed, but the cleanup left $CLEANUP_LEFT; work dir kept at $WORK"
    exit 1
fi
log "PASS (suite at $SHA): $(basename "$INSTALLER") ($INSTALLER_SHA) on $CLIENT_SSH ($CLIENT_OS) against $PEER_SSH ($PEER_KERNEL)"
if [ -n "$KEEP" ]; then
    log "work dir kept at $WORK"
else
    rm -rf "${WORK:?}"
    log "work dir $WORK removed"
fi
