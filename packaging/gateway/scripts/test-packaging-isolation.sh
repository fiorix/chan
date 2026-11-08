#!/usr/bin/env bash
# test-packaging-isolation.sh -- behavioural checks for gateway package
# identity and env-file ownership, and for the sdme provisioner's tenant
# refusals.
#
# It runs the real package postinst scripts against a scratch root in all 120
# install orders of the five account-plane packages, with the WireGuard
# agent's package at each of the six positions, drives the database
# readiness check, the postinst conffile
# refusals, the admission keypair helper, and every sdme provisioner refusal
# path against stubbed id/getent. That takes about half a minute, so it is not
# part of `make pre-push`; the static half, check-packaging-isolation.sh, is.
#
# Run it with `make gateway-packaging-isolation-test` (Linux, which also runs
# the static checks first) whenever a change touches a gateway postinst or
# packaging env file, packaging/gateway/scripts/configure.sh,
# check-database-ready.sh, generate-admission-keypair.py, or
# packaging/sdme/chan-devserver-provision.sh, and before cutting a release that
# carries such a change.

set -euo pipefail

REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)

die() {
    printf 'test-packaging-isolation: %s\n' "$*" >&2
    exit 1
}

services=(profile identity devserver-control devserver-proxy wireguard-agent)

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# A successful database reply keeps missing validation from passing merely
# because psql is unavailable or the fixture URL cannot connect.
mkdir -p "$WORK/readiness-bin"
cat > "$WORK/readiness-bin/psql" <<'EOF'
#!/bin/sh
printf 't\n'
EOF
chmod +x "$WORK/readiness-bin/psql"
readiness_check="$REPO/packaging/gateway/scripts/check-database-ready.sh"
for versions in \
    "0 1 EXPECTED_SQLX_MIGRATION must be positive" \
    "1 0 DATABASE_ROLE_POLICY_VERSION must be positive" \
    "auto 1 EXPECTED_SQLX_MIGRATION must be numeric" \
    "1 auto DATABASE_ROLE_POLICY_VERSION must be numeric"; do
    read -r expected policy message <<< "$versions"
    if PATH="$WORK/readiness-bin:$PATH" DATABASE_URL=unused \
        EXPECTED_SQLX_MIGRATION="$expected" \
        DATABASE_ROLE_POLICY_VERSION="$policy" \
        "$readiness_check" >/dev/null 2> "$WORK/readiness.err"; then
        die "database readiness accepted invalid versions: $expected $policy"
    fi
    [[ $(cat "$WORK/readiness.err") == "$message" ]] \
        || die "database readiness refusal returned the wrong error: $expected $policy"
done
PATH="$WORK/readiness-bin:$PATH" DATABASE_URL=unused \
    EXPECTED_SQLX_MIGRATION=1 DATABASE_ROLE_POLICY_VERSION=1 \
    "$readiness_check" \
    || die "database readiness rejected valid versions with a ready database"

mkdir -p "$WORK/postinst" "$WORK/postinst-bin"
packages=(admin profile identity devserver-control devserver-proxy)
for package in "${packages[@]}" wireguard-agent; do
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

# Refusals run before database preparation or any env-file write. The copy
# cannot find prepare-database-roles.sh even if a prompt accepts bad input.
sed -e '/^if \[\[ \$EUID -ne 0 \]\]; then/,/^fi$/d' \
    -e "s|/etc/chan-gateway|$WORK/configure-root/etc/chan-gateway|g" \
    "$REPO/packaging/gateway/scripts/configure.sh" > "$WORK/configure.sh"

configure_refusal() {
    local name=$1 answers=$2 message=$3
    if printf '%s' "$answers" | PATH="$WORK/postinst-bin:$PATH" bash "$WORK/configure.sh" \
        > "$WORK/configure.out" 2> "$WORK/configure.err"; then
        printf 'FAIL configure: %s was accepted\n' "$name" >&2
        return 1
    fi
    if ! grep -Fq "$message" "$WORK/configure.err"; then
        printf 'FAIL configure: %s returned the wrong error (expected %s)\n' "$name" "$message" >&2
        return 1
    fi
    if [[ -e "$WORK/configure-root/etc/chan-gateway" ]]; then
        printf 'FAIL configure: %s wrote configuration before refusing\n' "$name" >&2
        return 1
    fi
    printf 'PASS configure: %s refused before writes\n' "$name"
}

configure_failures=0
pg_answers=$'chan\nfixture-password\nchan_gateway\n'
for invalid_origin in '' 'https://gw.example.com/x' 'https://gw.example.com/' \
    'https://gw.example.com?q=1' 'https://gw.example.com#fragment' \
    'https://user@gw.example.com' 'ftp://gw.example.com' 'https://' \
    'https://bad host.example.com' 'https://gw.example.com:99999' \
    'https://gw.example.com?' 'https://gw.example.com#' 'https://[:::1]'; do
    configure_refusal "gateway origin [$invalid_origin]" "$pg_answers$invalid_origin"$'\n' \
        'Gateway public origin' || configure_failures=$((configure_failures + 1))
done
for invalid_origin in '' 'https://proxy.example.com/x'; do
    configure_refusal "proxy namespace [$invalid_origin]" \
        "$pg_answers"$'https://gw.example.com\n'"$invalid_origin"$'\n' \
        'Proxy namespace origin' || configure_failures=$((configure_failures + 1))
done
configure_refusal 'tunnel origin path' \
    "$pg_answers"$'https://gw.example.com\nhttps://proxy.example.com\nhttps://proxy.example.com/x\n' \
    'Tunnel ingress origin' || configure_failures=$((configure_failures + 1))
configure_refusal 'node origin path' \
    "$pg_answers"$'https://gw.example.com\nhttps://proxy.example.com\n\np1\nhttps://p1.proxy.example.com/x\n' \
    'This proxy node origin' || configure_failures=$((configure_failures + 1))
[[ $configure_failures -eq 0 ]] || die "$configure_failures configure origin refusals failed"

# Stop valid runs at the end of origin collection, before OAuth or secrets.
sed '/^PROXY_BASE_URL_TEMPLATE=/a\
printf "%s|%s|%s|%s\\n" "$ID_URL" "$PROXY_ORIGIN" "$TUNNEL_ORIGIN" "$PROXY_BASE_URL"\
exit 0' "$WORK/configure.sh" > "$WORK/configure-origins.sh"
for scheme in https http; do
    origin_answers="$pg_answers$scheme://gw.example.test:8443"$'\n'"$scheme://proxy.example.test:8443"$'\n\np1\n\n'
    printf '%s' "$origin_answers" | PATH="$WORK/postinst-bin:$PATH" bash "$WORK/configure-origins.sh" \
        > "$WORK/configure.out" 2> "$WORK/configure.err" \
        || die "configure rejected valid $scheme origins"
    grep -Fqx "$scheme://gw.example.test:8443|$scheme://proxy.example.test:8443|$scheme://proxy.example.test:8443|$scheme://p1.proxy.example.test:8443" \
        "$WORK/configure.out" || die "configure derived the wrong $scheme origins"
done
printf 'PASS configure: explicit origins and derived defaults preserve scheme and port\n'

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

# Five nested loops cover all 120 install orders of the five account-plane
# packages. Distinct package names make an order a permutation; repeated
# choices are skipped. The WireGuard agent's package joins each order at a
# rotating position, first through last, so it runs at each of the six
# positions in 20 orders: every postinst reapplies the same shared state, so
# where the agent's runs relative to the others is what an order can change,
# and all 720 orders of six would take about six times as long.
orders=0
declare -A agent_positions=()
for a in "${packages[@]}"; do
    for b in "${packages[@]}"; do
        [[ "$b" != "$a" ]] || continue
        for c in "${packages[@]}"; do
            [[ "$c" != "$a" && "$c" != "$b" ]] || continue
            for d in "${packages[@]}"; do
                [[ "$d" != "$a" && "$d" != "$b" && "$d" != "$c" ]] || continue
                for e in "${packages[@]}"; do
                    [[ "$e" != "$a" && "$e" != "$b" && "$e" != "$c" && "$e" != "$d" ]] || continue
                    order=("$a" "$b" "$c" "$d" "$e")
                    position=$((orders % 6))
                    run_package_order "${order[@]:0:position}" wireguard-agent "${order[@]:position}"
                    agent_positions[$position]=$((${agent_positions[$position]:-0} + 1))
                    orders=$((orders + 1))
                done
            done
        done
    done
done
[[ $orders -eq 120 ]] || die "ran $orders install orders, expected 120"
for position in 0 1 2 3 4 5; do
    [[ ${agent_positions[$position]:-0} -eq 20 ]] \
        || die "the WireGuard agent's postinst ran at position $position in ${agent_positions[$position]:-0} orders, expected 20"
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

mapfile -t admission_keys < <("$REPO/packaging/gateway/scripts/generate-admission-keypair.py")
[[ ${#admission_keys[@]} -eq 2 ]] \
    || die "admission key helper did not return a keypair"
for admission_key in "${admission_keys[@]}"; do
    [[ "$admission_key" =~ ^[A-Za-z0-9_-]{43}$ ]] \
        || die "admission key helper returned a non-canonical key"
done

provision="$REPO/packaging/sdme/chan-devserver-provision.sh"

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

printf 'PASS: gateway package and sdme isolation contracts (behavioural)\n'
