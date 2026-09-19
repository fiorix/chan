#!/usr/bin/env bash
# nginx-edge.sh -- run the tunnel ingress the way production runs it, in front
# of the devserver-tunnel e2e rig, and measure what the edge does to a live
# tunnel when the terminator behind it goes away.
#
# Production puts nginx on the `proxy.{domain}` apex of a proxy node: it
# terminates TLS + h2 and `grpc_pass`es `/v1/tunnel` as h2c into the same
# node's devserver-proxy tunnel listener (gateway/docs/dev-setup.md, "The TLS
# edges"). The rig reaches that listener through `tls-forward.py` instead, so
# nothing in the rig exercises nginx. This puts nginx where production puts
# it, beside the terminator in the proxy container:
#
#   gw-e2e-ds (chan devserver)
#     -> TLS h2 :7544   nginx, in gw-e2e-proxy
#     -> h2c 127.0.0.1:7100   devserver-proxy's tunnel listener
#
# The edge has to be co-located. devserver-proxy puts TUNNEL_BIND_ADDR through
# `require_protected_listener` (`gateway/crates/devserver-proxy/src/config.rs`
# line 126), which refuses a non-loopback cleartext listener unless the
# operator declares CHAN_GATEWAY_INTERNAL_TRANSPORT=protected-overlay, so an
# edge in another container cannot reach that listener at all. Nothing of the
# rig's own path changes:
# `tls-forward.py` keeps serving :7444, the proxy keeps its loopback bind, and
# only the devserver's `--tunnel-url` moves. Everything `up` replaces is saved
# under STATE_DIR and `clean` reads the same files, so a half-finished `up` is
# still reversible.
#
#   nginx-edge.sh up         stand the edge up and route the devserver through it
#   nginx-edge.sh scenario   stop/start the terminator, timing both sides
#   nginx-edge.sh clean      put the rig back and remove the edge
#   nginx-edge.sh status     what is up right now
#
# The nginx binary comes from a rootfs built off nginx-edge.sdme, because the
# rig's zone has no outbound internet to install a package in place:
#   sudo sdme fs build -f chan-e2e-nginx nginx-edge.sdme
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null || echo "$HERE/../../../../../..")"
SDME="sudo -n sdme"

C_PROXY="${C_PROXY:-gw-e2e-proxy}"
C_DS="${C_DS:-gw-e2e-ds}"
RFS_NGINX="${RFS_NGINX:-chan-e2e-nginx}"
NGINX_SRC="${NGINX_SRC:-/var/lib/sdme/fs/$RFS_NGINX/usr/sbin/nginx}"
STATE_DIR="${STATE_DIR:-$REPO/target/devserver-e2e/nginx-edge}"

EDGE_DIR="${EDGE_DIR:-/root/nginx-edge}"
EDGE_UNIT="${EDGE_UNIT:-nginx-edge}"
EDGE_PORT="${EDGE_PORT:-7544}"
APEX="${APEX:-proxy.localtest.me}"
PROXY_PUB_PORT="${PROXY_PUB_PORT:-7002}"
PROXY_TUN_PORT="${PROXY_TUN_PORT:-7100}"
PROXY_TLS_PORT="${PROXY_TLS_PORT:-7443}"
# The rig's own tunnel edge (run.sh's TUNNEL_TLS_PORT), which the devserver
# dials when the nginx edge is not in the way.
TUNNEL_TLS_PORT="${TUNNEL_TLS_PORT:-7444}"
DS_PORT="${DS_PORT:-8787}"
# A registered tunnel carries nothing between requests. nginx's grpc_read_timeout
# defaults to 60s, which closes an idle tunnel on its own; the edge sets both
# grpc timeouts long so the measurement is about the terminator and nothing else.
EDGE_GRPC_TIMEOUT="${EDGE_GRPC_TIMEOUT:-1h}"
# nginx arms client_body_timeout, 60s by default, whenever it is waiting for
# more of a request body (`ngx_http_v2_read_request_body`), and a tunnel's
# request body is idle for long stretches, so the edge sets it long too.
EDGE_BODY_TIMEOUT="${EDGE_BODY_TIMEOUT:-1h}"

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
ts()   { date -u +%FT%T.%3NZ; }
stamp(){ printf '   [%s] %s\n' "$(ts)" "$*"; }
die()  { printf '\033[1;31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

running()  { $SDME ps 2>/dev/null | grep -qE "^$1[[:space:]].*running"; }
cip()      { $SDME exec "$1" -- /usr/bin/hostname -I 2>/dev/null | awk '{print $1}'; }
main_pid() { $SDME exec "$1" -- /usr/bin/systemctl show "$2" -p MainPID --value 2>/dev/null | tr -d '\r\n'; }
in_proxy() { $SDME exec "$C_PROXY" -- "$@"; }

# A unit's environment and argv as the kernel holds them, so a restart carries
# exactly what the rig started the unit with and nothing systemd added.
unit_setenv() {  # container unit prefix,prefix,... -> one --setenv= per line
    local pid; pid="$(main_pid "$1" "$2")"
    [ -n "$pid" ] && [ "$pid" != 0 ] || return 1
    $SDME exec "$1" -- /bin/sh -c "base64 -w0 /proc/$pid/environ" 2>/dev/null | python3 -c '
import base64, sys
allow = tuple(sys.argv[1].split(","))
for item in base64.b64decode(sys.stdin.read()).split(b"\0"):
    if not item:
        continue
    name, _, value = item.decode("utf-8", "replace").partition("=")
    if name.startswith(allow):
        print("--setenv=%s=%s" % (name, value))
' "$3"
}

unit_argv() {  # container unit -> one argv element per line
    local pid; pid="$(main_pid "$1" "$2")"
    [ -n "$pid" ] && [ "$pid" != 0 ] || return 1
    $SDME exec "$1" -- /bin/sh -c "base64 -w0 /proc/$pid/cmdline" 2>/dev/null | python3 -c '
import base64, sys
for item in base64.b64decode(sys.stdin.read()).split(b"\0"):
    if item:
        print(item.decode("utf-8", "replace"))
'
}

unit_value() {  # container unit name -> that variable's value in the running unit
    local pid; pid="$(main_pid "$1" "$2")"
    [ -n "$pid" ] && [ "$pid" != 0 ] || return 1
    $SDME exec "$1" -- /bin/sh -c "base64 -w0 /proc/$pid/environ" 2>/dev/null | python3 -c '
import base64, sys
want = sys.argv[1]
for item in base64.b64decode(sys.stdin.read()).split(b"\0"):
    name, _, value = item.decode("utf-8", "replace").partition("=")
    if name == want:
        print(value)
        break
' "$3"
}

# By prefix, every variable run.sh passes to the unit named.
DSP_ENV_PREFIXES='RUST_LOG,BIND_ADDR,TUNNEL_BIND_ADDR,IDENTITY_,DEVSERVER_,FORWARDED_PROTO,DASHBOARD_URL'
DS_ENV_PREFIXES='RUST_LOG,HOME,XDG_RUNTIME_DIR,SSL_CERT_FILE,CHAN_'

require_rig() {
    $SDME ps >/dev/null 2>&1 || die "sudo -n sdme is not working"
    running "$C_PROXY" || die "rig container $C_PROXY is not running"
    running "$C_DS"    || die "rig container $C_DS is not running"
}

proxy_ready() {  # the apex health surface, which routes on the Host header
    in_proxy /usr/bin/curl -fsS -H "Host: $APEX" \
      "http://127.0.0.1:$PROXY_PUB_PORT/readyz" >/dev/null 2>&1
}

# ------------------------------------------------------------------------ up

cmd_up() {
    require_rig
    [ -r "$NGINX_SRC" ] || sudo -n test -r "$NGINX_SRC" \
      || die "no nginx binary at $NGINX_SRC; build the rootfs from nginx-edge.sdme first"
    mkdir -p "$STATE_DIR"
    local proxy_ip; proxy_ip="$(cip "$C_PROXY")"
    [ -n "$proxy_ip" ] || die "could not read the proxy container IP"
    info "$C_PROXY ip=$proxy_ip"

    say "stage nginx beside the terminator in $C_PROXY"
    # An edge left running from an earlier `up` holds its own binary open, and
    # the copy below would fail with ETXTBSY, so `up` always starts from a
    # stopped edge. The devserver redials once the edge is back.
    in_proxy /usr/bin/systemctl stop "$EDGE_UNIT" >/dev/null 2>&1
    in_proxy /bin/mkdir -p "$EDGE_DIR/sbin" "$EDGE_DIR/logs" "$EDGE_DIR/tmp"
    $SDME cp "$NGINX_SRC" "$C_PROXY:$EDGE_DIR/sbin/nginx" || die "could not stage nginx"
    in_proxy /bin/chmod 0755 "$EDGE_DIR/sbin/nginx"
    in_proxy "$EDGE_DIR/sbin/nginx" -V > "$STATE_DIR/nginx-version.txt" 2>&1
    info "nginx $(sed -n 's#^nginx version: ##p' "$STATE_DIR/nginx-version.txt")"
    grep -q 'http_v2_module' "$STATE_DIR/nginx-version.txt" \
      || die "this nginx was built without the HTTP/2 module, so it cannot terminate the tunnel"

    say "configure the edge"
    render_edge_conf > "$STATE_DIR/nginx.conf"
    $SDME cp "$STATE_DIR/nginx.conf" "$C_PROXY:$EDGE_DIR/nginx.conf"
    in_proxy "$EDGE_DIR/sbin/nginx" -p "$EDGE_DIR" -c "$EDGE_DIR/nginx.conf" -t 2>&1 | sed 's/^/   /'
    in_proxy "$EDGE_DIR/sbin/nginx" -p "$EDGE_DIR" -c "$EDGE_DIR/nginx.conf" -t >/dev/null 2>&1 \
      || die "nginx rejected the edge configuration"

    say "start the edge"
    in_proxy /usr/bin/systemd-run --unit="$EDGE_UNIT" --collect \
      "$EDGE_DIR/sbin/nginx" -p "$EDGE_DIR" -c "$EDGE_DIR/nginx.conf" \
      >/dev/null || die "could not start the edge"
    sleep 1
    in_proxy /usr/bin/systemctl is-active "$EDGE_UNIT" >/dev/null 2>&1 \
      || { in_proxy /usr/bin/journalctl -u "$EDGE_UNIT" --no-pager | tail -20; die "the edge is not active"; }
    info "nginx listening on $proxy_ip:$EDGE_PORT, grpc_pass -> 127.0.0.1:$PROXY_TUN_PORT (h2c)"

    # dsp is transient (systemd-run --collect), so stopping it destroys the
    # unit. Save what the rig gave it while it is still running, so the
    # scenario and clean can bring the same proxy back.
    save_dsp_env || die "could not read the proxy unit environment"

    say "point the rig's devserver at the edge"
    # The rig's certificate carries the proxy container's address in its SANs,
    # so dialling the edge by that address needs no name or trust change.
    local edge_url="https://$proxy_ip:$EDGE_PORT/v1/tunnel"
    local have_url; have_url="$(ds_tunnel_url)"
    if [ -n "$have_url" ] && [ "$have_url" != "$edge_url" ] && [ ! -f "$STATE_DIR/ds-url-original" ]; then
        printf '%s\n' "$have_url" > "$STATE_DIR/ds-url-original"
        info "devserver tunnel-url $have_url saved for clean"
    fi
    # Always restart the devserver, even when it is already pointed here. The
    # edge was just restarted, so its tunnel is gone, and a client that has
    # been failing to dial is deep into its exponential backoff; a restart
    # brings it back at once instead of whenever that backoff next fires.
    restart_chands "$edge_url" || die "could not repoint the devserver at the edge"

    wait_for_ds_line "tunnel connected" 60 "$(ds_epoch)" >/dev/null \
      || die "the devserver did not register through the edge"
    stamp "devserver registered through the edge"
    e2e_request || die "no end-to-end response through the edge"
    say "up"
}

render_edge_conf() {
    cat <<EOF
# The tunnel ingress in the production shape: TLS + h2 on the apex, and
# /v1/tunnel grpc_passed as h2c into the terminator on this node's loopback.
daemon off;
user root;
worker_processes 1;
error_log $EDGE_DIR/logs/error.log info;
pid $EDGE_DIR/nginx.pid;
events { worker_connections 1024; }
http {
    access_log $EDGE_DIR/logs/access.log;
    client_body_temp_path $EDGE_DIR/tmp;
    proxy_temp_path $EDGE_DIR/tmp;
    fastcgi_temp_path $EDGE_DIR/tmp;
    uwsgi_temp_path $EDGE_DIR/tmp;
    scgi_temp_path $EDGE_DIR/tmp;

    server {
        listen $EDGE_PORT ssl;
        http2 on;
        server_name $APEX;

        ssl_certificate     /root/proxy.crt;
        ssl_certificate_key /root/proxy.key;

        # A tunnel is one request that lives as long as the devserver and
        # carries nothing between uses, so the edge must not put an idle
        # deadline on either direction, and must not cap a body that never
        # ends. Both directions need one: the grpc timeouts below bound the
        # upstream leg, and client_body_timeout bounds how long nginx waits
        # for more request body from the devserver.
        client_max_body_size 0;
        client_body_timeout $EDGE_BODY_TIMEOUT;

        location /v1/tunnel {
            grpc_pass grpc://127.0.0.1:$PROXY_TUN_PORT;
            grpc_read_timeout $EDGE_GRPC_TIMEOUT;
            grpc_send_timeout $EDGE_GRPC_TIMEOUT;
            grpc_socket_keepalive on;
        }

        location / { return 404; }
    }
}
EOF
}

save_dsp_env() {
    local saved="$STATE_DIR/dsp-setenv"
    [ "$(main_pid "$C_PROXY" dsp)" != 0 ] || { [ -s "$saved" ] && return 0; return 1; }
    mkdir -p "$STATE_DIR"
    unit_setenv "$C_PROXY" dsp "$DSP_ENV_PREFIXES" > "$saved.tmp" || return 1
    [ "$(grep -c . "$saved.tmp")" -gt 4 ] || { rm -f "$saved.tmp"; return 1; }
    mv "$saved.tmp" "$saved"
}

restart_dsp() {  # bring the terminator back exactly as the rig ran it
    local saved="$STATE_DIR/dsp-setenv" args
    [ -s "$saved" ] || { printf 'no saved environment for dsp in %s; run run.sh to rebuild the rig\n' "$saved" >&2; return 1; }
    mapfile -t args < "$saved"
    in_proxy /usr/bin/systemctl stop dsp >/dev/null 2>&1
    in_proxy /usr/bin/systemd-run --unit=dsp --collect \
      "${args[@]}" /root/devserver-proxy-service >/dev/null || return 1
    for _ in $(seq 1 90); do proxy_ready && { stamp "dsp active and fleet-ready"; return 0; }; sleep 1; done
    in_proxy /usr/bin/journalctl -u dsp --no-pager | tail -20
    return 1
}

ds_epoch()      { $SDME exec "$C_DS" -- /bin/date -u +%s; }
ds_tunnel_url() { unit_argv "$C_DS" chands | sed -n 's/^--tunnel-url=//p' | head -1; }

restart_chands() {  # tunnel url
    local args argv
    mapfile -t args < <(unit_setenv "$C_DS" chands "$DS_ENV_PREFIXES")
    [ "${#args[@]}" -ge 4 ] || { printf 'read only %d env args from chands\n' "${#args[@]}" >&2; return 1; }
    mapfile -t argv < <(unit_argv "$C_DS" chands | sed "s#^--tunnel-url=.*#--tunnel-url=$1#")
    [ "${#argv[@]}" -ge 2 ] || { printf 'read only %d argv elements from chands\n' "${#argv[@]}" >&2; return 1; }
    $SDME exec "$C_DS" -- /usr/bin/systemctl stop chands
    $SDME exec "$C_DS" -- /usr/bin/systemd-run --unit=chands --collect \
      "${args[@]}" "${argv[@]}" >/dev/null || return 1
    stamp "chands restarted with --tunnel-url=$1"
}

wait_for_ds_line() {  # pattern seconds since-epoch -> seconds waited on stdout
    local pattern="$1" limit="$2" since="$3" start end
    start="$(date +%s.%N)"
    for _ in $(seq 1 $((limit * 4))); do
        if $SDME exec "$C_DS" -- /usr/bin/journalctl -u chands --no-pager -S "@$since" 2>/dev/null \
             | grep -q "$pattern"; then
            end="$(date +%s.%N)"
            python3 -c 'import sys;print("%.1f" % (float(sys.argv[1]) - float(sys.argv[2])))' "$end" "$start"
            return 0
        fi
        sleep 0.25
    done
    printf 'none\n'
    return 1
}

# ------------------------------------------------- end-to-end through the edge

e2e_request() {
    local proxy_ip ds_ip origin audience user_id devserver_id owner_pat stub_bind identity_origin
    proxy_ip="$(cip "$C_PROXY")"; ds_ip="$(cip "$C_DS")"
    origin="$(unit_value "$C_PROXY" stub STUB_PROXY_ORIGIN)"
    audience="$(unit_value "$C_PROXY" stub STUB_AUDIENCE)"
    user_id="$(unit_value "$C_PROXY" stub STUB_USER_ID)"
    devserver_id="$(unit_value "$C_PROXY" stub STUB_DEVSERVER_ID)"
    owner_pat="$(unit_value "$C_PROXY" stub STUB_DESKTOP_OWNER_PAT)"
    stub_bind="$(unit_value "$C_PROXY" stub STUB_BIND)"
    identity_origin="$(unit_value "$C_PROXY" dsp IDENTITY_PUBLIC_ORIGIN)"
    [ -n "$origin" ] && [ -n "$audience" ] && [ -n "$owner_pat" ] && [ -n "$identity_origin" ] \
      || { printf 'could not read the rig fixture configuration\n' >&2; return 1; }
    local host_name="${audience%:*}"

    $SDME exec "$C_DS" -- /bin/cat /usr/local/share/ca-certificates/chan-e2e.crt > "$STATE_DIR/ca.crt" 2>/dev/null
    [ -s "$STATE_DIR/ca.crt" ] || { printf 'could not read the rig CA from %s\n' "$C_DS" >&2; return 1; }

    local token prefix
    token="$($SDME exec "$C_DS" -- /bin/cat /root/.chan/devserver/config.json 2>/dev/null \
      | python3 -c 'import sys,json;print(json.load(sys.stdin).get("devserver_token",""))' 2>/dev/null)"
    prefix="$(curl -fsS --noproxy '*' -H "Authorization: Bearer $token" \
      "http://$ds_ip:$DS_PORT/api/devserver/workspaces" 2>/dev/null | python3 -c '
import json, sys
try:
    body = json.load(sys.stdin)
    rows = body if isinstance(body, list) else body.get("workspaces", [])
    print(rows[0]["prefix"])
except Exception:
    print("")')"
    [ -n "$prefix" ] || { printf 'could not resolve the mounted workspace prefix\n' >&2; return 1; }

    local entry_json entry_url credential
    entry_json="$(in_proxy /usr/bin/curl -fsS \
      -H "Authorization: Bearer $owner_pat" -H 'content-type: application/json' \
      --data "$(printf '{"owner_user_id":"%s","devserver_id":"%s","path":"%s/"}' \
                 "$user_id" "$devserver_id" "$prefix")" \
      "http://$stub_bind/desktop/v1/devserver/entry" 2>/dev/null)"
    entry_url="$(printf '%s' "$entry_json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["entry_exchange_url"])' 2>/dev/null)"
    credential="$(printf '%s' "$entry_json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["entry_credential"])' 2>/dev/null)"
    [ -n "$entry_url" ] && [ -n "$credential" ] \
      || { printf 'the identity fixture did not mint an entry credential\n' >&2; return 1; }

    local headers code gate csrf body
    headers="$(mktemp)"
    code="$(curl -sS --noproxy '*' --cacert "$STATE_DIR/ca.crt" \
      --resolve "$host_name:$PROXY_TLS_PORT:$proxy_ip" \
      -o /dev/null -D "$headers" -w '%{http_code}' -X POST -H "Origin: $identity_origin" \
      -H 'Content-Type: application/x-www-form-urlencoded' \
      --data-urlencode "credential=$credential" "$entry_url" 2>/dev/null || echo 000)"
    if [ "$code" != 303 ]; then
        rm -f "$headers"; printf 'entry exchange returned %s, expected 303\n' "$code" >&2; return 1
    fi
    gate="$(sed -n 's/^set-cookie: __Host-devserver_gate=\([^;]*\).*/\1/ip' "$headers" | head -1 | tr -d '\r')"
    csrf="$(sed -n 's/^set-cookie: __Host-devserver_csrf=\([^;]*\).*/\1/ip' "$headers" | head -1 | tr -d '\r')"
    rm -f "$headers"
    [ -n "$gate" ] && [ -n "$csrf" ] || { printf 'entry exchange minted no session\n' >&2; return 1; }

    body="$(mktemp)"
    code="$(curl -sS --noproxy '*' --cacert "$STATE_DIR/ca.crt" \
      --resolve "$host_name:$PROXY_TLS_PORT:$proxy_ip" -o "$body" -w '%{http_code}' \
      -H "Cookie: __Host-devserver_gate=$gate; __Host-devserver_csrf=$csrf" \
      "$origin$prefix/api/health" 2>/dev/null || echo 000)"
    stamp "GET $prefix/api/health -> $code $(head -c 200 "$body" | tr -d '\n')"
    rm -f "$body"
    [ "$code" = 200 ]
}

# ------------------------------------------------------------------- scenario

edge_upstreams()   { in_proxy /usr/bin/ss -Htn state established "dport = :$PROXY_TUN_PORT" 2>/dev/null | grep -c .; }
edge_downstreams() { in_proxy /usr/bin/ss -Htn state established "sport = :$EDGE_PORT"      2>/dev/null | grep -c .; }
edge_sockets()     { printf '%s downstream / %s upstream connection(s)' "$(edge_downstreams)" "$(edge_upstreams)"; }

cmd_scenario() {
    require_rig
    in_proxy /usr/bin/systemctl is-active "$EDGE_UNIT" >/dev/null 2>&1 \
      || die "the edge is not running; run '$0 up' first"
    [ "$(ds_tunnel_url)" = "https://$(cip "$C_PROXY"):$EDGE_PORT/v1/tunnel" ] \
      || die "the devserver is not dialling the edge; run '$0 up' first"
    mkdir -p "$STATE_DIR"
    # dsp is a transient --collect unit, so the stop below destroys it and its
    # environment survives only in $STATE_DIR/dsp-setenv. STATE_DIR is derived
    # from the checkout and sits under target/, so it can be absent even though
    # an earlier `up` wrote it. Save it while dsp is still up, or stop nothing.
    save_dsp_env \
      || die "cannot save the terminator's environment to $STATE_DIR/dsp-setenv, so it could not be restarted; nothing was stopped. Run '$0 up' first, or run.sh to rebuild the rig"
    local t_since p_since
    t_since="$(ds_epoch)"; p_since="$(in_proxy /bin/date -u +%s)"

    say "baseline: a devserver registered through the edge serves a request"
    stamp "edge holds $(edge_sockets)"
    e2e_request || die "the baseline request did not come back 200"

    say "close the terminator behind the edge"
    local t_stop saw_close saw_retry
    t_stop="$(ds_epoch)"
    stamp "stopping dsp"
    in_proxy /usr/bin/systemctl stop dsp
    stamp "dsp stopped; edge holds $(edge_sockets)"
    saw_close="$(wait_for_ds_line "tunnel disconnected" 30 "$((t_stop - 1))")"
    stamp "devserver reported the tunnel closed after ${saw_close}s"
    stamp "edge now holds $(edge_sockets)"
    saw_retry="$(wait_for_ds_line "tunnel dial failed" 30 "$((t_stop - 1))")"
    stamp "devserver reported its first failed redial after ${saw_retry}s"
    stamp "edge error log since the close:"
    in_proxy /bin/sh -c "tail -5 $EDGE_DIR/logs/error.log" 2>&1 | sed 's/^/     /'

    say "reopen the terminator"
    local t_start saw_up
    t_start="$(ds_epoch)"
    restart_dsp || die "could not restart the terminator"
    saw_up="$(wait_for_ds_line "tunnel connected" 90 "$((t_start - 1))")"
    stamp "devserver reconnected through the edge after ${saw_up}s"
    stamp "edge holds $(edge_sockets)"
    e2e_request || die "no end-to-end response after the reconnect"

    say "logs"
    $SDME exec "$C_DS" -- /usr/bin/journalctl -u chands --no-pager -o short-iso-precise -S "@$t_since" \
      > "$STATE_DIR/devserver.log" 2>&1
    in_proxy /usr/bin/journalctl -u dsp --no-pager -o short-iso-precise -S "@$p_since" \
      > "$STATE_DIR/proxy.log" 2>&1
    in_proxy /bin/cat "$EDGE_DIR/logs/error.log"  > "$STATE_DIR/nginx-error.log" 2>&1
    in_proxy /bin/cat "$EDGE_DIR/logs/access.log" > "$STATE_DIR/nginx-access.log" 2>&1
    info "devserver: $STATE_DIR/devserver.log"
    info "proxy:     $STATE_DIR/proxy.log"
    info "edge:      $STATE_DIR/nginx-error.log, $STATE_DIR/nginx-access.log"
    say "scenario complete"
}

# ---------------------------------------------------------------------- clean

cmd_clean() {
    local url proxy_ip edge_url
    proxy_ip="$(cip "$C_PROXY")"
    edge_url="https://$proxy_ip:$EDGE_PORT/v1/tunnel"
    if running "$C_DS"; then
        url="$(cat "$STATE_DIR/ds-url-original" 2>/dev/null)"
        # Removing the edge below strands a devserver that still dials it, and
        # the url the rig gave the devserver is known only from the saved file,
        # so with that file gone there is nothing to put back. Refuse while the
        # edge is still serving.
        if [ -z "$url" ] && [ "$(ds_tunnel_url)" = "$edge_url" ]; then
            die "the devserver dials the edge and $STATE_DIR/ds-url-original is gone, so clean cannot put it back and nothing was stopped; write the url the rig gave the devserver, normally https://$proxy_ip:$TUNNEL_TLS_PORT/v1/tunnel, into that file and run '$0 clean' again, or run run.sh to rebuild the rig"
        fi
        if [ -n "$url" ] && [ "$(ds_tunnel_url)" != "$url" ]; then
            restart_chands "$url" && rm -f "$STATE_DIR/ds-url-original" \
              || info "could not restore the devserver tunnel url $url"
        else
            rm -f "$STATE_DIR/ds-url-original"
        fi
    fi
    if running "$C_PROXY"; then
        in_proxy /usr/bin/systemctl stop "$EDGE_UNIT" >/dev/null 2>&1 && info "stopped the edge unit"
        in_proxy /bin/rm -rf "$EDGE_DIR" && info "removed $EDGE_DIR from $C_PROXY"
        in_proxy /usr/bin/systemctl is-active dsp >/dev/null 2>&1 \
          || { info "the terminator is down; bringing it back"; restart_dsp || info "could not restart dsp"; }
    fi
    if running "$C_DS"; then
        wait_for_ds_line "tunnel connected" 30 "$(( $(ds_epoch) - 2 ))" >/dev/null \
          && info "the rig is registered on its own tunnel path again" \
          || info "the rig has NOT re-registered; check journalctl -u chands in $C_DS"
    fi
    info "the rootfs '$RFS_NGINX' is left in place; remove it with: sudo sdme fs rm $RFS_NGINX"
}

# --------------------------------------------------------------------- status

cmd_status() {
    $SDME ps 2>/dev/null | sed 's/^/   /'
    if running "$C_PROXY"; then
        info "edge: $(in_proxy /usr/bin/systemctl is-active "$EDGE_UNIT" 2>&1)"
        in_proxy /usr/bin/systemctl is-active "$EDGE_UNIT" >/dev/null 2>&1 && info "edge holds $(edge_sockets)"
        info "proxy tunnel bind: $(unit_value "$C_PROXY" dsp TUNNEL_BIND_ADDR)"
    fi
    running "$C_DS" && info "devserver tunnel-url: $(ds_tunnel_url)"
}

case "${1:-}" in
    up)       cmd_up ;;
    scenario) cmd_scenario ;;
    clean)    cmd_clean ;;
    status)   cmd_status ;;
    *)        sed -n '2,32p' "$0"; exit 2 ;;
esac
