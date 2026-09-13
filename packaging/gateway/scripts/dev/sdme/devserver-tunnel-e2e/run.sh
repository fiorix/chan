#!/usr/bin/env bash
# devserver-tunnel-e2e -- cross-CONTAINER end-to-end for the chan devserver tunnel.
#
# Stands up the REAL devserver-proxy-service and a REAL `chan devserver run
# --tunnel-url` in two SEPARATE sdme containers, then drives a request through
# the proxy's PUBLIC surface, over the tunnel, into the devserver's mounted
# workspace. An authenticated 200 from the mounted workspace's `/api/health`
# is the proof -- that request travelled host -> TLS edge -> proxy:7002 ->
# gate -> tunnel -> chan devserver.
#
# Topology (see zone-isolation-probe.sh + README for WHY one zone):
#   zone gw-e2e
#     gw-e2e-proxy : devserver-proxy-service (real) + stub-identity (loopback)
#     gw-e2e-ds    : chan devserver run --tunnel-url + a mounted workspace
#   The tunnel is gw-e2e-ds -> gw-e2e-proxy:7100 (same-zone container IP). On
#   this host the kernel firewall drops container->host and cross-zone TCP
#   (ICMP only), and `-p` does not bridge zones, so same-zone is the only path
#   the host permits without root iptables. The containers are still separate
#   (own netns/fs/process tree); the tunnel genuinely crosses between them.
#
# Identity is a narrow stub on the proxy's loopback. It validates one exact
# tunnel PAT and signs short-lived admission and entry credentials; the real
# controller and proxy verify them. Public and tunnel traffic reaches the
# proxy's loopback-only listeners through per-run TLS forwarders.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null || echo "$HERE/../../../../../..")"
BIN_DIR="${BIN_DIR:-$REPO/target/devserver-e2e/bin}"
PROXY_BIN="$(readlink -f "$BIN_DIR/devserver-proxy-service")"
CONTROL_BIN="$(readlink -f "$BIN_DIR/devserver-control-service")"
CHAN_BIN="$(readlink -f "$BIN_DIR/chan")"
STUB_PY="$HERE/stub-identity.py"
MINT_PY="$HERE/mint-signed-credential.py"
TLS_FORWARD_PY="$HERE/tls-forward.py"
EXTENSION_PY="$HERE/e2e-extension.py"
KEYGEN_PY="$REPO/packaging/gateway/scripts/generate-admission-keypair.py"
RFS_SDME="$HERE/chan-e2e-run.sdme"
SDME="sudo -n sdme"
RFS="${RFS:-chan-e2e-run-v2}"

ZONE="${ZONE:-gw-e2e}"
C_PROXY="${C_PROXY:-gw-e2e-proxy}"
C_DS="${C_DS:-gw-e2e-ds}"

PROXY_ID="p1"
APEX="proxy.localtest.me"
NODE_HOST="$PROXY_ID.$APEX"
SUFFIX=".$NODE_HOST"
TENANT_USER="alice"
USER_ID="11111111-1111-4111-8111-111111111111"
GRANTEE_USER_ID="22222222-2222-4222-8222-222222222222"
IDENTITY_TOKEN="e2e-identity-internal-token-00000001"
PAT="chan_pat_e2e_dummy_token"
DEVSERVER_ID="$(printf '%s' "$PAT" | sha256sum | awk '{print $1}')"
DESKTOP_OWNER_PAT="chan_pat_e2e_desktop_owner"
DESKTOP_GRANTEE_PAT="chan_pat_e2e_desktop_grantee"
BROWSER_OWNER_SESSION="e2e-stub-identity-browser-owner"
BROWSER_GRANTEE_SESSION="e2e-stub-identity-browser-grantee"
CONTROL_OPERATOR_TOKEN="e2e-control-operator-00000000000001"
CONTROL_IDENTITY_TOKEN="e2e-control-identity-00000000000001"
CONTROL_PROFILE_TOKEN="e2e-control-profile-000000000000001"
PROXY_TOKEN="e2e-proxy-p1-00000000000000000001"
STUB_PORT="7799"
WS_NAME="notes"
PROXY_PUB_PORT=7002
PROXY_TUN_PORT=7100
PROXY_TLS_PORT=7443
TUNNEL_TLS_PORT=7444
CONTROL_ADMIN_PORT=7003
CONTROL_PROXY_PORT=7101
DS_PORT=8787
HOST_NAME="${TENANT_USER}--${DEVSERVER_ID:0:12}${SUFFIX}"
HOSTHDR="$HOST_NAME:$PROXY_TLS_PORT"
PROXY_ORIGIN="https://$HOSTHDR"
IDENTITY_ORIGIN="https://gw.localtest.me"

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die()  { printf '\033[1;31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }
cip()  { $SDME exec "$1" -- /usr/bin/hostname -I 2>/dev/null | awk '{print $1}'; }
proxy_curl() {
  curl --noproxy '*' --cacert "$TLS_DIR/ca.crt" \
    --resolve "$HOST_NAME:$PROXY_TLS_PORT:$PROXY_IP" "$@"
}

cleanup() {
  $SDME rm -f "$C_PROXY" "$C_DS" >/dev/null 2>&1 || true
  info "removed containers $C_PROXY $C_DS"
}
[ "${1:-}" = "--clean" ] && { say "cleanup"; cleanup; exit 0; }

say "preflight"
[ -x "$PROXY_BIN" ] || die "missing proxy binary $PROXY_BIN (build first)"
[ -x "$CONTROL_BIN" ] || die "missing controller binary $CONTROL_BIN (build first)"
[ -x "$CHAN_BIN" ]  || die "missing chan binary $CHAN_BIN (build first)"
[ -f "$STUB_PY" ] && [ -x "$MINT_PY" ] && [ -f "$TLS_FORWARD_PY" ] && [ -f "$EXTENSION_PY" ] \
  && [ -x "$KEYGEN_PY" ] \
  || die "missing helper scripts in $HERE"
command -v openssl >/dev/null || die "openssl is required"
mapfile -t ADMISSION_KEYS < <("$KEYGEN_PY")
mapfile -t ENTRY_KEYS < <("$KEYGEN_PY")
[ "${#ADMISSION_KEYS[@]}" = 2 ] && [ "${#ENTRY_KEYS[@]}" = 2 ] \
  || die "Ed25519 key generation failed"
ADMISSION_SIGNING_KEY="${ADMISSION_KEYS[0]}"
ADMISSION_VERIFYING_KEY="${ADMISSION_KEYS[1]}"
ENTRY_SIGNING_KEY="${ENTRY_KEYS[0]}"
ENTRY_VERIFYING_KEY="${ENTRY_KEYS[1]}"
$SDME ps >/dev/null 2>&1 || die "sudo -n sdme not working"
if ! $SDME fs ls 2>/dev/null | grep -qE "^${RFS}[[:space:]]"; then
  info "runtime rootfs '$RFS' missing -- building from $RFS_SDME (one-time)"
  ( cd "$HERE" && $SDME fs build -f "$RFS" "$(basename "$RFS_SDME")" ) >/tmp/e2e-rfs.log 2>&1 \
    || { tail -20 /tmp/e2e-rfs.log; die "rootfs build failed"; }
fi
info "binaries + helpers present; sdme ok; rootfs '$RFS' present"

mk() {  # name
  $SDME create --name "$1" -r "$RFS" --storage btrfs --network-zone "$ZONE" --started -t 90 >/tmp/e2e-mk.log 2>&1
  for _ in $(seq 1 15); do $SDME ps 2>/dev/null | grep -qE "^$1[[:space:]].*running" && return 0; sleep 1; done
  cat /tmp/e2e-mk.log; return 1
}

say "create two containers in zone $ZONE"
$SDME rm -f "$C_PROXY" "$C_DS" >/dev/null 2>&1 || true
mk "$C_PROXY" || die "create $C_PROXY"
mk "$C_DS"    || die "create $C_DS"
sleep 2
PROXY_IP="$(cip "$C_PROXY")"; DS_IP="$(cip "$C_DS")"
info "$C_PROXY ip=$PROXY_IP   $C_DS ip=$DS_IP"
[ -n "$PROXY_IP" ] && [ -n "$DS_IP" ] || die "could not read container IPs"

TLS_DIR="$(mktemp -d "$REPO/target/devserver-e2e/tls.XXXXXX")"
trap 'rm -rf -- "$TLS_DIR"' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=chan sdme e2e CA' -keyout "$TLS_DIR/ca.key" -out "$TLS_DIR/ca.crt" \
  >/dev/null 2>&1 || die "generate e2e CA"
openssl req -newkey rsa:2048 -nodes -subj "/CN=$APEX" \
  -addext "subjectAltName=DNS:$APEX,DNS:*.$NODE_HOST,IP:$PROXY_IP" \
  -keyout "$TLS_DIR/proxy.key" -out "$TLS_DIR/proxy.csr" >/dev/null 2>&1 \
  || die "generate proxy TLS key"
openssl x509 -req -days 1 -sha256 -copy_extensions copy \
  -in "$TLS_DIR/proxy.csr" -CA "$TLS_DIR/ca.crt" -CAkey "$TLS_DIR/ca.key" \
  -CAcreateserial -out "$TLS_DIR/proxy.crt" >/dev/null 2>&1 \
  || die "sign proxy TLS certificate"

say "stage binaries + helpers + workspace"
$SDME cp "$CONTROL_BIN" "$C_PROXY:/root/devserver-control-service"
$SDME cp "$PROXY_BIN" "$C_PROXY:/root/devserver-proxy-service"
$SDME cp "$STUB_PY"   "$C_PROXY:/root/stub-identity.py"
$SDME cp "$MINT_PY"   "$C_PROXY:/root/mint-signed-credential.py"
$SDME cp "$TLS_FORWARD_PY" "$C_PROXY:/root/tls-forward.py"
$SDME cp "$TLS_DIR/proxy.crt" "$C_PROXY:/root/proxy.crt"
$SDME cp "$TLS_DIR/proxy.key" "$C_PROXY:/root/proxy.key"
$SDME exec "$C_PROXY" -- /bin/chmod +x /root/devserver-control-service \
  /root/devserver-proxy-service /root/stub-identity.py \
  /root/mint-signed-credential.py /root/tls-forward.py
$SDME cp "$CHAN_BIN"  "$C_DS:/root/chan"
$SDME cp "$TLS_DIR/ca.crt" "$C_DS:/usr/local/share/ca-certificates/chan-e2e.crt"
$SDME exec "$C_DS" -- /usr/sbin/update-ca-certificates >/dev/null
$SDME exec "$C_DS" -- /bin/chmod +x /root/chan
$SDME exec "$C_DS" -- /bin/sh -c \
  "mkdir -p /root/$WS_NAME /run/chan && printf '# e2e notes\nhello-through-the-tunnel\n' > /root/$WS_NAME/README.md"
# A declared local extension: chan starts it when the devserver starts.
$SDME exec "$C_DS" -- /bin/mkdir -p /root/.chan/extensions
$SDME cp "$EXTENSION_PY" "$C_DS:/root/.chan/extensions/e2e-extension.py"
$SDME exec "$C_DS" -- /bin/sh -c \
  "printf 'name = \"E2E extension\"\ncommand = \"python3\"\nargs = [\"e2e-extension.py\"]\n' > /root/.chan/extensions/e2e.toml"

say "start scoped identity fixture (loopback) in $C_PROXY"
$SDME exec "$C_PROXY" -- /usr/bin/systemd-run --unit=stub --collect \
  --setenv=STUB_BIND=127.0.0.1:$STUB_PORT --setenv=STUB_USERNAME=$TENANT_USER \
  --setenv=STUB_USER_ID=$USER_ID --setenv=STUB_DEVSERVER_ID="$DEVSERVER_ID" \
  --setenv=STUB_GRANTEE_USER_ID=$GRANTEE_USER_ID --setenv=STUB_PROXY_ID=$PROXY_ID \
  --setenv=STUB_PROXY_ORIGIN="$PROXY_ORIGIN" --setenv=STUB_AUDIENCE="$HOSTHDR" \
  --setenv=STUB_TUNNEL_PAT=$PAT --setenv=STUB_IDENTITY_INTERNAL_TOKEN=$IDENTITY_TOKEN \
  --setenv=STUB_DESKTOP_OWNER_PAT=$DESKTOP_OWNER_PAT \
  --setenv=STUB_DESKTOP_GRANTEE_PAT=$DESKTOP_GRANTEE_PAT \
  --setenv=STUB_BROWSER_OWNER_SESSION=$BROWSER_OWNER_SESSION \
  --setenv=STUB_BROWSER_GRANTEE_SESSION=$BROWSER_GRANTEE_SESSION \
  "--setenv=STUB_ADMISSION_SIGNING_KEY=$ADMISSION_SIGNING_KEY" \
  "--setenv=STUB_ENTRY_SIGNING_KEY=$ENTRY_SIGNING_KEY" \
  /usr/bin/python3 /root/stub-identity.py || die "systemd-run stub identity"
sleep 1

say "start devserver-control-service in $C_PROXY"
$SDME exec "$C_PROXY" -- /usr/bin/systemd-run --unit=ctl --collect \
  --setenv=RUST_LOG=info \
  --setenv=BIND_ADDR=127.0.0.1:$CONTROL_ADMIN_PORT \
  --setenv=PROXY_BIND_ADDR=127.0.0.1:$CONTROL_PROXY_PORT \
  --setenv=DEVSERVER_OPERATOR_ADMIN_TOKENS=$CONTROL_OPERATOR_TOKEN \
  --setenv=DEVSERVER_IDENTITY_ADMIN_TOKENS=$CONTROL_IDENTITY_TOKEN \
  --setenv=DEVSERVER_PROFILE_ADMIN_TOKENS=$CONTROL_PROFILE_TOKEN \
  --setenv=DEVSERVER_PROXY_CREDENTIALS=$PROXY_ID=$PROXY_TOKEN \
  "--setenv=DEVSERVER_ADMISSION_VERIFYING_KEYS=$ADMISSION_VERIFYING_KEY" \
  --setenv=DEVSERVER_PROXY_BASE_URL_TEMPLATE=https://\{proxy_id\}.$APEX:$PROXY_TLS_PORT \
  --setenv=MAX_DEVSERVERS_PER_USER=2 \
  /root/devserver-control-service || die "systemd-run controller"
sleep 1
$SDME exec "$C_PROXY" -- /usr/bin/systemctl is-active ctl >/dev/null 2>&1 \
  || { $SDME exec "$C_PROXY" -- /usr/bin/journalctl -u ctl --no-pager | tail -30; die "controller not active"; }

say "start devserver-proxy-service in $C_PROXY"
$SDME exec "$C_PROXY" -- /usr/bin/systemd-run --unit=dsp --collect \
  --setenv=RUST_LOG=info \
  --setenv=BIND_ADDR=127.0.0.1:$PROXY_PUB_PORT \
  --setenv=TUNNEL_BIND_ADDR=127.0.0.1:$PROXY_TUN_PORT \
  --setenv=IDENTITY_URL=http://127.0.0.1:$STUB_PORT \
  --setenv=IDENTITY_INTERNAL_TOKEN=$IDENTITY_TOKEN \
  --setenv=IDENTITY_PUBLIC_ORIGIN=$IDENTITY_ORIGIN \
  "--setenv=DEVSERVER_ENTRY_VERIFYING_KEYS=$ENTRY_VERIFYING_KEY" \
  "--setenv=DEVSERVER_ADMISSION_VERIFYING_KEYS=$ADMISSION_VERIFYING_KEY" \
  --setenv=DEVSERVER_TUNNEL_ORIGIN=https://$APEX:$TUNNEL_TLS_PORT \
  --setenv=DEVSERVER_PROXY_BASE_URL=https://$NODE_HOST:$PROXY_TLS_PORT \
  --setenv=DEVSERVER_CONTROL_URL=http://127.0.0.1:$CONTROL_PROXY_PORT \
  --setenv=DEVSERVER_PROXY_TOKEN=$PROXY_TOKEN --setenv=DEVSERVER_PROXY_ID=$PROXY_ID \
  --setenv=FORWARDED_PROTO=https \
  --setenv=DASHBOARD_URL=$IDENTITY_ORIGIN/workspaces \
  /root/devserver-proxy-service || die "systemd-run proxy"
sleep 1
$SDME exec "$C_PROXY" -- /usr/bin/systemctl is-active dsp >/dev/null 2>&1 \
  || { $SDME exec "$C_PROXY" -- /usr/bin/journalctl -u dsp --no-pager | tail -30; die "proxy not active"; }

say "start TLS forwarders onto the proxy loopback listeners"
for SPEC in "public:$PROXY_TLS_PORT:$PROXY_PUB_PORT:http1" "tunnel:$TUNNEL_TLS_PORT:$PROXY_TUN_PORT:h2"; do
  IFS=: read -r UNIT TLS_PORT INNER_PORT PROTOCOL <<< "$SPEC"
  $SDME exec "$C_PROXY" -- /usr/bin/systemd-run --unit="tls-$UNIT" --collect \
    /usr/bin/python3 /root/tls-forward.py \
    --listen="0.0.0.0:$TLS_PORT" --target="127.0.0.1:$INNER_PORT" \
    --cert=/root/proxy.crt --key=/root/proxy.key --protocol="$PROTOCOL" \
    || die "systemd-run $UNIT TLS forwarder"
done
sleep 2
curl --cacert "$TLS_DIR/ca.crt" --resolve "$APEX:$PROXY_TLS_PORT:$PROXY_IP" \
  -fsS "https://$APEX:$PROXY_TLS_PORT/healthz" >/dev/null 2>&1 \
  && info "proxy /healthz ok over TLS (host -> $PROXY_IP:$PROXY_TLS_PORT)" \
  || die "host cannot reach proxy TLS surface $PROXY_IP:$PROXY_TLS_PORT"

say "wait for controller/proxy convergence"
READY=0
for _ in $(seq 1 90); do
  curl --cacert "$TLS_DIR/ca.crt" --resolve "$APEX:$PROXY_TLS_PORT:$PROXY_IP" \
    -fsS "https://$APEX:$PROXY_TLS_PORT/readyz" >/dev/null 2>&1 \
    && { READY=1; break; }
  sleep 1
done
[ "$READY" = 1 ] \
  || { $SDME exec "$C_PROXY" -- /usr/bin/journalctl -u dsp --no-pager | tail -30; die "proxy did not become fleet-ready"; }
info "controller and proxy converged"

say "start chan devserver in $C_DS (tunnel -> $C_PROXY:$PROXY_TUN_PORT, same zone)"
TUNNEL_URL="https://$PROXY_IP:$TUNNEL_TLS_PORT/v1/tunnel"
info "tunnel-url = $TUNNEL_URL"
$SDME exec "$C_DS" -- /usr/bin/systemd-run --unit=chands --collect \
  --setenv=RUST_LOG=info,chan_server::devserver=debug --setenv=HOME=/root --setenv=XDG_RUNTIME_DIR=/run/chan \
  --setenv=SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
  --setenv=CHAN_TUNNEL_TOKEN=$PAT --setenv=CHAN_DEVSERVER_LISTEN=1 \
  /root/chan devserver run --bind 0.0.0.0 --port $DS_PORT --tunnel-url="$TUNNEL_URL" \
  || die "systemd-run chan devserver"

say "wait for tunnel registration"
REG=0
for _ in $(seq 1 30); do
  $SDME exec "$C_DS" -- /usr/bin/journalctl -u chands --no-pager 2>/dev/null | grep -q "tunnel connected" && { REG=1; break; }
  sleep 1
done
$SDME exec "$C_DS" -- /usr/bin/journalctl -u chands --no-pager 2>/dev/null | tail -12
[ "$REG" = 1 ] || { $SDME exec "$C_PROXY" -- /usr/bin/journalctl -u dsp --no-pager | tail -20; die "tunnel did not connect"; }
info "tunnel connected"

say "mount workspace via chan serve (local devserver handoff)"
$SDME exec "$C_DS" -- /bin/sh -c "HOME=/root XDG_RUNTIME_DIR=/run/chan /root/chan serve /root/$WS_NAME" 2>&1 | tail -6 || true
sleep 2
TOKEN="$($SDME exec "$C_DS" -- /bin/cat /root/.chan/devserver/config.json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("devserver_token",""))' 2>/dev/null || true)"
WS_JSON="$(curl -fsS -H "Authorization: Bearer $TOKEN" "http://$DS_IP:$DS_PORT/api/devserver/workspaces" 2>/dev/null || true)"
info "workspaces: $WS_JSON"
PREFIX="$(printf '%s' "$WS_JSON" | python3 -c 'import sys,json
try:
 d=json.load(sys.stdin); rows=d if isinstance(d,list) else d.get("workspaces",[]); print(rows[0]["prefix"])
except Exception: print("")')"
[ -n "$PREFIX" ] || die "could not resolve mounted workspace prefix"
info "mounted prefix = $PREFIX"

# `chan serve` registers through the live devserver handoff. Current lifecycle
# semantics keep a newly registered workspace off until the management API
# explicitly serves it, so activate it before asking the proxy for tenant HTML.
ON_JSON="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data '{"on":true}' "http://$DS_IP:$DS_PORT/api/devserver/workspaces$PREFIX/on")" \
  || die "could not activate mounted workspace"
printf '%s' "$ON_JSON" | python3 -c '
import json, sys
row = json.load(sys.stdin)
assert row["on"] is True
assert row["status"] == "running"
assert row["token"]
' || die "workspace activation did not reach running state"
info "workspace active through management API"

say "mint authenticated desktop entry responses"
ENTRY_BODY="$(printf '{\"owner_user_id\":\"%s\",\"devserver_id\":\"%s\",\"path\":\"%s/\"}' \
  "$USER_ID" "$DEVSERVER_ID" "$PREFIX")"
BAD_ENTRY_CODE="$($SDME exec "$C_PROXY" -- /usr/bin/curl -sS -o /tmp/bad-entry.json \
  -w '%{http_code}' -H 'Authorization: Bearer wrong' -H 'content-type: application/json' \
  --data "$ENTRY_BODY" "http://127.0.0.1:$STUB_PORT/desktop/v1/devserver/entry" || true)"
[ "$BAD_ENTRY_CODE" = "401" ] || die "desktop entry accepted an invalid bearer ($BAD_ENTRY_CODE)"

OWNER_ENTRY_JSON="$($SDME exec "$C_PROXY" -- /usr/bin/curl -fsS \
  -H "Authorization: Bearer $DESKTOP_OWNER_PAT" -H 'content-type: application/json' \
  --data "$ENTRY_BODY" "http://127.0.0.1:$STUB_PORT/desktop/v1/devserver/entry")" \
  || die "owner desktop entry response"
GRANTEE_ENTRY_JSON="$($SDME exec "$C_PROXY" -- /usr/bin/curl -fsS \
  -H "Authorization: Bearer $DESKTOP_GRANTEE_PAT" -H 'content-type: application/json' \
  --data "$ENTRY_BODY" "http://127.0.0.1:$STUB_PORT/desktop/v1/devserver/entry")" \
  || die "grantee desktop entry response"
printf '%s\n%s\n' "$OWNER_ENTRY_JSON" "$GRANTEE_ENTRY_JSON" | python3 -c '
import base64
import json, sys
rows = [json.loads(line) for line in sys.stdin if line.strip()]
assert len(rows) == 2
for index, row in enumerate(rows):
    assert row["owner_user_id"] == sys.argv[2]
    assert row["username"] == sys.argv[1]
    assert row["devserver_id"] == sys.argv[3] and len(row["devserver_id"]) == 64
    assert row["proxy_origin"] == sys.argv[4]
    assert row["entry_exchange_url"] == sys.argv[4] + "/_chan/entry"
    assert "?" not in row["entry_exchange_url"]
    credential = row["entry_credential"]
    payload = credential.split(".")[1]
    payload += "=" * ((4 - len(payload) % 4) % 4)
    claims = json.loads(base64.urlsafe_b64decode(payload))
    assert claims["sub"] == sys.argv[5 + index]
    assert claims["owner_user_id"] == sys.argv[2]
    assert claims["client"] == "desktop"
    assert claims["next_path"] == sys.argv[7] + "/"
    assert not ({"name", "email", "role"} & claims.keys())
    assert row["expires_at"].endswith("Z")
' "$TENANT_USER" "$USER_ID" "$DEVSERVER_ID" "$PROXY_ORIGIN" \
  "$USER_ID" "$GRANTEE_USER_ID" "$PREFIX" \
  || die "desktop entry response identity/origin validation"
info "entry handoff uses immutable owner binding, POST credential, the desktop client, and no role/PII claims"

entry_field() { printf '%s' "$1" | python3 -c 'import json,sys;print(json.load(sys.stdin)[sys.argv[1]])' "$2"; }
OWNER_ENTRY_URL="$(entry_field "$OWNER_ENTRY_JSON" entry_exchange_url)"
OWNER_ENTRY_CREDENTIAL="$(entry_field "$OWNER_ENTRY_JSON" entry_credential)"
GRANTEE_ENTRY_URL="$(entry_field "$GRANTEE_ENTRY_JSON" entry_exchange_url)"
GRANTEE_ENTRY_CREDENTIAL="$(entry_field "$GRANTEE_ENTRY_JSON" entry_credential)"
OWNER_ENTRY_H="$(mktemp)"; GRANTEE_ENTRY_H="$(mktemp)"
OWNER_ENTRY_CODE="$(proxy_curl -sS -o /dev/null -D "$OWNER_ENTRY_H" -w '%{http_code}' \
  -X POST -H "Origin: $IDENTITY_ORIGIN" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "credential=$OWNER_ENTRY_CREDENTIAL" "$OWNER_ENTRY_URL" || echo 000)"
GRANTEE_ENTRY_CODE="$(proxy_curl -sS -o /dev/null -D "$GRANTEE_ENTRY_H" -w '%{http_code}' \
  -X POST -H "Origin: $IDENTITY_ORIGIN" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "credential=$GRANTEE_ENTRY_CREDENTIAL" "$GRANTEE_ENTRY_URL" || echo 000)"
[ "$OWNER_ENTRY_CODE" = "303" ] && [ "$GRANTEE_ENTRY_CODE" = "303" ] \
  || die "entry exchange did not mint sessions (owner=$OWNER_ENTRY_CODE grantee=$GRANTEE_ENTRY_CODE)"
OWNER_GATE="$(sed -n 's/^set-cookie: __Host-devserver_gate=\([^;]*\).*/\1/ip' "$OWNER_ENTRY_H" | head -1 | tr -d '\r')"
OWNER_CSRF="$(sed -n 's/^set-cookie: __Host-devserver_csrf=\([^;]*\).*/\1/ip' "$OWNER_ENTRY_H" | head -1 | tr -d '\r')"
GRANTEE_GATE="$(sed -n 's/^set-cookie: __Host-devserver_gate=\([^;]*\).*/\1/ip' "$GRANTEE_ENTRY_H" | head -1 | tr -d '\r')"
GRANTEE_CSRF="$(sed -n 's/^set-cookie: __Host-devserver_csrf=\([^;]*\).*/\1/ip' "$GRANTEE_ENTRY_H" | head -1 | tr -d '\r')"
[ -n "$OWNER_GATE" ] && [ -n "$OWNER_CSRF" ] && [ -n "$GRANTEE_GATE" ] && [ -n "$GRANTEE_CSRF" ] \
  || die "entry exchange omitted session/csrf cookies"
[[ "$OWNER_GATE$OWNER_CSRF$GRANTEE_GATE$GRANTEE_CSRF" != *.* ]] \
  || die "entry exchange leaked a signed credential instead of opaque cookies"
OWNER_LOCATION="$(sed -n 's/^location: //ip' "$OWNER_ENTRY_H" | head -1 | tr -d '\r')"
[ "$OWNER_LOCATION" = "$PREFIX/" ] && [[ "$OWNER_LOCATION" != *credential* ]] \
  && [[ "$OWNER_LOCATION" != *"$OWNER_ENTRY_CREDENTIAL"* ]] \
  || die "entry exchange Location was not the clean signed relative path"
REPLAY_CODE="$(proxy_curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H "Origin: $IDENTITY_ORIGIN" -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "credential=$OWNER_ENTRY_CREDENTIAL" "$OWNER_ENTRY_URL" || echo 000)"
[ "$REPLAY_CODE" = 404 ] || die "entry credential replay expected 404, got $REPLAY_CODE"
info "POST exchange minted opaque owner/grantee sessions and rejected replay"

say "drive authenticated owner request through the proxy"
RESP_H="$(mktemp)"; RESP_B="$(mktemp)"
CODE="$(proxy_curl -sS -o "$RESP_B" -D "$RESP_H" -w '%{http_code}' \
  -H "Cookie: __Host-devserver_gate=$OWNER_GATE; __Host-devserver_csrf=$OWNER_CSRF" \
  "$PROXY_ORIGIN$PREFIX/api/health" || echo 000)"

say "prove native-trust routes reach the desktop guard for owner and grantee"
TRUST_PATH="/api/library/devservers/gw%3Afeedface%3A$TENANT_USER%3A$DEVSERVER_ID/native-trust"
MUT_B="$(mktemp)"
for METHOD in PUT DELETE; do
  OWNER_MUT_CODE="$(proxy_curl -sS -o "$MUT_B" -w '%{http_code}' -X "$METHOD" \
    -H "Cookie: __Host-devserver_gate=$OWNER_GATE; __Host-devserver_csrf=$OWNER_CSRF" \
    -H "x-chan-csrf: $OWNER_CSRF" "$PROXY_ORIGIN$TRUST_PATH" || echo 000)"
  [ "$OWNER_MUT_CODE" = "409" ] && grep -qx 'window management requires the chan desktop app' "$MUT_B" \
    || die "owner $METHOD native-trust did not reach desktop bridge guard ($OWNER_MUT_CODE)"

  GRANTEE_MUT_CODE="$(proxy_curl -sS -o "$MUT_B" -w '%{http_code}' -X "$METHOD" \
    -H "Cookie: __Host-devserver_gate=$GRANTEE_GATE; __Host-devserver_csrf=$GRANTEE_CSRF" \
    -H "x-chan-csrf: $GRANTEE_CSRF" "$PROXY_ORIGIN$TRUST_PATH" || echo 000)"
  [ "$GRANTEE_MUT_CODE" = "409" ] && grep -qx 'window management requires the chan desktop app' "$MUT_B" \
    || die "grantee $METHOD native-trust did not reach desktop bridge guard ($GRANTEE_MUT_CODE)"
  info "$METHOD native-trust: owner and grantee both reached route (409 no desktop)"
done

say "reverse-tunnel legs: only the owner's desktop session reaches them"
# A browser session for the owner, through the stub's share landing: the same
# no-store handoff page identity serves, whose credential names the browser.
BROWSER_PAGE="$($SDME exec "$C_PROXY" -- /usr/bin/curl -fsS \
  -H "Cookie: stub_identity_session=$BROWSER_OWNER_SESSION" \
  "http://127.0.0.1:$STUB_PORT/s/$TENANT_USER$PREFIX")" \
  || die "owner browser share landing"
BROWSER_HANDOFF="$(printf '%s' "$BROWSER_PAGE" | python3 -c '
import base64, html, json, re, sys
page = sys.stdin.read()
action = html.unescape(re.search(r"action=\"([^\"]+)\"", page).group(1))
credential = html.unescape(re.search(r"name=\"credential\" value=\"([^\"]+)\"", page).group(1))
payload = credential.split(".")[1]
claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
assert action == sys.argv[1] + "/_chan/entry", action
assert claims["client"] == "browser", claims
assert claims["sub"] == sys.argv[2] and claims["owner_user_id"] == sys.argv[2], claims
assert claims["next_path"] == sys.argv[3] + "/", claims
print(action)
print(credential)
' "$PROXY_ORIGIN" "$USER_ID" "$PREFIX")" || die "the owner's share landing did not hand off a browser credential"
BROWSER_ENTRY_URL="$(printf '%s\n' "$BROWSER_HANDOFF" | sed -n 1p)"
BROWSER_ENTRY_CREDENTIAL="$(printf '%s\n' "$BROWSER_HANDOFF" | sed -n 2p)"
BROWSER_ENTRY_H="$(mktemp)"
BROWSER_ENTRY_CODE="$(proxy_curl -sS -o /dev/null -D "$BROWSER_ENTRY_H" -w '%{http_code}' \
  -X POST -H "Origin: $IDENTITY_ORIGIN" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "credential=$BROWSER_ENTRY_CREDENTIAL" "$BROWSER_ENTRY_URL" || echo 000)"
[ "$BROWSER_ENTRY_CODE" = 303 ] || die "the owner's browser credential did not mint a session ($BROWSER_ENTRY_CODE)"
BROWSER_OWNER_GATE="$(sed -n 's/^set-cookie: __Host-devserver_gate=\([^;]*\).*/\1/ip' "$BROWSER_ENTRY_H" | head -1 | tr -d '\r')"
[ -n "$BROWSER_OWNER_GATE" ] || die "the browser exchange set no session cookie"
LEG_B="$(mktemp)"
code="$(proxy_curl -sS -o "$LEG_B" -w '%{http_code}' \
  -H "Cookie: __Host-devserver_gate=$BROWSER_OWNER_GATE" "$PROXY_ORIGIN$PREFIX/api/health" || echo 000)"
[ "$code" = 200 ] || die "the owner's browser session did not reach the workspace ($code)"
info "the owner's share landing minted a browser credential; its session reaches the workspace (200)"

ds_journal() { # the devserver's journal with the log formatter's ANSI colour codes removed
  { $SDME exec "$C_DS" -- /usr/bin/journalctl -u chands --no-pager -o cat 2>/dev/null || true; } \
    | sed 's/\x1b\[[0-9;]*m//g'
}
ds_client_count() { # ds_client_count <uuid> <client>: tunnel requests the devserver accepted as that subject and client
  ds_journal | grep -c "gateway assertion accepted.*sub=$1 .*client=$2" || true
}
ds_leg_refusals() { # reverse-tunnel legs the devserver refused as not the owner's desktop
  ds_journal | grep -c 'reverse tunnel leg refused' || true
}
proxy_journal() {
  { $SDME exec "$C_PROXY" -- /usr/bin/journalctl -u dsp --no-pager -o cat 2>/dev/null || true; } \
    | sed 's/\x1b\[[0-9;]*m//g'
}
proxy_ws_upstream_count() { # proxy_ws_upstream_count <status>: WebSocket upstream handshakes the devserver answered with <status>
  proxy_journal | grep -c "ws handshake: HTTP error: $1" || true
}
ws_upgrade() { # ws_upgrade <path> <gate>: a cookie WebSocket upgrade through the TLS edge; prints the proxy's status line
  python3 - "$TLS_DIR/ca.crt" "$PROXY_IP" "$HOST_NAME" "$PROXY_TLS_PORT" "$1" "$2" "$PROXY_ORIGIN" <<'PY'
import base64, os, socket, ssl, sys
ca, ip, host, port, path, gate, origin = sys.argv[1:8]
context = ssl.create_default_context(cafile=ca)
# The per-run CA carries no keyUsage extension, which curl accepts and
# Python's strict X.509 mode refuses; the chain and host are still verified.
context.verify_flags &= ~ssl.VERIFY_X509_STRICT
stream = context.wrap_socket(socket.create_connection((ip, int(port)), timeout=10), server_hostname=host)
key = base64.b64encode(os.urandom(16)).decode()
stream.sendall((
    f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
    f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
    f"Origin: {origin}\r\nCookie: __Host-devserver_gate={gate}\r\n\r\n"
).encode())
head = b""
while b"\r\n\r\n" not in head:
    chunk = stream.recv(4096)
    if not chunk:
        break
    head += chunk
print(head.split(b"\r\n", 1)[0].decode(errors="replace"))
# The proxy answers 101 before it dials the devserver, and drops this socket
# when the devserver refuses the upstream handshake. Wait for that end.
try:
    while stream.recv(4096):
        pass
except (OSError, ssl.SSLError):
    pass
PY
}
TUNNEL_ID="e2e-no-such-tunnel"
LEGS=("/api/library/tunnel/control?tunnel=$TUNNEL_ID" "/api/library/tunnel/conn?tunnel=$TUNNEL_ID&conn=c0")
wait_count() { # wait_count <function> <args...> <minimum>: poll a journal counter until it reaches minimum
  local minimum="${*: -1}" got=0
  for _ in $(seq 1 20); do
    got="$("${@:1:$#-1}")"
    [ "$got" -ge "$minimum" ] && break
    sleep 0.5
  done
  printf '%s' "$got"
}
tunnel_leg_case() { # tunnel_leg_case <label> <gate> <subject uuid> <client> <reach|refuse>
  local label="$1" gate="$2" subject="$3" client="$4" expected="$5" leg code line accepted refused upstream
  accepted="$(ds_client_count "$subject" "$client")"
  refused="$(ds_leg_refusals)"
  for leg in "${LEGS[@]}"; do
    code="$(proxy_curl -sS -o "$LEG_B" -w '%{http_code}' \
      -H "Cookie: __Host-devserver_gate=$gate" "$PROXY_ORIGIN$leg" || echo 000)"
    if [ "$expected" = reach ]; then
      # Past the gate, the leg's WebSocket extractor refuses a plain GET.
      [ "$code" = 400 ] && ! grep -q 'reverse tunnels' "$LEG_B" \
        || die "$label ${leg%%\?*}: expected the leg's own 400 past the gate, got $code ($(head -c 120 "$LEG_B"))"
    else
      [ "$code" = 403 ] && [ "$(cat "$LEG_B")" = 'reverse tunnels are not available for this gateway role' ] \
        || die "$label ${leg%%\?*}: expected the 403 refusal, got $code ($(head -c 120 "$LEG_B"))"
    fi
  done
  [ "$(wait_count ds_client_count "$subject" "$client" $((accepted + 2)))" -ge $((accepted + 2)) ] \
    || die "$label: the devserver did not accept the leg requests as sub=$subject client=$client"
  if [ "$expected" = reach ]; then
    [ "$(ds_leg_refusals)" = "$refused" ] || die "$label: the devserver logged a leg refusal"
    upstream="$(proxy_ws_upstream_count '404 Not Found')"
  else
    [ "$(wait_count ds_leg_refusals $((refused + 2)))" -ge $((refused + 2)) ] \
      || die "$label: the devserver did not log both leg refusals"
    upstream="$(proxy_ws_upstream_count '403 Forbidden')"
  fi
  info "$label: GET on both legs -> $code; the devserver saw sub=$subject client=$client"

  # The same through a real WebSocket upgrade: the proxy answers 101 and
  # relays the devserver's answer to the upstream handshake into its journal.
  # Reaching the control leg's handler means the registry's 404 for an
  # unknown tunnel; the gate's refusal is a 403.
  line="$(ws_upgrade "${LEGS[0]}" "$gate")"
  [[ "$line" == 'HTTP/1.1 101'* ]] || die "$label: the proxy did not accept the cookie upgrade ($line)"
  if [ "$expected" = reach ]; then
    [ "$(wait_count proxy_ws_upstream_count '404 Not Found' $((upstream + 1)))" -ge $((upstream + 1)) ] \
      || die "$label: the devserver's control leg handler did not answer the upgrade (no upstream 404 in the proxy journal)"
    info "$label: WebSocket upgrade reached the control leg's handler (upstream 404, unknown tunnel)"
  else
    [ "$(wait_count proxy_ws_upstream_count '403 Forbidden' $((upstream + 1)))" -ge $((upstream + 1)) ] \
      || die "$label: the devserver did not refuse the upgrade (no upstream 403 in the proxy journal)"
    info "$label: WebSocket upgrade refused by the devserver (upstream 403)"
  fi
}
tunnel_leg_case "owner, desktop session" "$OWNER_GATE" "$USER_ID" desktop reach
tunnel_leg_case "owner, browser session" "$BROWSER_OWNER_GATE" "$USER_ID" browser refuse
tunnel_leg_case "grantee, desktop session" "$GRANTEE_GATE" "$GRANTEE_USER_ID" desktop refuse

say "extension links: no anonymous caller, each link bound to the signed-in user"
EXT_JSON=""; ENTRY_PATH=""
for _ in $(seq 1 20); do
  EXT_JSON="$(proxy_curl -fsS -H "Cookie: __Host-devserver_gate=$OWNER_GATE" \
    "$PROXY_ORIGIN$PREFIX/api/extensions" || true)"
  ENTRY_PATH="$(printf '%s' "$EXT_JSON" | python3 -c 'import json, sys
try:
    rows = [row for row in json.load(sys.stdin) if row.get("id") == "e2e"]
    print(rows[0]["entry_path"] if rows else "")
except Exception:
    print("")')"
  [ -n "$ENTRY_PATH" ] && break
  sleep 1
done
[[ "$ENTRY_PATH" =~ ^/_chan/extensions/e2e/[0-9a-f]{64}/$ ]] \
  || die "the extension catalog did not list the e2e extension (entry_path='$ENTRY_PATH', catalog: $EXT_JSON)"
EXT_URL="$PROXY_ORIGIN$PREFIX$ENTRY_PATH"
EXT_H="$(mktemp)"; EXT_B="$(mktemp)"
FRAME_NAVIGATION=(-H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Dest: iframe' -H 'Accept: text/html')
FRAME_REQUEST=(-H 'Origin: null' -H 'Sec-Fetch-Site: cross-site' -H 'Sec-Fetch-Mode: cors' -H 'Sec-Fetch-Dest: empty')
info "catalog lists e2e at $PREFIX/_chan/extensions/e2e/[capability]/"

ext_requests() { # the extension's own request log
  $SDME exec "$C_DS" -- /bin/sh -c 'cat /root/e2e-extension-requests.log 2>/dev/null' || true
}
ext_request_count() { ext_requests | grep -c . || true; }
ds_subject_count() { # ds_subject_count <uuid>: tunnel requests the devserver accepted as that subject
  ds_journal | grep -c "gateway assertion accepted.*sub=$1" || true
}
refused_404() { # refused_404 <label> <code>: the session gate's 404, readable by the frame, no redirect
  [ "$2" = 404 ] && grep -qi '^access-control-allow-origin: null' "$EXT_H" \
    && ! grep -qi '^location:' "$EXT_H" \
    || die "$1: expected the CORS-readable 404, got $2 ($(head -c 160 "$EXT_B"))"
}
ds_accepted_count() { # tunnel requests the devserver accepted, from any subject
  ds_journal | grep -c 'gateway assertion accepted' || true
}

# Four climbs from a bound path land on the tenant's own /api/health, so a
# layer that resolved any of these spellings would hand a leaked extension
# link the owner's devserver. The encoded forms are the ones the devserver
# itself turns into path structure (it decodes the capture once, then a
# WHATWG parser splits on `\` and reads `%2e` as a dot).
DOT_SEGMENT_CLIMBS=(
  '../../../../api/health'
  '%2e%2e/%2e%2e/%2e%2e/%2e%2e/api/health'
  '%2E%2e/.%2E/%2e./../api/health'
  '..%2f..%2f..%2f..%2fapi/health'
  '..%5c..%5c..%5c..%5capi/health'
  '%252e%252e/%252e%252e/%252e%252e/%252e%252e/api/health'
)
dot_segment_case() { # dot_segment_case <label> <bound url>: no dot segment leaves the proxy
  local label="$1" bound="$2" climb method code seen rows before after last failure failures=()
  local -a data
  seen="$(ext_request_count)"
  before="$(ds_accepted_count)"
  for climb in "${DOT_SEGMENT_CLIMBS[@]}"; do
    for method in GET POST; do
      data=()
      [ "$method" = POST ] && data=(-H 'Content-Type: text/plain' --data "climb")
      # --path-as-is: curl would otherwise resolve the raw `..` itself.
      code="$(proxy_curl -sS --path-as-is -o "$EXT_B" -D "$EXT_H" -w '%{http_code}' -X "$method" \
        "${FRAME_REQUEST[@]}" "${data[@]}" "$bound$climb" || echo 000)"
      rows="$(ext_requests | tail -n "+$((seen + 1))")"
      # The extension's own 404 comes back through the proxy with the same
      # status and CORS header, so only the body tells the proxy's refusal
      # from a forwarded request.
      if [ "$code" != 404 ] || [ "$(cat "$EXT_B")" != '{"error":"not found"}' ] \
        || ! grep -qi '^access-control-allow-origin: null' "$EXT_H" || grep -qi '^location:' "$EXT_H"; then
        failures+=("$method $climb: expected the proxy's readable 404, got $code body '$(head -c 80 "$EXT_B")'")
      fi
      if [ -n "$rows" ]; then
        failures+=("$method $climb: reached the extension as $(printf '%s' "$rows" | tr '\n' ' ')")
      fi
      seen="$(ext_request_count)"
    done
  done

  # A near miss is an ordinary segment and still reaches the extension. It
  # goes last so the devserver's line for it bounds the journal read below.
  code="$(proxy_curl -sS --path-as-is -o "$EXT_B" -D "$EXT_H" -w '%{http_code}' \
    "${FRAME_REQUEST[@]}" "${bound}a..b" || echo 000)"
  ext_requests | tail -n "+$((seen + 1))" | python3 -c '
import json, sys
rows = [json.loads(line) for line in sys.stdin if line.strip()]
assert rows == [{"method": "GET", "path": "/a..b", "body": ""}], rows
' || failures+=("GET a..b: the near miss did not reach the extension as exactly GET /a..b (got $code)")
  after="$before"; last=""
  for _ in $(seq 1 20); do
    after="$(ds_accepted_count)"
    [ "$((after - before))" -ge 1 ] && [ "$after" = "$last" ] && break
    last="$after"
    sleep 0.5
  done
  [ "$((after - before))" = 1 ] \
    || failures+=("the devserver accepted $((after - before)) tunnel requests during the climbs and the near miss; expected 1, the near miss")

  if [ "${#failures[@]}" -gt 0 ]; then
    for failure in "${failures[@]}"; do printf '   %s: %s\n' "$label" "$failure" >&2; done
    die "$label: ${#failures[@]} dot-segment assertion(s) failed on the bound path"
  fi
  info "$label: ${#DOT_SEGMENT_CLIMBS[@]} climbs as GET and POST each got the proxy's 404, reached neither the extension nor the devserver; a..b still reached the extension"
}

SEEN="$(ext_request_count)"
CODE_ANON="$(proxy_curl -sS -o "$EXT_B" -D "$EXT_H" -w '%{http_code}' "${FRAME_REQUEST[@]}" "$EXT_URL" || echo 000)"
refused_404 "capability link, cookieless frame fetch" "$CODE_ANON"
CODE_ANON="$(proxy_curl -sS -o "$EXT_B" -D "$EXT_H" -w '%{http_code}' "${FRAME_NAVIGATION[@]}" "$EXT_URL" || echo 000)"
refused_404 "capability link, navigation with no session cookie" "$CODE_ANON"
CODE_ANON="$(proxy_curl -sS -o "$EXT_B" -D "$EXT_H" -w '%{http_code}' -X POST "${FRAME_REQUEST[@]}" \
  -H 'Content-Type: text/plain' --data anonymous "${EXT_URL}echo" || echo 000)"
refused_404 "capability link, cookieless POST" "$CODE_ANON"
[ "$(ext_request_count)" = "$SEEN" ] || die "a request with no session reached the extension: $(ext_requests | tail -3)"
info "no session cookie: the capability link answers 404 to a fetch, a navigation and a POST; the extension saw none of them"

extension_link_case() { # extension_link_case <label> <gate cookie> <subject uuid> [climbs]
  local label="$1" gate="$2" subject="$3" climbs="${4:-}" code location bound seen before after revoke_json
  code="$(proxy_curl -sS -o "$EXT_B" -D "$EXT_H" -w '%{http_code}' "${FRAME_NAVIGATION[@]}" \
    -H "Cookie: __Host-devserver_gate=$gate" "$EXT_URL" || echo 000)"
  location="$(sed -n 's/^location: //ip' "$EXT_H" | head -1 | tr -d '\r')"
  [ "$code" = 303 ] && [[ "$location" =~ ^$PREFIX/_chan/extensions/e2e/[0-9a-f]{96}/$ ]] \
    && grep -qi '^access-control-allow-origin: null' "$EXT_H" \
    || die "$label: frame navigation with a session expected a 303 to a bound path, got $code location='$location'"
  bound="$PROXY_ORIGIN$location"
  info "$label: navigation with the session cookie -> 303 to $PREFIX/_chan/extensions/e2e/[binding]/"

  seen="$(ext_request_count)"
  before="$(ds_subject_count "$subject")"
  code="$(proxy_curl -sS -o "$EXT_B" -D "$EXT_H" -w '%{http_code}' "${FRAME_REQUEST[@]}" "$bound" || echo 000)"
  [ "$code" = 200 ] && grep -q 'e2e-extension-entry' "$EXT_B" \
    && grep -qi '^access-control-allow-origin: null' "$EXT_H" \
    || die "$label: cookieless GET on the bound path expected the entry document, got $code ($(head -c 160 "$EXT_B"))"
  code="$(proxy_curl -sS -o "$EXT_B" -D "$EXT_H" -w '%{http_code}' -X POST "${FRAME_REQUEST[@]}" \
    -H 'Content-Type: text/plain' --data "from-$label" "${bound}echo" || echo 000)"
  [ "$code" = 200 ] && grep -qx "e2e-extension-echo POST from-$label" "$EXT_B" \
    || die "$label: cookieless, CSRF-less POST on the bound path expected the echo, got $code ($(head -c 160 "$EXT_B"))"
  ext_requests | tail -n "+$((seen + 1))" | python3 -c '
import json, sys
rows = [json.loads(line) for line in sys.stdin if line.strip()]
expected = [
    {"method": "GET", "path": "/", "body": ""},
    {"method": "POST", "path": "/echo", "body": "from-" + sys.argv[1]},
]
assert rows == expected, rows
' "$label" || die "$label: the extension did not see exactly the bound GET and POST: $(ext_requests | tail -n "+$((seen + 1))")"
  after="$before"
  for _ in $(seq 1 10); do
    after="$(ds_subject_count "$subject")"
    [ "$((after - before))" -ge 2 ] && break
    sleep 0.5
  done
  [ "$((after - before))" -ge 2 ] \
    || die "$label: the devserver did not accept the bound requests as subject $subject ($before -> $after)"
  info "$label: bound GET 200 and POST 200 reached the extension; the devserver accepted them as sub=$subject"
  [ "$climbs" = climbs ] && dot_segment_case "$label" "$bound"

  revoke_json="$($SDME exec "$C_PROXY" -- /usr/bin/curl -fsS -X POST \
    -H "Authorization: Bearer $CONTROL_PROFILE_TOKEN" -H 'content-type: application/json' \
    --data "{\"scope\":\"exact\",\"subject_user_id\":\"$subject\",\"owner_user_id\":\"$USER_ID\",\"devserver_id\":\"$DEVSERVER_ID\"}" \
    "http://127.0.0.1:$CONTROL_ADMIN_PORT/admin/v1/sessions/revoke")" \
    || die "$label: session revocation through devserver-control failed"
  printf '%s' "$revoke_json" | python3 -c '
import json, sys
body = json.load(sys.stdin)
assert body["revoked"] >= 1 and body["proxies_confirmed"] == 1, body
' || die "$label: revocation did not confirm: $revoke_json"
  seen="$(ext_request_count)"
  code="$(proxy_curl -sS -o "$EXT_B" -D "$EXT_H" -w '%{http_code}' "${FRAME_REQUEST[@]}" "$bound" || echo 000)"
  refused_404 "$label: bound GET after revocation" "$code"
  code="$(proxy_curl -sS -o "$EXT_B" -D "$EXT_H" -w '%{http_code}' -X POST "${FRAME_REQUEST[@]}" \
    -H 'Content-Type: text/plain' --data "after-revoke" "${bound}echo" || echo 000)"
  refused_404 "$label: bound POST after revocation" "$code"
  code="$(proxy_curl -sS -o "$EXT_B" -D "$EXT_H" -w '%{http_code}' "${FRAME_NAVIGATION[@]}" \
    -H "Cookie: __Host-devserver_gate=$gate" "$EXT_URL" || echo 000)"
  refused_404 "$label: navigation with the revoked session cookie" "$code"
  [ "$(ext_request_count)" = "$seen" ] || die "$label: a request after revocation reached the extension"
  info "$label: after revoking the session the bound GET and POST and a new navigation answer 404; the extension saw none"
}

extension_link_case grantee "$GRANTEE_GATE" "$GRANTEE_USER_ID" climbs
extension_link_case owner "$OWNER_GATE" "$USER_ID"
# The client is not part of the principal: the exact revocation of the owner's
# sessions above ended the owner's browser session as well as the desktop one.
code="$(proxy_curl -sS -o "$LEG_B" -w '%{http_code}' \
  -H "Cookie: __Host-devserver_gate=$BROWSER_OWNER_GATE" "$PROXY_ORIGIN$PREFIX/api/health" || echo 000)"
[ "$code" = 404 ] || die "the owner's browser session outlived the revocation of the owner's sessions ($code)"
info "revoking the owner's sessions ended the owner's browser session too (404)"
# Read the journal into a file first: a `grep -q` at the end of a pipeline
# can SIGPIPE its writer, and under pipefail a match would then read as none.
DS_JOURNAL="$(mktemp)"
ds_journal > "$DS_JOURNAL"
grep -q 'gateway assertion accepted' "$DS_JOURNAL" \
  || die "the devserver journal has no accepted assertions to inspect"
if grep -q 'gateway assertion names no user' "$DS_JOURNAL"; then
  die "the devserver refused an assertion that named no user: the proxy signed an anonymous caller"
fi
if grep -qE 'gateway assertion accepted.*sub=(0{8}-0{4}-0{4}-0{4}-0{12}|0{32})?( |$)' "$DS_JOURNAL"; then
  die "the devserver accepted a nil or empty subject"
fi
info "the devserver journal holds no nil or empty subject, accepted or refused"
rm -f "$EXT_H" "$EXT_B" "$DS_JOURNAL"

say "RESULT"
echo "REQUEST : GET $PREFIX/api/health   Host: $HOSTHDR (authenticated owner entry)"
echo "          via proxy TLS $PROXY_IP:$PROXY_TLS_PORT  ->  tunnel $TUNNEL_URL  ->  $C_DS"
echo "STATUS  : $CODE"
echo "--- response headers ---"; sed -n '1,12p' "$RESP_H"
echo "--- body (head) ---"; head -c 600 "$RESP_B"; echo
if [ "$CODE" = "200" ] && python3 -c '
import json, sys
body = json.load(sys.stdin)
assert body["status"] == "ok"
assert isinstance(body["instance"], str) and body["instance"]
' < "$RESP_B"; then
  printf '\n\033[1;32mPASS\033[0m: authenticated workspace health returned 200 through proxy+tunnel\n'
  rm -f "$RESP_H" "$RESP_B" "$OWNER_ENTRY_H" "$GRANTEE_ENTRY_H" "$BROWSER_ENTRY_H" "$MUT_B" "$LEG_B"
  info "leaving containers up; re-run with --clean to remove"
  exit 0
fi
echo "--- proxy log ---";     $SDME exec "$C_PROXY" -- /usr/bin/journalctl -u dsp    --no-pager | tail -25
echo "--- devserver log ---"; $SDME exec "$C_DS"    -- /usr/bin/journalctl -u chands --no-pager | tail -25
die "expected authenticated workspace health 200; got $CODE"
