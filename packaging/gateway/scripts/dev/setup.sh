#!/usr/bin/env bash
# packaging/gateway/scripts/dev/setup.sh
#
# One-time bootstrap for the local dev stack:
#   * Generates secrets in packaging/gateway/scripts/dev/secrets/*.env if missing.
#   * Validates that packaging/gateway/scripts/dev/.env has the GitHub OAuth creds.
#   * Confirms Postgres is reachable and runs the identity binary in
#     migration-only mode before run.sh starts the long-lived services.
#
# Idempotent. Pass --force to regenerate secrets from scratch.

set -euo pipefail

cd "$(dirname "$0")"
SCRIPT_DIR="$(pwd -P)"
KEYPAIR_HELPER="$SCRIPT_DIR/../generate-admission-keypair.py"
SECRETS_DIR="$SCRIPT_DIR/secrets"
TLS_DIR="$SECRETS_DIR/tls"
ENV_FILE="$SCRIPT_DIR/.env"
ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)/gateway"

FORCE=0
for arg in "$@"; do
    case "$arg" in
        -f|--force) FORCE=1 ;;
        -h|--help)
            sed -n '2,12p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *) echo "unknown arg: $arg" >&2; exit 2 ;;
    esac
done

if [[ ! -f "$ENV_FILE" ]]; then
    echo "error: $ENV_FILE missing; copy env.example and fill in GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET" >&2
    exit 1
fi
set -a
# $ENV_FILE is a developer's own secrets file, chosen at runtime and never
# checked in, so there is no path for shellcheck to follow.
# shellcheck source=/dev/null
. "$ENV_FILE"
set +a

if [[ -z "${GITHUB_CLIENT_ID:-}" || -z "${GITHUB_CLIENT_SECRET:-}" ]]; then
    echo "error: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set in $ENV_FILE" >&2
    echo "       (see env.example for how to provision a dev OAuth app)" >&2
    exit 1
fi

DATABASE_URL=${DATABASE_URL:-postgres://chan:chan@127.0.0.1/chan_gateway}

mkdir -p "$SECRETS_DIR" "$TLS_DIR"

# Public wildcard routing cannot use cleartext DNS names, even when they happen
# to resolve into 127/8. Generate a local CA and edge certificate; run.sh keeps
# every Rust service on loopback and terminates TLS in front of identity and
# each proxy's public/tunnel listeners.
if [[ ! -f "$TLS_DIR/ca.crt" || ! -f "$TLS_DIR/ca.key" \
      || ! -f "$TLS_DIR/edge.crt" || ! -f "$TLS_DIR/edge.key" \
      || $FORCE -eq 1 ]]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
        -subj '/CN=chan local gateway dev CA' \
        -keyout "$TLS_DIR/ca.key" -out "$TLS_DIR/ca.crt" >/dev/null 2>&1
    openssl req -newkey rsa:2048 -nodes -subj '/CN=localtest.me' \
        -addext 'subjectAltName=DNS:gw.localtest.me,DNS:proxy.localtest.me,DNS:*.proxy.localtest.me,DNS:*.p1.proxy.localtest.me,DNS:*.p2.proxy.localtest.me,DNS:*.p3.proxy.localtest.me,IP:127.0.0.1,IP:127.0.0.2,IP:127.0.0.3' \
        -keyout "$TLS_DIR/edge.key" -out "$TLS_DIR/edge.csr" >/dev/null 2>&1
    openssl x509 -req -days 365 -sha256 -copy_extensions copy \
        -in "$TLS_DIR/edge.csr" -CA "$TLS_DIR/ca.crt" -CAkey "$TLS_DIR/ca.key" \
        -CAcreateserial -out "$TLS_DIR/edge.crt" >/dev/null 2>&1
    chmod 0600 "$TLS_DIR/ca.key" "$TLS_DIR/edge.key"
    chmod 0644 "$TLS_DIR/ca.crt" "$TLS_DIR/edge.crt"
fi

# Generate secrets if absent (or always if --force).
get_existing() {
    local path=$1 key=$2
    [[ -f "$path" ]] || return 1
    awk -F= -v k="$key" '$1==k {sub(/^[^=]+=/,""); print; exit}' "$path"
}

rand_hex() { openssl rand -hex 32; }

PROFILE_AUTH_TOKEN=$(get_existing "$SECRETS_DIR/profile.env" PROFILE_AUTH_TOKEN || true)
[[ -z "$PROFILE_AUTH_TOKEN" || $FORCE -eq 1 ]] && PROFILE_AUTH_TOKEN=$(rand_hex)

IDENTITY_INTERNAL_TOKEN=$(get_existing "$SECRETS_DIR/identity.env" IDENTITY_INTERNAL_TOKEN || true)
[[ -z "$IDENTITY_INTERNAL_TOKEN" || $FORCE -eq 1 ]] && IDENTITY_INTERNAL_TOKEN=$(rand_hex)

IDENTITY_SESSION_INTERNAL_TOKEN=$(get_existing "$SECRETS_DIR/identity.env" IDENTITY_SESSION_INTERNAL_TOKEN || true)
IDENTITY_ACCOUNT_ADMIN_TOKEN=$(get_existing "$SECRETS_DIR/identity.env" IDENTITY_ACCOUNT_ADMIN_TOKEN || true)
PROFILE_ADMIN_TOKEN=$(get_existing "$SECRETS_DIR/profile.env" PROFILE_ADMIN_TOKEN || true)
IDENTITY_ADMIN_TOKEN=$(get_existing "$SECRETS_DIR/identity.env" IDENTITY_ADMIN_TOKEN || true)
DEVSERVER_OPERATOR_ADMIN_TOKEN=$(get_existing "$SECRETS_DIR/devserver-control.env" DEVSERVER_OPERATOR_ADMIN_TOKENS || true)
DEVSERVER_OPERATOR_ADMIN_TOKEN=${DEVSERVER_OPERATOR_ADMIN_TOKEN%%;*}
DEVSERVER_IDENTITY_ADMIN_TOKEN=$(get_existing "$SECRETS_DIR/identity.env" DEVSERVER_IDENTITY_ADMIN_TOKEN || true)
DEVSERVER_PROFILE_ADMIN_TOKEN=$(get_existing "$SECRETS_DIR/profile.env" DEVSERVER_PROFILE_ADMIN_TOKEN || true)

scoped_tokens=("$IDENTITY_INTERNAL_TOKEN")
for token_name in IDENTITY_SESSION_INTERNAL_TOKEN IDENTITY_ACCOUNT_ADMIN_TOKEN \
    PROFILE_ADMIN_TOKEN IDENTITY_ADMIN_TOKEN \
    DEVSERVER_OPERATOR_ADMIN_TOKEN DEVSERVER_IDENTITY_ADMIN_TOKEN \
    DEVSERVER_PROFILE_ADMIN_TOKEN; do
    token=${!token_name}
    duplicate=false
    for existing_token in "${scoped_tokens[@]:-}"; do
        [[ "$token" != "$existing_token" ]] || duplicate=true
    done
    if [[ -z "$token" || $duplicate == true || $FORCE -eq 1 ]]; then
        token=$(rand_hex)
        while [[ " ${scoped_tokens[*]:-} " == *" $token "* ]]; do token=$(rand_hex); done
        printf -v "$token_name" '%s' "$token"
    fi
    scoped_tokens+=("${!token_name}")
done

DEVSERVER_ADMISSION_SIGNING_KEY=$(get_existing "$SECRETS_DIR/identity.env" DEVSERVER_ADMISSION_SIGNING_KEY || true)
DEVSERVER_ADMISSION_VERIFYING_KEY=$(get_existing "$SECRETS_DIR/devserver-control.env" DEVSERVER_ADMISSION_VERIFYING_KEYS || true)
DEVSERVER_ADMISSION_VERIFYING_KEY=${DEVSERVER_ADMISSION_VERIFYING_KEY%%;*}
if [[ -z "$DEVSERVER_ADMISSION_SIGNING_KEY" || -z "$DEVSERVER_ADMISSION_VERIFYING_KEY" || $FORCE -eq 1 ]]; then
    mapfile -t admission_keys < <("$KEYPAIR_HELPER")
    [[ ${#admission_keys[@]} -eq 2 ]] || { echo "admission key generation failed" >&2; exit 1; }
    DEVSERVER_ADMISSION_SIGNING_KEY=${admission_keys[0]}
    DEVSERVER_ADMISSION_VERIFYING_KEY=${admission_keys[1]}
fi

DEVSERVER_ENTRY_SIGNING_KEY=$(get_existing "$SECRETS_DIR/identity.env" DEVSERVER_ENTRY_SIGNING_KEY || true)
DEVSERVER_ENTRY_VERIFYING_KEYS=$(get_existing "$SECRETS_DIR/devserver-proxy.p1.env" DEVSERVER_ENTRY_VERIFYING_KEYS || true)
DEVSERVER_ENTRY_VERIFYING_KEYS=${DEVSERVER_ENTRY_VERIFYING_KEYS%%;*}
if [[ -z "$DEVSERVER_ENTRY_SIGNING_KEY" || -z "$DEVSERVER_ENTRY_VERIFYING_KEYS" || $FORCE -eq 1 ]]; then
    mapfile -t entry_keys < <("$KEYPAIR_HELPER")
    [[ ${#entry_keys[@]} -eq 2 ]] || { echo "entry key generation failed" >&2; exit 1; }
    DEVSERVER_ENTRY_SIGNING_KEY=${entry_keys[0]}
    DEVSERVER_ENTRY_VERIFYING_KEYS=${entry_keys[1]}
fi

DEVSERVER_PROXY_TOKENS=()
DEVSERVER_PROXY_CREDENTIALS=""
for n in 1 2 3; do
    token=$(get_existing "$SECRETS_DIR/devserver-proxy.p$n.env" DEVSERVER_PROXY_TOKEN || true)
    [[ -z "$token" || $FORCE -eq 1 ]] && token=$(rand_hex)
    for existing_token in "${DEVSERVER_PROXY_TOKENS[@]:-}"; do
        [[ "$token" != "$existing_token" ]] || token=$(rand_hex)
    done
    DEVSERVER_PROXY_TOKENS+=("$token")
    [[ -n "$DEVSERVER_PROXY_CREDENTIALS" ]] && DEVSERVER_PROXY_CREDENTIALS+=";"
    DEVSERVER_PROXY_CREDENTIALS+="p$n=$token"
done

write_env() {
    local path=$1 content=$2
    if [[ -f "$path" && $FORCE -eq 0 ]]; then
        # Re-emit anyway so a manual edit gets overwritten back to
        # a self-consistent state. Use --force when you actually
        # want to keep manual edits out of the loop.
        :
    fi
    printf '%s\n' "$content" > "$path"
    chmod 0600 "$path"
}

write_env "$SECRETS_DIR/profile.env" "# generated by packaging/gateway/scripts/dev/setup.sh
BIND_ADDR=127.0.0.1:17001
DATABASE_URL=$DATABASE_URL
CHAN_GATEWAY_MIGRATIONS=external
PROFILE_AUTH_TOKEN=$PROFILE_AUTH_TOKEN
PROFILE_ADMIN_TOKEN=$PROFILE_ADMIN_TOKEN
DEVSERVER_ADMIN_URL=http://127.0.0.1:17003
DEVSERVER_PROFILE_ADMIN_TOKEN=$DEVSERVER_PROFILE_ADMIN_TOKEN
RUST_LOG=${RUST_LOG:-info,profile=debug}"

PROVIDER_ENV="GITHUB_CLIENT_ID=$GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET=$GITHUB_CLIENT_SECRET"
# A provider configured with an id but no secret is a half-written env file:
# name the missing variable instead of aborting on `set -u`.
if [[ -n "${GOOGLE_CLIENT_ID:-}" ]]; then
    PROVIDER_ENV+="
GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET:?set GOOGLE_CLIENT_SECRET alongside GOOGLE_CLIENT_ID}"
fi
if [[ -n "${GITLAB_CLIENT_ID:-}" ]]; then
    PROVIDER_ENV+="
GITLAB_CLIENT_ID=$GITLAB_CLIENT_ID
GITLAB_CLIENT_SECRET=${GITLAB_CLIENT_SECRET:?set GITLAB_CLIENT_SECRET alongside GITLAB_CLIENT_ID}"
fi

write_env "$SECRETS_DIR/identity.env" "# generated by packaging/gateway/scripts/dev/setup.sh
BIND_ADDR=127.0.0.1:16900
INTERNAL_BIND_ADDR=127.0.0.1:17004
BASE_URL=https://gw.localtest.me:17000
DEVSERVER_PROXY_ORIGIN=https://proxy.localtest.me:17002
DEVSERVER_TUNNEL_ORIGIN=https://proxy.localtest.me:17100
DATABASE_URL=$DATABASE_URL
CHAN_GATEWAY_MIGRATIONS=external
COOKIE_SECURE=true
PROFILE_SERVICE_URL=http://127.0.0.1:17001
PROFILE_AUTH_TOKEN=$PROFILE_AUTH_TOKEN
PROFILE_ADMIN_TOKEN=$PROFILE_ADMIN_TOKEN
DEVSERVER_POLICY_REQUIRED=false
IDENTITY_INTERNAL_TOKEN=$IDENTITY_INTERNAL_TOKEN
IDENTITY_SESSION_INTERNAL_TOKEN=$IDENTITY_SESSION_INTERNAL_TOKEN
DEVSERVER_ADMIN_URL=http://127.0.0.1:17003
DEVSERVER_IDENTITY_ADMIN_TOKEN=$DEVSERVER_IDENTITY_ADMIN_TOKEN
DEVSERVER_ADMISSION_SIGNING_KEY=$DEVSERVER_ADMISSION_SIGNING_KEY
DEVSERVER_ADMISSION_VERIFYING_KEYS=$DEVSERVER_ADMISSION_VERIFYING_KEY
DEVSERVER_ENTRY_SIGNING_KEY=$DEVSERVER_ENTRY_SIGNING_KEY
IDENTITY_ADMIN_TOKEN=$IDENTITY_ADMIN_TOKEN
IDENTITY_ACCOUNT_ADMIN_TOKEN=$IDENTITY_ACCOUNT_ADMIN_TOKEN
$PROVIDER_ENV
RUST_LOG=${RUST_LOG:-info,identity=debug}"

# The controller owns the aggregate admin tree and fleet admission;
# identity and profile point their DEVSERVER_ADMIN_URL at it. Its
# origin template pins every proxy's public base URL to one node label
# below the devserver apex.
write_env "$SECRETS_DIR/devserver-control.env" "# generated by packaging/gateway/scripts/dev/setup.sh
BIND_ADDR=127.0.0.1:17003
PROXY_BIND_ADDR=127.0.0.1:17101
DEVSERVER_OPERATOR_ADMIN_TOKENS=$DEVSERVER_OPERATOR_ADMIN_TOKEN
DEVSERVER_IDENTITY_ADMIN_TOKENS=$DEVSERVER_IDENTITY_ADMIN_TOKEN
DEVSERVER_PROFILE_ADMIN_TOKENS=$DEVSERVER_PROFILE_ADMIN_TOKEN
DEVSERVER_PROXY_CREDENTIALS=$DEVSERVER_PROXY_CREDENTIALS
DEVSERVER_ADMISSION_VERIFYING_KEYS=$DEVSERVER_ADMISSION_VERIFYING_KEY
DEVSERVER_PROXY_BASE_URL_TEMPLATE=https://{proxy_id}.proxy.localtest.me:17002
MAX_DEVSERVERS_PER_USER=100
RUST_LOG=${RUST_LOG:-info,devserver_control=debug}"

# One env file per proxy node so run.sh can boot a fleet of 1 to 3.
# p1 uses the plain 127.0.0.1 ports so the single-proxy default needs
# no aliasing; p2/p3 take the same ports on 127.0.0.2/127.0.0.3
# (loopback aliases) because the origin template cannot express a
# per-node port.
rm -f "$SECRETS_DIR/devserver-proxy.env"
for n in 1 2 3; do
    write_env "$SECRETS_DIR/devserver-proxy.p$n.env" "# generated by packaging/gateway/scripts/dev/setup.sh
BIND_ADDR=127.0.0.$n:16902
TUNNEL_BIND_ADDR=127.0.0.$n:16910
DEVSERVER_TUNNEL_ORIGIN=https://proxy.localtest.me:17100
DEVSERVER_PROXY_BASE_URL=https://p$n.proxy.localtest.me:17002
DEVSERVER_CONTROL_URL=http://127.0.0.1:17101
DEVSERVER_PROXY_TOKEN=${DEVSERVER_PROXY_TOKENS[$((n - 1))]}
DEVSERVER_PROXY_ID=p$n
DASHBOARD_URL=https://gw.localtest.me:17000/workspaces
IDENTITY_URL=http://127.0.0.1:17004
IDENTITY_INTERNAL_TOKEN=$IDENTITY_INTERNAL_TOKEN
DEVSERVER_ENTRY_VERIFYING_KEYS=$DEVSERVER_ENTRY_VERIFYING_KEYS
DEVSERVER_ADMISSION_VERIFYING_KEYS=$DEVSERVER_ADMISSION_VERIFYING_KEY
IDENTITY_PUBLIC_ORIGIN=https://gw.localtest.me:17000
FORWARDED_PROTO=https
RUST_LOG=${RUST_LOG:-info,devserver_proxy=debug}"
done

echo "wrote secrets to $SECRETS_DIR/"

# The same identity binary shipped to production owns both the shared sqlx
# migrations and its tower-sessions schema. Migration-only mode needs no OAuth,
# listener, or sibling-service configuration and exits as soon as DDL succeeds.
echo "applying migrations via identity-service..."
(
    cd "$ROOT"
    cargo build --quiet --bin identity-service
    env DATABASE_URL="$DATABASE_URL" \
        CHAN_GATEWAY_MIGRATIONS=only \
        ./target/debug/identity-service
)

echo
echo "setup complete."
echo "  next: packaging/gateway/scripts/dev/run.sh"
