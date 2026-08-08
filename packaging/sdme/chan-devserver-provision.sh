#!/usr/bin/env bash
# chan-devserver-provision -- baked into the chan-devserver rootfs (see
# chan-devserver.sdme) at /usr/local/bin. Run it ONCE inside a booted container
# to stand up one tunnel-publishing `chan devserver` as a lingering systemd
# --user service. One container is one externally shared trust domain; a second
# Unix user is refused instead of pretending the shared kernel is isolation.
#
# The rootfs ships base tools (curl, ca-certificates, dbus-user-session, dialog)
# but NOT `chan`. This script installs the released `chan` per-user via
# https://chan.app/install.sh into ~/.local/bin (no root, no PPA; honors
# http(s)_proxy), then does the per-tenant part that cannot be baked because it
# carries a secret: it creates a regular user, turns on linger so their user
# manager runs with nobody logged in, writes
# ~/.config/systemd/user/chan-devserver.service carrying the CHAN_TUNNEL_TOKEN
# (which flips the devserver into tunnel mode), and enables + starts it.
# Re-running is idempotent: it reuses an already-installed ~/.local/bin/chan,
# rewrites the unit with the current token, and restarts.
#
# Usage:
#   chan-devserver-provision [--user NAME] [--token chan_pat_...] [--tunnel-url URL]
#
# Flags win over env; when stdin is a terminal, `dialog` prompts for the token
# if it is still unset (reach this via `sdme join`). Non-interactively (e.g.
# `sdme exec`), every required value must arrive by flag or env, or the script
# errors instead of hanging.
#
#   --user NAME        Linux user to own the service   (env CHAN_DEVSERVER_USER,
#                      default: devserver)
#   --token TOKEN      chan_pat_* PAT from gw.chan.app  (env CHAN_TUNNEL_TOKEN)
#   --tunnel-url URL   override the gateway endpoint     (env CHAN_TUNNEL_URL;
#                      default: chan's built-in https://usr.chan.app/v1/tunnel)
#
# The published host is resolved backend-side from the token, so it is keyed by
# the token owner's handle -- {handle}--{disc}.{proxy}.usr.chan.app --
# independent of --user.

set -euo pipefail

die() { printf 'chan-devserver-provision: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '/^# Usage:/,/^# The published host/p' "$0" | sed 's/^# \{0,1\}//'
}

# Emit `export VAR='val'; ` for each proxy var that is set (single-quote-escaped)
# so they survive `su`'s environment reset when the chan install runs as the
# user. Some environments require an outbound proxy to reach chan.app; curl reads
# these from the environment. set -u safe via ${VAR-}.
proxy_exports() {
  for _v in http_proxy https_proxy no_proxy all_proxy \
            HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY; do
    eval "_val=\${$_v-}"
    [ -n "${_val:-}" ] || continue
    _esc=$(printf '%s' "$_val" | sed "s/'/'\\\\''/g")
    printf "export %s='%s'; " "$_v" "$_esc"
  done
}

USER_NAME="${CHAN_DEVSERVER_USER:-devserver}"
TOKEN="${CHAN_TUNNEL_TOKEN:-}"
TUNNEL_URL="${CHAN_TUNNEL_URL:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --user)         USER_NAME="${2:?--user needs a value}"; shift 2 ;;
    --user=*)       USER_NAME="${1#*=}"; shift ;;
    --token)        TOKEN="${2:?--token needs a value}"; shift 2 ;;
    --token=*)      TOKEN="${1#*=}"; shift ;;
    --tunnel-url)   TUNNEL_URL="${2:?--tunnel-url needs a value}"; shift 2 ;;
    --tunnel-url=*) TUNNEL_URL="${1#*=}"; shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              die "unknown argument: $1 (try --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "must run as root (it creates a user and enables linger)"

# dialog fills the token if it is still unset, but only with a real terminal.
if [ -z "$TOKEN" ] && [ -t 0 ] && command -v dialog >/dev/null 2>&1; then
  TOKEN="$(dialog --stdout --insecure --passwordbox \
    "chan_pat_ tunnel token for user '$USER_NAME' (from gw.chan.app):" 8 64)" \
    || die "cancelled"
  clear 2>/dev/null || true
fi

[ -n "$USER_NAME" ] || die "no --user / CHAN_DEVSERVER_USER"
[ -n "$TOKEN" ]     || die "no --token / CHAN_TUNNEL_TOKEN (and no terminal for a dialog prompt)"
[[ "$USER_NAME" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] \
  || die "user must match [a-z_][a-z0-9_-]{0,31}"
[[ "$USER_NAME" != root ]] || die "root cannot own a chan devserver"
[[ "$TOKEN" =~ ^chan_pat_[A-Za-z0-9_-]{43}$ ]] \
  || die "token does not have the chan_pat_ base64url shape"

# A grant reaches an interactive shell as this user. Pin the container to that
# one trust domain before creating anything the new user could influence.
STATE_DIR=/var/lib/chan-devserver
OWNER_FILE=$STATE_DIR/owner
while IFS=: read -r managed_user _ _ _ _ managed_home _; do
  managed_unit=$managed_home/.config/systemd/user/chan-devserver.service
  if [ -f "$managed_unit" ] && [ "$managed_user" != "$USER_NAME" ]; then
    die "existing managed devserver belongs to '$managed_user'; use a separate container for '$USER_NAME'"
  fi
done < <(getent passwd)

PINNED_USER=""
if [ -f "$OWNER_FILE" ]; then
  PINNED_USER=$(sed -n '1p' "$OWNER_FILE")
  [ "$PINNED_USER" = "$USER_NAME" ] \
    || die "container already belongs to trust-domain user '$PINNED_USER'; use a separate container for '$USER_NAME'"
fi

# 1. The user. systemd --user refuses to run for root, so this must be a
#    regular login user. The running devserver hands users this shell, but it
#    deliberately carries no sudo or other route to sibling or host secrets.
if id -u "$USER_NAME" >/dev/null 2>&1; then
  [ "$PINNED_USER" = "$USER_NAME" ] \
    || die "refusing preexisting user '$USER_NAME' on an unowned container"
else
  [ -z "$PINNED_USER" ] \
    || die "pinned user '$USER_NAME' is missing from the account database"
  useradd -m -s /bin/bash "$USER_NAME"
fi
UID_N="$(id -u "$USER_NAME")"
GID_N="$(id -g "$USER_NAME")"
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
[ -n "$HOME_DIR" ] || die "no home directory for $USER_NAME"
[ "$UID_N" -ne 0 ] || die "user '$USER_NAME' resolves to uid 0"
[ "$GID_N" -ne 0 ] || die "user '$USER_NAME' resolves to gid 0"

# An interactive workspace shell inherits every supplementary group. Refuse all
# of them instead of maintaining a brittle privileged-group denylist.
for group_id in $(id -G "$USER_NAME"); do
  [ "$group_id" = "$GID_N" ] \
    || die "user '$USER_NAME' has unsafe supplemental group id $group_id"
done
[ ! -e "/etc/sudoers.d/chan-devserver-$USER_NAME" ] \
  || die "user '$USER_NAME' has a legacy sudoers grant"

# Record ownership only after the requested OS identity has passed every
# privilege check. A rejected root alias or group-bearing user cannot pin state.
install -d -m 0700 -o root -g root "$STATE_DIR"
if [ -z "$PINNED_USER" ]; then
  (umask 077; printf '%s\n' "$USER_NAME" > "$OWNER_FILE")
  chown root:root "$OWNER_FILE"
fi

# Make the user's interactive shells usable out of the box: ~/.local/bin on
# PATH, and the user-session env so `systemctl --user` works without the caller
# exporting it. The devserver-spawned shell and a plain `su` get no
# login session, so XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS are otherwise
# unset; :=default only fills them when a real login session has not. The stock
# ~/.profile also adds ~/.local/bin for LOGIN shells once the dir exists.
# Both path components are named explicitly: `install -d a/b` applies the
# owner/mode only to the final component and leaves the intermediate `a`
# root-owned with the umask default, which would make ~/.local unwritable
# by the user (breaking `chan upgrade` and ~/.local/{state,share}).
install -d -o "$USER_NAME" -g "$USER_NAME" -m 755 \
  "$HOME_DIR/.local" "$HOME_DIR/.local/bin"
BASHRC="$HOME_DIR/.bashrc"
if [ ! -e "$BASHRC" ] || ! grep -qF 'chan-devserver: shell setup' "$BASHRC"; then
  cat >> "$BASHRC" <<'EOF'

# chan-devserver: shell setup (PATH + user-session env for systemctl --user)
: "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; export XDG_RUNTIME_DIR
: "${DBUS_SESSION_BUS_ADDRESS:=unix:path=${XDG_RUNTIME_DIR}/bus}"; export DBUS_SESSION_BUS_ADDRESS
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
EOF
  chown "$USER_NAME:$USER_NAME" "$BASHRC"
fi

# 2. chan itself, installed FOR THE USER (no root, no PPA). install.sh defaults
#    to PREFIX=$HOME/.local, so running it as the user drops chan + the cs
#    symlink in ~/.local/bin. su sets HOME to the user's, and proxy_exports
#    forwards any http(s)_proxy into the piped shell (curl reads it). Skip when
#    already installed so a re-run for a new token does not refetch; the user
#    owns the binary, so `chan upgrade` works for them later without root.
CHAN_BIN="$HOME_DIR/.local/bin/chan"
if [ ! -x "$CHAN_BIN" ]; then
  su -s /bin/sh "$USER_NAME" -c \
    "$(proxy_exports)curl -fsSL https://chan.app/install.sh | sh" \
    || die "installing chan via https://chan.app/install.sh failed (proxy/network?)"
  [ -x "$CHAN_BIN" ] || die "chan install did not produce $CHAN_BIN"
fi

# 3. Linger: start user@$UID_N.service now and on every boot, so the user
#    manager (and its /run/user/$UID_N D-Bus socket) exists with nobody
#    logged in -- the whole point of a headless container.
loginctl enable-linger "$USER_NAME"

# Run a command against the user's own `systemctl --user` manager. su as root
# needs no setuid and no login session; export the runtime dir + bus so
# `systemctl --user` resolves the manager (a plain su shell has neither).
as_user() {
  su -s /bin/sh -c \
    "export XDG_RUNTIME_DIR='/run/user/$UID_N' \
       DBUS_SESSION_BUS_ADDRESS='unix:path=/run/user/$UID_N/bus'; $1" \
    "$USER_NAME"
}

# Linger brings the manager up asynchronously; wait for its bus to answer.
ready=""
for _ in $(seq 1 60); do
  if as_user "systemctl --user show --property=Version" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 0.5
done
[ -n "$ready" ] || die "user manager for $USER_NAME did not come up (linger/dbus-user-session?)"

# 4. The unit, carrying the token. Mode 600: the PAT is a secret and the unit
#    embeds it verbatim via Environment=. The absolute ~/.local/bin/chan path is
#    used because systemd user units do not expand ~.
UNIT_DIR="$HOME_DIR/.config/systemd/user"
UNIT="$UNIT_DIR/chan-devserver.service"
# Same install -d caveat as ~/.local above: name the parents so they are
# user-owned (755) rather than left root-owned; only the final unit dir
# is 700 (it holds the token-bearing unit, later chmod'd 600).
install -d -o "$USER_NAME" -g "$USER_NAME" -m 755 \
  "$HOME_DIR/.config" "$HOME_DIR/.config/systemd"
install -d -o "$USER_NAME" -g "$USER_NAME" -m 700 "$UNIT_DIR"

EXEC="$CHAN_BIN devserver"
[ -n "$TUNNEL_URL" ] && EXEC="$EXEC --tunnel-url=$TUNNEL_URL"

( umask 077; cat > "$UNIT" <<EOF
[Unit]
Description=chan devserver
After=network.target

[Service]
Type=notify
NotifyAccess=main
FileDescriptorStoreMax=512
KillMode=process
Environment="CHAN_TUNNEL_TOKEN=$TOKEN"
ExecStart=$EXEC
TimeoutStartSec=10min
Restart=on-failure
WatchdogSec=30

[Install]
WantedBy=default.target
EOF
)
chown "$USER_NAME:$USER_NAME" "$UNIT"
chmod 600 "$UNIT"

# 5. Reload, enable on boot, and (re)start so a re-run picks up the new token.
as_user "systemctl --user daemon-reload"
as_user "systemctl --user enable chan-devserver.service"
if ! as_user "systemctl --user restart chan-devserver.service"; then
  as_user "systemctl --user status --no-pager chan-devserver.service" || true
  die "chan-devserver.service failed to start (see status above)"
fi

printf '\nchan devserver provisioned for user %s and started.\n' "$USER_NAME"
printf '  unit:  %s\n' "$UNIT"
printf '  check: su - %s      # interactive login shell has the session env, then:\n' "$USER_NAME"
printf '           systemctl --user status chan-devserver\n'
printf '           journalctl --user -u chan-devserver -f\n'
printf '\nMounted workspaces publish at https://<handle>--<disc>.<proxy>.usr.chan.app/<workspace>/\n'
printf '(<handle> is resolved from the token, not the Linux user name).\n'
