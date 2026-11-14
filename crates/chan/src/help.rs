//! Long-form help for the `chan` commands.
//!
//! See `crates/chan-shell/src/help.rs` for why these are consts and not
//! doc comments, and why every line stops at 76 columns.

use crate::{help, KEYBINDINGS_TABLE};

/// `chan close` long help (manpage head).
pub(crate) const CHAN_CLOSE: &str = r#"Tear down the server holding a workspace, the inverse of `chan serve`.

Finds the process holding the workspace's writer lock (from its
`writer.lock` record), reaches it over its control socket, asks it to
tear down, and waits for the flock to release. The holder decides the
scope: a dedicated `chan serve` process exits, while a chan-desktop or
`chan devserver` host unmounts just that tenant and keeps running.

The desktop app's own `chan` asks the running chan-desktop first. A
desktop that does not serve the workspace says so, and the close goes
on to the lock's holder as it does with no desktop running, so a
dedicated `chan serve` exits either way.

Closing is idempotent. A workspace nothing is serving prints "(not
served: PATH)" and succeeds, as does one whose recorded holder is gone
or exposes no control socket. A holder that is reached but fails to
tear down is reported on stderr and treated as closed. If the host
answers that the workspace is still releasing, close prints that
answer, leaves the workspace registered and exits 75.

Closing keeps the workspace registered, so `chan serve` brings it back
with its metadata intact. When you are done with a workspace on this
machine, `chan workspace forget` runs this same teardown and then also
drops the registry entry and chan's metadata for it.

`chan close --forget PATH` is the short spelling of `chan workspace
forget PATH`, including --on and the live-terminal refusal.

With --on TARGET the same verb reaches a workspace on a REGISTERED
remote devserver through the desktop app: TARGET is the devserver's
URL or its label on the Computers screen, as `chan devserver ls` shows
it, PATH is the workspace's path on that machine, and the devserver
unmounts it and keeps it registered there. The desktop resolves both
and refuses ambiguity; a devserver that is registered but not connected
points at `chan devserver connect`.

This is a library command, not a window command: it needs no chan
terminal and no workspace window.
"#;

/// `chan close` examples, side effects, and caveats.
pub(crate) const CHAN_CLOSE_AFTER: &str = r#"EXAMPLES:
Stop serving a workspace:
  chan close ~/notes
  # closed: /home/you/notes

Close something nothing is serving -- still a success:
  chan close ~/archive
  # (not served: /home/you/archive)

Unmount a workspace on a registered remote devserver (label `lab`):
  chan close /srv/notes --on lab
  # closed: /srv/notes (on lab)

SIDE EFFECTS:
Ends the dedicated serve process (or unmounts the tenant on a host) and
releases the workspace's writer lock, so its terminals go away with it.
Progress lines go to stdout; the "could not reach the server" warning
goes to stderr.

CAVEATS:
A chan-desktop or devserver host REFUSES to close a workspace that
still has live terminals: the command fails with "refusing to close
PATH: N live terminal(s)" and exits nonzero. There is no --force; close
the terminals first. A dedicated standalone serve has no such guard and
shuts down with its terminals. The --on arm carries the same refusal,
coming from the remote devserver's own guard; it needs the chan desktop
app running and the devserver connected.

A close succeeds, and prints "closed:", only once the workspace's
writer lock is free or nothing holds it. When a live process holds the
lock and answers on no control socket within five seconds, answers the
close with an error and keeps the lock, or still holds it five seconds
after the close was sent, the command names that pid and exits nonzero.

SEE ALSO:
`chan serve` to serve it again, `chan ps` to see what is served, `chan
workspace forget` to also drop it from the registry.
"#;

/// `chan workspace forget` long help (manpage head).
pub(crate) const CHAN_FORGET: &str = r#"Stop serving a workspace, then forget it from the registry.

`chan close --forget PATH` is an alias, with the same --on reach.

Runs the same teardown as `chan close` (best-effort, idempotent), then
drops the workspace's registry entry in `~/.chan/config.toml` and the
whole `~/.chan/workspaces/<key>/` metadata directory, trash included.
The workspace directory and its files are never touched. On a devserver
or desktop host the removal is also pushed into that host's own
library, so the workspace stops coming back on the Computers screen
after a restart.

A holder that refuses teardown because live terminals would die also
stops the registry removal: close the terminals first. So does a host
that answers over its control socket or the desktop handoff that it is
still releasing. The command prints that answer, forgets nothing and
exits 75. A second run can ask the host again. A writer lock still held
five seconds after the close was sent stops it too: the command names
the holder's pid, forgets nothing and exits 1.

For a stored row with no reachable lock-record holder and a free writer
lock, forget asks the one discovered devserver for this library even
when the workspace is off. Multiple matches or a missing control socket
leave the row registered and exit 1. A failed request or another error
answer also exits 1; run the command again to check whether the row is
still registered. With no matching devserver, the unserved row is
forgotten on disk. `CHAN_NO_DEVSERVER_HANDOFF` does not skip this
removal request.

An unreachable lock-record holder is treated as closed only with a free
writer lock and no matching devserver. A held lock prevents unregistering
and leaves the row and windows intact. Another error the holder answers
is printed with a warning before disk removal continues.
Other desktop handoff errors fall through without being printed.

When PATH names the root stored by a registry row, the command asks
for and forgets that row even if its path now resolves into another
workspace's folder. A `..` names that row only when it removes a plain
directory; otherwise the resolved lookup applies. Other paths name
the workspace they resolve to. `chan close` uses the resolved path.

With --on TARGET the verb reaches a workspace on a REGISTERED remote
devserver through the desktop app: TARGET is the devserver's URL or its
label on the Computers screen, as `chan devserver ls` shows it, PATH is
the workspace's path on that machine, and the devserver unmounts it and
drops its own registration; your local registry is untouched, and so
are the files on that machine. The live-terminal refusal is the
devserver's own.

This is a library command, not a window command: it needs no chan
terminal and no workspace window.
"#;

/// `chan workspace forget` examples, side effects, and caveats.
pub(crate) const CHAN_FORGET_AFTER: &str = r#"EXAMPLES:
Serve it no more and forget it, leaving the files on disk:
  chan workspace forget ~/notes
  # closed: /home/you/notes
  # unregistered: /home/you/notes

Forget something nothing is serving:
  chan workspace forget ~/archive
  # (not served: /home/you/archive)
  # unregistered: /home/you/archive

Forget a workspace on a registered remote devserver (label `lab`):
  chan workspace forget /srv/notes --on lab
  # forgot: /srv/notes on lab. The files on that machine are untouched.

SIDE EFFECTS:
Tears down the serve like `chan close`, then drops the registry entry
and deletes `~/.chan/workspaces/<key>/`. Progress lines go to stdout;
a lock-record holder's "could not reach the server" warning goes to
stderr.

CAUTIONS:
Forgetting is not reversible. It deletes chan's metadata for the
workspace -- search index, graph database, trash, saved layouts -- and
a later `chan serve` on the same path starts from empty metadata. Your
files are untouched either way.

CAVEATS:
The live-terminal refusal stops the registry removal too: a host that
refuses teardown leaves the workspace registered, and the command exits
nonzero.

A host that answers "workspace is still releasing; retry" has forgotten
nothing, so the workspace stays registered here as well. That exit is
75, not 1, so a script can tell a host that has not let go from a
refusal. A holder of the writer lock that answers on no control socket
within five seconds, or answers with an error and keeps the lock, also
leaves the workspace registered, with exit 1. A desktop handoff is
attempted when enabled. A second run
asks a matching discovered devserver even when the workspace is off;
with no matching devserver, it forgets the unserved row on disk.

SEE ALSO:
`chan close` to stop serving without forgetting, `chan workspace add`
to register without serving, `chan ps`.
"#;

/// `chan config` long help (manpage head).
pub(crate) const CHAN_CONFIG: &str = r"Read or write the settings that live outside any workspace.

chan config edits the same preferences the web Settings overlay does.
Keys are dotted and split across two namespaces: `editor.*` persists to
~/.chan/preferences.toml, `server.*` to ~/.chan/server.toml (both under
the CHAN_HOME directory when that is set). No workspace is involved and
nothing needs to be running.

Terminal server keys are printed canonically as `server.terminal.*`.
The shorter `terminal.*` spelling is accepted as an alias by both get
and set; the HTTP config API continues to call that owner `terminal.*`.

`chan config get` with no key prints the whole editor + server config as
TOML, or JSON with --json. With a key it prints that one value.
`chan config set` takes either `key=value` or `key value`, validates the
value, saves the file, and echoes back `key = value`. An unknown key is
an error on both sides, and the error lists every settable key.

A running chan server watches that directory, so an edit made here
reloads into open windows without a restart.
";

/// `chan config` examples, side effects, and caveats.
pub(crate) const CHAN_CONFIG_AFTER: &str = r"EXAMPLES:
Print everything, then one value:
  chan config get
  chan config get editor.theme
  -> system   (the default; light and dark are the other two)

Set a value, either spelling:
  chan config set editor.line_spacing=compact
  chan config set server.search.aggression aggressive
  -> echoes `server.search.aggression = aggressive`

Read a value for a script:
  chan config get server.terminal.session_cap --json

Disable terminal secret masking explicitly:
  chan config set server.terminal.secret_masking false

KEYS:
The leaf paths printed by `chan config get` are the current serialized
values. Every printed scalar is readable and writable. Optional editor
font, Hybrid surface, terminal secret masking and default profile values
accept `none` to clear them.

Enum values are the lowercase values printed by get. Integers retain
their live bounds: editor font 10..=32, terminal scrollback 10..=50,
terminal font 8..=32, terminal background opacity 80..=100 (percent),
and terminal timeout/session/ring values must be nonzero.
`editor.page_width_ratio` is 0.25..=1.0. Colors accept #rgb or
#rrggbb and are stored as lowercase #rrggbb. Booleans are true or false.
The legacy line-spacing value `tight` is accepted as `compact`.
`server.terminal.secret_mask_suffixes` accepts a JSON string array with
at most 100 unique values matching [A-Za-z0-9_]+.

SIDE EFFECTS:
`set` rewrites ~/.chan/preferences.toml for an `editor.*` key and
~/.chan/server.toml for a `server.*` key, creating the file on first
save; the confirmation line goes to stdout. A running server picks the
change up from its watch on that directory and pushes it to open
windows. `get` writes nothing.

CAVEATS:
`editor.shortcuts` and `server.terminal.profiles` are collections. Get
prints them, but set refuses each with its edit route: Settings or PATCH
/api/config for shortcuts, server.toml or Settings > Terminal for
profiles.
An empty value is refused rather than stored, so a typo cannot silently
wipe a preference.
editor.date_format is stored verbatim without validation; an id the
editor does not know renders as `iso`.

SEE ALSO:
`chan serve --search-aggression` to override the indexer profile for one
run, `chan serve --no-settings` to make a standalone serve refuse
settings writes.
";

/// `chan devserver` long help (manpage head).
pub(crate) const CHAN_DEVSERVER: &str = r"Serve many workspaces from one process on one address, headless.

DESCRIPTION:
A devserver aggregates workspaces behind a single port. Once it is
running, `chan serve PATH` on that same box registers the workspace
with the running same-user devserver and exits instead of binding
its own server, so the devserver owns each workspace's
single-writer flock and its terminal sessions. A desktop client
lists, opens, and forgets workspaces over the management API; what
was mounted comes back on the next start.

Because the sessions live in the devserver process, a client can
disconnect and reconnect while terminals and their agents keep
running -- that is the point of running one on a remote box, a VM,
or beside your desktop.

Install chan on the target machine, then `chan devserver start`.
`chan devserver run` runs in the FOREGROUND on 127.0.0.1:8787 until
Ctrl-C. The management verbs -- start, stop, restart, status, join,
rotate-token -- drive a background service instead.
status prints a running service's launch URL with its persisted token
when stdout is a terminal or --url is given. In a pipe without --url
it prints the address without the token and names the flag. A missing
persisted token is named by its config path and yields no URL.
status does not check the token against the running server; a server
still using another token can refuse that URL.
join brings the service up (or re-attaches to a running one) and
stays attached, blocking on its health until Ctrl-C or its non-TTY
stdin closes, at which point it detaches and the service keeps
running; that is the form connect scripts use.
rotate-token re-mints the bearer token (the response to a
suspected leak) and prints the new CHAN_DEVSERVER_TOKEN= marker and
/?t= URL. A running devserver drops the old token immediately;
reopen any browser tab that used the old URL. Tokens also rotate on
their own at the first cold start after they turn 30 days old.

--service picks the backend. `auto` (the default) resolves per-OS at
runtime: under a management verb it is systemd on Linux, launchd on
macOS, and chan's own daemon on Windows and FreeBSD; under `run` it
is the plain foreground server. `none` forces the foreground server
and only `run` accepts it. `chan` is the cross-OS self-managed
background daemon (pidfile + flock) and works under `run` or a
management verb. `systemd` and `launchd` are OS-backed and need a
management verb.

The same noun's client side manages the registry of REMOTE devservers
that the desktop's Computers screen lists: `register URL` adds one
without dialing it, `ls` lists the rows with their connection state,
`connect` / `disconnect` drive the dial from the CLI (sign-in and
trust prompts stay on the Computers screen), and `forget` removes a row,
the undo of register. These verbs need the chan desktop app running on
this machine. A connected devserver's WORKSPACES are managed by the
workspace lifecycle verbs with --on TARGET (`chan workspace serve`,
`chan close`, `chan workspace forget`), where TARGET is the URL or
label `ls` shows.

The devserver speaks plain HTTP with a bearer token and no TLS, so
keep the bind on loopback and reach a remote one over `ssh -L`. The
token is minted once and reused, persisted 0600 in the devserver
config; the launch URL is printed on the line before the
CHAN_DEVSERVER_TOKEN= marker on stdout when the bound address is
known. The desktop's control terminal scrapes the marker on every
connect, and the URL opens the same devserver in a browser. A
LAN-bound launch URL leaves its token visible in that terminal.
";

/// `chan devserver` examples, side effects, and caveats.
pub(crate) const CHAN_DEVSERVER_AFTER: &str = r"EXAMPLES:
  chan devserver run
    Foreground server on 127.0.0.1:8787. Prints the launch URL
    then CHAN_DEVSERVER_TOKEN=<token> on stdout; Ctrl-C stops it.

  chan devserver start
    Linux: ensures lingering, writes and enables
    ~/.config/systemd/user/chan-devserver.service, starts it,
    returns. macOS: writes and bootstraps
    ~/Library/LaunchAgents/app.chan.devserver.plist. Prints the
    launch URL before the token marker when its address is known.
    Then `chan serve ~/src/proj` registers that workspace with it.

  chan devserver status --url
    Prints the running service's launch URL even through a pipe.

  ssh box -L 8787:localhost:8787 chan devserver join
    The connect-script shape the desktop's Add-devserver dialog
    ships as its placeholder: brings the remote service up,
    forwards its port to local 127.0.0.1:8787, and stays in the
    foreground.

  mkdir -p /tmp/iso-run && chmod 700 /tmp/iso-run
  CHAN_HOME=/tmp/iso XDG_RUNTIME_DIR=/tmp/iso-run \
    chan devserver run --port 8788
    A second, fully isolated instance beside your real one.

If a control socket cannot bind, the devserver keeps serving; cs in a
new terminal reports the missing socket and quotes the bind reason
supplied at spawn in CHAN_CONTROL_SOCKET_ERROR.

PER PLATFORM:
  Linux: run it directly; systemd is the default backend. For a
  SECOND isolated instance, set CHAN_HOME to a separate directory
  and pass --port. CHAN_HOME REPLACES ~/.chan (it is not a parent
  of it): registry, devserver config, tokens, per-workspace
  metadata and locks all move there. The control socket does NOT
  route through CHAN_HOME -- it lands in a real, owner-owned 0700
  $XDG_RUNTIME_DIR, or /tmp/chan-control-<uid> when that is absent
  or unsafe -- so a fully isolated instance needs its own private
  XDG_RUNTIME_DIR too.

  macOS: run the devserver inside a Lima VM and connect to it, so
  the workspace lives on Linux. Connect script:
    limactl shell chan -- chan devserver join
  Natively on the Mac, --service=launchd works too, but tunnel
  mode is refused there.

  Windows: --service=chan is the only backend (systemd is
  Linux-only, launchd macOS-only), and `auto` under a management
  verb resolves to it. To put the workspace on Linux, run the devserver
  inside WSL2 and connect to it.

  Any remote box: do not bind a public interface. Tunnel:
    ssh box.example.net -L 8787:localhost:8787 chan devserver join
  Keep connect scripts in the foreground (e.g. `ssh -N`).

SIDE EFFECTS:
  Writes ~/.chan/devserver/config.json (0600, bearer token +
  its mint time; rotate-token and the 30-day age check on a
  cold start replace the token in place),
  workspaces.json (the mount list) and terminals/; --service=chan
  and launchd also write devserver.log (systemd logs to the
  journal instead). Under CHAN_HOME all of these move with it.
  start/restart write and enable the systemd unit or the
  launchd plist, recording this binary's resolved path and the
  bound address; --service=chan writes daemon.lock + daemon.json
  and detaches a daemon child.
  stop stops AND disables the systemd unit / launchd agent, so
  it does not return on the next login or boot. The unit/plist
  file stays on disk.
  The CHAN_DEVSERVER_TOKEN= marker goes to stdout, with a launch URL
  line before it when the bound address is known. The status report
  also goes to stdout; its URL includes the persisted bearer token when
  stdout is a terminal or --url is given; progress and warnings go
  to stderr.

CAUTIONS:
  A non-loopback --bind prints a warning on the foreground and
  --service=chan paths: there is no TLS, only a bearer-token gate.
  A foreground devserver started with the default environment
  SHARES ~/.chan with chan-desktop, so both contend on the same
  writer locks; a workspace the desktop already serves shows as
  Locked, not On or Off.
  --service=systemd needs lingering to survive logout; it runs
  `loginctl enable-linger` and fails loudly (with the sudo hint)
  when it is denied. A launchd agent outlives the launching shell
  and the GUI login session but NOT a full logout.
  Under --service=systemd, live PTYs ride the systemd fd store
  through EVERY restart: restart, a bare `systemctl --user
  restart`, a watchdog kill, or a crash. restart --force tears
  the sessions down first and restarts without them; stop and
  `systemctl --user stop` end the terminals.
  join exits 0 when you detach with Ctrl-C or its non-TTY stdin
  closes, and non-zero when the backing service dies or stops
  answering /api/health.
  --tunnel-token is visible in `ps`; prefer CHAN_TUNNEL_TOKEN.
  --tunnel-wireguard FILE (CHAN_TUNNEL_WIREGUARD) holds the
  tunnel's private key: the file must be owner-only, it is read
  and refused before anything starts, and only its path is
  recorded in a systemd unit or handed to the --service=chan
  daemon.

CAVEATS:
  --service=none only runs under `run`; --service=systemd and
  --service=launchd need a management verb.
  --service=systemd is Linux-only and --service=launchd is
  macOS-only; --service=chan is the portable fallback. On a Linux
  box with no systemd, `auto` errors and points at --service=chan.
  Tunnel mode (--tunnel-token) is refused under --service=launchd,
  because the plist would persist the token at 0644.
  A --service=systemd tunnel unit is the ONLY store for its PAT, so
  start/restart/join reuse the token, endpoint and name it
  already carries; supply a token to rotate it, or --no-tunnel to
  convert the service back to a local devserver. The unit also
  exports CHAN_TUNNEL_URL, so the terminals the devserver spawns
  can run these verbs without naming an endpoint.
  With --tunnel-wireguard the dial to the tunnel URL runs through
  an in-process WireGuard tunnel whose peer is an ordinary
  WireGuard server (kernel `wg`), so the URL may be an http://
  address inside the tunnel; the tunnel's public key is printed
  when it starts, for the peer's configuration.
  Omitting --bind/--port on restart/join preserves the running
  service's address instead of reverting to defaults.
  `chan devserver register URL` registers a devserver with
  chan-desktop and needs a running desktop; `chan serve --devserver`
  is refused from inside a devserver shell, since nesting is
  unsupported.

SEE ALSO:
  chan serve, chan ps, chan close, chan config.
";

/// `chan serve` examples, side effects, and caveats.
pub(crate) const CHAN_SERVE_AFTER: &str = r#"EXAMPLES:
Serve the current directory and open the browser on it:
  chan serve .
  -> "chan is ready:" plus the tokened URL on stderr; runs until Ctrl-C

Serve a subdirectory of a repository, on another port, headless:
  chan serve --here --port 9000 --no-browser ~/src/proj/docs

Hand a workspace to the local devserver from a plain shell:
  chan serve --devserver ~/notes
  -> selects the sole devserver or unique CHAN_HOME match, then exits

Choose one of several local devservers explicitly:
  chan serve --devserver=9999 ~/notes
  chan serve --devserver=http://127.0.0.1:9999 ~/notes

Mount a workspace on a registered, connected remote devserver:
  chan serve /srv/notes --on lab
  # served /srv/notes on devserver lab (mounted at /notes-1a2b3c).
  # Open it from the Computers screen.

SIDE EFFECTS:
Creates the workspace root when missing, and the standalone path
registers it in the workspace library. The directory is created only
after the route is settled, so a refused route creates nothing. A
standalone serve holds the workspace's single-writer lock for as long as
it runs, and watches the chan config directory (~/.chan, or CHAN_HOME)
for config edits. The ready URL, the non-loopback warnings, the browser
NOTE, and the update banner go to stderr; the devserver and desktop
registration confirmations go to stdout.

CAUTIONS:
The standalone form blocks in the foreground; --timeout (30s, 5m, 1h)
gives it a graceful idle shutdown. The VCS-parent refusal exits 70. With
several live devservers, chan prefers the unique one whose library root
matches this CLI's CHAN_HOME and otherwise refuses with the candidate
list. A valued --devserver refuses when that port is not live; a bare
--devserver with no live candidate keeps the standalone fallback. The
standalone default port 8787 is also `chan devserver`'s default: on a
collision chan says whether a discovered devserver of yours reports that
port. --no-token removes the only auth gate. --no-settings makes the
server bound here answer 403 on its settings-write routes; a serve that
would hand the workspace to chan-desktop or a devserver is refused with
it, so add --standalone.

CAVEATS:
serve takes a PATH only; a devserver URL belongs to `chan devserver
register` and is refused here with that pointer. --devserver from
inside a devserver shell is refused (no nesting); omit the flag to
register with the current one. A standalone serve that meets another
process's workspace lock points you at `chan serve --devserver`. When
a devserver of this chan home refuses for that lock, serve prints its
sentence and exits 1 instead. --on and --devserver are distinct flags
by design: a port-shaped --on value and a label-shaped --devserver
value are both refused with a pointer at the other. --on takes no
local serve flag, needs the chan desktop app running with that
devserver connected, and its PATH is a path on that machine (absolute).

SEE ALSO:
`chan close` to tear a server down, `chan ps` to see what is served, `chan
devserver`, `chan config`.
"#;

/// `chan ps` long help (manpage head).
pub(crate) const CHAN_PS: &str = r"List every registered workspace and what, if anything, is serving it.

A workspace counts as served when its writer lock has a live holder;
the holder's pid and lock-acquisition time come from the `writer.lock`
record. The serving kind is resolved with an Identify round-trip to the
holder's control socket: `standalone` (a dedicated `chan serve`),
`desktop` (chan-desktop's embedded server), or `devserver` (a
multi-workspace `chan devserver`). A holder that does not answer leaves
the BY column as `-` while STATE still reads `served`.

Reads the registry in `~/.chan/config.toml` and each workspace's lock
record. It opens no workspace and needs no chan terminal or workspace
window.
";

/// `chan ps` examples, side effects, and caveats.
pub(crate) const CHAN_PS_AFTER: &str = r#"EXAMPLES:
What is being served right now. Each row prints on one line, wider than
this help, so it is shown here in two halves:
  chan ps
  # STATE    BY                PID  READY       GEN      PASS
  # served   devserver      184223  ready       3        -
  # served   standalone      91044  -           -        -
  # free     -                   -  -           -        -
  # ACTION     INDEXER   QUEUE  WORKSPACE
  # -          idle          0  /home/you/notes
  # -          -             -  /home/you/site
  # -          -             -  /home/you/archive

Machine-readable, one object per registered workspace (here only the
standalone row of the table above):
  chan ps --json
  # {
  #   "workspaces": [
  #     {
  #       "path": "/home/you/site",
  #       "served": true,
  #       "served_by": "standalone",
  #       "pid": 91044,
  #       "since": "2026-07-19T10:02:11.512983421+00:00",
  #       "activity": null
  #     }
  #   ]
  # }

Ask about one workspace before acting on it:
  chan ps --json | jq -r '.workspaces[]
    | select(.path == "/home/you/notes") | .served_by'

SIDE EFFECTS:
None on disk; output goes to stdout. It connects to each live holder's
control socket to ask what kind of server it is. When the local
devserver serves a listed workspace, it reads that devserver's bearer
from its config, GETs /api/devserver/workspaces, and GETs each such
workspace's /api/index/status and /api/health.

CAVEATS:
Only REGISTERED workspaces are listed; with none registered it prints
"(no workspaces registered)". A free row serializes `served_by`, `pid`,
`since` and `activity` as null, and `since` appears only in --json.
Only a workspace the local devserver serves fills READY through QUEUE
(`activity` in --json); every other row shows `-` there, never 0. STATE
reads `degraded` when that devserver reports a root it cannot use.

SEE ALSO:
`chan serve` to serve a workspace, `chan close` to stop serving one, `chan
workspace ls` for the registry alone.
"#;

/// `chan metrics` long help (manpage head).
pub(crate) const CHAN_METRICS: &str = r"Print the serving chan process's own readings, once or as a stream.

The server samples itself once per second and keeps ten minutes of
samples in memory; this command reads that cache over HTTP. It never
starts a server. The readings are the SERVER process's, not this
command's and not those of the shells or agents the server started:
version, build, PID, host, uptime, CPU (100% is one logical core),
resident memory and process I/O; chan's own traffic at each layer
(service sockets, HTTP/2, yamux, reverse forwards, file payload);
transfer workers and gateway tunnels; and the size of the chan home,
which is scanned only while someone reads. Layers overlap, so their byte
counts are not to be added up. A reading the platform cannot give prints
as n/a (null in --json), never as zero.

Without --url the target is the devserver of this CHAN_HOME, read with
that devserver's own bearer at the address its systemd unit pins with
--bind and --port, else at the port it last recorded, on loopback. A
wildcard bind is reached on loopback, and the read never goes through a
proxy.

--url reads any chan server by a URL chan printed for it: a devserver's
launch URL, a `chan serve` URL, or a tenant's. The bearer is --token,
else CHAN_METRICS_TOKEN, else the URL's ?t= token, and never the local
devserver's. CHAN_METRICS_TOKEN applies only beside --url.

--json prints the view as one JSON document, and --history adds the
retained samples to it. --watch repeats about once per second: the first
output is complete, and with --json each later line is one object that
carries only the samples newer than the last one sent.

--varlink makes the devserver a systemd-report source: it serves the
readings as systemd's metrics interface, io.systemd.Metrics, on stdin
and stdout, for a socket named io.chan.Devserver in the directory
systemd-report reads. Each family is io.chan.Devserver.<Name>.
";

/// `chan metrics` examples, side effects, and caveats.
pub(crate) const CHAN_METRICS_AFTER: &str = r#"EXAMPLES:
What this machine's devserver costs right now:
  chan metrics
  # chan 0.127.0 (git-0123456789ab)  PID 184223  Host: box
  # Uptime 3600s  CPU 1.5%  RSS 12.0 MiB
  # ...then a line each for process I/O, every traffic layer, the
  # transfer workers, the tunnels and the chan home

The same view as JSON, then with the retained samples:
  chan metrics --json
  chan metrics --json --history

Follow it, one JSON object per line, until Ctrl-C:
  chan metrics --watch --json
  chan metrics --watch --json | jq '.latest.process.cpuPercent'

Another chan server, by the URL it printed, then with the token kept
out of the argument list:
  chan metrics --url 'http://127.0.0.1:8787/?t=TOKEN'
  CHAN_METRICS_TOKEN=TOKEN chan metrics --url http://127.0.0.1:8787

The devserver in systemd-report, once the example user units are
installed (systemd-report lives in /usr/lib/systemd):
  systemctl --user enable --now chan-metrics.socket
  /usr/lib/systemd/systemd-report --user metrics io.chan.Devserver

SIDE EFFECTS:
None on this machine's disk. Each read is one GET of the server's
/api/metrics. Reads drive the server's scan of the chan home: the first
read starts one, scans repeat once per minute while reads keep arriving,
and the scan rests after five minutes with no read. Output goes to
stdout.

CAVEATS:
On Linux a read without --url sends the bearer only when every socket
listening on the address belongs to your user, read from /proc/net/tcp
and /proc/net/tcp6, because a recorded port outlives its devserver and
another user could be listening there. It refuses otherwise, also when
nothing listens there. On macOS, FreeBSD and Windows there is no such
check, and the bearer goes to the port unverified.

A failed read ends --watch with the error, so a watch rides out a server
restart only when the server answers again by the next read, about a
second later. A restart it does ride out shows as one complete output,
since the server's sample sequences start again.

--history needs --json, and --token needs --url. Without --url,
CHAN_METRICS_TOKEN is ignored.

--varlink is not for a terminal: systemd passes it one connected client
on stdin and stdout, from a socket unit with Accept=yes and a service
template with StandardInput=socket. Example units are in the chan
repository under docs/systemd/; no package installs them. Each List call
reads the running devserver once and never starts it: with the devserver
down, List answers io.systemd.Metrics.NoSuchMetric, which systemd-report
reads as no metrics, and the reason goes to stderr, the unit's journal.
The source is built on Unix only; on Windows the flag is refused.

SEE ALSO:
`chan ps` for which workspaces are served, `chan devserver status` for
the devserver's service.
"#;

/// `chan workspace contacts import csv` long help (manpage head).
pub(crate) const CHAN_WORKSPACE_CONTACTS_IMPORT_CSV: &str = r#"Import contacts from a CSV file into a workspace, one markdown note
per contact.

Reads a Google Contacts CSV (export at contacts.google.com -> Export
-> "Google CSV"), parses the whole file before touching the
workspace, and writes one note per contact into --into. Each note
carries `chan.kind: contact` frontmatter, so the indexer stamps it
as a contact node in the graph and the editor's `@@` picker finds
it. --workspace is required and auto-registers the path when the
library does not know it yet; --into is required and is created if
missing (use --into "" for the workspace root). --provider defaults
to google, the only supported dialect.

Filenames come from the contact's display name, falling back to the
email local part, then phone-<digits>, then unnamed-<n>; they are
sanitized and get a " (2)", " (3)" suffix on collision inside the
batch. A note that already exists at a contact's natural name is
skipped unless --overwrite.

The contact's data lives in the note body as bullets (Email, Phone,
Org, Labels) with the CSV notes below it, so a plain markdown editor
shows a readable note rather than a wall of YAML. In the graph a
contact is its own node kind; a lookup matches a case-insensitive
substring of the title, basename, emails or the `aliases:` array,
and `@@name` mention pills resolve through that. The import writes
no aliases: you add them by editing the note, and since a mention is
only [A-Za-z0-9_-]+, an alias containing a space can never match.
"#;

/// `chan workspace contacts import csv` examples, side effects, and caveats.
pub(crate) const CHAN_WORKSPACE_CONTACTS_IMPORT_CSV_AFTER: &str = r#"EXAMPLES:
Preview without writing anything:

  chan workspace contacts import csv contacts.csv \
    --into Contacts --workspace . --dry-run

  WOULD WRITE     Contacts/Jane Q. Doe.md
  WOULD SKIP      Contacts/John Roe.md  (exists)

  1 would write, 0 would overwrite, 1 would skip (dry-run; no
  files changed)

Do the import. One line per contact, then the counts:

  chan workspace contacts import csv contacts.csv \
    --into Contacts --workspace .

  WROTE     Contacts/Jane Q. Doe.md
  SKIPPED   Contacts/John Roe.md  (exists)

  1 wrote, 0 overwrote, 1 skipped, 0 failed

Refresh previously imported notes at the workspace root:

  chan workspace contacts import csv contacts.csv \
    --into "" --workspace . --overwrite

An imported note looks like this. `aliases:` is not written by the
import -- add it by hand to make extra @@mentions resolve here:

  ---
  aliases: [jq, jdoe]
  chan:
    kind: contact
    provider: google
    imported_at: 2026-05-10T12:34:56Z
    frontmatter_version: 2
  ---

  # Jane Q. Doe

  - **Email**: jane@example.com (work)
  - **Phone**: +1-555-0100 (mobile)
  - **Org**: Acme Corp - Engineer
  - **Labels**: Friends, Work

SIDE EFFECTS:
Registers the --workspace path in the library when it is not already
known, creating the directory if it does not exist. Creates the
--into directory, then writes one markdown file per contact. The
per-contact report and the totals go to stdout. --dry-run runs the
same slug and existence checks but writes nothing.

CAUTIONS:
--overwrite replaces existing notes in place, discarding hand edits
(including aliases you added). Run --dry-run first. A CSV parse
error aborts before any file is written; a per-contact write error
is reported as FAILED and the batch continues.

CAVEATS:
Only --provider google is accepted; any other value is an error.
Contacts show up in the graph and in the @@ picker only once the
index has picked the new notes up.

SEE ALSO:
  chan workspace index, chan workspace graph.
"#;

/// `chan serve --help`, assembled at first use: the launcher catalog, then
/// the generated chord table, then the worked examples. Composed at
/// runtime rather than with `concat!` because the pieces are consts, not
/// literals, and the chord table has to stay a separate const for
/// `make shortcuts-check` to diff it against the generator.
pub(super) static SERVE_AFTER_HELP: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    format!(
        "{SERVE_LAUNCHER}\nIN-APP KEYBINDINGS (Cmd = Ctrl on Linux / Windows):\n\n\
         {KEYBINDINGS_TABLE}\n{}",
        help::CHAN_SERVE_AFTER
    )
});

/// `chan serve` long help: what serving a workspace actually does.
pub(super) const SERVE_LONG_ABOUT: &str = r#"Register a directory as a chan workspace and serve it.

`chan open` serves a workspace; `chan-files` and `chan-edit` open a path
in a window, as `cs open` does inside chan.

chan serve PATH creates the directory if it does not exist, registers it
in the workspace registry, and serves it. Serving is load-bearing: a
bare `chan workspace add` only registers, while serving mounts the
workspace so the editor, terminal, search, graph, and a devserver can
reach it. The path is always explicit -- a bare `chan serve` is an error.

Where it serves follows the shell's parentage and the live same-user
instances on the box. A chan-desktop terminal stays with the desktop; a
`chan devserver` terminal stays with that devserver. From a plain shell,
one live desktop or devserver wins automatically. With both kinds live,
the standalone CLI prefers the devserver and the desktop CLI preserves
its desktop behavior. With neither, the standalone CLI binds a local
server and stays in the foreground until Ctrl-C. --standalone, --desktop,
and --devserver force one target. --devserver=<port|url> names one local
devserver explicitly. A missing explicit devserver or an ambiguous set is
refused rather than guessed. When a registration was sent but no valid
reply comes back in time, serve exits 1 instead of serving standalone,
because the devserver may still be mounting the workspace. When a
devserver of this chan home says another chan process holds the
workspace, serve prints that answer and exits 1: a standalone open
would meet the same lock. Other failed handoffs fall through to a
standalone server.

--on TARGET serves PATH on a REGISTERED remote devserver instead: TARGET
is the devserver's URL or its label on the Computers screen, as `chan
devserver ls` shows it, PATH is a path on that machine, and the desktop
resolves both and refuses ambiguity. It is a different flag from
--devserver by design (one flag, one object kind): a port-shaped --on
and a label-shaped --devserver are both refused with a pointer at the
other.

The standalone server binds 127.0.0.1:8787 by default (::1 with -6),
prints "chan is ready:" and the tokened URL on stderr, and opens the
system browser unless --no-browser. There is no TLS, only a
bearer-token gate, so a non-loopback --host serves your workspace in
plaintext and prints a warning saying so.

Without --here, chan serve refuses a path inside a Git, Mercurial, or
Subversion working tree: it exits 70 and prints a `chan-error:
vcs-parent` marker on stderr, because the repository root is almost
always the better workspace root. --here serves the subdirectory
verbatim.

serve takes a PATH only. A remote devserver is registered on the
Computers screen by `chan devserver register URL`; a URL passed here is
refused with that pointer rather than read as a relative directory.
"#;

/// One line of `chan-files --help`.
pub(super) const CHAN_FILES_ABOUT: &str =
    "Open a directory in chan's file browser, as `cs open` does inside chan";

/// One line of `chan-edit --help`.
pub(super) const CHAN_EDIT_ABOUT: &str =
    "Open a file in chan's editor, as `cs open` does inside chan";

/// The long help both names share: they differ only in their one line and the
/// desktop entry that runs them, so the rule they follow is stated once.
pub(super) const OPENER_LONG_ABOUT: &str = r#"Open each PATH in a chan window, as `cs open PATH` does inside chan.

`chan open` serves a workspace; `chan-files` and `chan-edit` open a path
in a window, as `cs open` does inside chan.

`chan-files` and `chan-edit` are names of the chan binary, and both
follow `cs open`'s rule for every path: a directory opens in the file
browser, a text file in the editor, any other file is revealed in its
directory, and a missing path with a text file's name is created empty
and opened in the editor. The two names differ only in this help and in
the desktop entry that runs them, which makes chan a file browser or a
Markdown editor to `xdg-open`. PATH defaults to the current directory; a
file:// URI is read as the path it names.

In a chan terminal each path goes where `cs open` sends it: a desktop
terminal's to the desktop, a devserver terminal's to that devserver.
From any other shell, or a desktop entry, each path opens in a
standalone window of the running chan-desktop, which has 5 s to answer
each path; one that does not is reported (chan-desktop did not answer)
and the rest are not sent. With no desktop running, the desktop's own
`chan-files` and `chan-edit` start it with the paths; the standalone
chan CLI says no desktop is running and exits 1. So does
CHAN_NO_DESKTOP_HANDOFF, and a session with no display (an SSH login,
or off macOS no DISPLAY or WAYLAND_DISPLAY). A path that cannot be
opened is reported, in argument order, and the rest still open; the exit
status is then 1.
"#;

/// `chan-files` / `chan-edit` examples.
pub(super) const OPENER_AFTER_HELP: &str = r#"EXAMPLES:
  chan-files ~/notes
    Opens the file browser on ~/notes.
  chan-edit todo.md
    Opens todo.md in the editor, creating it empty when it is missing.
  xdg-mime default chan-edit.desktop text/markdown
    Makes chan the Markdown editor `xdg-open` uses (Linux).
"#;

/// The usage line `chan-term` prints with a usage error and opens its help
/// with.
pub(crate) const CHAN_TERM_USAGE: &str = "\
Usage: chan-term [--dir=PATH] [--app-id=ID] [--title=TITLE] [--hold]
                 [-e CMD ARGS... | -- CMD ARGS...]";

/// `chan-term --help`. Not a clap command: its grammar is the one
/// xdg-terminal-exec maps its options onto, where `-e` hands everything after
/// it to the command verbatim.
pub(crate) const CHAN_TERM_HELP: &str = r#"Open a terminal window: your shell, or a command, in a window of its own.

Usage: chan-term [--dir=PATH] [--app-id=ID] [--title=TITLE] [--hold]
                 [-e CMD ARGS... | -- CMD ARGS...]

Options:
  --dir=PATH      Start in PATH; a relative one is read against the
                  current directory, and one that is no directory falls
                  back to the home directory
  --app-id=ID     Give the window the Wayland app_id and X11 class ID
                  (Linux and FreeBSD)
  --title=TITLE   Give the window the fixed title TITLE
  --hold          Keep the window open after the command exits
  -e CMD ARGS...  Run CMD with ARGS, exactly as given, instead of your
                  shell; everything after -e is the command's
  -- CMD ARGS...  The same as -e
  -h, --help      Print help
  -V, --version   Print version

chan-term is a name of the chan binary and the command chan-term.desktop
runs, so it is the terminal xdg-terminal-exec opens once that entry is
the first in xdg-terminals.list. Every option takes its value after = or
as the next argument.

A launch that only runs your shell, here or in --dir, opens a terminal
window of the running chan-desktop, one it does not save, which has 5 s
to answer. With no desktop running, Chan Desktop's chan-term starts it,
and its first window is that terminal. Such a launch exits 1 with the
reason and opens nothing, from Chan Desktop's chan-term too, when the
running desktop refuses the window or does not answer (chan-desktop did
not answer), with CHAN_NO_DESKTOP_HANDOFF set, and in a session with no
display (an SSH login, or off macOS no DISPLAY or WAYLAND_DISPLAY). A
launch with a command, --hold, --app-id or --title is one window in a
process of its own, which ends when the window closes; it exits with the
command's status, and with 127 and no window when the command is not
found.

The standalone chan CLI cannot open a window or start a desktop, so its
chan-term only asks a running chan-desktop for that shell window. It
also exits 1 with the reason when a launch needs a window of its own,
and when no desktop runs.

EXAMPLES:
  chan-term --dir ~/src
    Opens your shell in ~/src.
  chan-term --title=Build --hold -e make -j8
    Runs make in a window titled Build that stays open after it exits.
  echo chan-term.desktop > ~/.config/xdg-terminals.list
    Makes chan the terminal xdg-terminal-exec opens (Linux).
"#;

/// The launcher catalog, which is the thing a user reaches for once the
/// window is up. Kept next to the chord table it introduces.
const SERVE_LAUNCHER: &str = r#"Inside the window, everything chan can do is one chord away. The command
launcher is Cmd+K on the macOS desktop app and Ctrl+Alt+K everywhere
else (web, Linux, Windows). On the desktop app, Cmd+P
(Ctrl+Shift+P on Windows and Linux) is View > Computers, which shows or
hides the Computers screen. Team Work has no chord of its own: New team
in the command launcher or a pane's menu opens it in a workspace window.

In a workspace or terminal window the launcher opens on a list, not an
empty box: up to five recent commands, then the focused app's commands,
the pane's (New tab, Tab, Pane), the window's, the workspace's, a
Settings summary and the ways into Computers, each under its heading.
Typing filters and ranks the commands and settings of every scope, and
this machine's workspaces and windows, into one list; commands that
cannot run here follow it, a few at most, each with its reason. The
scope orbs (the focused app, Pane, Window, Workspace, Settings,
Computers) narrow the list to one scope; Workspace shows only in a
workspace window, and Computers opens its action branches without
requiring a query. The Computers SPA searches its authorized aggregate
library instead.

Apps you can spawn from it (Pane > New tab):

  New terminal        a shell tab
  New team            a Team Work group of agent terminals
  New draft           a markdown file in the editor
  New graph           the project link graph
  New file browser    the file tree
  New dashboard       metrics, workspace and search status, about
  New slide deck      a deck
  New diagram         an Excalidraw canvas

New team and New graph need a workspace window. New file browser also
works in a standalone terminal window whose server serves a filesystem,
and New draft, New slide deck and New diagram in one whose server also
keeps drafts.

Every command also has a category (Global, Workspace, Search, Apps, Tabs,
Panes, Editor, File Browser, Terminal, Dashboard, Graph): typing one in
the launcher matches its commands, and Settings > Keyboard Shortcuts
lists the commands under their categories, with a chord per platform.
"#;

/// One line of `chan --help`. Kept separate from the Cargo description,
/// which is package metadata with its own downstream constraints.
pub(super) const CHAN_ABOUT: &str = "Supercharged terminal emulator: scriptable, local and remote";

/// Orientation for anyone (or anything) meeting chan for the first time.
/// This is the opening section of `chan dump-skill`, so it carries the one
/// distinction everything else depends on: whether you are in a workspace
/// window or a standalone terminal.
pub(super) const CHAN_LONG_ABOUT: &str = "\
A supercharged terminal emulator: scriptable from the shell, the keyboard
and the mouse; the same locally and on remote machines; a multiplexer of
its own plus tmux control mode (tmux -CC); devservers reached over a TCP
tunnel or through a self-hosted gateway. Around the terminal, any
directory becomes a workspace.

`chan serve PATH` registers a directory as a workspace and serves it. The
workspace indexes its content for search, builds a graph from the links,
tags, and mentions in your documents, and hosts the editor, terminals,
file browser, graph, dashboard, and Team Work over that one tree.
Everything runs locally; the server binds loopback by default. The
registry of known workspaces lives in `~/.chan/config.toml`, or under
`CHAN_HOME` when that is set.

Inside any chan terminal, `cs` drives the window that spawned it. It is
this same binary under a second name, picked by argv[0], so `cs open
notes/plan.md` and `chan shell open notes/plan.md` are the same
command.

Commands disambiguate on their first letters, iproute2 style, at every
level, so `chan w ls`, `chan de status`, and `chan du` resolve to
workspace ls, devserver status, and dump-skill. The prefix has to be
unambiguous: `s` matches both serve and shell, and `c` matches close,
config, and completions, so each is rejected rather than guessed.";

/// The rest of the orientation. Split from the long_about because clap
/// prints `after_long_help` below OPTIONS, which is where the two-modes
/// table reads best.
pub(super) const CHAN_AFTER_HELP: &str = r#"THE TWO MODES:
Where you are decides what you can do. There is no environment variable
that tells them apart: workspace-only commands simply refuse in a
standalone terminal, and say so.

  A WORKSPACE WINDOW -- the one you want.
    Adds what needs a workspace: search, the graph, Team Work, and the
    workspace-only `cs` commands: graph, search, export, terminal team,
    session handover and takeover, and `cs open` of a chan://graph
    link. This is where work belongs.

  A STANDALONE TERMINAL -- no workspace behind it. PTYs start in $HOME.
    Fully automatable: every `cs pane` command and every `cs terminal`
    command but team works (terminal new PATH needs a host that serves
    a filesystem), so scripting it is supported and expected. It has
    the command launcher, tabs, panes and a Dashboard, and when its
    host serves a filesystem, the file browser and the editor over it.
    It is the right place to manage the chan library -- `chan serve`,
    `chan close`, `chan workspace forget`, `chan ps` -- and the wrong
    place for heavy work, because search, the graph and Team Work need
    a workspace.

Run a workspace-only command in a standalone terminal and it says so:
  cs <cmd> is only available in a workspace window; this is a
  standalone terminal.

TELLING WHERE YOU ARE:
  $CHAN                 set to 1 inside any chan-spawned terminal
  $CHAN_CONTROL_SOCKET  required by every `cs` command
  $CHAN_WINDOW_ID       also required by window-targeting commands
  $CHAN_TAB_NAME        this tab's name, when it has one
  $CHAN_TAB_GROUP       this tab's broadcast group, default "default"
  $CHAN_TERMINAL        configured engine at PTY spawn: xterm or ghostty
  $CHAN_WORKSPACE_PATH  the served root, or $HOME in a standalone
                        terminal, so it does NOT identify the mode

EXAMPLES:
Serve a project and open it:
  chan serve ~/src/my-project

See what is being served, then tear one down:
  chan ps
  chan close ~/src/my-project

Most installs put `cs` on your PATH. If yours did not, link it once:
  ln -s "$(command -v chan)" ~/.local/bin/cs

Install the topic index so an agent can fetch the pages it needs:
  mkdir -p ~/.claude/skills/chan
  chan dump-skill > ~/.claude/skills/chan/SKILL.md

SEE ALSO:
`chan dump-skill --list` for every topic, then `chan dump-skill --topic
cs` for the environment contract and `--topic open` for the workspace and
its apps.
"#;

/// `chan dump-skill` long help. A const rather than a doc comment because
/// clap collapses a doc comment's paragraphs into one line, which would
/// destroy the example block below.
pub(super) const DUMP_SKILL_LONG_ABOUT: &str = "\
Print an installable index of chan's agent manual.

The output teaches an agent what chan is and how to drive it: the `cs`
command surface, the command launcher and built-in apps, authoring
documents with diagrams and slide decks, the project graph, teams of
agents, and devservers. Every section is the live `--help` of a real
command, so the skill cannot go stale against the binary printing it.
The default index lists a command for every topic. --topic <SLUG> reads one;
pages over 8 KiB list numbered parts to read with --part N. Each index,
page or part fits in 8 KiB. --full explicitly prints the entire manual
without that limit. cs dump-skill accepts the same selectors and prints
the same bytes, without needing a terminal or running server.

Writes nothing. The document goes to stdout; you decide where it lands.";

/// `chan dump-skill` examples. The install one-liner points at the user's
/// own agent directory on purpose: writing into a checkout's skills dir
/// would commit a generated file back into the repo.
pub(super) const DUMP_SKILL_AFTER_HELP: &str = r#"EXAMPLES:
Install the skill for a local agent (the usual first run):
  mkdir -p ~/.claude/skills/chan
  chan dump-skill > ~/.claude/skills/chan/SKILL.md

See what topics exist, then read one:
  chan dump-skill --list
  chan dump-skill --topic teams
  cs dump-skill --topic serve --part 1

Save the complete manual without the output size limit:
  chan dump-skill --full > chan-manual.md

Hand a topic to another agent, or drop it into a team brief:
  chan dump-skill --topic graph | cs copy
  chan dump-skill --topic cs-terminal-team >> brief.md

SIDE EFFECTS:
None. Every form writes to stdout only.

CAVEATS:
A `--topic` page is a fragment: it carries no skill frontmatter, so it is
a manual page to read, not a file to install as a skill.

SEE ALSO:
`chan dump-skill --list` for every slug, and `chan --help` for the
orientation the skill opens with.
"#;
