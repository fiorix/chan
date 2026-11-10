#!/usr/bin/env bash
# Generate /etc/chan-gateway/{domain,migrate,profile,identity,
# devserver-control,devserver-proxy,admin}.env on a host where the .debs are already
# installed, and wireguard-agent.env when that package is installed too.
#
# Usage:
#   sudo ./configure.sh
#
# Prompts for the values that aren't safely defaultable (Postgres
# password, public origins, OAuth credentials) and, to offer WireGuard
# enrollment, for the ingress list and the address pool. Generates the
# shared secrets (PROFILE_AUTH_TOKEN, IDENTITY_INTERNAL_TOKEN,
# admission/entry keypairs, the proxy credential, the WireGuard agent's
# bearer, and distinct profile, identity, controller-operator, and
# controller-client tokens)
# and threads them across the files where they must
# match. Backs up any existing env files before overwriting: every run
# writes each file whole from that run's answers, and carries nothing over
# from the file it replaces.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)

if [[ $EUID -ne 0 ]]; then
    echo "error: run as root (sudo $0)" >&2
    exit 1
fi

SERVICE_USERS=(
    chan-gateway-profile
    chan-gateway-identity
    chan-gateway-migrate
    chan-gateway-devserver-control
    chan-gateway-devserver-proxy
)
for service_user in "${SERVICE_USERS[@]}"; do
    if ! getent passwd "$service_user" >/dev/null; then
        echo "error: $service_user is missing. Install all service .debs first." >&2
        exit 1
    fi
done
# The WireGuard agent runs on a proxy host that terminates kernel
# WireGuard, which in production is often a host of its own: its env file
# is written only when its package is installed here.
AGENT_INSTALLED=false
if getent passwd chan-gateway-wireguard-agent >/dev/null; then
    AGENT_INSTALLED=true
fi

read -rp "Postgres user [chan]: " PG_USER
PG_USER=${PG_USER:-chan}

read -rsp "Postgres password for ${PG_USER}: " PG_PASS; echo
[[ -n "$PG_PASS" ]] || { echo "password required" >&2; exit 1; }

read -rp "Postgres database [chan_gateway]: " PG_DB
PG_DB=${PG_DB:-chan_gateway}

# Origins are concatenated into callback, dashboard and node URLs. Reject
# extra URL components before preparing database roles or writing files.
require_origin() {
    local name=$1 value=$2
    [[ -n "$value" ]] || { echo "error: $name is required" >&2; exit 1; }
    if ! python3 - "$value" <<'PYTHON'
import re
import sys
from urllib.parse import urlsplit

label = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
host = rf"(?:{label}(?:\.{label})*\.?|\[[0-9A-Fa-f:.]+\])"
value = sys.argv[1]
if not re.fullmatch(rf"https?://{host}(?::[0-9]+)?", value):
    sys.exit(1)
try:
    urlsplit(value).port
except ValueError:
    sys.exit(1)
PYTHON
    then
        echo "error: $name must be an http(s) origin with a host and optional port, without credentials, path, trailing slash, query or fragment" >&2
        exit 1
    fi
}

origin_host() {
    python3 -c 'import sys; from urllib.parse import urlsplit; print(urlsplit(sys.argv[1]).hostname)' "$1"
}

read -rp "Gateway public origin (e.g. https://gw.example.com): " ID_URL || true
require_origin "Gateway public origin" "$ID_URL"
read -rp "Proxy namespace origin (e.g. https://proxy.example.com): " PROXY_ORIGIN || true
require_origin "Proxy namespace origin" "$PROXY_ORIGIN"
echo "The tunnel ingress host needs a DNS record and certificate. Its TLS edge"
echo "routes /v1/tunnel to 127.0.0.1:7100 as h2c (nginx grpc_pass), and / to"
echo "127.0.0.1:7002, where /healthz and /readyz answer only for that host."
read -rp "Tunnel ingress origin [$PROXY_ORIGIN]: " TUNNEL_ORIGIN || true
TUNNEL_ORIGIN=${TUNNEL_ORIGIN:-$PROXY_ORIGIN}
require_origin "Tunnel ingress origin" "$TUNNEL_ORIGIN"
read -rp "This proxy node id [p1]: " PROXY_ID
PROXY_ID=${PROXY_ID:-p1}
# The node origin must match the controller's template expansion for the
# id, so the default prepends it to the namespace host.
PROXY_BASE_URL_DEFAULT="${PROXY_ORIGIN%%://*}://${PROXY_ID}.${PROXY_ORIGIN#*://}"
echo "The node origin's wildcard needs a DNS record, a wildcard certificate,"
echo "and a TLS edge route to 127.0.0.1:7002 for tenant HTTP and WebSockets."
read -rp "This proxy node origin [$PROXY_BASE_URL_DEFAULT]: " PROXY_BASE_URL || true
PROXY_BASE_URL=${PROXY_BASE_URL:-$PROXY_BASE_URL_DEFAULT}
require_origin "This proxy node origin" "$PROXY_BASE_URL"
PROXY_BASE_URL_TEMPLATE="${PROXY_ORIGIN%%://*}://{proxy_id}.${PROXY_ORIGIN#*://}"
if [[ $AGENT_INSTALLED == true ]]; then
    read -rp "Kernel WireGuard interface for the agent [wg0]: " WG_INTERFACE
    WG_INTERFACE=${WG_INTERFACE:-wg0}
fi

# WireGuard enrollment is identity's ingress list and profile's address
# pool, written together or not at all: identity refuses a partial set, and
# a list without a pool fails every desktop sign-in that enrolls a key. Both
# answers are checked here by the rules identity and profile apply at
# startup, so a value either would refuse stops this run before database
# roles are prepared or a file is written.
#
# Prints two lines: the list as it is written, one id=public_key@endpoint
# per node with no spaces, and the ids. Identity builds each node's tenant
# names from the id and the proxy namespace host and keeps its own host out
# of them, so both origins take part in the check.
wireguard_ingresses() {
    python3 - "$@" <<'PYTHON'
import base64
import binascii
import ipaddress
import re
import sys

answer, proxy_host, identity_host = sys.argv[1:4]
SHAPE = "WireGuard ingresses must be id=public_key@endpoint entries with ';' between them"


def refuse(message):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def label(value):
    return re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", value) is not None


def canonical_key(value):
    if len(value) != 44:
        return False
    try:
        raw = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        return False
    return len(raw) == 32 and base64.b64encode(raw).decode() == value


def endpoint(value):
    if value.startswith("["):
        host, closed, tail = value[1:].partition("]")
        if not closed or not tail.startswith(":"):
            return False
        if not re.fullmatch(r"[0-9A-Fa-f:.]+", host):
            return False
        try:
            ipaddress.IPv6Address(host)
        except ValueError:
            return False
        port = tail[1:]
    else:
        host, colon, port = value.rpartition(":")
        if not colon or len(host) > 253:
            return False
        if not all(label(part) for part in host.lower().split(".")):
            return False
    return re.fullmatch(r"[0-9]{1,5}", port) is not None and 0 < int(port) < 65536


# Every part of an entry is ASCII, and lowercasing below must not fold
# another script's letter into one.
if not answer.isascii():
    refuse(SHAPE)
# A host that ends in a number is an address to identity, with no names
# below it.
labels = proxy_host.split(".")
if not all(label(part) for part in labels) or re.fullmatch(
    r"[0-9]+|0x[0-9a-f]*", labels[-1]
):
    refuse("Proxy namespace origin needs a DNS name as its host to offer WireGuard enrollment")

entries = []
for number, entry in enumerate(answer.split(";"), start=1):
    ingress_id, equals, peer = entry.partition("=")
    key, at, target = peer.partition("@")
    if not equals or not at:
        refuse(SHAPE)
    ingress_id, key, target = ingress_id.strip(), key.strip(), target.strip()
    where = f"WireGuard ingress entry {number}"
    if not label(ingress_id):
        refuse(f"{where}: the id must be a proxy node id, one lowercase DNS label")
    if not canonical_key(key):
        refuse(f"{where}: the public key must be padded base64 for 32 bytes")
    if not endpoint(target):
        refuse(f"{where}: the endpoint must be host:port or [IPv6]:port with a port from 1 to 65535")
    if any(ingress_id == listed for listed, _, _ in entries):
        refuse(f"{where}: the id {ingress_id} is listed twice")
    node = f"{ingress_id}.{proxy_host}"
    if len(node) > 253:
        refuse(f"{where}: the id does not form a DNS name under the proxy namespace host")
    if identity_host == node or identity_host.endswith(f".{node}"):
        refuse(f"{where}: Gateway public origin's host must not be the node's name or a name below it")
    entries.append((ingress_id, key, target))

print(";".join(f"{ingress_id}={key}@{target}" for ingress_id, key, target in entries))
print(" ".join(ingress_id for ingress_id, _, _ in entries))
PYTHON
}

# Prints four lines: the pool in canonical form; its first host address,
# which profile never allocates and every ingress interface answers on; that
# address as the /32 a desktop routes into its tunnels; and that address
# with the pool's prefix, as an interface carries it. A pool narrower than
# /30 has no address left to allocate.
wireguard_pool() {
    python3 - "$@" <<'PYTHON'
import ipaddress
import re
import sys

answer = sys.argv[1]
try:
    if not re.fullmatch(r"[0-9]{1,3}(?:\.[0-9]{1,3}){3}/[0-9]{1,2}", answer):
        raise ValueError(answer)
    pool = ipaddress.IPv4Network(answer)
    if pool.prefixlen > 30:
        raise ValueError(answer)
except ValueError:
    print(
        "error: WireGuard address pool must be an IPv4 network of /30 or wider"
        " with no host bits set, such as 10.7.0.0/24",
        file=sys.stderr,
    )
    sys.exit(1)
address = pool.network_address + 1
print(pool)
print(address)
print(f"{address}/32")
print(f"{address}/{pool.prefixlen}")
PYTHON
}

# Identity refuses to start while one of the four variables that describe a
# single ingress is set. Every run replaces identity.env whole, so none of
# them outlives a run; an existing file that sets one is shown before the
# prompt, where the same ingress can still be given in the list's form.
if [[ -f /etc/chan-gateway/identity.env ]]; then
    # sed fails only when it cannot read the file, which must not pass for a
    # file that sets none of them.
    if ! SINGLE_INGRESS_LINES=$(sed -n -E \
        's/^[[:space:]]*(WIREGUARD_(HOST_ID|ENDPOINT|PUBLIC_KEY|HOSTS)=[[:space:]]*[^[:space:]].*)$/    \1/p' \
        /etc/chan-gateway/identity.env); then
        echo "error: cannot read /etc/chan-gateway/identity.env" >&2
        exit 1
    fi
    if [[ -n $SINGLE_INGRESS_LINES ]]; then
        echo
        echo "/etc/chan-gateway/identity.env configures WireGuard enrollment for one ingress:"
        printf '%s\n' "$SINGLE_INGRESS_LINES"
        echo "Identity does not start with these variables set, and this run writes none"
        echo "of them. To keep enrollment, list that ingress below as"
        echo "<its node's proxy id>=<WIREGUARD_PUBLIC_KEY>@<WIREGUARD_ENDPOINT>."
    fi
fi

echo
echo "WireGuard enrollment is optional. To offer it, list every proxy node that"
echo "terminates WireGuard as id=public_key@endpoint, with ';' between nodes. The"
echo "id is the node's proxy id, the key is what 'wg show <interface> public-key'"
echo "prints on that node, and the endpoint is the host:port desktops reach its"
echo "interface on. This node's entry is:"
echo "    ${PROXY_ID}=<public key>@$(origin_host "$PROXY_BASE_URL"):51820"
read -rp "WireGuard ingresses (empty to leave enrollment off): " WG_INGRESSES || true
if [[ -n $WG_INGRESSES ]]; then
    WG_ANSWER=$(wireguard_ingresses "$WG_INGRESSES" \
        "$(origin_host "$PROXY_ORIGIN")" "$(origin_host "$ID_URL")") || exit 1
    mapfile -t WG_LIST <<< "$WG_ANSWER"
    [[ ${#WG_LIST[@]} -eq 2 ]] || { echo "WireGuard ingress check failed" >&2; exit 1; }
    WG_INGRESSES=${WG_LIST[0]}
    WG_INGRESS_IDS=${WG_LIST[1]}
    echo "Enrolled desktops take their tunnel addresses from one IPv4 pool. Every"
    echo "ingress interface answers on the pool's first host address, which is"
    echo "never handed out."
    read -rp "WireGuard address pool [10.7.0.0/24]: " WG_POOL_V4 || true
    WG_ANSWER=$(wireguard_pool "${WG_POOL_V4:-10.7.0.0/24}") || exit 1
    mapfile -t WG_POOL <<< "$WG_ANSWER"
    [[ ${#WG_POOL[@]} -eq 4 ]] || { echo "WireGuard address pool check failed" >&2; exit 1; }
    WG_POOL_V4=${WG_POOL[0]}
    WG_INGRESS_ADDRESS=${WG_POOL[1]}
    WG_ALLOWED_IPS=${WG_POOL[2]}
    WG_INTERFACE_ADDRESS=${WG_POOL[3]}
fi

echo
echo "Configure at least one OAuth provider. Press Enter to skip any."
echo

# shellcheck disable=SC2034  # namerefs: the writes land in the caller's vars
prompt_provider() {
    # bash 4.3+ namerefs; safer than `eval` because the value never
    # passes through the shell parser.
    local name=$1
    local -n out_id=$2
    local -n out_secret=$3
    local id="" secret=""
    read -rp "$name OAuth Client ID (empty to skip): " id
    if [[ -n "$id" ]]; then
        read -rsp "$name OAuth Client Secret: " secret; echo
        if [[ -z "$secret" ]]; then
            echo "  -> ${name} secret was empty; skipping ${name}"
            id=""
        fi
    fi
    out_id="$id"
    out_secret="$secret"
}

prompt_provider "GitHub"     GH_ID  GH_SECRET
prompt_provider "Google"     GOOG_ID GOOG_SECRET
prompt_provider "GitLab"     GL_ID  GL_SECRET

if [[ -z "$GH_ID" && -z "$GOOG_ID" && -z "$GL_ID" ]]; then
    echo "error: at least one provider is required" >&2
    exit 1
fi

emit_provider_env() {
    local prefix=$1 id=$2 secret=$3
    if [[ -n "$id" ]]; then
        printf '%s_CLIENT_ID=%s\n%s_CLIENT_SECRET=%s\n' \
            "$prefix" "$id" "$prefix" "$secret"
    fi
}

# URL-encode the password so special characters don't break DATABASE_URL.
PG_PASS_ENC=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$PG_PASS")
MIGRATION_DATABASE_URL="postgres://${PG_USER}:${PG_PASS_ENC}@127.0.0.1/${PG_DB}"

# Runtime services receive separate, randomly generated login roles that have
# DML access but cannot create database objects. The owner URL is written only
# to migrate.env and used here to create/rotate the application roles.
IDENTITY_DATABASE_PASSWORD=$(openssl rand -hex 32)
PROFILE_DATABASE_PASSWORD=$(openssl rand -hex 32)
IDENTITY_DATABASE_URL="postgres://chan_gateway_identity:${IDENTITY_DATABASE_PASSWORD}@127.0.0.1/${PG_DB}"
PROFILE_DATABASE_URL="postgres://chan_gateway_profile:${PROFILE_DATABASE_PASSWORD}@127.0.0.1/${PG_DB}"
DATABASE_URL=$MIGRATION_DATABASE_URL \
IDENTITY_DATABASE_PASSWORD=$IDENTITY_DATABASE_PASSWORD \
PROFILE_DATABASE_PASSWORD=$PROFILE_DATABASE_PASSWORD \
    "$SCRIPT_DIR/prepare-database-roles.sh"

# IDENTITY_INTERNAL_TOKEN is shared only by identity and devserver-proxy.
# DEVSERVER_PROXY_TOKEN authenticates this
# proxy node; the controller stores it only under the provisioned proxy id.
PROFILE_AUTH_TOKEN=$(openssl rand -hex 32)
IDENTITY_INTERNAL_TOKEN=$(openssl rand -hex 32)
DEVSERVER_PROXY_TOKEN=$(openssl rand -hex 32)

# Never reuse a bearer across an inbound API or controller authorization scope.
GENERATED_BEARER_TOKENS=("$IDENTITY_INTERNAL_TOKEN")
generate_unique_bearer_token() {
    local candidate existing collision
    while :; do
        candidate=$(openssl rand -hex 32)
        collision=false
        for existing in "${GENERATED_BEARER_TOKENS[@]:-}"; do
            if [[ $candidate == "$existing" ]]; then
                collision=true
                break
            fi
        done
        [[ $collision == false ]] || continue
        GENERATED_BEARER_TOKENS+=("$candidate")
        UNIQUE_BEARER_TOKEN=$candidate
        return
    done
}
generate_unique_bearer_token; IDENTITY_SESSION_INTERNAL_TOKEN=$UNIQUE_BEARER_TOKEN
generate_unique_bearer_token; WIREGUARD_AGENT_TOKEN=$UNIQUE_BEARER_TOKEN
generate_unique_bearer_token; IDENTITY_ACCOUNT_ADMIN_TOKEN=$UNIQUE_BEARER_TOKEN
generate_unique_bearer_token; PROFILE_ADMIN_TOKEN=$UNIQUE_BEARER_TOKEN
generate_unique_bearer_token; IDENTITY_ADMIN_TOKEN=$UNIQUE_BEARER_TOKEN
generate_unique_bearer_token; DEVSERVER_OPERATOR_ADMIN_TOKEN=$UNIQUE_BEARER_TOKEN
generate_unique_bearer_token; DEVSERVER_IDENTITY_ADMIN_TOKEN=$UNIQUE_BEARER_TOKEN
generate_unique_bearer_token; DEVSERVER_PROFILE_ADMIN_TOKEN=$UNIQUE_BEARER_TOKEN

mapfile -t ADMISSION_KEYS < <("$SCRIPT_DIR/generate-admission-keypair.py")
[[ ${#ADMISSION_KEYS[@]} -eq 2 ]] || { echo "admission key generation failed" >&2; exit 1; }
DEVSERVER_ADMISSION_SIGNING_KEY=${ADMISSION_KEYS[0]}
DEVSERVER_ADMISSION_VERIFYING_KEY=${ADMISSION_KEYS[1]}
mapfile -t ENTRY_KEYS < <("$SCRIPT_DIR/generate-admission-keypair.py")
[[ ${#ENTRY_KEYS[@]} -eq 2 ]] || { echo "entry key generation failed" >&2; exit 1; }
DEVSERVER_ENTRY_SIGNING_KEY=${ENTRY_KEYS[0]}
DEVSERVER_ENTRY_VERIFYING_KEYS=${ENTRY_KEYS[1]}

install -d -m 0751 -o root -g root /etc/chan-gateway

write_env() {
    local path=$1 owner=$2 mode=$3 content=$4 backup
    if [[ -f "$path" ]]; then
        backup="${path}.bak.$(date +%Y%m%d-%H%M%S)"
        cp -p "$path" "$backup"
        chown root:root "$backup"
        chmod 0600 "$backup"
        echo "backed up $path -> $backup"
    fi
    # Write via a redirect, not `install /dev/stdin`: GNU install fails
    # with "No such file or directory" reading the here-string fd when
    # the destination already exists (and the .debs ship these as
    # conf-files, so it always does). Set owner/mode explicitly after.
    printf '%s\n' "$content" > "$path"
    chown "root:$owner" "$path"
    chmod "$mode" "$path"
    echo "wrote $path"
}

write_env /etc/chan-gateway/domain.env root 0644 "$(cat <<EOF
# Generated by configure.sh on $(date -Iseconds).
# Explicit public origins. No service derives deployment hostnames.
BASE_URL=${ID_URL}
DEVSERVER_PROXY_ORIGIN=${PROXY_ORIGIN}
DEVSERVER_TUNNEL_ORIGIN=${TUNNEL_ORIGIN}
DEVSERVER_PROXY_BASE_URL=${PROXY_BASE_URL}
DASHBOARD_URL=${ID_URL}/workspaces
EOF
)"

write_env /etc/chan-gateway/migrate.env chan-gateway-migrate 0640 "$(cat <<EOF
# Generated by configure.sh on $(date -Iseconds).
# Database-owner credentials belong only to this one-shot service.
DATABASE_URL=${MIGRATION_DATABASE_URL}
IDENTITY_DATABASE_PASSWORD=${IDENTITY_DATABASE_PASSWORD}
PROFILE_DATABASE_PASSWORD=${PROFILE_DATABASE_PASSWORD}
CHAN_GATEWAY_MIGRATIONS=only
EXPECTED_SQLX_MIGRATION=18
DATABASE_ROLE_POLICY_VERSION=2
EOF
)"

# Identity's enrollment values and profile's pool are one answer, so both
# files carry them or both carry the commented examples.
if [[ -n $WG_INGRESSES ]]; then
    IDENTITY_WIREGUARD_ENV=$(cat <<EOF
# Every listed node's interface answers on WIREGUARD_INGRESS_ADDRESSES, the
# first host address of profile's WIREGUARD_POOL_V4.
WIREGUARD_INGRESSES=${WG_INGRESSES}
WIREGUARD_INGRESS_ADDRESSES=${WG_INGRESS_ADDRESS}
WIREGUARD_ALLOWED_IPS=${WG_ALLOWED_IPS}
EOF
)
    PROFILE_WIREGUARD_ENV=$(cat <<EOF
# Enrollment pool. Its first host address is never allocated: every ingress
# interface answers on it (identity's WIREGUARD_INGRESS_ADDRESSES).
WIREGUARD_POOL_V4=${WG_POOL_V4}
EOF
)
else
    IDENTITY_WIREGUARD_ENV=$(cat <<EOF
# WireGuard enrollment is off. To offer it, set the three values below
# together with WIREGUARD_POOL_V4 in profile.env, after the kernel interface
# of every listed node is up.
# WIREGUARD_INGRESSES=${PROXY_ID}=<interface-public-key>@$(origin_host "$PROXY_BASE_URL"):51820
# WIREGUARD_INGRESS_ADDRESSES=10.7.0.1
# WIREGUARD_ALLOWED_IPS=10.7.0.1/32
EOF
)
    PROFILE_WIREGUARD_ENV=$(cat <<EOF
# Enrollment pool; enable it together with identity's enrollment values.
# WIREGUARD_POOL_V4=10.7.0.0/24
EOF
)
fi

write_env /etc/chan-gateway/profile.env chan-gateway-profile 0640 "$(cat <<EOF
# Generated by configure.sh on $(date -Iseconds).
BIND_ADDR=127.0.0.1:7001
DATABASE_URL=${PROFILE_DATABASE_URL}
CHAN_GATEWAY_MIGRATIONS=external
EXPECTED_SQLX_MIGRATION=18
DATABASE_ROLE_POLICY_VERSION=2
PROFILE_AUTH_TOKEN=${PROFILE_AUTH_TOKEN}
PROFILE_ADMIN_TOKEN=${PROFILE_ADMIN_TOKEN}
DEVSERVER_ADMIN_URL=http://127.0.0.1:7003
DEVSERVER_PROFILE_ADMIN_TOKEN=${DEVSERVER_PROFILE_ADMIN_TOKEN}
${PROFILE_WIREGUARD_ENV}
# WIREGUARD_POOL_V6=fd00:7::/64
# WIREGUARD_POOL_RESERVED=10.7.0.10,fd00:7::10
# WIREGUARD_RELEASE_GRACE_MINUTES=5
EOF
)"

PROVIDER_ENV=$(
    {
        emit_provider_env GITHUB    "$GH_ID"   "$GH_SECRET"
        emit_provider_env GOOGLE    "$GOOG_ID" "$GOOG_SECRET"
        emit_provider_env GITLAB    "$GL_ID"   "$GL_SECRET"
    }
)

write_env /etc/chan-gateway/identity.env chan-gateway-identity 0640 "$(cat <<EOF
# Generated by configure.sh on $(date -Iseconds).
BIND_ADDR=127.0.0.1:7000
INTERNAL_BIND_ADDR=127.0.0.1:7004
DATABASE_URL=${IDENTITY_DATABASE_URL}
CHAN_GATEWAY_MIGRATIONS=external
EXPECTED_SQLX_MIGRATION=18
DATABASE_ROLE_POLICY_VERSION=2
COOKIE_SECURE=true
PROFILE_SERVICE_URL=http://127.0.0.1:7001
PROFILE_AUTH_TOKEN=${PROFILE_AUTH_TOKEN}
PROFILE_ADMIN_TOKEN=${PROFILE_ADMIN_TOKEN}
DEVSERVER_POLICY_REQUIRED=false
IDENTITY_INTERNAL_TOKEN=${IDENTITY_INTERNAL_TOKEN}
IDENTITY_SESSION_INTERNAL_TOKEN=${IDENTITY_SESSION_INTERNAL_TOKEN}
WIREGUARD_AGENT_TOKEN=${WIREGUARD_AGENT_TOKEN}
${IDENTITY_WIREGUARD_ENV}
# WIREGUARD_PERSISTENT_KEEPALIVE=25
DEVSERVER_ADMISSION_SIGNING_KEY=${DEVSERVER_ADMISSION_SIGNING_KEY}
DEVSERVER_ADMISSION_VERIFYING_KEYS=${DEVSERVER_ADMISSION_VERIFYING_KEY}
DEVSERVER_ENTRY_SIGNING_KEY=${DEVSERVER_ENTRY_SIGNING_KEY}
IDENTITY_ADMIN_TOKEN=${IDENTITY_ADMIN_TOKEN}
IDENTITY_ACCOUNT_ADMIN_TOKEN=${IDENTITY_ACCOUNT_ADMIN_TOKEN}
DEVSERVER_ADMIN_URL=http://127.0.0.1:7003
DEVSERVER_IDENTITY_ADMIN_TOKEN=${DEVSERVER_IDENTITY_ADMIN_TOKEN}
${PROVIDER_ENV}
EOF
)"

write_env /etc/chan-gateway/devserver-control.env chan-gateway-devserver-control 0640 "$(cat <<EOF
# Generated by configure.sh on $(date -Iseconds).
BIND_ADDR=127.0.0.1:7003
PROXY_BIND_ADDR=127.0.0.1:7101
DEVSERVER_OPERATOR_ADMIN_TOKENS=${DEVSERVER_OPERATOR_ADMIN_TOKEN}
DEVSERVER_IDENTITY_ADMIN_TOKENS=${DEVSERVER_IDENTITY_ADMIN_TOKEN}
DEVSERVER_PROFILE_ADMIN_TOKENS=${DEVSERVER_PROFILE_ADMIN_TOKEN}
DEVSERVER_PROXY_CREDENTIALS=${PROXY_ID}=${DEVSERVER_PROXY_TOKEN}
DEVSERVER_ADMISSION_VERIFYING_KEYS=${DEVSERVER_ADMISSION_VERIFYING_KEY}
DEVSERVER_PROXY_BASE_URL_TEMPLATE=${PROXY_BASE_URL_TEMPLATE}
MAX_DEVSERVERS_PER_USER=100
EOF
)"

write_env /etc/chan-gateway/devserver-proxy.env chan-gateway-devserver-proxy 0640 "$(cat <<EOF
# Generated by configure.sh on $(date -Iseconds).
# devserver-proxy holds no database; DEVSERVER_PROXY_BASE_URL comes from
# domain.env.
BIND_ADDR=127.0.0.1:7002
TUNNEL_BIND_ADDR=127.0.0.1:7100
IDENTITY_URL=http://127.0.0.1:7004
IDENTITY_INTERNAL_TOKEN=${IDENTITY_INTERNAL_TOKEN}
DEVSERVER_ENTRY_VERIFYING_KEYS=${DEVSERVER_ENTRY_VERIFYING_KEYS}
DEVSERVER_ADMISSION_VERIFYING_KEYS=${DEVSERVER_ADMISSION_VERIFYING_KEY}
IDENTITY_PUBLIC_ORIGIN=${ID_URL}
DEVSERVER_CONTROL_URL=http://127.0.0.1:7101
DEVSERVER_PROXY_TOKEN=${DEVSERVER_PROXY_TOKEN}
DEVSERVER_PROXY_ID=${PROXY_ID}
EOF
)"

if [[ $AGENT_INSTALLED == true ]]; then
    write_env /etc/chan-gateway/wireguard-agent.env chan-gateway-wireguard-agent 0640 "$(cat <<EOF
# Generated by configure.sh on $(date -Iseconds).
IDENTITY_URL=http://127.0.0.1:7004
WIREGUARD_AGENT_TOKEN=${WIREGUARD_AGENT_TOKEN}
WIREGUARD_AGENT_HOST_ID=${PROXY_ID}
WIREGUARD_INTERFACE=${WG_INTERFACE}
EOF
)"
else
    echo "chan-gateway-wireguard-agent is not installed here: on each proxy host"
    echo "that runs it, set WIREGUARD_AGENT_TOKEN in wireguard-agent.env to the"
    echo "value written to /etc/chan-gateway/identity.env, and"
    echo "WIREGUARD_AGENT_HOST_ID to that node's id in WIREGUARD_INGRESSES."
fi

write_env /etc/chan-gateway/admin.env root 0600 "$(cat <<EOF
# Generated by configure.sh on $(date -Iseconds).
CHAN_ADMIN_PROFILE_URL=http://127.0.0.1:7001
CHAN_ADMIN_IDENTITY_URL=http://127.0.0.1:7004
CHAN_ADMIN_WORKSPACE_URL=http://127.0.0.1:7003
CHAN_ADMIN_PROFILE_TOKEN=${PROFILE_ADMIN_TOKEN}
CHAN_ADMIN_IDENTITY_TOKEN=${IDENTITY_ADMIN_TOKEN}
CHAN_ADMIN_OPERATOR_TOKEN=${DEVSERVER_OPERATOR_ADMIN_TOKEN}
EOF
)"

echo
echo "Done. Verify each enabled OAuth app's Authorization callback URL is:"
[[ -n "$GH_ID"   ]] && echo "    ${ID_URL}/auth/github/callback"
[[ -n "$GOOG_ID" ]] && echo "    ${ID_URL}/auth/google/callback"
[[ -n "$GL_ID"   ]] && echo "    ${ID_URL}/auth/gitlab/callback"
echo
echo "DNS records and certificate names for these origins:"
echo "    $(origin_host "$ID_URL") (identity public origin)"
echo "    $(origin_host "$TUNNEL_ORIGIN") (tunnel ingress and proxy health)"
echo "    *.$(origin_host "$PROXY_BASE_URL") (this node's tenant wildcard)"
echo
echo "Then stop database clients, run the owner-only migration/reconcile unit,"
echo "and enable + start the services:"
echo "    systemctl stop chan-gateway-identity chan-gateway-profile"
echo "    systemctl restart chan-gateway-migrate"
echo "    systemctl enable --now chan-gateway-profile"
echo "    systemctl enable --now chan-gateway-identity"
echo "    systemctl enable --now chan-gateway-devserver-control"
echo "    systemctl enable --now chan-gateway-devserver-proxy"
if [[ $AGENT_INSTALLED == true ]]; then
    echo "and, once the WireGuard interface ${WG_INTERFACE} is up:"
    echo "    systemctl enable --now chan-gateway-wireguard-agent"
fi
if [[ -n $WG_INGRESSES ]]; then
    echo
    echo "WireGuard enrollment is on for these nodes: ${WG_INGRESS_IDS}"
    echo "Each needs its interface up with the listed key, reachable at the listed"
    echo "endpoint, with Address = ${WG_INTERFACE_ADDRESS}, and its agent running with the"
    echo "node's id as WIREGUARD_AGENT_HOST_ID and the WIREGUARD_AGENT_TOKEN written"
    echo "to /etc/chan-gateway/identity.env."
    if [[ $AGENT_INSTALLED == true && " $WG_INGRESS_IDS " != *" $PROXY_ID "* ]]; then
        echo "This node's id, ${PROXY_ID}, is not one of them: identity answers 404 to its"
        echo "agent, which then applies no peer list."
    fi
fi
echo
echo "Tail logs while bringing them up:"
echo "    journalctl -u 'chan-gateway-*' -f"
