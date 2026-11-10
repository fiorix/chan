#!/usr/bin/env bash
# test-packaging-isolation.sh -- behavioural checks for gateway package
# identity and env-file ownership, and for the sdme provisioner's tenant
# refusals.
#
# It runs the real package postinst scripts against a scratch root in all 120
# install orders of the five account-plane packages, with the WireGuard
# agent's package at each of the six positions, drives the database
# readiness check, configure.sh's refusals and whole runs of it against a
# scratch root, the postinst conffile
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

# WireGuard enrollment answers. The keys are canonical base64 for 32 bytes
# and hold `+`, `/` and the `=` pad, the characters a written list carries
# unescaped beside its own `=`, `@` and `;`.
key_a='++++++++++++++++++++++++++++++++++++++++//4='
key_b='P//wP//wP//wP//wP//wP//wP//wP//wP//wP//wAH8='
# The postinst getent finds every user, so the agent's package counts as
# installed and its interface prompt takes the last answer here.
wg_answers="$pg_answers"$'https://gw.example.test\nhttps://proxy.example.test\n\np1\n\n\n'
p1_entry="p1=$key_a@p1.proxy.example.test:51820"
p2_entry="p2=$key_b@p2.proxy.example.test:51820"
# Padded base64 of the right length for one byte too few, and the Kelvin
# sign, a letter outside ASCII whose lowercase form is the ASCII k.
key_31_bytes="$(printf 'A%.0s' {1..42})=="
kelvin=$'\xe2\x84\xaa'
while IFS='|' read -r name ingresses message; do
    configure_refusal "WireGuard ingresses, $name" "$wg_answers$ingresses"$'\n' \
        "$message" || configure_failures=$((configure_failures + 1))
done <<EOF
entry without an endpoint|p1=$key_a|must be id=public_key@endpoint entries
entry without a key|p1@p1.proxy.example.test:51820|must be id=public_key@endpoint entries
trailing separator|$p1_entry;|must be id=public_key@endpoint entries
letter outside ASCII|p1=$key_a@${kelvin}1.proxy.example.test:51820|must be id=public_key@endpoint entries
uppercase id|P1=$key_a@p1.proxy.example.test:51820|entry 1: the id must be a proxy node id
id of two labels|p1.proxy=$key_a@p1.proxy.example.test:51820|entry 1: the id must be a proxy node id
short key|p1=${key_a:1}@p1.proxy.example.test:51820|entry 1: the public key must be padded base64 for 32 bytes
key with stray trailing bits|p1=${key_a%4=}5=@p1.proxy.example.test:51820|entry 1: the public key must be padded base64 for 32 bytes
key of 31 bytes|p1=$key_31_bytes@p1.proxy.example.test:51820|entry 1: the public key must be padded base64 for 32 bytes
endpoint without a port|p1=$key_a@p1.proxy.example.test|entry 1: the endpoint must be host:port
endpoint port zero|p1=$key_a@p1.proxy.example.test:0|entry 1: the endpoint must be host:port
endpoint port above 65535|p1=$key_a@p1.proxy.example.test:65536|entry 1: the endpoint must be host:port
unbracketed IPv6 endpoint|p1=$key_a@2001:db8::2:51820|entry 1: the endpoint must be host:port
scoped IPv6 endpoint|p1=$key_a@[fe80::1%eth0]:51820|entry 1: the endpoint must be host:port
endpoint with a user|p1=$key_a@wg@p1.proxy.example.test:51820|entry 1: the endpoint must be host:port
second entry's endpoint|$p1_entry;p2=$key_b@p2.proxy.example.test|entry 2: the endpoint must be host:port
repeated id|$p1_entry;p1=$key_b@p2.proxy.example.test:51820|entry 2: the id p1 is listed twice
EOF
configure_refusal 'WireGuard ingresses under an address-literal proxy namespace' \
    "$pg_answers"$'https://gw.example.test\nhttps://192.0.2.7:8443\n\np1\n\n\n'"p1=$key_a@192.0.2.7:51820"$'\n' \
    'Proxy namespace origin needs a DNS name' || configure_failures=$((configure_failures + 1))
configure_refusal 'WireGuard ingress that carries the gateway host' \
    "$pg_answers"$'https://gw.p1.proxy.example.test\nhttps://proxy.example.test\n\np1\n\n\n'"$p1_entry"$'\n' \
    "entry 1: Gateway public origin's host must not be" || configure_failures=$((configure_failures + 1))
for invalid_pool in 10.7.0.0/31 10.7.0.5/24 10.7.0.0 10.7.0.0/255.255.255.0 fd00:7::/64 pool \
    0.0.0.0/0 10.0.0.0/7 224.0.0.0/4; do
    configure_refusal "WireGuard address pool [$invalid_pool]" \
        "$wg_answers$p1_entry"$'\n'"$invalid_pool"$'\n' \
        'WireGuard address pool must be an IPv4 network from /8 to /30' \
        || configure_failures=$((configure_failures + 1))
done
# A pool that reaches into a block no tunnel address comes from, whole or in
# part, at both ends of each block.
while read -r invalid_pool block; do
    configure_refusal "WireGuard address pool [$invalid_pool]" \
        "$wg_answers$p1_entry"$'\n'"$invalid_pool"$'\n' \
        "WireGuard address pool must not overlap $block" \
        || configure_failures=$((configure_failures + 1))
done <<'EOF'
0.0.0.0/24 0.0.0.0/8, this network and the unspecified address
0.255.255.252/30 0.0.0.0/8, this network and the unspecified address
127.0.0.0/8 127.0.0.0/8, the loopback addresses
127.255.255.252/30 127.0.0.0/8, the loopback addresses
169.254.0.0/16 169.254.0.0/16, the link-local addresses
169.0.0.0/8 169.254.0.0/16, the link-local addresses
224.0.0.0/24 224.0.0.0/4, the multicast addresses
239.255.255.252/30 224.0.0.0/4, the multicast addresses
240.0.0.0/24 240.0.0.0/4, the reserved addresses and the broadcast address
255.255.255.252/30 240.0.0.0/4, the reserved addresses and the broadcast address
EOF
[[ $configure_failures -eq 0 ]] || die "$configure_failures configure WireGuard refusals failed"

# The pools beside those blocks and at the /8 bound are taken, and give the
# tunnel address, its /32 and the interface address. The copy stops after
# the pool check.
sed '/^    WG_INTERFACE_ADDRESS=\${WG_POOL\[3\]}$/a\
    printf "%s|%s|%s|%s\\n" "$WG_POOL_V4" "$WG_INGRESS_ADDRESS" "$WG_ALLOWED_IPS" "$WG_INTERFACE_ADDRESS"\
    exit 0' "$WORK/configure.sh" > "$WORK/configure-pool.sh"
grep -Fq 'exit 0' "$WORK/configure-pool.sh" || die "the pool check copy does not stop after the pool"
for valid_pool in 10.0.0.0/8 1.0.0.0/8 126.255.255.252/30 128.0.0.0/8 169.253.0.0/16 \
    169.255.0.0/16 223.255.255.252/30 100.64.0.0/10 172.16.0.0/12 192.168.0.0/16 10.7.0.0/24; do
    address=$(python3 -c 'import ipaddress, sys; print(ipaddress.IPv4Network(sys.argv[1]).network_address + 1)' "$valid_pool")
    printf '%s' "$wg_answers$p1_entry"$'\n'"$valid_pool"$'\n' \
        | PATH="$WORK/postinst-bin:$PATH" bash "$WORK/configure-pool.sh" \
        > "$WORK/configure.out" 2> "$WORK/configure.err" \
        || die "configure refused the WireGuard address pool $valid_pool: $(cat "$WORK/configure.err")"
    grep -Fqx "$valid_pool|$address|$address/32|$address/${valid_pool#*/}" "$WORK/configure.out" \
        || die "configure derived the wrong addresses from $valid_pool: $(tail -n 1 "$WORK/configure.out")"
done
printf 'PASS configure: pools beside the refused blocks and at the /8 bound are taken\n'

# Whole runs, against a scratch root of their own so the refusals above keep
# proving they wrote nothing. Database role preparation is a stand-in that
# takes what the real script requires; every other step is configure.sh's.
full_root="$WORK/full-root/etc/chan-gateway"
mkdir -p "$WORK/configure-full" "$WORK/no-agent-bin"
sed -e '/^if \[\[ \$EUID -ne 0 \]\]; then/,/^fi$/d' \
    -e "s|/etc/chan-gateway|$full_root|g" \
    "$REPO/packaging/gateway/scripts/configure.sh" > "$WORK/configure-full/configure.sh"
cat > "$WORK/configure-full/prepare-database-roles.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?}" "${IDENTITY_DATABASE_PASSWORD:?}" "${PROFILE_DATABASE_PASSWORD:?}"
EOF
chmod +x "$WORK/configure-full/prepare-database-roles.sh"
cp "$REPO/packaging/gateway/scripts/generate-admission-keypair.py" "$WORK/configure-full/"
# A host without the agent's package: every service user but the agent's.
cp "$WORK/postinst-bin/chown" "$WORK/postinst-bin/install" "$WORK/no-agent-bin/"
cat > "$WORK/no-agent-bin/getent" <<'EOF'
#!/usr/bin/env bash
[[ ${2:-} != chan-gateway-wireguard-agent ]]
EOF
chmod +x "$WORK/no-agent-bin/getent"

configure_run() {
    local name=$1 bin=$2 answers=$3
    printf '%s' "$answers" | PATH="$bin:$PATH" bash "$WORK/configure-full/configure.sh" \
        > "$WORK/configure-full.out" 2> "$WORK/configure-full.err" \
        || die "configure run failed ($name): $(cat "$WORK/configure-full.err")"
}

# bash prints a read prompt only when its input is a terminal, so a run whose
# prompts are asserted runs on a pseudo-terminal, which input is not echoed
# to. Its output and its errors arrive as one stream. A run that waits ten
# seconds for an answer it was not given is stopped and exits 124.
cat > "$WORK/tty-run.py" <<'EOF'
import os
import select
import subprocess
import sys
import termios

answers = sys.stdin.buffer.read()
primary, secondary = os.openpty()
attrs = termios.tcgetattr(secondary)
attrs[3] &= ~termios.ECHO
termios.tcsetattr(secondary, termios.TCSANOW, attrs)
child = subprocess.Popen(
    sys.argv[1:], stdin=secondary, stdout=secondary, stderr=secondary, start_new_session=True
)
os.close(secondary)
output = bytearray()
stalled = False
while True:
    readable, writable, _ = select.select([primary], [primary] if answers else [], [], 10)
    if not readable and not writable:
        stalled = True
        child.kill()
        break
    if writable:
        try:
            answers = answers[os.write(primary, answers[:256]):]
        except OSError:
            answers = b""
    if readable:
        try:
            chunk = os.read(primary, 4096)
        except OSError:
            break
        if not chunk:
            break
        output += chunk
status = child.wait()
sys.stdout.buffer.write(bytes(output).replace(b"\r\n", b"\n"))
if stalled:
    print("tty-run: the run waited for an answer", file=sys.stderr)
    sys.exit(124)
sys.exit(status if status >= 0 else 128 - status)
EOF

configure_tty_run() {
    local bin=$1 answers=$2
    printf '%s' "$answers" | PATH="$bin:$PATH" \
        python3 "$WORK/tty-run.py" bash "$WORK/configure-full/configure.sh" \
        > "$WORK/configure-full.out" 2> "$WORK/configure-full.err"
}

# The value an env file assigns to a name; every line that assigns it.
env_value() {
    sed -n "s/^[[:space:]]*$2=//p" "$1"
}

# The WireGuard names an env file assigns, in file order, each followed by a
# space. A name assigned twice is listed twice, and a commented line is no
# assignment.
wireguard_names() {
    sed -n 's/^[[:space:]]*\(WIREGUARD_[A-Z0-9_]*\)=.*/\1/p' "$1" | tr '\n' ' '
}

require_env() {
    local file=$1 name=$2 expected=$3 actual
    actual=$(env_value "$file" "$name")
    [[ "$actual" == "$expected" ]] \
        || die "$file assigns $name [$actual], expected [$expected]"
}

require_wireguard_names() {
    local file=$1 expected=$2 actual
    actual=$(wireguard_names "$file")
    [[ "$actual" == "$expected" ]] \
        || die "$file assigns the WireGuard names [$actual], expected [$expected]"
}

require_output() {
    grep -Fq -- "$1" "$WORK/configure-full.out" \
        || die "configure run did not print: $1"
}

refute_output() {
    local status=0
    grep -Fq -- "$1" "$WORK/configure-full.out" || status=$?
    [[ $status -eq 1 ]] || die "configure run printed (or grep failed on): $1"
}

# Identity refuses to start with a single-ingress variable set, so no file a
# run leaves in place may name one, commented or not.
refute_single_ingress_names() {
    local status=0
    grep -En 'WIREGUARD_(HOST_ID|ENDPOINT|PUBLIC_KEY|HOSTS)([^A-Z_]|$)' "$full_root"/*.env \
        || status=$?
    [[ $status -eq 1 ]] || die "a configured env file names a single-ingress variable"
}

# One bearer, minted once: identity.env carries one line of it and the
# agent's file the same value.
require_one_agent_token() {
    agent_token=$(env_value "$full_root/identity.env" WIREGUARD_AGENT_TOKEN)
    [[ "$agent_token" =~ ^[0-9a-f]{64}$ ]] \
        || die "identity.env does not carry one generated WIREGUARD_AGENT_TOKEN: [$agent_token]"
    require_env "$full_root/wireguard-agent.env" WIREGUARD_AGENT_TOKEN "$agent_token"
}

full_answers="$pg_answers"$'https://gw.example.test\nhttps://proxy.example.test:8443\n\np1\n\n'
oauth_answers=$'github-client\ngithub-secret\n\n\n'
# How a run announces that the files it replaces have enrollment on, that
# the pool it writes is not the one they set, and the settings it drops.
replaced_enrollment='The configuration this run replaces has WireGuard enrollment on'
pool_changes='The pool changes from'
not_written='The files this run replaces set these WireGuard settings, which it does not'

# Two nodes, typed with spaces, an uppercase host and a bracketed IPv6
# endpoint, and a pool of the operator's own. The list is written without
# the spaces and otherwise as typed; the tunnel address and the one routed
# network follow from the pool, and profile gets the pool in the same run.
configure_run 'two ingresses' "$WORK/postinst-bin" \
    "$full_answers"$'wg0\n'" p1 = $key_a @ P1.proxy.example.test:51820 ; p2=$key_b@[2001:db8::2]:51821 "$'\n10.9.8.0/22\n'"$oauth_answers"
require_wireguard_names "$full_root/identity.env" \
    'WIREGUARD_AGENT_TOKEN WIREGUARD_INGRESSES WIREGUARD_INGRESS_ADDRESSES WIREGUARD_ALLOWED_IPS '
require_env "$full_root/identity.env" WIREGUARD_INGRESSES \
    "p1=$key_a@P1.proxy.example.test:51820;p2=$key_b@[2001:db8::2]:51821"
require_env "$full_root/identity.env" WIREGUARD_INGRESS_ADDRESSES 10.9.8.1
require_env "$full_root/identity.env" WIREGUARD_ALLOWED_IPS 10.9.8.1/32
require_wireguard_names "$full_root/profile.env" 'WIREGUARD_POOL_V4 '
require_env "$full_root/profile.env" WIREGUARD_POOL_V4 10.9.8.0/22
require_wireguard_names "$full_root/wireguard-agent.env" \
    'WIREGUARD_AGENT_TOKEN WIREGUARD_AGENT_HOST_ID WIREGUARD_INTERFACE '
require_env "$full_root/wireguard-agent.env" WIREGUARD_AGENT_HOST_ID p1
require_one_agent_token
first_agent_token=$agent_token
refute_single_ingress_names
require_output 'WireGuard enrollment is on for these nodes: p1 p2'
require_output 'Address = 10.9.8.1/22'
refute_output 'is not one of them'
refute_output 'configures WireGuard enrollment for one ingress'
refute_output "$replaced_enrollment"
refute_output "$pool_changes"
printf 'PASS configure: an ingress list enables identity and profile together, as typed less its spaces\n'

# A second run over a configuration that names one ingress in the four
# variables identity refuses, answered with an empty list. The run shows the
# lines it will not carry over, leaves enrollment off in both files, names
# none of the four, and keeps the replaced file as a backup. Its secrets are
# its own: the agent's bearer is a new value, again the same in both files.
# The first run's pool is still in profile.env, and a pool without a list is
# not enrollment: the run does not announce it as such.
cat > "$full_root/identity.env" <<EOF
WIREGUARD_AGENT_TOKEN=$first_agent_token
WIREGUARD_HOST_ID=wg1
  WIREGUARD_ENDPOINT=wg.example.test:51820
WIREGUARD_PUBLIC_KEY=$key_a
WIREGUARD_ALLOWED_IPS=10.7.0.1/32
WIREGUARD_HOSTS=proxy.example.test=10.7.0.1;*.proxy.example.test=10.7.0.1
EOF
configure_run 'empty list over one ingress' "$WORK/postinst-bin" \
    "$full_answers"$'wg0\n\n'"$oauth_answers"
require_output 'configures WireGuard enrollment for one ingress'
for shown in 'WIREGUARD_HOST_ID=wg1' 'WIREGUARD_ENDPOINT=wg.example.test:51820' \
    "WIREGUARD_PUBLIC_KEY=$key_a" \
    'WIREGUARD_HOSTS=proxy.example.test=10.7.0.1;*.proxy.example.test=10.7.0.1'; do
    grep -Fqx -- "    $shown" "$WORK/configure-full.out" \
        || die "configure run did not show the replaced line: $shown"
done
require_wireguard_names "$full_root/identity.env" 'WIREGUARD_AGENT_TOKEN '
require_wireguard_names "$full_root/profile.env" ''
refute_single_ingress_names
refute_output 'WireGuard enrollment is on'
refute_output "$replaced_enrollment"
backups=("$full_root"/identity.env.bak.*)
[[ ${#backups[@]} -eq 1 ]] && grep -Fqx 'WIREGUARD_HOST_ID=wg1' "${backups[0]}" \
    || die "the replaced identity.env was not kept as one backup"
require_one_agent_token
[[ "$agent_token" != "$first_agent_token" ]] \
    || die "a second run kept the first run's WIREGUARD_AGENT_TOKEN"
printf 'PASS configure: an empty list leaves enrollment off and no single-ingress variable behind\n'

# An existing file that only comments those variables out, or leaves one
# empty, configures nothing and is not announced. The same holds for the
# list: the file the last run wrote shows it as a commented example, and an
# empty value sets none. profile.env sets a pool all the same, which rows of
# an earlier enrollment may hold addresses in: it is the pool question's
# default, and a pool alone is not announced as enrollment. This node's agent
# is installed but its id is not in the list, which the run points out.
printf '%s\n' '# WIREGUARD_HOST_ID=p1' 'WIREGUARD_ENDPOINT=' 'WIREGUARD_HOSTS= ' \
    'WIREGUARD_INGRESSES= ' >> "$full_root/identity.env"
grep -q '^# WIREGUARD_INGRESSES=p1=' "$full_root/identity.env" \
    || die "the empty-list run left no commented WIREGUARD_INGRESSES example"
printf '%s\n' 'WIREGUARD_POOL_V4=10.9.8.0/22' >> "$full_root/profile.env"
configure_run 'list without this node' "$WORK/postinst-bin" \
    "$full_answers"$'wg0\n'"$p2_entry"$'\n\n'"$oauth_answers"
refute_output 'configures WireGuard enrollment for one ingress'
refute_output "$replaced_enrollment"
require_env "$full_root/profile.env" WIREGUARD_POOL_V4 10.9.8.0/22
require_env "$full_root/identity.env" WIREGUARD_INGRESS_ADDRESSES 10.9.8.1
refute_output "$pool_changes"
require_output 'WireGuard enrollment is on for these nodes: p2'
require_output "This node's id, p1, is not one of them"
refute_single_ingress_names
printf 'PASS configure: a list without this node says its agent is refused, on the pool profile.env sets\n'

# Runs over a configuration that has enrollment on. Every run writes the
# files whole from its own answers, so an empty list would turn enrollment
# off: the run says so before it asks, and shows the list as a line to answer
# with, as the list check writes it. The list is no default; the pool is the
# pool question's default, shown in its prompt, and a pool given in its
# place is announced with what it does. The planted list is a hand edit, in
# quotes, indented and with spaces, which a pasted line must not carry.
kept_list="$p1_entry;p2=$key_b@[2001:db8::2]:51821"
plant_enrollment() {
    cat > "$full_root/identity.env" <<EOF
WIREGUARD_AGENT_TOKEN=$agent_token
  WIREGUARD_INGRESSES=" p1 = $key_a @ p1.proxy.example.test:51820 ; p2=$key_b@[2001:db8::2]:51821 "
WIREGUARD_INGRESS_ADDRESSES=10.9.8.1
WIREGUARD_ALLOWED_IPS=10.9.8.1/32
EOF
    printf 'WIREGUARD_POOL_V4=%s\n' "$1" > "$full_root/profile.env"
}
require_replaced_enrollment() {
    require_output "$replaced_enrollment"
    require_output 'answer to the list below turns it off. To keep it, answer with this line:'
    require_output "The pool question offers the pool profile.env sets, $1."
}
# Every file under the scratch root and its digest: a refused run changes none.
root_digest() {
    find "$full_root" -type f -exec sha256sum {} + | sort
}

# An empty list: the run shows what the answer costs before it takes it,
# and the answer still turns enrollment off in both files.
plant_enrollment 10.9.8.0/22
configure_run 'empty list over an ingress list' "$WORK/postinst-bin" \
    "$full_answers"$'wg0\n\n'"$oauth_answers"
require_replaced_enrollment 10.9.8.0/22
shown_list=$(sed -n '/To keep it, answer with this line:$/{n;p;}' "$WORK/configure-full.out")
[[ -n $shown_list ]] || die "the enrollment notice showed no line to answer with"
require_wireguard_names "$full_root/identity.env" 'WIREGUARD_AGENT_TOKEN '
require_wireguard_names "$full_root/profile.env" ''
refute_output 'WireGuard enrollment is on for these nodes'
refute_output "$not_written"
printf 'PASS configure: an empty list over a configured one is announced and leaves enrollment off\n'

# The line shown, given back whole as the answer, and Enter at the pool: the
# list is written as the replaced file meant it and the pool does not
# change. The tunnel address and allowed IPs the replaced file sets are the
# ones the pool gives, so no setting is named as not written.
plant_enrollment 10.9.8.0/22
configure_tty_run "$WORK/postinst-bin" "$full_answers"$'wg0\n'"$shown_list"$'\n\n'"$oauth_answers" \
    || die "configure run failed (the shown line given back): $(cat "$WORK/configure-full.out" "$WORK/configure-full.err")"
require_replaced_enrollment 10.9.8.0/22
[[ $shown_list == "    $kept_list" ]] \
    || die "the enrollment notice showed [$shown_list], expected [    $kept_list]"
require_output 'WireGuard address pool [10.9.8.0/22]: '
require_env "$full_root/identity.env" WIREGUARD_INGRESSES "$kept_list"
require_env "$full_root/profile.env" WIREGUARD_POOL_V4 10.9.8.0/22
require_env "$full_root/identity.env" WIREGUARD_INGRESS_ADDRESSES 10.9.8.1
require_env "$full_root/identity.env" WIREGUARD_ALLOWED_IPS 10.9.8.1/32
require_output 'Address = 10.9.8.1/22'
refute_output "$pool_changes"
refute_output "$not_written"
require_output 'WireGuard enrollment is on for these nodes: p1 p2'
printf 'PASS configure: a rerun shows the replaced list as an answer it takes and keeps the pool on Enter\n'

# Another pool given at the same question is written, and the run says that
# enrolled keys keep their addresses and the interfaces change address.
plant_enrollment 10.9.8.0/22
configure_run 'a new pool over a replaced one' "$WORK/postinst-bin" \
    "$full_answers"$'wg0\n'"$kept_list"$'\n10.7.0.0/24\n'"$oauth_answers"
require_env "$full_root/profile.env" WIREGUARD_POOL_V4 10.7.0.0/24
require_env "$full_root/identity.env" WIREGUARD_INGRESS_ADDRESSES 10.7.0.1
require_output 'The pool changes from 10.9.8.0/22 to 10.7.0.0/24. Enrolled keys keep their addresses:'
require_output 'nothing moves them into the new pool. Each node'"'"'s interface takes the Address printed at the end.'
require_output 'Address = 10.7.0.1/24'
printf 'PASS configure: a new pool over a replaced one says what it does to enrolled keys\n'

# A replaced list the check refuses as it stands is shown as the file sets
# it, with the reason, and is not offered as a line to answer with.
plant_enrollment 10.9.8.0/22
printf 'WIREGUARD_INGRESSES=P1=%s@p1.proxy.example.test:51820\n' "$key_a" > "$full_root/identity.env"
configure_run 'a replaced list the check refuses' "$WORK/postinst-bin" \
    "$full_answers"$'wg0\n\n'"$oauth_answers"
require_output 'with a list'
require_output 'this run refuses (WireGuard ingress entry 1: the id must be a proxy node id, one lowercase DNS label):'
grep -Fqx -- "    P1=$key_a@p1.proxy.example.test:51820" "$WORK/configure-full.out" \
    || die "configure run did not show the refused list as identity.env sets it"
refute_output 'answer with this line:'
printf 'PASS configure: a replaced list the check refuses is shown with its reason\n'

# The WireGuard settings the run does not carry over are named, each by its
# file, with a pointer to the backups: the IPv6 pool, the reservations, the
# release grace, the keepalive, the agent's poll interval and wg binary,
# and a tunnel address and allowed networks the pool does not give. No
# secret is printed: the bearers, a look-alike name and a commented line
# hold a marker that must appear nowhere in the run's output.
marker=planted-secret-c0ffee
plant_enrollment 10.9.8.0/22
cat >> "$full_root/identity.env" <<EOF
WIREGUARD_AGENT_TOKEN=$marker
WIREGUARD_AGENT_TOKEN_NEXT=$marker
IDENTITY_INTERNAL_TOKEN=$marker
WIREGUARD_INGRESS_ADDRESSES=10.9.8.1,fd00:7::1
WIREGUARD_ALLOWED_IPS=10.9.8.1/32,fd00:7::1/128
WIREGUARD_PERSISTENT_KEEPALIVE='25'
EOF
cat >> "$full_root/profile.env" <<EOF
PROFILE_AUTH_TOKEN=$marker
WIREGUARD_POOL_V6=fd00:7::/64
WIREGUARD_POOL_RESERVED=10.9.8.10,fd00:7::10
WIREGUARD_RELEASE_GRACE_MINUTES=7
# WIREGUARD_RELEASE_GRACE_MINUTES=$marker
EOF
cat > "$full_root/wireguard-agent.env" <<EOF
WIREGUARD_AGENT_TOKEN=$marker
WIREGUARD_AGENT_POLL_SECS=9
WIREGUARD_WG_BIN=/usr/local/bin/wg
EOF
configure_run 'settings the run does not carry over' "$WORK/postinst-bin" \
    "$full_answers"$'wg0\n'"$kept_list"$'\n\n'"$oauth_answers"
for printed in "$WORK/configure-full.out" "$WORK/configure-full.err"; do
    if grep -Fq -- "$marker" "$printed"; then
        die "configure run printed a planted secret"
    fi
done
require_output "$not_written"
require_output 'carry over. Set them again by hand from the backup it keeps of each file,'
for shown in 'identity.env: WIREGUARD_INGRESS_ADDRESSES=10.9.8.1,fd00:7::1' \
    'identity.env: WIREGUARD_ALLOWED_IPS=10.9.8.1/32,fd00:7::1/128' \
    'identity.env: WIREGUARD_PERSISTENT_KEEPALIVE=25' \
    'profile.env: WIREGUARD_POOL_V6=fd00:7::/64' \
    'profile.env: WIREGUARD_POOL_RESERVED=10.9.8.10,fd00:7::10' \
    'profile.env: WIREGUARD_RELEASE_GRACE_MINUTES=7' \
    'wireguard-agent.env: WIREGUARD_AGENT_POLL_SECS=9' \
    'wireguard-agent.env: WIREGUARD_WG_BIN=/usr/local/bin/wg'; do
    grep -Fqx -- "    $shown" "$WORK/configure-full.out" \
        || die "configure run did not name the setting it does not carry over: $shown"
done
printf 'PASS configure: the settings a run does not carry over are named, and no secret is printed\n'

# A replaced pool the script refuses, here with host bits set, is no default:
# the run says so and asks without one, and Enter stops it before anything
# is written. A pool typed at that question is written.
plant_enrollment 10.9.8.5/22
digest_before=$(root_digest)
if configure_tty_run "$WORK/postinst-bin" "$full_answers"$'wg0\n'"$kept_list"$'\n\n'"$oauth_answers"; then
    die "configure accepted Enter at a pool question without a default"
fi
require_output 'profile.env sets the pool 10.9.8.5/22, which this run does not write:'
require_output 'This question has no default; an empty answer stops the run.'
# With no default pool to compare with, the tunnel address is named.
grep -Fqx -- '    identity.env: WIREGUARD_INGRESS_ADDRESSES=10.9.8.1' "$WORK/configure-full.out" \
    || die "configure run did not name the tunnel address without a default pool"
require_output 'WireGuard address pool: error: WireGuard address pool must be an IPv4 network'
refute_output 'WireGuard address pool ['
[[ $(root_digest) == "$digest_before" ]] \
    || die "a run refused at the pool question changed the configuration"
configure_run 'a pool typed over a refused one' "$WORK/postinst-bin" \
    "$full_answers"$'wg0\n'"$kept_list"$'\n10.9.8.0/22\n'"$oauth_answers"
require_env "$full_root/profile.env" WIREGUARD_POOL_V4 10.9.8.0/22
require_output 'The pool changes from 10.9.8.5/22 to 10.9.8.0/22.'
printf 'PASS configure: a replaced pool the script refuses is no default\n'

# A host without the agent's package, whose own node terminates no
# WireGuard: another node is the one ingress, on the default pool of a first
# run. No agent file is written, the run says what each node's agent needs,
# and a node that runs no agent is not told its agent is refused.
rm -rf "$WORK/full-root"
configure_tty_run "$WORK/no-agent-bin" "$full_answers$p2_entry"$'\n\n'"$oauth_answers" \
    || die "configure run failed (one ingress, no agent package): $(cat "$WORK/configure-full.out" "$WORK/configure-full.err")"
require_output 'WireGuard address pool [10.7.0.0/24]: '
require_wireguard_names "$full_root/identity.env" \
    'WIREGUARD_AGENT_TOKEN WIREGUARD_INGRESSES WIREGUARD_INGRESS_ADDRESSES WIREGUARD_ALLOWED_IPS '
require_env "$full_root/identity.env" WIREGUARD_INGRESSES "$p2_entry"
require_env "$full_root/identity.env" WIREGUARD_INGRESS_ADDRESSES 10.7.0.1
require_env "$full_root/identity.env" WIREGUARD_ALLOWED_IPS 10.7.0.1/32
require_env "$full_root/profile.env" WIREGUARD_POOL_V4 10.7.0.0/24
[[ ! -e "$full_root/wireguard-agent.env" ]] \
    || die "configure wrote wireguard-agent.env without the agent's package"
require_output "WIREGUARD_AGENT_HOST_ID to that node's id in WIREGUARD_INGRESSES."
require_output 'Address = 10.7.0.1/24'
refute_output 'is not one of them'
printf 'PASS configure: one ingress and the default pool, without the agent package\n'

# An existing env file that cannot be read stops the run before its first
# question, whichever file it is: identity.env and profile.env, which the
# run reads for its notices, and every file it copies to a backup. The run
# is on a terminal, where every question prints its prompt, and given the
# answers to the questions before the WireGuard ones: its whole output is
# the one error line. Root reads any file, so the case exists only for
# another user.
if [[ $EUID -ne 0 ]]; then
    printf '%s\n' 'WIREGUARD_INTERFACE=wg0' > "$full_root/wireguard-agent.env"
    for unreadable in domain migrate profile identity devserver-control devserver-proxy \
        wireguard-agent admin; do
        chmod 000 "$full_root/$unreadable.env"
        if configure_tty_run "$WORK/postinst-bin" "$full_answers"$'wg0\n'; then
            die "configure accepted an unreadable $unreadable.env"
        fi
        printed=$(cat "$WORK/configure-full.out")
        [[ $printed == "error: cannot read $full_root/$unreadable.env" ]] \
            || die "an unreadable $unreadable.env printed [$printed]$(cat "$WORK/configure-full.err")"
        chmod 0640 "$full_root/$unreadable.env"
        printf 'PASS configure: an unreadable %s.env is refused before the first question\n' "$unreadable"
    done
else
    printf 'SKIP configure: unreadable env files (root reads every file)\n'
fi

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
    --user root --token "$valid_pat" --tunnel-url https://proxy.example.test/v1/tunnel 2> "$WORK/root-refusal.err"; then
    die "sdme provisioner accepted root"
fi
grep -Fq 'root cannot own a chan devserver' "$WORK/root-refusal.err" \
    || die "root refusal returned the wrong error"

rm -f "$WORK/state/owner"
if PATH="$WORK/bin:$PATH" "$WORK/provision.sh" \
    --user existing --token "$valid_pat" --tunnel-url https://proxy.example.test/v1/tunnel 2> "$WORK/preexisting-refusal.err"; then
    die "sdme provisioner accepted a preexisting first-run account"
fi
grep -Fq "refusing preexisting user 'existing' on an unowned container" \
    "$WORK/preexisting-refusal.err" \
    || die "preexisting-account refusal returned the wrong error"

printf 'zeroalias\n' > "$WORK/state/owner"
if MOCK_TARGET_UID=0 PATH="$WORK/bin:$PATH" "$WORK/provision.sh" \
    --user zeroalias --token "$valid_pat" --tunnel-url https://proxy.example.test/v1/tunnel 2> "$WORK/uid-zero-refusal.err"; then
    die "sdme provisioner accepted a uid-0 alias"
fi
grep -Fq "user 'zeroalias' resolves to uid 0" "$WORK/uid-zero-refusal.err" \
    || die "uid-0 refusal returned the wrong error"

printf 'grouped\n' > "$WORK/state/owner"
if MOCK_TARGET_GROUPS='1001 27' PATH="$WORK/bin:$PATH" "$WORK/provision.sh" \
    --user grouped --token "$valid_pat" --tunnel-url https://proxy.example.test/v1/tunnel 2> "$WORK/group-refusal.err"; then
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
if PATH="$WORK/bin:$PATH" env -u CHAN_TUNNEL_URL -u CHAN_TUNNEL_TOKEN \
    "$WORK/provision-preflight.sh" --user bob --token "$valid_pat" < /dev/null \
    > "$WORK/url-refusal.out" 2> "$WORK/url-refusal.err"; then
    die "sdme provisioner accepted a token without a tunnel URL"
fi
grep -Fq -- '--tunnel-url' "$WORK/url-refusal.err" \
    && grep -Fq CHAN_TUNNEL_URL "$WORK/url-refusal.err" \
    || die "missing tunnel URL refusal returned the wrong error"
printf 'PASS provisioner: missing tunnel URL refused before admission\n'

PATH="$WORK/bin:$PATH" "$WORK/provision-preflight.sh" \
    --user bob --token "$valid_pat" --tunnel-url https://proxy.example.test/v1/tunnel \
    || die "sdme provisioner rejected its pinned account on rerun"

printf 'alice\n' > "$WORK/state/owner"
if PATH="$WORK/bin:$PATH" "$WORK/provision.sh" \
    --user bob --token "$valid_pat" --tunnel-url https://proxy.example.test/v1/tunnel 2> "$WORK/owner-refusal.err"; then
    die "sdme provisioner accepted a second state owner"
fi
grep -Fq "container already belongs to trust-domain user 'alice'" \
    "$WORK/owner-refusal.err" || die "state-owner refusal returned the wrong error"

rm -f "$WORK/state/owner"
mkdir -p "$WORK/home/alice/.config/systemd/user"
: > "$WORK/home/alice/.config/systemd/user/chan-devserver.service"
if PATH="$WORK/bin:$PATH" "$WORK/provision.sh" \
    --user bob --token "$valid_pat" --tunnel-url https://proxy.example.test/v1/tunnel 2> "$WORK/legacy-refusal.err"; then
    die "sdme provisioner accepted a second legacy managed user"
fi
grep -Fq "existing managed devserver belongs to 'alice'" \
    "$WORK/legacy-refusal.err" || die "legacy-user refusal returned the wrong error"

printf 'PASS: gateway package and sdme isolation contracts (behavioural)\n'
