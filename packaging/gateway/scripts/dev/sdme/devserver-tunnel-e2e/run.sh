#!/usr/bin/env bash
# devserver-tunnel-e2e -- cross-CONTAINER end-to-end for the chan devserver tunnel.
#
# Stands up the REAL devserver-proxy-service and a REAL `chan devserver
# --tunnel-url` in two SEPARATE sdme containers, then drives a request through
# the proxy's PUBLIC surface, over the tunnel, into the devserver's mounted
# workspace. An authenticated 200 from the mounted workspace's `/api/health`
# is the proof -- that request travelled host -> TLS edge -> proxy:7002 ->
# gate -> tunnel -> chan devserver.
#
# Topology (see zone-isolation-probe.sh + README for WHY one zone):
#   zone gw-e2e
#     gw-e2e-proxy : devserver-proxy-service (real) + stub-identity (loopback)
#     gw-e2e-ds    : chan devserver --tunnel-url + a mounted workspace
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
KEYGEN_PY="$REPO/packaging/gateway/scripts/generate-admission-keypair.py"
RFS_SDME="$HERE/chan-e2e-run.sdme"
SDME="sudo -n sdme"
RFS="${RFS:-chan-e2e-run-v2}"

ZONE="${ZONE:-gw-e2e}"
C_PROXY="${C_PROXY:-gw-e2e-proxy}"
C_DS="${C_DS:-gw-e2e-ds}"

PROXY_ID="p1"
APEX="usr.localtest.me"
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
[ -f "$STUB_PY" ] && [ -x "$MINT_PY" ] && [ -f "$TLS_FORWARD_PY" ] \
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

say "start scoped identity fixture (loopback) in $C_PROXY"
$SDME exec "$C_PROXY" -- /usr/bin/systemd-run --unit=stub --collect \
  --setenv=STUB_BIND=127.0.0.1:$STUB_PORT --setenv=STUB_USERNAME=$TENANT_USER \
  --setenv=STUB_USER_ID=$USER_ID --setenv=STUB_DEVSERVER_ID="$DEVSERVER_ID" \
  --setenv=STUB_GRANTEE_USER_ID=$GRANTEE_USER_ID --setenv=STUB_PROXY_ID=$PROXY_ID \
  --setenv=STUB_PROXY_ORIGIN="$PROXY_ORIGIN" --setenv=STUB_AUDIENCE="$HOSTHDR" \
  --setenv=STUB_TUNNEL_PAT=$PAT --setenv=STUB_IDENTITY_INTERNAL_TOKEN=$IDENTITY_TOKEN \
  --setenv=STUB_DESKTOP_OWNER_PAT=$DESKTOP_OWNER_PAT \
  --setenv=STUB_DESKTOP_GRANTEE_PAT=$DESKTOP_GRANTEE_PAT \
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
  --setenv=RUST_LOG=info --setenv=HOME=/root --setenv=XDG_RUNTIME_DIR=/run/chan \
  --setenv=SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
  --setenv=CHAN_TUNNEL_TOKEN=$PAT --setenv=CHAN_DEVSERVER_LISTEN=1 \
  /root/chan devserver --bind 0.0.0.0 --port $DS_PORT --tunnel-url="$TUNNEL_URL" \
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

say "mount workspace via chan open (local devserver handoff)"
$SDME exec "$C_DS" -- /bin/sh -c "HOME=/root XDG_RUNTIME_DIR=/run/chan /root/chan open /root/$WS_NAME" 2>&1 | tail -6 || true
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

# `chan open` registers through the live devserver handoff. Current lifecycle
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
    assert claims["next_path"] == sys.argv[7] + "/"
    assert not ({"name", "email", "role"} & claims.keys())
    assert row["expires_at"].endswith("Z")
' "$TENANT_USER" "$USER_ID" "$DEVSERVER_ID" "$PROXY_ORIGIN" \
  "$USER_ID" "$GRANTEE_USER_ID" "$PREFIX" \
  || die "desktop entry response identity/origin validation"
info "entry handoff uses immutable owner binding, POST credential, and no role/PII claims"

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

say "prove native-trust routes and require_local_mutation"
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
  [ "$GRANTEE_MUT_CODE" = "403" ] \
    && grep -qx 'launcher mutation is not available for this gateway role' "$MUT_B" \
    || die "grantee $METHOD native-trust bypassed require_local_mutation ($GRANTEE_MUT_CODE)"
  info "$METHOD native-trust: owner reached route (409 no desktop); grantee refused (403)"
done

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
  rm -f "$RESP_H" "$RESP_B" "$OWNER_ENTRY_H" "$GRANTEE_ENTRY_H" "$MUT_B"
  info "leaving containers up; re-run with --clean to remove"
  exit 0
fi
echo "--- proxy log ---";     $SDME exec "$C_PROXY" -- /usr/bin/journalctl -u dsp    --no-pager | tail -25
echo "--- devserver log ---"; $SDME exec "$C_DS"    -- /usr/bin/journalctl -u chands --no-pager | tail -25
die "expected authenticated workspace health 200; got $CODE"
