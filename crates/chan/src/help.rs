//! Long-form help for the `chan` commands.
//!
//! See `crates/chan-shell/src/help.rs` for why these are consts and not
//! doc comments, and why every line stops at 76 columns.

/// `chan close` long help (manpage head).
pub(crate) const CHAN_CLOSE: &str = r#"Tear down the server holding a workspace, the inverse of `chan serve`.

Finds the process holding the workspace's writer lock (from its
`writer.lock` record), reaches it over its control socket, asks it to
tear down, and waits for the flock to release. The holder decides the
scope: a dedicated `chan serve` process exits, while a chan-desktop or
`chan devserver` host unmounts just that tenant and keeps running.

Closing is idempotent. A workspace nothing is serving prints "(not
served: PATH)" and succeeds, as does one whose recorded holder is gone
or exposes no control socket. A holder that is reached but fails to
tear down is reported on stderr and treated as closed.

Closing keeps the workspace registered, so `chan serve` brings it back
with its metadata intact. When you are done with a workspace on this
machine, `chan workspace forget` runs this same teardown and then also
drops the registry entry and chan's metadata for it.

With --on TARGET the same verb reaches a workspace on a REGISTERED
remote devserver through the desktop app: TARGET is the devserver's
URL or launcher label as `chan devserver ls` shows it, PATH is the
workspace's path on that machine, and the devserver unmounts it and
keeps it registered there. The desktop resolves both and refuses
ambiguity; a devserver that is registered but not connected points at
`chan devserver connect`.

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

SEE ALSO:
`chan serve` to serve it again, `chan ps` to see what is served, `chan
workspace forget` to also drop it from the registry.
"#;

/// `chan workspace forget` long help (manpage head).
pub(crate) const CHAN_FORGET: &str = r#"Stop serving a workspace, then forget it from the registry.

Runs the same teardown as `chan close` (best-effort, idempotent), then
drops the workspace's registry entry in `~/.chan/config.toml` and the
whole `~/.chan/workspaces/<key>/` metadata directory, trash included.
The workspace directory and its files are never touched. On a devserver
or desktop host the removal is also pushed into that host's own
library, so the workspace stops coming back in the launcher after a
restart.

A holder that refuses teardown because live terminals would die also
stops the registry removal: close the terminals first. An unreachable
holder is treated as closed and the removal proceeds.

With --on TARGET the verb reaches a workspace on a REGISTERED remote
devserver through the desktop app: TARGET is the devserver's URL or
launcher label as `chan devserver ls` shows it, PATH is the workspace's
path on that machine, and the devserver unmounts it and drops its own
registration; your local registry is untouched, and so are the files on
that machine. The live-terminal refusal is the devserver's own.

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
the "could not reach the server" warning goes to stderr.

CAUTIONS:
Forgetting is not reversible. It deletes chan's metadata for the
workspace -- search index, graph database, trash, saved layouts -- and
a later `chan serve` on the same path starts from empty metadata. Your
files are untouched either way.

CAVEATS:
The live-terminal refusal stops the registry removal too: a host that
refuses teardown leaves the workspace registered, and the command exits
nonzero.

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
an error on both sides, pointing you back at `chan config get`.

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
values. Every printed scalar is readable and writable except
`editor.cs_dismissed`, which is read-only. Optional editor font and
Hybrid surface values accept `none` to clear them.

Enum values are the lowercase values printed by get. Integers retain
their live bounds: editor font 10..=32, terminal scrollback 10..=50,
terminal font 8..=32, and terminal timeout/session/ring values must be
nonzero. `editor.page_width_ratio` is 0.25..=1.0. Colors accept #rgb or
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
`editor.shortcuts` is a map collection. Get can print it, but set
refuses with the supported edit route: Settings or PATCH /api/config.
An empty value is refused rather than stored, so a typo cannot silently
wipe a preference.
editor.date_format is stored verbatim without validation; an id the
editor does not know renders as `iso`.

SEE ALSO:
`chan serve --search-aggression` to override the indexer profile for one
run, `chan serve --no-settings` to lock the in-app Settings panel.
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

The same noun's client side manages the desktop launcher's registry
of REMOTE devservers: `register URL` adds one to the launcher
without dialing it, `ls` lists the rows with their connection state,
`connect` / `disconnect` drive the dial from the CLI (sign-in and
trust prompts stay in the launcher), and `forget` removes a row, the
undo of register. These verbs need the chan desktop app running on
this machine. A connected devserver's WORKSPACES are managed by the
workspace lifecycle verbs with --on TARGET (`chan workspace serve`,
`chan close`, `chan workspace forget`), where TARGET is the URL or
label `ls` shows.

The devserver speaks plain HTTP with a bearer token and no TLS, so
keep the bind on loopback and reach a remote one over `ssh -L`. The
token is minted once and reused, persisted 0600 in the devserver
config; it is printed as a CHAN_DEVSERVER_TOKEN= line on stdout,
which the desktop's control terminal scrapes on every connect.
";

/// `chan devserver` examples, side effects, and caveats.
pub(crate) const CHAN_DEVSERVER_AFTER: &str = r"EXAMPLES:
  chan devserver run
    Foreground server on 127.0.0.1:8787. Prints
    CHAN_DEVSERVER_TOKEN=<token> on stdout; Ctrl-C stops it.

  chan devserver start
    Linux: ensures lingering, writes and enables
    ~/.config/systemd/user/chan-devserver.service, starts it,
    returns. macOS: writes and bootstraps
    ~/Library/LaunchAgents/app.chan.devserver.plist. Then
    `chan serve ~/src/proj` registers that workspace with it.

  ssh box -L 8787:localhost:8787 chan devserver join
    The connect-script shape the desktop's Add-devserver dialog
    ships as its placeholder: brings the remote service up,
    forwards its port to local 127.0.0.1:8787, and stays in the
    foreground.

  CHAN_HOME=/tmp/iso XDG_RUNTIME_DIR=/tmp/iso-run \
    chan devserver run --port 8788
    A second, fully isolated instance beside your real one.

PER PLATFORM:
  Linux: run it directly; systemd is the default backend. For a
  SECOND isolated instance, set CHAN_HOME to a separate directory
  and pass --port. CHAN_HOME REPLACES ~/.chan (it is not a parent
  of it): registry, devserver config, tokens, per-workspace
  metadata and locks all move there. The control socket does NOT
  route through CHAN_HOME -- it lands in $XDG_RUNTIME_DIR (else
  /tmp) -- so a fully isolated instance needs XDG_RUNTIME_DIR set
  to its own directory too.

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
  The CHAN_DEVSERVER_TOKEN= marker and the status report go to
  stdout; progress lines and warnings go to stderr.

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
port. --no-token removes the only auth gate; --no-settings greys the
Settings cog and makes every settings-write route answer 403.

CAVEATS:
serve takes a PATH only; a devserver URL belongs to `chan devserver
register` and is refused here with that pointer. --devserver from
inside a devserver shell is refused (no nesting); omit the flag to
register with the current one. If another process already holds the
workspace lock, the serve fails and points you at `chan serve
--devserver`. --on and --devserver are distinct flags by design: a
port-shaped --on value and a label-shaped --devserver value are both
refused with a pointer at the other. --on takes no local serve flag,
needs the chan desktop app running with that devserver connected, and
its PATH is a path on that machine (absolute).

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
What is being served right now:
  chan ps
  # STATE    BY                PID  WORKSPACE
  # served   devserver      184223  /home/you/notes
  # served   standalone      91044  /home/you/site
  # free     -                   -  /home/you/archive

Machine-readable, one object per registered workspace:
  chan ps --json
  # {
  #   "workspaces": [
  #     {
  #       "path": "/home/you/notes",
  #       "served": true,
  #       "served_by": "devserver",
  #       "pid": 184223,
  #       "since": "2026-07-19T10:02:11.512983421+00:00"
  #     }
  #   ]
  # }

Ask about one workspace before acting on it:
  chan ps --json | jq -r '.workspaces[]
    | select(.path == "/home/you/notes") | .served_by'

SIDE EFFECTS:
None. Read-only, output on stdout. It does connect to each live
holder's control socket to ask what kind of server it is.

CAVEATS:
Only REGISTERED workspaces are listed; with none registered it prints
"(no workspaces registered)". A free row serializes `served_by`, `pid`
and `since` as null, and `since` appears only in --json (the table
carries STATE, BY, PID and WORKSPACE).

SEE ALSO:
`chan serve` to serve a workspace, `chan close` to stop serving one, `chan
workspace ls` for the registry alone.
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
