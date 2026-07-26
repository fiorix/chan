#!/usr/bin/env bash
# Generate /etc/chan-gateway/{domain,migrate,profile,identity,
# devserver-control,devserver-proxy,admin}.env on a host where the .debs are already
# installed.
#
# Usage:
#   sudo ./configure.sh
#
# Prompts for the values that aren't safely defaultable (Postgres
# password, base domain, OAuth credentials). Generates the shared
# secrets (PROFILE_AUTH_TOKEN, IDENTITY_INTERNAL_TOKEN,
# admission/entry keypairs, the proxy credential, and
# distinct profile, identity, controller-operator, and controller-client tokens)
# and threads them across the files where they must
# match. Backs up any existing env files before overwriting.

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

read -rp "Postgres user [chan]: " PG_USER
PG_USER=${PG_USER:-chan}

read -rsp "Postgres password for ${PG_USER}: " PG_PASS; echo
[[ -n "$PG_PASS" ]] || { echo "password required" >&2; exit 1; }

read -rp "Postgres database [chan_gateway]: " PG_DB
PG_DB=${PG_DB:-chan_gateway}

read -rp "Gateway public origin [https://gw.chan.app]: " ID_URL
ID_URL=${ID_URL:-https://gw.chan.app}
read -rp "Proxy namespace origin [https://usr.chan.app]: " PROXY_ORIGIN
PROXY_ORIGIN=${PROXY_ORIGIN:-https://usr.chan.app}
read -rp "Tunnel ingress origin [$PROXY_ORIGIN]: " TUNNEL_ORIGIN
TUNNEL_ORIGIN=${TUNNEL_ORIGIN:-$PROXY_ORIGIN}
read -rp "This proxy node id [p1]: " PROXY_ID
PROXY_ID=${PROXY_ID:-p1}
# The node origin must match the controller's template expansion for the
# id, so the default prepends it to the namespace host.
PROXY_BASE_URL_DEFAULT="${PROXY_ORIGIN%%://*}://${PROXY_ID}.${PROXY_ORIGIN#*://}"
read -rp "This proxy node origin [$PROXY_BASE_URL_DEFAULT]: " PROXY_BASE_URL
PROXY_BASE_URL=${PROXY_BASE_URL:-$PROXY_BASE_URL_DEFAULT}
PROXY_BASE_URL_TEMPLATE="${PROXY_ORIGIN%%://*}://{proxy_id}.${PROXY_ORIGIN#*://}"

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
GENERATED_ADMIN_TOKENS=()
generate_unique_admin_token() {
    local candidate existing collision
    while :; do
        candidate=$(openssl rand -hex 32)
        collision=false
        for existing in "${GENERATED_ADMIN_TOKENS[@]:-}"; do
            if [[ $candidate == "$existing" ]]; then
                collision=true
                break
            fi
        done
        [[ $collision == false ]] || continue
        GENERATED_ADMIN_TOKENS+=("$candidate")
        UNIQUE_ADMIN_TOKEN=$candidate
        return
    done
}
generate_unique_admin_token; PROFILE_ADMIN_TOKEN=$UNIQUE_ADMIN_TOKEN
generate_unique_admin_token; IDENTITY_ADMIN_TOKEN=$UNIQUE_ADMIN_TOKEN
generate_unique_admin_token; DEVSERVER_OPERATOR_ADMIN_TOKEN=$UNIQUE_ADMIN_TOKEN
generate_unique_admin_token; DEVSERVER_IDENTITY_ADMIN_TOKEN=$UNIQUE_ADMIN_TOKEN
generate_unique_admin_token; DEVSERVER_PROFILE_ADMIN_TOKEN=$UNIQUE_ADMIN_TOKEN

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
EXPECTED_SQLX_MIGRATION=16
DATABASE_ROLE_POLICY_VERSION=1
EOF
)"

write_env /etc/chan-gateway/profile.env chan-gateway-profile 0640 "$(cat <<EOF
# Generated by configure.sh on $(date -Iseconds).
BIND_ADDR=127.0.0.1:7001
DATABASE_URL=${PROFILE_DATABASE_URL}
CHAN_GATEWAY_MIGRATIONS=external
EXPECTED_SQLX_MIGRATION=16
DATABASE_ROLE_POLICY_VERSION=1
PROFILE_AUTH_TOKEN=${PROFILE_AUTH_TOKEN}
PROFILE_ADMIN_TOKEN=${PROFILE_ADMIN_TOKEN}
DEVSERVER_ADMIN_URL=http://127.0.0.1:7003
DEVSERVER_PROFILE_ADMIN_TOKEN=${DEVSERVER_PROFILE_ADMIN_TOKEN}
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
EXPECTED_SQLX_MIGRATION=16
DATABASE_ROLE_POLICY_VERSION=1
COOKIE_SECURE=true
PROFILE_SERVICE_URL=http://127.0.0.1:7001
PROFILE_AUTH_TOKEN=${PROFILE_AUTH_TOKEN}
PROFILE_ADMIN_TOKEN=${PROFILE_ADMIN_TOKEN}
DEVSERVER_POLICY_REQUIRED=false
IDENTITY_INTERNAL_TOKEN=${IDENTITY_INTERNAL_TOKEN}
DEVSERVER_ADMISSION_SIGNING_KEY=${DEVSERVER_ADMISSION_SIGNING_KEY}
DEVSERVER_ADMISSION_VERIFYING_KEYS=${DEVSERVER_ADMISSION_VERIFYING_KEY}
DEVSERVER_ENTRY_SIGNING_KEY=${DEVSERVER_ENTRY_SIGNING_KEY}
IDENTITY_ADMIN_TOKEN=${IDENTITY_ADMIN_TOKEN}
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

write_env /etc/chan-gateway/admin.env root 0600 "$(cat <<EOF
# Generated by configure.sh on $(date -Iseconds).
CHAN_ADMIN_PROFILE_URL=http://127.0.0.1:7001
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
echo "Then stop database clients, run the owner-only migration/reconcile unit,"
echo "and enable + start the services:"
echo "    systemctl stop chan-gateway-identity chan-gateway-profile"
echo "    systemctl restart chan-gateway-migrate"
echo "    systemctl enable --now chan-gateway-profile"
echo "    systemctl enable --now chan-gateway-identity"
echo "    systemctl enable --now chan-gateway-devserver-control"
echo "    systemctl enable --now chan-gateway-devserver-proxy"
echo
echo "Tail logs while bringing them up:"
echo "    journalctl -u 'chan-gateway-*' -f"
