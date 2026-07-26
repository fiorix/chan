#!/usr/bin/env bash
# Static regression checks for gateway package identity and env-file ownership.

set -euo pipefail

REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)

die() {
    printf 'test-packaging-isolation: %s\n' "$*" >&2
    exit 1
}

assert_contains() {
    local file=$1 text=$2
    grep -Fqx "$text" "$file" \
        || die "$file does not contain: $text"
}

services=(profile identity devserver-control devserver-proxy)
for service in "${services[@]}"; do
    user="chan-gateway-$service"
    packaging="$REPO/gateway/crates/$service/packaging"
    unit="$packaging/chan-gateway-$service.service"
    postinst="$packaging/postinst"
    env_file="$packaging/$service.env"

    assert_contains "$unit" "User=$user"
    assert_contains "$unit" "Group=$user"
    assert_contains "$postinst" "    install -d -m 0751 -o root -g root /etc/chan-gateway"
    assert_contains "$postinst" "      chown root:root /etc/chan-gateway/domain.env"
    assert_contains "$postinst" "      chmod 0644 /etc/chan-gateway/domain.env"
    assert_contains "$postinst" "      chown root:$user /etc/chan-gateway/$service.env"
    assert_contains "$postinst" "      chmod 0640 /etc/chan-gateway/$service.env"
    grep -Fq "Permissions are 0640 root:$user" "$env_file" \
        || die "$env_file does not document its service-only group"
done

migrate_packaging="$REPO/gateway/crates/identity/packaging"
assert_contains "$migrate_packaging/chan-gateway-migrate.service" \
    "User=chan-gateway-migrate"
assert_contains "$migrate_packaging/chan-gateway-migrate.service" \
    "Group=chan-gateway-migrate"
assert_contains "$migrate_packaging/chan-gateway-migrate.service" \
    "EnvironmentFile=/etc/chan-gateway/migrate.env"
assert_contains "$migrate_packaging/chan-gateway-migrate.service" \
    "ExecStartPre=/usr/lib/chan-gateway/prepare-database-roles"
assert_contains "$migrate_packaging/chan-gateway-migrate.service" \
    "ExecStart=/usr/bin/chan-gateway-identity"
assert_contains "$migrate_packaging/chan-gateway-migrate.service" \
    "ExecStartPost=/usr/lib/chan-gateway/reconcile-database-roles"
assert_contains "$migrate_packaging/chan-gateway-migrate.service" \
    "RemainAfterExit=yes"
if grep -Fq '[Install]' "$migrate_packaging/chan-gateway-migrate.service"; then
    die "database migration unit must run only as an app-service dependency"
fi
for service in profile identity; do
    assert_contains "$REPO/gateway/crates/$service/packaging/chan-gateway-$service.service" \
        "Requires=chan-gateway-migrate.service"
    assert_contains "$REPO/gateway/crates/$service/packaging/$service.env" \
        "CHAN_GATEWAY_MIGRATIONS=external"
    assert_contains "$REPO/gateway/crates/$service/packaging/chan-gateway-$service.service" \
        "ExecStartPre=/usr/lib/chan-gateway/check-database-ready"
    assert_contains "$REPO/gateway/crates/$service/packaging/$service.env" \
        "EXPECTED_SQLX_MIGRATION=16"
    assert_contains "$REPO/gateway/crates/$service/packaging/$service.env" \
        "DATABASE_ROLE_POLICY_VERSION=1"
    if grep -Fq 'postgres://chan:chan@' \
        "$REPO/gateway/crates/$service/packaging/$service.env"; then
        die "$service env still carries the database-owner URL"
    fi
done
assert_contains "$migrate_packaging/migrate.env" "CHAN_GATEWAY_MIGRATIONS=only"
assert_contains "$migrate_packaging/migrate.env" "EXPECTED_SQLX_MIGRATION=16"
assert_contains "$migrate_packaging/migrate.env" "DATABASE_ROLE_POLICY_VERSION=1"
assert_contains "$migrate_packaging/postinst" \
    "      chown root:chan-gateway-migrate /etc/chan-gateway/migrate.env"
assert_contains "$migrate_packaging/postinst" \
    "      chmod 0640 /etc/chan-gateway/migrate.env"

readiness_check="$REPO/packaging/gateway/scripts/check-database-ready.sh"
for versions in "0 1" "1 0" "auto 1"; do
    read -r expected policy <<< "$versions"
    if DATABASE_URL=unused \
        EXPECTED_SQLX_MIGRATION="$expected" \
        DATABASE_ROLE_POLICY_VERSION="$policy" \
        "$readiness_check" >/dev/null 2>&1; then
        die "database readiness accepted invalid versions: $versions"
    fi
done

# Every package reapplies the same directory state, so installing admin first,
# last, or between service packages cannot remove traversal from service users.
assert_contains "$REPO/gateway/crates/admin/packaging/postinst" \
    "    install -d -m 0751 -o root -g root /etc/chan-gateway"
assert_contains "$REPO/gateway/crates/admin/packaging/postinst" \
    "      chown root:root /etc/chan-gateway/domain.env"
assert_contains "$REPO/gateway/crates/admin/packaging/postinst" \
    "      chmod 0644 /etc/chan-gateway/domain.env"
assert_contains "$REPO/gateway/crates/admin/packaging/postinst" \
    "      chown root:root /etc/chan-gateway/admin.env"
assert_contains "$REPO/gateway/crates/admin/packaging/postinst" \
    "      chmod 0600 /etc/chan-gateway/admin.env"

if rg -n '^(User|Group)=chan-gateway$' \
    "$REPO"/gateway/crates/*/packaging/*.service; then
    die "a gateway daemon still uses the shared chan-gateway identity"
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/postinst" "$WORK/postinst-bin"
packages=(admin profile identity devserver-control devserver-proxy)
for package in "${packages[@]}"; do
    sed "s|/etc/chan-gateway|$WORK/package-root/etc/chan-gateway|g" \
        "$REPO/gateway/crates/$package/packaging/postinst" \
        > "$WORK/postinst/$package"
done
cat > "$WORK/postinst-bin/getent" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$WORK/postinst-bin/adduser" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$WORK/postinst-bin/chown" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$WORK/postinst-bin/install" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mode=
destination=
while [[ $# -gt 0 ]]; do
    case "$1" in
        -d) shift ;;
        -m) mode=$2; shift 2 ;;
        -o|-g) shift 2 ;;
        *) destination=$1; shift ;;
    esac
done
mkdir -p "$destination"
[[ -z "$mode" ]] || chmod "$mode" "$destination"
EOF
chmod +x "$WORK"/postinst-bin/*

assert_mode() {
    local expected=$1 path=$2
    find "$path" -prune -perm "$expected" | grep -q . \
        || die "$path does not have mode $expected after package-order simulation"
}

run_package_order() {
    rm -rf "$WORK/package-root"
    mkdir -p "$WORK/package-root/etc/chan-gateway"
    touch "$WORK/package-root/etc/chan-gateway/domain.env"
    for service in "${services[@]}"; do
        cp "$REPO/gateway/crates/$service/packaging/$service.env" \
            "$WORK/package-root/etc/chan-gateway/$service.env"
    done
    touch "$WORK/package-root/etc/chan-gateway/admin.env"
    cp "$REPO/gateway/crates/identity/packaging/migrate.env" \
        "$WORK/package-root/etc/chan-gateway/migrate.env"
    for package in "$@"; do
        PATH="$WORK/postinst-bin:$PATH" /bin/sh "$WORK/postinst/$package" configure
    done
    assert_mode 0751 "$WORK/package-root/etc/chan-gateway"
    assert_mode 0644 "$WORK/package-root/etc/chan-gateway/domain.env"
    assert_mode 0600 "$WORK/package-root/etc/chan-gateway/admin.env"
    assert_mode 0640 "$WORK/package-root/etc/chan-gateway/migrate.env"
    for service in "${services[@]}"; do
        assert_mode 0640 "$WORK/package-root/etc/chan-gateway/$service.env"
    done
}

# Five nested loops cover all 120 install orders. Distinct package names make
# an order a permutation; repeated choices are skipped.
for a in "${packages[@]}"; do
    for b in "${packages[@]}"; do
        [[ "$b" != "$a" ]] || continue
        for c in "${packages[@]}"; do
            [[ "$c" != "$a" && "$c" != "$b" ]] || continue
            for d in "${packages[@]}"; do
                [[ "$d" != "$a" && "$d" != "$b" && "$d" != "$c" ]] || continue
                for e in "${packages[@]}"; do
                    [[ "$e" != "$a" && "$e" != "$b" && "$e" != "$c" && "$e" != "$d" ]] || continue
                    run_package_order "$a" "$b" "$c" "$d" "$e"
                done
            done
        done
    done
done

# A retained pre-hardening conffile must fail package configuration instead of
# starting an app with owner credentials or automatic DDL.
cp "$REPO/gateway/crates/profile/packaging/profile.env" \
    "$WORK/package-root/etc/chan-gateway/profile.env"
sed -i 's|^DATABASE_URL=.*|DATABASE_URL=postgres://owner:secret@127.0.0.1/db|' \
    "$WORK/package-root/etc/chan-gateway/profile.env"
if PATH="$WORK/postinst-bin:$PATH" /bin/sh "$WORK/postinst/profile" configure \
    2> "$WORK/profile-owner.err"; then
    die "profile postinst accepted a database-owner URL"
fi
grep -Fq 'non-owner chan_gateway_profile DATABASE_URL' "$WORK/profile-owner.err" \
    || die "profile owner-URL refusal returned the wrong error"

cp "$REPO/gateway/crates/identity/packaging/identity.env" \
    "$WORK/package-root/etc/chan-gateway/identity.env"
sed -i 's/^CHAN_GATEWAY_MIGRATIONS=external$/CHAN_GATEWAY_MIGRATIONS=auto/' \
    "$WORK/package-root/etc/chan-gateway/identity.env"
if PATH="$WORK/postinst-bin:$PATH" /bin/sh "$WORK/postinst/identity" configure \
    2> "$WORK/identity-auto.err"; then
    die "identity postinst accepted automatic runtime DDL"
fi
grep -Fq 'CHAN_GATEWAY_MIGRATIONS=external setting' "$WORK/identity-auto.err" \
    || die "identity auto-mode refusal returned the wrong error"

assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    "install -d -m 0751 -o root -g root /etc/chan-gateway"
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    "MAX_DEVSERVERS_PER_USER=100"
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    '        chown root:root "$backup"'
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    '        chmod 0600 "$backup"'
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    'write_env /etc/chan-gateway/migrate.env chan-gateway-migrate 0640 "$(cat <<EOF'
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    'DATABASE_URL=${MIGRATION_DATABASE_URL}'
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    'DATABASE_URL=${IDENTITY_DATABASE_URL}'
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    'DATABASE_URL=${PROFILE_DATABASE_URL}'
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    'CHAN_GATEWAY_MIGRATIONS=external'
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    'DEVSERVER_ENTRY_SIGNING_KEY=${DEVSERVER_ENTRY_SIGNING_KEY}'
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    'DEVSERVER_ENTRY_VERIFYING_KEYS=${DEVSERVER_ENTRY_VERIFYING_KEYS}'
assert_contains "$REPO/gateway/crates/identity/packaging/identity.env" \
    "INTERNAL_BIND_ADDR=127.0.0.1:7004"
assert_contains "$REPO/gateway/crates/devserver-proxy/packaging/devserver-proxy.env" \
    "IDENTITY_URL=http://127.0.0.1:7004"
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    'INTERNAL_BIND_ADDR=127.0.0.1:7004'
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    'IDENTITY_URL=http://127.0.0.1:7004'
if rg -n '^IDENTITY_URL=.*:7000/?$' \
    "$REPO"/gateway/crates/*/packaging/*.env \
    "$REPO/packaging/gateway/scripts/configure.sh" \
    "$REPO/packaging/gateway/scripts/dev/setup.sh"; then
    die "an internal identity client still targets the public listener"
fi

for scoped_env in \
    DEVSERVER_OPERATOR_ADMIN_TOKENS \
    DEVSERVER_IDENTITY_ADMIN_TOKENS \
    DEVSERVER_PROFILE_ADMIN_TOKENS; do
    assert_contains "$REPO/gateway/crates/devserver-control/packaging/devserver-control.env" \
        "$scoped_env="
done
assert_contains "$REPO/gateway/crates/devserver-control/packaging/devserver-control.env" \
    "DEVSERVER_ADMISSION_VERIFYING_KEYS="
assert_contains "$REPO/gateway/crates/identity/packaging/identity.env" \
    "DEVSERVER_ADMISSION_VERIFYING_KEYS="
if grep -Fq 'DEVSERVER_ADMISSION_VERIFYING_KEY=' \
    "$REPO/gateway/crates/devserver-control/packaging/devserver-control.env"; then
    die "controller package retains the non-rotatable admission verifier variable"
fi
assert_contains "$REPO/gateway/crates/identity/packaging/identity.env" \
    "DEVSERVER_IDENTITY_ADMIN_TOKEN="
assert_contains "$REPO/gateway/crates/identity/packaging/identity.env" \
    "IDENTITY_SESSION_INTERNAL_TOKEN="
assert_contains "$REPO/gateway/crates/identity/packaging/identity.env" \
    "IDENTITY_ACCOUNT_ADMIN_TOKEN="
for scoped_env in IDENTITY_SESSION_INTERNAL_TOKEN IDENTITY_ACCOUNT_ADMIN_TOKEN; do
    assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
        "$scoped_env=\${$scoped_env}"
    assert_contains "$REPO/packaging/gateway/scripts/dev/setup.sh" \
        "$scoped_env=\$$scoped_env"
done
assert_contains "$REPO/gateway/crates/profile/packaging/profile.env" \
    "DEVSERVER_PROFILE_ADMIN_TOKEN="
for scoped_env in \
    CHAN_ADMIN_PROFILE_TOKEN CHAN_ADMIN_IDENTITY_TOKEN CHAN_ADMIN_OPERATOR_TOKEN; do
    assert_contains "$REPO/gateway/crates/admin/packaging/admin.env" "$scoped_env="
done
if rg -n '^DEVSERVER_ADMIN_TOKEN=|^CHAN_ADMIN_TOKEN=' \
    "$REPO"/gateway/crates/*/packaging/*.env \
    "$REPO/packaging/gateway/scripts/configure.sh"; then
    die "packaging retains a shared admin bearer"
fi
if rg -n '^DEVSERVER_GATE_SECRET=' \
    "$REPO"/gateway/crates/*/packaging/*.env \
    "$REPO/packaging/gateway/scripts/configure.sh" \
    "$REPO/packaging/gateway/scripts/dev/setup.sh"; then
    die "runtime packaging retains the retired cross-service session secret"
fi
if rg -n '^IDENTITY_(SESSION_INTERNAL|ACCOUNT_ADMIN)_TOKEN=' \
    "$REPO/gateway/crates/devserver-proxy/packaging/devserver-proxy.env" \
    "$REPO/gateway/crates/admin/packaging/admin.env"; then
    die "a narrow account bearer escaped identity packaging"
fi

# Keep both developer E2E paths on the production credential and transport
# contracts. These fixtures are executable documentation and must not quietly
# regress to the retired shared-secret/query-bearer flow or cleartext public
# DNS origins.
sdme_e2e="$REPO/packaging/gateway/scripts/dev/sdme/devserver-tunnel-e2e"
if rg -n 'DEVSERVER_GATE_SECRET|HS256|mint-gate-token|entry_url[^[:space:]]*\?t=' \
    "$sdme_e2e"; then
    die "sdme devserver E2E retains a retired credential contract"
fi
for expected in \
    DEVSERVER_ENTRY_VERIFYING_KEYS \
    IDENTITY_PUBLIC_ORIGIN \
    DEVSERVER_PROXY_CREDENTIALS \
    devserver-control-service \
    mint-signed-credential.py; do
    rg -q --fixed-strings "$expected" "$sdme_e2e" \
        || die "sdme devserver E2E does not exercise $expected"
done

dev_setup="$REPO/packaging/gateway/scripts/dev/setup.sh"
dev_run="$REPO/packaging/gateway/scripts/dev/run.sh"
if rg -n '^(BASE_URL|DEVSERVER_PROXY_ORIGIN|DEVSERVER_TUNNEL_ORIGIN|DEVSERVER_PROXY_BASE_URL|IDENTITY_PUBLIC_ORIGIN|DASHBOARD_URL)=http://.*localtest\.me' \
    "$dev_setup"; then
    die "local gateway runner publishes a cleartext DNS origin"
fi
for expected in \
    'BASE_URL=https://id.localtest.me:17000' \
    'DEVSERVER_PROXY_ORIGIN=https://devserver.localtest.me:17002' \
    'DEVSERVER_TUNNEL_ORIGIN=https://devserver.localtest.me:17100' \
    'IDENTITY_PUBLIC_ORIGIN=https://id.localtest.me:17000'; do
    grep -Fq "$expected" "$dev_setup" \
        || die "local gateway setup does not contain: $expected"
done
grep -Fq 'TLS_SHIM="$SCRIPT_DIR/tls-shim.mjs"' "$dev_run" \
    || die "local gateway runner does not publish TLS edges"

prepare="$REPO/packaging/gateway/scripts/prepare-database-roles.sh"
reconcile="$REPO/packaging/gateway/scripts/reconcile-database-roles.sh"
for role in chan_gateway_identity chan_gateway_profile; do
    grep -Fq "ALTER ROLE $role NOSUPERUSER NOCREATEDB NOCREATEROLE" "$prepare" \
        || die "$prepare does not constrain $role"
done
grep -Fq "Remove every role" "$prepare" \
    || die "$prepare does not remove application role memberships"
grep -Fq "public._sqlx_migrations" "$reconcile" \
    || die "$reconcile does not explicitly isolate sqlx history"
grep -Fq "chan_gateway_deployment_state" "$reconcile" \
    || die "$reconcile does not publish an exact readiness marker"
for table in devserver_user_policies devserver_fleet_policy identity_session_index; do
    grep -Fq "public.$table" "$reconcile" \
        || die "$reconcile does not inventory and grant $table"
    grep -Fq "public.$table" "$REPO/packaging/gateway/scripts/test-database-roles.sh" \
        || die "database role test does not exercise $table"
done
grep -Fq "application database role owns an object" "$prepare" \
    || die "$prepare does not reject app-owned database objects"
grep -Fq "application database role owns an object" "$reconcile" \
    || die "$reconcile does not reject app-owned database objects"
if grep -Eq 'GRANT .*ALL (TABLES|SEQUENCES)|ALTER DEFAULT PRIVILEGES.*GRANT' \
    "$prepare" "$reconcile"; then
    die "database role scripts contain a blanket or default grant"
fi

latest_migration=$(find "$REPO/gateway/migrations" -maxdepth 1 -name '*.sql' -printf '%f\n' \
    | sort | tail -n 1)
latest_migration=${latest_migration%%_*}
latest_migration=$((10#$latest_migration))
grep -Fqx "EXPECTED_SQLX_MIGRATION=$latest_migration" \
    "$migrate_packaging/migrate.env" \
    || die "migrate.env does not pin the latest sqlx migration"

gateway_version=$(sed -n 's/^version = "\([^"]*\)"$/\1/p' \
    "$REPO/gateway/Cargo.toml" | head -n 1)
grep -Fq "chan-gateway-identity (= ${gateway_version}-1)" \
    "$REPO/gateway/crates/profile/Cargo.toml" \
    || die "profile package does not require the same-version identity migrator"

mapfile -t admission_keys < <("$REPO/packaging/gateway/scripts/generate-admission-keypair.py")
[[ ${#admission_keys[@]} -eq 2 ]] \
    || die "admission key helper did not return a keypair"
for admission_key in "${admission_keys[@]}"; do
    [[ "$admission_key" =~ ^[A-Za-z0-9_-]{43}$ ]] \
        || die "admission key helper returned a non-canonical key"
done

provision="$REPO/packaging/sdme/chan-devserver-provision.sh"
grep -Fq 'container already belongs to trust-domain user' "$provision" \
    || die "sdme provisioner does not refuse a second trust-domain user"
if grep -Eq 'NOPASSWD|adduser .* sudo|apt-get .* sudo' "$provision"; then
    die "sdme provisioner still grants or installs sudo"
fi

# Exercise both second-tenant refusal paths without requiring a privileged
# container. Only the state root and id/getent lookups are redirected.
mkdir -p "$WORK/bin" "$WORK/state" "$WORK/home/alice"
sed "s|STATE_DIR=/var/lib/chan-devserver|STATE_DIR=$WORK/state|" \
    "$provision" > "$WORK/provision.sh"
chmod +x "$WORK/provision.sh"
cat > "$WORK/bin/id" <<'EOF'
#!/usr/bin/env bash
if [[ ${1:-} == -u && $# -eq 1 ]]; then
    printf '0\n'
elif [[ ${1:-} == -u ]]; then
    printf '%s\n' "${MOCK_TARGET_UID:-1001}"
elif [[ ${1:-} == -g ]]; then
    printf '%s\n' "${MOCK_TARGET_GID:-1001}"
elif [[ ${1:-} == -G ]]; then
    printf '%s\n' "${MOCK_TARGET_GROUPS:-${MOCK_TARGET_GID:-1001}}"
else
    exit 2
fi
EOF
cat > "$WORK/bin/getent" <<EOF
#!/usr/bin/env bash
if [[ \${1:-} == passwd && \$# -eq 1 ]]; then
    printf 'alice:x:1001:1001::%s:/bin/bash\\n' '$WORK/home/alice'
elif [[ \${1:-} == passwd ]]; then
    printf '%s:x:1001:1001::%s/%s:/bin/bash\\n' "\${2:-}" '$WORK/home' "\${2:-}"
else
    exit 2
fi
EOF
cat > "$WORK/bin/install" <<'EOF'
#!/usr/bin/env bash
destination=${!#}
mkdir -p "$destination"
EOF
chmod +x "$WORK/bin/id" "$WORK/bin/getent" "$WORK/bin/install"

valid_pat=chan_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA

if PATH="$WORK/bin:$PATH" "$WORK/provision.sh" \
    --user root --token "$valid_pat" 2> "$WORK/root-refusal.err"; then
    die "sdme provisioner accepted root"
fi
grep -Fq 'root cannot own a chan devserver' "$WORK/root-refusal.err" \
    || die "root refusal returned the wrong error"

rm -f "$WORK/state/owner"
if PATH="$WORK/bin:$PATH" "$WORK/provision.sh" \
    --user existing --token "$valid_pat" 2> "$WORK/preexisting-refusal.err"; then
    die "sdme provisioner accepted a preexisting first-run account"
fi
grep -Fq "refusing preexisting user 'existing' on an unowned container" \
    "$WORK/preexisting-refusal.err" \
    || die "preexisting-account refusal returned the wrong error"

printf 'zeroalias\n' > "$WORK/state/owner"
if MOCK_TARGET_UID=0 PATH="$WORK/bin:$PATH" "$WORK/provision.sh" \
    --user zeroalias --token "$valid_pat" 2> "$WORK/uid-zero-refusal.err"; then
    die "sdme provisioner accepted a uid-0 alias"
fi
grep -Fq "user 'zeroalias' resolves to uid 0" "$WORK/uid-zero-refusal.err" \
    || die "uid-0 refusal returned the wrong error"

printf 'grouped\n' > "$WORK/state/owner"
if MOCK_TARGET_GROUPS='1001 27' PATH="$WORK/bin:$PATH" "$WORK/provision.sh" \
    --user grouped --token "$valid_pat" 2> "$WORK/group-refusal.err"; then
    die "sdme provisioner accepted a supplemental group"
fi
grep -Fq "unsafe supplemental group id 27" "$WORK/group-refusal.err" \
    || die "supplemental-group refusal returned the wrong error"

# A prior successful owner pin is the only path that may reuse an account.
# Stop this harness immediately after the admission checks so it does not need
# a real user manager or network access.
sed '/^# Make the user.s interactive shells/i exit 0' \
    "$WORK/provision.sh" > "$WORK/provision-preflight.sh"
chmod +x "$WORK/provision-preflight.sh"
printf 'bob\n' > "$WORK/state/owner"
PATH="$WORK/bin:$PATH" "$WORK/provision-preflight.sh" \
    --user bob --token "$valid_pat" \
    || die "sdme provisioner rejected its pinned account on rerun"

printf 'alice\n' > "$WORK/state/owner"
if PATH="$WORK/bin:$PATH" "$WORK/provision.sh" \
    --user bob --token "$valid_pat" 2> "$WORK/owner-refusal.err"; then
    die "sdme provisioner accepted a second state owner"
fi
grep -Fq "container already belongs to trust-domain user 'alice'" \
    "$WORK/owner-refusal.err" || die "state-owner refusal returned the wrong error"

rm -f "$WORK/state/owner"
mkdir -p "$WORK/home/alice/.config/systemd/user"
: > "$WORK/home/alice/.config/systemd/user/chan-devserver.service"
if PATH="$WORK/bin:$PATH" "$WORK/provision.sh" \
    --user bob --token "$valid_pat" 2> "$WORK/legacy-refusal.err"; then
    die "sdme provisioner accepted a second legacy managed user"
fi
grep -Fq "existing managed devserver belongs to 'alice'" \
    "$WORK/legacy-refusal.err" || die "legacy-user refusal returned the wrong error"

printf 'PASS: gateway package and sdme isolation contracts\n'
