//! Long-form help for the `cs` commands.
//!
//! Consts rather than doc comments for two reasons that are easy to
//! rediscover the hard way: a derive doc comment collapses its paragraphs
//! onto one line (destroying every example block below), and the workspace
//! pins clap WITHOUT `wrap_help`, so whatever is written here reaches the
//! terminal verbatim. Every line is hand-wrapped at 76 columns, and
//! `chan`'s skill tests enforce that plus ASCII-only.
//!
//! These same strings are what `chan dump-skill` emits, so a correction
//! here fixes the manual and `cs X --help` together.
//!
//! Section order in each `_AFTER` const follows the template the skill
//! tests assume: EXAMPLES, SIDE EFFECTS, CAUTIONS, CAVEATS, SEE ALSO,
//! omitting any that would be empty. A page never links to its own topic.

/// `cs copy` long help (manpage head).
pub(crate) const CS_COPY: &str = r"Copy stdin onto the clipboard of the machine viewing this window.

The clipboard is the VIEWING machine's, not the machine running the
shell. Copy inside a workspace served from a devserver and Cmd+V pastes
it into a local app. chan stores nothing of its own: the bytes go
straight to that machine's browser or desktop clipboard, which is also
why moving content between two workspaces works -- both windows reach
the same system clipboard.

The content type is sniffed from the bytes, in order: an image by magic
bytes, then an HTML document (leading <!doctype html> or <html>), then
plain UTF-8 text. A non-PNG image is re-encoded to PNG in the window,
the one image format the clipboard reliably accepts. --html forces
text/html for a fragment that would not sniff as a document; --mime
forces any type. Bytes that match none of the three are refused with a
hint to pass --mime.
";

/// `cs copy` examples, side effects, and caveats.
pub(crate) const CS_COPY_AFTER: &str = r#"EXAMPLES:
  cs copy < photo.jpg
    Puts the image on the clipboard; prints "copied 51234 bytes
    (image/jpeg)" on stderr. It arrives as PNG.
  git log --oneline -20 | cs copy
    Copies the text; Cmd+V pastes it into any local app.
  printf '<b>bold</b>' | cs copy --html
    Copies it as rich text, with a plain-text fallback alongside.

SIDE EFFECTS:
  Reads stdin to EOF, then BLOCKS until the window acknowledges the
  write. Mutates the viewing machine's system clipboard. The ack
  ("copied N bytes (<mime>)") goes to stderr; stdout stays empty.

CAUTIONS:
  After 2 seconds with no reply it prints a waiting notice on stderr
  (the window may be waiting on a clipboard permission prompt, or on
  the viewing machine's clipboard owner) and keeps waiting; the server
  gives up at 30 seconds and the CLI exits 124.
  Payloads are capped at 32 MB. Empty stdin, an over-cap payload,
  unsniffable bytes, and a forced --mime text/* over non-UTF-8 bytes
  all fail with exit 1.

CAVEATS:
  --html and --mime are mutually exclusive. The target is the window
  named by $CHAN_WINDOW_ID, so the clipboard that changes belongs to
  whoever is looking at that window, not to this shell's host.

SEE ALSO:
  cs paste, cs upload, cs download.
"#;

/// `cs dashboard` long help (manpage head).
pub(crate) const CS_DASHBOARD: &str = r"Open a Dashboard tab in a window and Hybrid side.

The Dashboard hosts a three-slide carousel: slot 0 Workspace, slot 1
Search (the live indexing graph), slot 2 About. It auto-advances every
5 seconds, pausing while the pointer is over it, while it has focus,
while its tab is not the visible one, when the workspace's carousel
preference is off, or when the tab was opened with --carousel-off.

--carousel-index picks the slide the new tab lands on. The index is
clamped into range, and an index whose slot the user switched off
falls back to the first enabled slot.
";

/// `cs dashboard` examples, side effects, and caveats.
pub(crate) const CS_DASHBOARD_AFTER: &str = r#"EXAMPLES:
  cs dashboard
    Opens a Dashboard tab on its default slide, auto-rotating.
  cs dashboard --carousel-index 1 --carousel-off
    Lands on the Search / indexing graph and stays there.
  cs dashboard --window win-2 --pane pane-4 --side b
    Queues the Dashboard directly into pane-4 side B of win-2.

SIDE EFFECTS:
  Queues ONE command to the exact target window; prints "dashboard
  request queued" on stderr, nothing on stdout. The new tab is
  appended at the requested pane and side, or at the active pane and
  visible side when those coordinates are omitted.

CAUTIONS:
  The command refuses an offline target instead of claiming it queued.
  Once accepted it returns before the tab renders. Each run appends
  another Dashboard tab; they stack.

CAVEATS:
  --carousel-off is per tab: it does not change the workspace-wide
  carousel preference, so other dashboards keep rotating.
  --window defaults to $CHAN_WINDOW_ID; --pane and --side default to
  the target window's active pane and visible side at dequeue time.

SEE ALSO:
  cs open, cs pane, cs window list.
"#;

/// `cs download` long help (manpage head).
pub(crate) const CS_DOWNLOAD: &str = r#"Download a file or directory through this window.

The same UI the Inspector's download action uses: the transfer bubble
shows progress and the bytes land on the machine VIEWING the window
(its browser download, or the desktop app's download flow). That is
what makes it a way to pull files off a devserver box.

PATH is required; "." is the terminal's current directory. A directory
downloads as a tar named <leaf>.tar, built and streamed on the fly with
nothing staged on disk first. In a workspace window the source is
resolved workspace-relative, must stay inside the workspace root, and
its tar skips .chan and .git; in a standalone terminal the source is
the absolute path the shell itself can reach and is pre-flighted
readable before any archive work begins.
"#;

/// `cs download` examples, side effects, and caveats.
pub(crate) const CS_DOWNLOAD_AFTER: &str = r#"EXAMPLES:
  cs download notes/plan.md
    Downloads the single file.
  cs download .
    Downloads the current directory as <leaf>.tar.
  cs download build/out.bin
    Any file type works here, unlike cs open, which refuses binaries.

SIDE EFFECTS:
  Queues ONE window command and returns; the transfer runs in the
  window. The ack ("download request queued for <path>") goes to
  stderr. Nothing is written on this machine.

CAUTIONS:
  Fire-and-forget once queued: exit 0 means the window was asked, not
  that the file arrived. A source that cannot be stat'ed fails before
  anything is queued, with exit 1. Cancelling from the transfer
  bubble aborts the stream mid-tar.

CAVEATS:
  Works in workspace windows and standalone terminals, with the same
  root asymmetry as cs upload: workspace-relative and walled at the
  workspace root in one, plain filesystem paths under the shell's own
  reach in the other. Failures after the transfer starts surface in
  the window, not on this terminal.

SEE ALSO:
  cs upload, cs open, cs export; chan dump-skill --topic transfer.
"#;

/// `cs export` long help (manpage head).
pub(crate) const CS_EXPORT: &str = r#"Render a workspace file through a live renderer window and write the
result back into the workspace.

`cs export doc.md` reads doc.md from the workspace, renders it in an
open workspace window (a connected browser or chan-desktop), uploads
the bytes back into the workspace, and prints the final
workspace-relative output path on stdout. The default output swaps
the source extension for the format: notes/doc.md -> notes/doc.pdf.
`pdf` is the only registered format today.

The rendering happens in the window, not in the terminal running cs:
the format-to-exporter registry lives in the frontend. The server
sends the job to the latest-joined live workspace window.

What comes out depends on the source's frontmatter. A markdown file
carrying `chan.kind: slides` exports as a deck: one slide per A4
landscape page, split at every page break. Anything else exports as
a document: A4 portrait, 0.65in margins, paginated at block
boundaries and forced at every page break. Mermaid fences,
Excalidraw embeds and images render into the PDF the way the editor
shows them.

Authoring conventions the exporter honors:
  - a code fence tagged `mermaid` renders as a diagram; tag it
    `mermaid-to-excalidraw` for the hand-drawn style
  - `<hr class="chan-page-break">` alone on a line is a page break
    (in a deck, the start of the next slide)
  - `chan.kind: slides` frontmatter turns the file into a deck
"#;

/// `cs export` examples, side effects, and caveats.
pub(crate) const CS_EXPORT_AFTER: &str = r#"EXAMPLES:
Export a document. Prints the output path; doc.pdf lands next to it:

  cs export notes/doc.md
  notes/doc.pdf

Export a deck to a chosen path (one landscape page per slide):

  cs export decks/kickoff.md --format pdf --out out/kickoff.pdf
  out/kickoff.pdf

A deck is a markdown file with this frontmatter. `slides:` and both
of its fields are optional; aspect_ratio is "16:9" or "4:3" (any
other value exports the file as a document, not a deck) and
zoom_factor is a positive multiplier (a percentage like 150% also
works):

  ---
  chan:
    kind: slides
    slides:
      aspect_ratio: "16:9"
      zoom_factor: 2
  ---

  # Slide 1

  content

  <hr class="chan-page-break">

  # Slide 2

Page breaks: `<hr class="chan-page-break">` alone on a line, blank
line after it, splits a deck into slides and forces a document page
cut. In the live editor, typing @pagebreak or @break followed by
Space or Enter rewrites the line to that hr; the rewrite happens at
typing time only, so a file written with the markers keeps them as
plain text. One asymmetry: a literal @pagebreak line still splits
decks and PDF export, but the editor shows it as raw text, so the hr
form is the canonical one to write. `@break` left literally in the
source does nothing anywhere.

Diagrams: put the graph in a code fence tagged `mermaid`, or
`mermaid-to-excalidraw` for the hand-drawn style. Rendering is
client-side, in the window that runs the export:

  (fence tagged mermaid)
  flowchart LR
    spec --> draft --> review

Editor conveniences worth knowing while typing in the live editor:

  [[         file picker; commits [[target]]
  [[file#    heading picker inside that file
  @@name     contact picker; commits an @@name mention pill
  @today     typing macro: expands to today's date
  @date      same, plus the calendar / format popover
  ![         image picker; commits ![](path)

The @ triggers are live-editor typing macros, expanded on Space or
Enter as you type and never expanded in a file written with them. An
agent writing markdown writes the materialized forms instead: the hr
line above for a page break, and a concrete date for @today/@date.

Dates: a concrete date in any of these shapes gets the editor's date
pill wherever it appears; ISO is the preferred one to write:

  2026-07-23          YYYY-MM-DD (ISO)
  02 Jan 2029         DD Mon YYYY
  13 April 2024       D Month YYYY
  13th April 2024     Dth Month YYYY
  April 13, 2024      Month D, YYYY
  13/04/2024          DD/MM/YYYY
  04/13/2024          MM/DD/YYYY

SIDE EFFECTS:
Writes the output file into the workspace through the upload route,
replacing an existing file at that path. Pushes an export job to the
chosen window; that window does the reading, rendering and upload.
The output path goes to stdout; errors go to stderr.

CAUTIONS:
Blocks until the renderer replies. The server gives up after 90s with
"no reply from the renderer within 90s"; inside the renderer each page
has its own 30s render ceiling. Any failure exits nonzero with the
renderer's own message. An existing output file is replaced without
asking.

CAVEATS:
Workspace windows only: a terminal-only session refuses with "cs
export is only available in a workspace window; this is a standalone
terminal.", pointing at the open window that would do the rendering.
It also refuses when no window is connected -- there is no headless
export. An unregistered --format value is rejected by the renderer,
not by the server. With several windows open the latest-joined live
one renders, which may not be the one you are looking at.

SEE ALSO:
  cs open, cs search.
"#;

/// `cs graph` long help (manpage head).
pub(crate) const CS_GRAPH: &str = r#"Open the workspace graph in a window and Hybrid side.

The graph is the workspace's link structure. Files, contact notes
included, are the stored nodes; wiki-links, markdown links, #tag and
@@mention edges are stored per file as link / tag / mention edges.
Directory containment and per-file language are NOT stored: they are
derived at query time from the workspace catalog and the maintained
report, so folder and language nodes appear without ever being written
to the graph.

Bare `cs graph` opens the graph at workspace scope. With PATH it focuses
that file or directory; PATH is resolved against the terminal's cwd and
must be inside the workspace.

The target defaults to $CHAN_WINDOW_ID. `--window`, `--pane`, and
`--side a|b` address another exact live destination. Workspace windows
only: a standalone terminal refuses with "cs graph is only available in
a workspace window; this is a standalone terminal."

Navigating the tab: drag the background to pan, wheel to zoom toward the
cursor, drag a node to move it. A click selects a node and opens the
inspector; a double-click on a directory node expands or collapses its
children in place. Re-rooting is the inspector's "Graph from here",
which spawns a NEW graph tab; the ancestor breadcrumb re-scopes the
current tab in place. Right-click opens the tab menu, which carries the
Depth slider and the node-type filter chips (tag, contact, language,
media, folder, markdown, source), each with its count.
"#;

/// `cs graph` examples, side effects, and caveats.
pub(crate) const CS_GRAPH_AFTER: &str = r#"EXAMPLES:
  cs graph
    workspace-scoped graph; stderr: "graph request queued"
  cs graph notes/design.md
    focused on one file; stderr:
    "graph request queued for notes/design.md"
  cs graph crates/chan-server/src
    focused on a directory
  cs graph --window win-2 --pane pane-4 --side b
    workspace graph in pane-4 side B of win-2
  cs open 'chan://graph?s=workspace&m=s'
    reopens a serialized view; the "Copy link to graph" command puts
    such a link on the clipboard

SIDE EFFECTS:
  Opens a Graph tab in the target window. Nothing is written to the
  workspace. The confirmation line goes to stderr; stdout stays empty.

CAUTIONS:
  Refuses unless the exact target window is connected. Once queued it
  returns without waiting for the tab to render.

CAVEATS:
  Workspace windows only. A PATH outside the workspace root is
  refused; a PATH that does not exist on disk is sent as a file
  scope. --window defaults to $CHAN_WINDOW_ID; --pane and --side
  default to the active pane and visible side at dequeue time.

SEE ALSO:
  cs open, cs search.
"#;

/// `cs open` long help (manpage head).
pub(crate) const CS_OPEN: &str = r#"Open a path, directory, or chan://graph link in a window and side.

A directory -- or no argument at all, which means the terminal's current
directory -- opens the File Browser there. A text file opens in the
editor, on the surface its extension implies: .md / .txt land in the
markdown editor, .excalidraw in the drawing canvas, .json in the
collapsible tree, .csv / .tsv in the table, and every other text format
in source mode. A path that does not exist yet is created as an empty
file and opened, as long as its name is a text-class name. An argument
starting with chan://graph? (the string a graph tab's "Copy link to
graph" produces) reopens that graph view instead of touching the
filesystem.

Workspace windows only, and the path must resolve inside the workspace
root. The target defaults to $CHAN_WINDOW_ID. `--window`, `--pane`, and
`--side a|b` select an exact destination. The command launcher's "Open"
entry runs the same path, so what you can type here you can also type
there.
"#;

/// `cs open` examples, side effects, and caveats.
pub(crate) const CS_OPEN_AFTER: &str = r#"EXAMPLES:
  cs open notes/plan.md
    Opens the note in the markdown editor.
  cs open diagram.excalidraw
    Opens the drawing canvas; source mode shows the raw scene JSON.
  cs open .
    Opens the File Browser on the terminal's current directory.
  cs open data/rows.csv
    Opens the table view.
  cs open notes/plan.md --window win-2 --pane pane-4 --side b
    Opens the note directly in pane-4 side B of win-2.

SIDE EFFECTS:
  Queues ONE command to the exact target window and returns; the tab
  appears asynchronously. The ack ("open request queued for <rel>")
  goes to stderr; stdout stays empty.
  A path that does not exist is CREATED as an empty file before it is
  opened.

CAUTIONS:
  Refuses an offline target rather than claiming it queued. Exit 0
  means the connected target accepted the queue, not that the file is
  on screen. A stale pane id can still fail when the SPA dequeues it.

CAVEATS:
  A file whose bytes are not text is refused with "cannot open binary
  file <rel>". A path outside the workspace root is refused. In a
  standalone terminal the command refuses and points at 'chan open
  PATH', which loads the path AS a workspace window. --pane and --side
  default to the target's active pane and visible side at dequeue time.

SEE ALSO:
  cs graph, cs search, cs terminal new, chan open; chan dump-skill --topic
  open.
"#;

/// `cs pane` long help (manpage head).
pub(crate) const CS_PANE: &str = r"Design and inspect a window's pane layout.

DESCRIPTION:
A window is a tree of split panes. Every pane is a Hybrid with two
permanent tab sides, A and B, one visible side, and one active tab per
side. `cs pane list` reports every pane and both sides, including an
explicit empty side. Bare `cs pane` is a compatibility alias for list.
`--json [--pretty]` emits the complete nested snapshot.

The layout commands are `new right|bottom`, `focus`, `resize`,
`equalize`, `swap`, and `close`. `new` prints the new pane id, so a
script can place later tabs there. `focus --side a|b` selects a pane
and side atomically. `split` and `close-pane` remain compatibility
aliases; `close-tab` and `close-all` remain available until tab
lifecycle gets its own command.

The target is `--window <id>`, the window owning `--tab-name <name>`,
or $CHAN_WINDOW_ID in that order. `--window` and `--tab-name`
conflict. Workspace and standalone terminal windows both accept pane
commands.
";

/// `cs pane` examples, side effects, and caveats.
pub(crate) const CS_PANE_AFTER: &str = r#"EXAMPLES:
  cs pane list --json --pretty
    every pane with side A and side B

  right=$(cs pane new right)
  cs terminal new --pane "$right" --side a --tab-name @@Runner
    creates, focuses, and prints the new pane, then queues the
    terminal directly into side A

  cs pane focus pane-4 --side b
    selects pane-4 and its B side in one operation

  cs pane equalize --pane pane-4
    sets pane-4's nearest enclosing split to 50/50

  cs pane swap pane-7 --pane pane-4
    swaps the complete Hybrid contents of pane-4 and pane-7

  cs pane resize 0.1 --pane pane-4
    grows pane-4 inside its nearest enclosing split

SIDE EFFECTS:
  A mutation changes the live layout, is visible immediately, and
  schedules a save of the window's session, so it survives a
  reload. The close ops discard tabs. The report (or the exec
  summary and its `blocked:` list) goes to stdout; errors go to
  stderr.

CAUTIONS:
  Every call blocks on the exact target window's reply and gives up
  after 5s with "no reply from the window (is it open in a browser?)" --
  which is what a window whose browser tab was closed looks like.
  A close blocked by an unsaved file or a live terminal still
  prints its summary and the blocked tabs, then exits non-zero.
  `--force` closes past unsaved edits and live terminals; no UI
  confirm dialog is raised on either path.

CAVEATS:
  With no --window, $CHAN_WINDOW_ID, or `--tab-name` the command
  refuses: "cs pane needs a target: run inside a chan terminal
  ($CHAN_WINDOW_ID) or pass --tab-name". A `--tab-name` owned by
  more than one live window is refused, not guessed.
  Closing the last pane clears its tabs instead of removing it: a
  window always keeps one pane.
  Pane ids are runtime window-local handles, not durable names.

SEE ALSO:
  cs terminal new (accepts --pane and --side), cs window, cs session.
"#;

/// `cs paste` long help (manpage head).
pub(crate) const CS_PASTE: &str = r#"Write the clipboard of the machine viewing this window to stdout.

Same viewing-machine rule as cs copy: the bytes come off the system
clipboard of whoever is looking at the window, which is what makes
"Cmd+C locally, cs paste inside a devserver workspace" work, and what
lets one workspace pick up what another one copied.

Output is RAW bytes, so 'cs paste > shot.png' yields a real PNG. With
no flag the preference is image first, then plain text; HTML is never
chosen automatically. --text, --html and --image each force one
representation. The emitted MIME is reported on stderr so a redirect
to a file stays clean.
"#;

/// `cs paste` examples, side effects, and caveats.
pub(crate) const CS_PASTE_AFTER: &str = r#"EXAMPLES:
  cs paste > shot.png
    Writes the clipboard image; prints "image/png" on stderr.
  cs paste --text > snippet.txt
    Forces the plain-text representation.
  cs paste --html > rich.html
    Takes the rich-text representation instead of the image.

SIDE EFFECTS:
  BLOCKS on a clipboard read in the window, then writes the raw bytes
  to stdout and the MIME to stderr. Nothing is written to disk and
  the clipboard is not modified.

CAUTIONS:
  Do not dump it to a live TTY: clipboard text can carry control and
  escape sequences. Redirect to a file, or pipe through a sanitizer.
  After 2 seconds with no reply the CLI prints a waiting notice; a
  browser that needs a user gesture raises a paste card in the window
  whose [Paste] button carries the click the read wants, and the
  desktop's native read can itself be waiting on the viewing
  machine's clipboard owner. An unanswered request ends at the
  server's 30-second bound and the CLI exits 124. Payloads are capped
  at 32 MB.

CAVEATS:
  --text, --html and --image are mutually exclusive. A forced
  representation that is not on the clipboard fails with "clipboard
  is empty" (exit 1) rather than falling back to another one.

SEE ALSO:
  cs copy, cs upload, cs download; chan dump-skill --topic clipboard.
"#;

/// `cs search` long help (manpage head).
pub(crate) const CS_SEARCH: &str = r"Query, browse and traverse the workspace behind this terminal.

One request covers three things: lexical content search, entity browsing,
and graph traversal from typed seeds. A plain QUERY searches content and
every entity domain at depth 0. `--from` seeds are exact and default to
one hop. A non-content `--domain` with no query browses that entity kind.

Selectors are TYPE:VALUE, TYPE one of file, directory, tag, mention,
contact, language:

  file:notes/design.md        workspace-relative path
  directory:crates/chan-server   `directory:.` is the root
  tag:design                  leading # optional, case-insensitive
  mention:alex                leading @@ optional
  contact:contacts/alex.md    path, basename, title, email or alias
  language:Rust               needs a maintained report

--domain takes those same six names plus `content`.

Relationship kinds: link, tag and mention come from the stored graph;
language and contains are derived at query time. --direction auto (the
default) resolves per seed -- out for file and directory seeds, both for
tag, mention, contact and language seeds; out, in and both override it
for every seed.

Markdown by default (## Content, ## Entities, ## Graph, ## Warnings, ##
Errors sections); --json emits the core result unchanged, --json --pretty
indents it. Session-scoped: it needs $CHAN_CONTROL_SOCKET but no window
id. Workspace windows only.
";

/// `cs search` examples, side effects, and caveats.
pub(crate) const CS_SEARCH_AFTER: &str = r#"EXAMPLES:
  cs search retry backoff
    content hits as "path:line - heading" plus a snippet, matched
    terms wrapped in **
  cs search --from file:notes/design.md --depth 2
    everything within two hops of that file, following its outgoing
    link / tag / mention edges
  cs search --from tag:design --edge-kind tag
    the files carrying #design (tag seeds traverse both directions)
  cs search --domain tag
    browse every tag in the workspace, no query needed
  cs search --from language:Rust --edge-kind language --json --pretty
    the Rust files, as indented JSON

SIDE EFFECTS:
  Read-only: nothing is written to the workspace and no tab is
  opened. The result prints on stdout.

CAUTIONS:
  Defaults and caps: --limit 20 (max 100), --node-limit 100 (max
  1000), --edge-limit 250 (max 2500), --depth max 10. Exceeding a
  max clamps to it and adds a "<field> was clamped from N to M" line
  under ## Warnings instead of failing. --limit applies to content
  hits and entity matches independently. Structured errors still
  print their ## Errors section, then exit nonzero.

CAVEATS:
  Workspace windows only: a standalone terminal refuses with "cs
  search is only available in a workspace window; this is a
  standalone terminal." A request with no QUERY, no --from and no
  non-content --domain is rejected before it is sent. An ambiguous
  contact or mention selector fails instead of guessing; the
  candidate list rides in the JSON error payload. Language selectors
  and the language domain need a maintained report.

SEE ALSO:
  cs graph, cs open.
"#;

/// `cs session` long help (manpage head).
pub(crate) const CS_SESSION: &str = r"Inspect a shared workspace session and move its leadership.

DESCRIPTION:
Every window connected to a workspace is a participant in one shared
session, and exactly one participant leads it. `list` prints the
roster (window, name, role, status) as markdown, or as records with
`--json [--pretty]`. Bare `self` is the whoami: your window, name,
role, status, whether you lead, and your gateway identity when one
was asserted. `self --name <name>` renames you in the roster (it
renames the participant, not the terminal tab); `self --reset`
clears that name back to your gateway identity or generated
default.

`handover` is the polite path: a follower asks the leader for
leadership (`--to <window>` names a different beneficiary) and
BLOCKS until the leader answers or the timeout runs out. The leader
can answer from its own terminal with `handover --accept` /
`handover --reject`. `takeover` is the unilateral path: it succeeds
only when the leader is gone, unless `--force`.

Workspace windows only. `list` needs $CHAN_CONTROL_SOCKET; `self`,
`handover` and `takeover` additionally need $CHAN_WINDOW_ID, since
they act as that participant.
";

/// `cs session` examples, side effects, and caveats.
pub(crate) const CS_SESSION_AFTER: &str = r#"EXAMPLES:
  cs session list
    a | window | name | role | status | table; role is leader or
    follower

  cs session self
    a field table for you alone: window, name, role, status,
    leader yes/no, and identity when the gateway asserted one

  cs session self --name Alice
    -> "renamed to Alice", and every window's roster updates

  cs session handover --timeout 60
    blocks up to 60s, then prints "handover accepted; <window> now
    leads" or "handover rejected"

  cs session takeover --force
    -> "you are now the leader", seized from a live leader

SIDE EFFECTS:
  A rename, a reset, an accepted handover and a takeover all
  rebroadcast the session roster, so every connected window sees
  the change. A handover REQUEST pushes a prompt into the leader's
  window. Each mutation prints one line on stdout; the queries
  print their table.

CAUTIONS:
  `handover` blocks: 30s by default, `--timeout <secs>` to change
  it. When nobody answers it prints "no answer within Ns" and exits
  124; the pending request is dropped, so a late answer finds
  nothing waiting.
  Only one handover is allowed in flight: a second gets "another
  handover is already in flight".
  `takeover --force` seizes leadership from a LIVE leader with no
  prompt and no confirmation.

CAVEATS:
  All four actions refuse on a standalone terminal: "cs session
  <action> is only available in a workspace window; this is a
  standalone terminal. Standalone terminals have no shared session
  to lead."
  A plain `takeover` against a live leader is refused ("the leader
  is live; ask with `cs session handover`, or seize it with
  `--force`"), and `handover` against a disconnected leader is
  refused the other way ("the leader is not connected; use `cs
  session takeover` instead").
  `self --name` conflicts with `--reset`.

SEE ALSO:
  cs window, cs pane.
"#;

/// `cs terminal` long help (manpage head).
pub(crate) const CS_TERMINAL: &str = r#"Operate the server's live terminal sessions by tab name and group.

Every chan-spawned terminal is a session in the server's registry,
tagged with a tab name ($CHAN_TAB_NAME, when the tab is named) and a
group ($CHAN_TAB_GROUP, "default" when unset). Those two are the
selectors: --tab-name matches every session with exactly that name,
--tab-group matches every session in that group, and passing both
narrows to the intersection. write, restart and close require at
least one selector, so a forgotten filter cannot fan out to every
terminal by accident; scrollback takes --tab-name only and demands a
single match.

Selection is server-wide, not window-scoped: write, list, restart,
close and scrollback reach every live session this server owns,
whichever window (or none) hosts it. Of those, none targets a
window; `new` does, the caller's own, via $CHAN_WINDOW_ID. Every
subcommand needs $CHAN_CONTROL_SOCKET.

Subcommand prefixes infer, so `cs te n` / `cs te w` / `cs te l` are
terminal new / write / list. A bare t is too short to infer: it
matches both terminal and tunnel.

A standalone terminal (the workspace-less terminal tenant) supports
ALL of this: tab names, groups, the write queue, restart, close and
scrollback. Only `terminal new --path` and `terminal team` refuse
there, both for want of a workspace root. That makes a standalone
terminal fully automatable and the right place to manage the chan
library itself (`chan open`, `chan close`, `chan close --remove`,
`chan ps`), while real work belongs in a workspace window, where the
launcher, the apps and the workspace-only cs commands (open, graph,
search, export, session, terminal team) exist.
"#;

/// `cs terminal` examples, side effects, and caveats.
pub(crate) const CS_TERMINAL_AFTER: &str = r#"EXAMPLES:
  cs terminal list
    every live session, grouped, as a markdown table

  cs terminal new --tab-name @@Alice --tab-group alpha
    opens a named, grouped tab in the caller's window

  cs terminal write --tab-group alpha $'git status\n'
    runs the command in every tab of group alpha

  cs terminal close --tab-group alpha
    tears the whole group down and frees its tab names

THE RICH PROMPT (typing INTO an agent by hand):
`cs terminal write` is the programmatic way to put text in front of an
agent. The Rich Prompt is the human one: a floating markdown composer
over the bottom of a terminal, for input too long or too rich to type
at a raw prompt. Toggle it with Cmd+Shift+P (Ctrl+Shift+P on Linux and
Windows), or "Show/Hide Rich Prompt" in the command launcher.

It edits a real per-terminal draft with the same editor file tabs use,
so PASTING AN IMAGE works: the image lands as a markdown embed and
renders in the composer straight away. Cmd+Enter (Ctrl+Enter) submits.

On submit, each image embed is delivered to the agent as the bare
ABSOLUTE on-disk path, not the `![](...)` markdown -- so an agent that
reads the line gets a path it can open, while the composer keeps
showing you the picture. That is how you hand an agent a screenshot.

Submissions ride the same per-terminal queue as `cs terminal write`,
so a poke from another terminal cannot interleave with what you are
typing.

CAVEATS:
  Tab names are not unique: several sessions can carry the same
  name, in which case write / restart / close hit every holder and
  scrollback refuses as ambiguous.

  On a standalone terminal, `cs terminal new --path` and `cs
  terminal team` refuse with "only available in a workspace window;
  this is a standalone terminal". There is no env var that tells a
  workspace window from a standalone terminal, so that refusal is
  the honest signal.

SEE ALSO:
  cs terminal survey (ask a human and block), cs terminal team (Team
  Work), cs pane (the layout a tab lands in), cs window. chan dump-skill
  --topic cs-terminal-write.
"#;

/// `cs terminal close` long help (manpage head).
pub(crate) const CS_TERMINAL_CLOSE: &str = r"Close (tear down) live terminal session(s) selected by name and/or
group.

Kills the PTY and removes the session from the registry, so its tab
name frees for re-use. The teardown partner to `new` and `restart`,
and the clean alternative to killing the pid out of band, which
leaves the entry lingering and holding its name. At least one of
--tab-name / --tab-group is required; --tab-group tears down a
whole group (a finished team, say) in one call.
";

/// `cs terminal close` examples, side effects, and caveats.
pub(crate) const CS_TERMINAL_CLOSE_AFTER: &str = r#"EXAMPLES:
  cs terminal close --tab-name @@Alice
    closes that tab; prints "closed 1 terminal session(s)"

  cs terminal close --tab-group alpha
    closes every tab in group alpha

  cs terminal close --tab-name @@Alice --tab-group alpha
    closes @@Alice's tab only if it is in group alpha

SIDE EFFECTS:
  Kills each matching PTY and drops its registry entry, taking its
  scrollback ring and any pending queued writes with it. The ack
  goes to stderr.

CAUTIONS:
  Destructive and unconfirmed: there is no force flag and no undo.
  A bare --tab-group closes EVERY session in that group. No
  selector match is an error ("no live terminal session matched").

SEE ALSO:
  cs terminal restart (relaunch instead), cs pane close-tab (close a tab
  within the layout), cs terminal new.
"#;

/// `cs terminal list` long help (manpage head).
pub(crate) const CS_TERMINAL_LIST: &str = r#"List every live terminal session this server owns, grouped by tab
group.

The markdown table carries one row per session: name, spawn, agent,
session id, window, pane, side, tab, window kind, window status,
queue and cwd. `agent` is the server-derived submit agent (claude
/ codex / gemini / kimi / opencode, `-` for a shell session),
derived from the session's spawn command and CHAN_AGENT spawn env;
it is what a `cs terminal write --submit` delivery will actually
encode for, so read it here instead of guessing a target's chord.
`queue` is the number of logical messages still pending in that
session's write queue: `0` is an idle queue, and a deep queue means
that session has not seen the latest write yet. The window columns
are resolved against the library's window set, so a session reads
back kind `workspace`, `standalone-terminal` or `control` with
status `alive` / `offline` while its window has a row, `orphaned`
once that window is gone, and `none` when the session was created
outside any browser window. --json emits the raw payload
({"groups": {...}}) instead; --json --pretty indents it. The JSON
form carries the same `agent` field (null for a shell session) and
the same count as `queue_depth`.
"#;

/// `cs terminal list` examples, side effects, and caveats.
pub(crate) const CS_TERMINAL_LIST_AFTER: &str = r#"EXAMPLES:
  cs terminal list
    a markdown table per group, or "No live terminal sessions."

  cs terminal list --json --pretty
    the same data as indented JSON

  cs te l --json | jq -r '.groups.alpha[].name'
    just the tab names of group alpha

SIDE EFFECTS:
  Read-only. Both the markdown and the JSON go to stdout.

CAVEATS:
  This is the live session registry, not a directory of tab names:
  a name shows up only while its terminal is alive, and the same
  name can appear twice. A standalone serve has no library window
  set, so every session there reads back `orphaned`.

SEE ALSO:
  cs window list (the window set), cs pane (layout within one window), cs
  terminal scrollback (read one session's output).
"#;

/// `cs terminal new` long help (manpage head).
pub(crate) const CS_TERMINAL_NEW: &str = r#"Open a new terminal tab in a window and Hybrid side.

The target defaults to the caller's own window ($CHAN_WINDOW_ID),
active pane, and visible side. `--window`, `--pane`, and `--side a|b`
address another live destination directly.
--tab-name sets $CHAN_TAB_NAME inside the new terminal and
--tab-group sets $CHAN_TAB_GROUP ("default" when omitted); those are
what a later `cs terminal write` / restart / close selects on. The
optional path sets the tab's working directory: workspace-relative,
or absolute under the workspace root, and a file resolves to its
parent directory. Pathless `new` also works on a standalone
terminal; --path is workspace-only. --command runs a command instead
of the default shell. Repeat --env KEY=VALUE to set its spawn
environment; CHAN_AGENT can identify an unrecognised agent launcher.
"#;

/// `cs terminal new` examples, side effects, and caveats.
pub(crate) const CS_TERMINAL_NEW_AFTER: &str = r#"EXAMPLES:
  cs terminal new
    a tab at the workspace root, unnamed, group "default"

  cs terminal new notes/ --tab-name @@Alice --tab-group alpha
    a named tab in group alpha, cwd notes/

  cs terminal new --pane pane-4 --side b --tab-name build
    a named terminal in pane-4 side B

  cs terminal new README.md
    a tab whose cwd is README.md's parent directory

  cs terminal new --tab-name @@Agent --command './run-agent.sh' \
    --env CHAN_AGENT=codex
    a codex-derived session even though the launcher name is unrecognised

SIDE EFFECTS:
  Queues a tab in the target window. The one-line ack ("terminal
  request queued", or "terminal request queued for <path>") goes to
  stderr; stdout stays empty.

CAUTIONS:
  The ack means the request was queued to the exact connected window,
  not that the tab exists yet: creation is asynchronous. An offline
  target errors instead of claiming it queued.

CAVEATS:
  Needs --window or $CHAN_WINDOW_ID plus $CHAN_CONTROL_SOCKET; without
  it the command refuses ("this needs $CHAN_WINDOW_ID"). On a
  standalone terminal a --path is refused with "cs terminal new --path
  is only available in a workspace window"; drop --path to open a
  terminal there.

SEE ALSO:
  cs terminal write (drive the new tab), cs terminal close (tear it down),
  cs pane (where the tab lands).
"#;

/// `cs terminal restart` long help (manpage head).
pub(crate) const CS_TERMINAL_RESTART: &str = r"Restart live terminal session(s), preserving or overriding their spawn command
and environment.

The server respawns the PTY under the same session id, so an
attached viewer re-attaches to the relaunched terminal instead of
losing the tab, and a session started as an agent comes back as
that agent. Tab name, group and window are preserved, so later
selectors still find it. At least one of --tab-name / --tab-group
is required. With no --command or --env, command and environment are
preserved exactly. --command replaces the command; repeated --env
KEY=VALUE entries override matching variables and preserve the rest.
This is the out-of-band path the Team Work bootstrap needs: a shell
cannot restart the very shell running its own script, but the server can.
";

/// `cs terminal restart` examples, side effects, and caveats.
pub(crate) const CS_TERMINAL_RESTART_AFTER: &str = r#"EXAMPLES:
  cs terminal restart --tab-name @@Alice
    relaunches @@Alice's agent; prints "restarted 1 terminal
    session(s)"

  cs terminal restart --tab-group alpha
    recycles every member of that team in one call

  cs terminal restart --tab-name @@Alice --command './run-agent.sh' \
    --env CHAN_AGENT=codex
    relaunches @@Alice as a codex-derived agent session

SIDE EFFECTS:
  Kills and respawns each matching PTY. Whatever the old process
  held in memory is gone, and anything still sitting in that
  session's write queue is dropped. The ack goes to stderr.

CAUTIONS:
  Destructive to running work: a restart interrupts an agent
  mid-task, with no confirmation step. No selector match is an
  error ("no live terminal session matched").

SEE ALSO:
  cs terminal close (tear down instead of relaunch), cs terminal write
  (its queue does not survive a restart).
"#;

/// `cs terminal scrollback` long help (manpage head).
pub(crate) const CS_TERMINAL_SCROLLBACK: &str = r"Dump a live terminal session's scrollback, its replay ring, to
stdout, selected by tab name.

The bytes are the raw PTY stream, the same replay a fresh viewer
attaches to, so they carry that terminal's escape sequences. It is
how a lead process reads what a worker's terminal actually printed.
Exactly one session must match the name: zero is an error and two
or more is refused as ambiguous. There is no group axis, since
scrollback reads one terminal's history.
";

/// `cs terminal scrollback` examples, side effects, and caveats.
pub(crate) const CS_TERMINAL_SCROLLBACK_AFTER: &str = r#"EXAMPLES:
  cs terminal scrollback --tab-name @@Alice
    prints @@Alice's replay ring to stdout

  cs terminal scrollback --tab-name @@Alice > alice.log
    captures it for later reading

  cs terminal scrollback --tab-name @@Alice | tail -40
    the tail of what that terminal printed

SIDE EFFECTS:
  Read-only. The scrollback goes to stdout with no trailing newline
  added: the ring already carries the session's own line breaks.

CAUTIONS:
  The output is raw PTY bytes, control and escape sequences
  included, so redirect it to a file or a pager rather than dumping
  it into a live TTY. The ring is bounded, so a long-running
  session shows only its tail.

CAVEATS:
  --tab-name is required and must match exactly one live session:
  two sessions sharing a name fail with "N live sessions match tab
  name ...; scrollback needs a single match". A closed session is
  no longer in the registry, so it has no scrollback to read.

SEE ALSO:
  cs terminal list (find the tab name), cs terminal write (drive the same
  tab).
"#;

/// `cs terminal survey` long help (manpage head).
pub(crate) const CS_TERMINAL_SURVEY: &str = r#"Ask the host a question in an overlay and block until they answer.

Raises a survey over every SPA window that owns a matching terminal tab
and holds the connection open until the host picks an option, defers
with [F], dismisses it, or the timeout elapses. At least one selector
(--tab-name and/or --tab-group) is required, plus 1..=4 --option values
and a markdown body (positional words, or --stdin for multi-line).

The reply goes to STDOUT so it captures cleanly in $(...): the chosen
option label, "host will follow up later" on [F], or "survey dismissed;
no answer". A timeout prints to stderr and exits 124, leaving stdout
empty.

This is how an agent reaches a human here: a window overlay, not a TUI
prompt. Works in a workspace window and in a standalone terminal alike
-- what it needs is a live window owning the target tab.
"#;

/// `cs terminal survey` examples, side effects, and caveats.
pub(crate) const CS_TERMINAL_SURVEY_AFTER: &str = r#"EXAMPLES:
Each case shows the invocation and the JSON survey the SPA receives.
`surveyId` is empty from the CLI; the server mints it before the SPA sees
it. Every overlay shows the options PLUS [F] (follow up) and Dismiss, so
the blocking call prints one of: the chosen option label; "host will
follow up later" on [F] (the host will answer later in a separate
prompt -- treat it as "more is coming", NOT an answer and NOT a drop);
or "survey dismissed; no answer" when the host drops it.

Single question, two options:
  cs terminal survey --tab-name @@Alice \
    --title "Merge order" --option "A first" --option "B first" \
    "Which patch lands first?"

  {
    "surveyId": "",
    "title": "Merge order",
    "bodyMarkdown": "Which patch lands first?",
    "options": ["A first", "B first"]
  }

Four options, no title, multi-line body from stdin:
  printf 'Pick a slot:\n\n- morning\n- evening' \
    | cs terminal survey --tab-group leads --stdin \
        --option Mon --option Tue --option Wed --option Thu

  {
    "surveyId": "",
    "title": null,
    "bodyMarkdown": "Pick a slot:\n\n- morning\n- evening",
    "options": ["Mon", "Tue", "Wed", "Thu"]
  }

SIDE EFFECTS:
  - Opens an overlay in every window owning a matching tab; the first
    reply wins and the stale overlays in the other windows are closed.
  - The answer / follow-up / dismissal line goes to stdout; the timeout
    notice goes to stderr.

CAUTIONS:
  - BLOCKS. Default --timeout is 600 seconds; on elapse it prints
    "no reply within <secs>s" to stderr and exits 124.
  - Surveys addressed to the same target run ONE at a time: a later one
    waits in a per-target FIFO (cap 100 open plus waiting) and only
    opens once the earlier ones resolve. --timeout bounds the TOTAL
    wait, so a survey can time out while still queued, without ever
    opening an overlay. Past the cap the call is refused outright.
  - Keep it to one decision and up to 4 options. Batch or sequence
    several pending questions instead of firing many tiny surveys.

CAVEATS:
  - --tab-name must match a live tab of the window you want the overlay
    in; a selector matching no live session is an error. When the host
    has no tab of their own, target the lead's tab (or the team's
    group).
  - [F] is a deferral signal, not an answer: do not act on the surveyed
    question until the host's follow-up prompt arrives.

SEE ALSO:
  cs terminal write (queued poke), cs terminal team (spawn the team whose
  host you survey).
"#;

/// `cs terminal team` long help (manpage head).
pub(crate) const CS_TERMINAL_TEAM: &str = r"Create, load and bring up a team of agent terminals from one config.

A team is one workspace-relative directory. `new` validates the config
you hand it, writes {dir}/config.toml, regenerates {dir}/bootstrap.md,
creates the tasks/ journals/ followups/ tree, then spawns the members
lead-first. Each agent is poked when its own PTY enables bracketed-paste
mode; the per-agent waits run concurrently and stop after 15 seconds
with every unready member named in a non-zero result. `load` re-reads an
existing {dir}/config.toml and spawns the same team again. `--script` on
either prints the whole bootstrap as a runnable shell script instead of
mutating anything; its fixed `sleep 3` is an approximation because the
script cannot observe server-owned PTY state. This is the CLI equivalent
of the Cmd+P Team Work dialog.

The config carries team_name, host_name, host_handle, tab_group and 1
to 9 [[members]], exactly one of them is_lead. Each member has a handle
(it becomes the tab's $CHAN_TAB_NAME), a command and optional env. The
submit-encoding agent is DERIVED from the command by loose whole-word
match (claude / codex / gemini / kimi / opencode); set CHAN_AGENT in a
member's env to force it for an unorthodox launcher. A command matching
none is a plain shell member: it spawns, but gets no submit chord and
no identity poke.

A member may also carry `position = { row = R, col = C }`, the grid
coordinate the Team Work dialog's split layout saves. A positioned
config surfaces as that pane grid instead of stacking: the target
window must hold a single pane (the seed the grid carves), or the
spawn is refused naming the ways out. A member-free grid cell receives
the seed pane's existing tabs, so the terminal you ran `cs` from keeps
a pane of its own. `--tabs` ignores positions and stacks every member;
an explicit `--pane` names the seed pane and skips the single-pane
requirement.

The generated bootstrap.md is what every member reads. It already
carries the roster (each peer's handle, launch command, derived agent
and role), the hold-until-poked rule, the task-file protocol under
tasks/, the per-member journal, the between-tasks queue-draining
discipline, and how the lead reaches the host with `cs terminal survey`.
Pass `--brief FILE` on `new` to fold a round's own operating
instructions VERBATIM into bootstrap.md as its own section after the
Roster -- that is the normal way to give a team its work, and it
survives a regenerate, unlike hand-editing the generated file.

Working as a team's host is different from working 1:1 with one agent.
The generated bootstrap sets the shape: the host sets scope and is
reached through the lead; the lead distributes tasks, sequences the
work and aggregates requests for the host; workers do not contact the
host directly.

Workspace windows only, including --script: a standalone terminal has no
workspace tree to seed a team into. The team's .md files are indexed and
graphed like any other workspace content.
";

/// `cs terminal team` examples, side effects, and caveats.
pub(crate) const CS_TERMINAL_TEAM_AFTER: &str = r#"EXAMPLES:
A team is one config.toml (the on-disk `{dir}/config.toml` shape).
Members are 1..=9, exactly one `is_lead = true`. The submit-encoding
agent (claude / codex / gemini / kimi / opencode) is DERIVED from each
member's `command`: a loose whole-word match, so `claude --resume` or
`/usr/local/bin/codex-cli` resolve. A command that matches none is a
plain shell member (no submit chord). To force the agent for an
unorthodox launcher, set `CHAN_AGENT` in the member's env (claude /
codex / gemini / kimi / opencode, or none / shell to force a shell).
`created_at` is optional: the server stamps the current time when it is
omitted.

  # myteam.toml
  team_name   = "alpha"
  host_name   = "Neo"
  host_handle = "@@Neo"
  tab_group   = "alpha"

  [[members]]
  handle  = "@@Lead"
  command = "claude"
  is_lead = true

  [[members]]
  handle  = "@@Alice"
  command = "codex"

  # A custom launcher the command can't reveal: name the agent.
  [[members]]
  handle  = "@@Bob"
  command = "./my-agent.sh"
  env     = { CHAN_AGENT = "gemini" }

Write the team (config.toml + the server-regenerated bootstrap.md + the
tasks/journals/followups tree) inside the workspace at `alpha/`, then
spawn it:
  cs terminal team new alpha --config myteam.toml

Provision the team with the round's work at the same time. The brief is
folded verbatim into bootstrap.md, so every member reads it as part of
its process doc:
  cs terminal team new alpha --config myteam.toml --brief round.md

Preview the WHOLE bootstrap as a runnable shell script (mutates nothing;
prints to stdout). Run it from a chan terminal at the workspace root to
spawn the team:
  cs terminal team new alpha --config myteam.toml --script

Pipe the config in instead of a file:
  cat myteam.toml | cs terminal team new alpha --stdin

Bring a saved team back up (or emit its bootstrap script):
  cs terminal team load alpha
  cs terminal team load alpha --script

HOLD FOR A CHECK BEFORE ANY WORK STARTS:
Members start as soon as they are poked, so if you want to inspect the
roster first, say so IN THE BRIEF -- there is no flag for it. A brief
that opens with:

  Read this bootstrap end to end, reply with your handle, your role and
  the peer you report to, then HOLD. Do not start any work until you
  are poked with a task path.

gives you a window to read each tab, fix the roster, and only then poke
the lead to distribute.

A WORKFLOW THAT SCALES:
  1. Keep a scratch directory for the round, outside the material you
     want indexed and graphed.
  2. Drop a requirements document in it: what to build, what done looks
     like, what not to touch.
  3. Give ONE agent that document and have it produce a roadmap -- the
     ordered, dependency-aware breakdown, with an owner per item.
  4. Spawn a team with that roadmap as its --brief, sized to the
     parallel items (a lead plus 2-4 workers goes a long way).
  5. Stay in the loop through the lead, who surveys you for decisions
     and reports completions.
The split matters: planning is one careful agent's job, execution is
where more terminals actually buy you throughput.

SIDE EFFECTS:
  - `new` writes {dir}/config.toml (normalized, with created_at
    stamped when omitted), regenerates {dir}/bootstrap.md, and creates
    {dir}/tasks, {dir}/journals, {dir}/followups.
  - `new` and `load` then SPAWN: one terminal per member, lead first,
    each tab named after the member's handle, in the team's tab group
    (`tab_group`, else the team name; a live collision resolves to
    <group>-2, -3, ...). Sessions bind to the calling window and
    surface as tabs in it.
  - Each AGENT member is poked as soon as its PTY enables
    bracketed-paste mode, with all member waits running concurrently.
    Shell members are spawned but never poked and do not wait.
  - `--script` mutates nothing and prints the script to stdout;
    otherwise the one-line spawn summary goes to stderr.

CAUTIONS:
  - `new` OVERWRITES {dir}/config.toml and regenerates bootstrap.md.
    bootstrap.md is tool-owned: hand edits are lost on the next write.
    Put your custom instructions in --brief instead.
  - Running `new` or `load` again spawns ANOTHER live copy of the team
    (in the next free group). Close the old one first with
    `cs terminal close --tab-group <group>`.
  - The call blocks until each agent is poked, its terminal ends, or its
    15-second readiness bound ends. An unready member is named, is not
    poked, and makes the command exit non-zero; ready peers are still
    poked.
  - `--script` uses a fixed `sleep 3` approximation because its shell
    path cannot observe the server's per-agent PTY readiness state.
  - A member whose command fails to start is reported and skipped; the
    rest of the team still comes up. Only a total failure is an error.

CAVEATS:
  - Workspace windows only, including `--script`. A standalone terminal
    refuses with a terminal-only message.
  - The dir must resolve inside the workspace: relative dirs join the
    caller's cwd, an absolute dir must be under the workspace root, and
    the workspace root itself is refused (name a subdirectory).
  - `--brief` is a `new` flag only: `load` never regenerates
    bootstrap.md, so there is nothing for a brief to fold into.
  - Exactly one member must be `is_lead`, and there must be 1..=9 of
    them; anything else is rejected before a single tab is spawned.

SEE ALSO:
  cs terminal write (the poke), cs terminal survey (lead to host), cs
  terminal scrollback (read a peer's terminal), cs terminal close
  --tab-group (retire a team).
"#;

/// `cs terminal team load` long help (manpage head).
pub(crate) const CS_TERMINAL_TEAM_LOAD: &str = r"Bring a team that already exists on disk back up.

Reads and revalidates {dir}/config.toml, then spawns the members exactly
the way `new` does after its write: lead first, one tab per handle in
the team's group. Each agent's identity poke waits for its own PTY to
enable bracketed-paste mode; the waits run concurrently with a
15-second bound that names every unready member and returns non-zero.
Nothing is written -- config.toml is not rewritten and
bootstrap.md is not regenerated, so a config.toml you hand-edited is
picked up as-is while the existing bootstrap.md stays untouched.

With `--script` it writes nothing and spawns nothing: the paste-and-run
bootstrap script for the saved team goes to stdout. Its fixed `sleep 3`
is an approximation of the server path's PTY readiness gate.

Without `--script`, `--window`, `--pane`, and `--side a|b` place every
surfaced member tab at one exact live destination. Members carrying
`position` grid coordinates surface as that pane grid instead of
stacking: the target window must hold a single pane (the seed the grid
carves), or the load is refused before anything is spawned, naming the
ways out. A member-free grid cell receives the seed pane's existing
tabs, so a host terminal that ran the command keeps a pane of its own.
`--tabs` ignores positions and stacks; an explicit `--pane` names the
seed pane and skips the single-pane requirement.
";

/// `cs terminal team load` examples, side effects, and caveats.
pub(crate) const CS_TERMINAL_TEAM_LOAD_AFTER: &str = r"EXAMPLES:
  cs terminal team load alpha
    -> revalidates alpha/config.toml and spawns the roster, lead first

  cs terminal team load teams/alpha --script > boot.sh
    -> emits the bootstrap script for the saved team; spawns nothing
  cs terminal team load alpha --pane pane-4 --side b
    -> surfaces every member in pane-4 side B

SIDE EFFECTS:
  - Spawns one terminal per member bound to the target window, surfaces
    it at the requested pane and side, then pokes each agent member.
  - Spawn summary to stderr; `--script` output to stdout.

CAUTIONS:
  - Loading a team that is already running spawns a SECOND copy in the
    next free tab group. Close the old one first.
  - A positioned config (grid layout) is refused while the target
    window holds more than one pane. Close the extra panes, pass
    --tabs, or rerun with --window against a fresh window.
  - Blocks until every agent is poked, its terminal ends, or its
    15-second readiness bound ends. An unready member is named, is not
    poked, and makes the command exit non-zero; ready peers are still
    poked.
  - `--script` uses a fixed `sleep 3` approximation and cannot observe
    the server's per-agent PTY readiness state.
  - A hand-edited config.toml that fails validation is refused here,
    with the first failure as the message.

CAVEATS:
  - Workspace windows only, including `--script`.
  - Placement flags conflict with `--script`, which does not surface
    tabs. --window defaults to $CHAN_WINDOW_ID.
  - `load` never regenerates bootstrap.md, so there is no `--brief`
    here. To fold a new brief in, re-run `cs terminal team new` with
    the same dir.

SEE ALSO:
  cs terminal team new, cs terminal close --tab-group, chan dump-skill
  --topic teams.
";

/// `cs terminal team new` long help (manpage head).
pub(crate) const CS_TERMINAL_TEAM_NEW: &str = r"Validate a team config, materialize the team directory, and bring the
team up.

Reads the config from `--config FILE` or `--stdin` (exactly one),
stamps `created_at` when the config omits it, validates it, then writes
{dir}/config.toml, the regenerated {dir}/bootstrap.md and the tasks/
journals/ followups/ tree inside the workspace. It then spawns one
terminal per member, lead first. Each agent is poked when its own PTY
enables bracketed-paste mode; the waits run concurrently and have a
15-second bound that names every unready member and returns non-zero.

`--brief FILE` folds that file's text verbatim into bootstrap.md after
the Roster, which is how a round's operating instructions reach every
member and survive a later regenerate. `--script` turns the whole thing
into a preview: the paste-and-run bootstrap script goes to stdout and
nothing is written or spawned. The script's fixed `sleep 3` is an
approximation because it cannot observe server-owned PTY state.

Without `--script`, `--window`, `--pane`, and `--side a|b` place every
surfaced member tab at one exact live destination. Members carrying
`position` grid coordinates surface as that pane grid instead of
stacking: the target window must hold a single pane (the seed the grid
carves), or the command is refused before anything is written or
spawned, naming the ways out. A member-free grid cell receives the
seed pane's existing tabs, so a host terminal that ran the command
keeps a pane of its own. `--tabs` ignores positions and stacks; an
explicit `--pane` names the seed pane and skips the single-pane
requirement.
";

/// `cs terminal team new` examples, side effects, and caveats.
pub(crate) const CS_TERMINAL_TEAM_NEW_AFTER: &str = r"EXAMPLES:
  cs terminal team new alpha --config myteam.toml
    -> writes alpha/{config.toml,bootstrap.md,tasks,journals,followups}
       and spawns the roster, lead first

  cs terminal team new teams/alpha --config myteam.toml --brief round.md
    -> same, with round.md folded into bootstrap.md as its own section

  cs terminal team new alpha --config myteam.toml --script > boot.sh
    -> writes nothing; boot.sh recreates the team using only `cs` plus
       plain shell

  cat myteam.toml | cs terminal team new alpha --stdin --mcp-env on
    -> config from stdin, team terminals get the chan MCP env vars
  cs terminal team new alpha --config myteam.toml \
    --pane pane-4 --side b
    -> surfaces every member in pane-4 side B

SIDE EFFECTS:
  - Creates/overwrites {dir}/config.toml and {dir}/bootstrap.md and
    creates the tasks/ journals/ followups/ subdirectories.
  - Spawns one terminal session per member, bound to the target
    window and surfaced at the requested pane and side, then writes an
    identity poke to each agent member.
  - Spawn summary to stderr; `--script` output to stdout.

CAUTIONS:
  - Blocks until every agent is poked, its terminal ends, or its
    15-second readiness bound ends. An unready member is named, is not
    poked, and makes the command exit non-zero; ready peers are still
    poked.
  - `--script` uses a fixed `sleep 3` approximation and cannot observe
    the server's per-agent PTY readiness state.
  - Overwrites an existing team at {dir}: config.toml is replaced and
    bootstrap.md is regenerated from the config plus `--brief`.
  - A positioned config (grid layout) is refused while the target
    window holds more than one pane; nothing is written or spawned.
    Close the extra panes, pass --tabs, or rerun with --window against
    a fresh window.
  - Passing both `--config` and `--stdin`, or neither, is an error.
  - `--mcp-env` defaults OFF (codex fails to start on a stray MCP
    descriptor); agents still reach `cs search` and friends with it off.
    Passing it overrides `mcp_env` in the input config.

CAVEATS:
  - Workspace windows only, including `--script`.
  - Placement flags conflict with `--script`, which does not surface
    tabs. --window defaults to $CHAN_WINDOW_ID.
  - The config is rejected before anything is written or spawned unless
    it has 1..=9 members with exactly one `is_lead` and non-empty
    team_name / host_name / host_handle / member handles.
  - A member command matching no known agent spawns as a shell member:
    no submit chord, no identity poke.

SEE ALSO:
  cs terminal team load, cs terminal write, cs terminal survey, chan
  dump-skill --topic teams.
";

/// `cs terminal write` long help (manpage head).
pub(crate) const CS_TERMINAL_WRITE: &str = r#"Write up to 4096 UTF-8 bytes into live terminal session(s), queued
per target and delivered when that target is idle.

No newline is appended. `cs terminal write --tab-name @@A ls` only
types "ls" and leaves it at the prompt; `cs terminal write
--tab-name @@A $'ls\n'` runs it. --stdin reads the bytes from this
process's stdin instead of the positional argument (UTF-8 only).
At least one of --tab-name / --tab-group is required.

Every logical write, raw or submitted, is limited to 4096 bytes.
Larger input is refused, never truncated. Put longer content in a
file and send a short poke naming its path.

The bytes are QUEUED, not written straight through. Each session
has its own FIFO, and the drainer delivers only once that
session's output has gone quiet. At one idle opportunity the
longest run of consecutive submitted messages sharing the
target's proven built-in encoding is framed as a single
chronological prompt, so a burst of notifications costs one agent
turn instead of one turn each and the agent can reconcile them
before acting. A write with no --submit, a gemini target, a Rich
Prompt turn and a runtime submit override each end that run and
are delivered on their own. The command prints the message's
position among the target's pending messages and returns at
once; it never waits for the agent's reply.

The queue holds 100 entries per target, where a gemini message
costs two entries and every other message costs one. The queue is
dropped when the session is recycled (restarted). "Idle" is
detected from output quiescence, so a target sitting at its
prompt with a PAUSED, half-typed buffer reads as idle; that rare
case is not detected.

--submit submits the bytes into each target hands-free. A non-empty
body is delivered as its trailing newlines trimmed, then exactly
one newline, then the chord; an empty body stays chord-only. The
SERVER owns the encoding: for every matched session it derives
that session's agent from the session's own spawn command and
CHAN_AGENT spawn env, and applies THAT agent's chord, so the value
you pass only records what you believed the target runs. A
mismatch is corrected server-side and noted in the ack; a target
that derives to no agent (a shell) receives the raw bytes
untouched with no chord, and the command exits 69. Spawn the
session with CHAN_AGENT set, or spawn the agent as the session's
command instead of typing it into a shell. The applied encodings:
claude appends a chord, codex, kimi, and opencode wrap the text in
bracketed paste plus a CR, gemini takes the CR as its own later
queue entry, one idle gate after the body. Omit --submit and the
text parks in the agent's compose box unsubmitted, since a bare
newline is a newline to an agent, not a submit.

CHAN_AGENT is read from the TARGET session's spawn environment
(it overrides the command sniff there); CHAN_MODE is read by
nothing. Chord templates resolve where the derivation runs, in
the SERVER's environment: env CHAN_SUBMIT_<AGENT>, then the
server's <config>/chan/submit.toml, then the built-in default. A
CHAN_SUBMIT_* value in the WRITER's environment has no effect.
Discover a target's agent with cs terminal list (the agent
column, null/- for a shell session).
"#;

/// `cs terminal write` examples, side effects, and caveats.
pub(crate) const CS_TERMINAL_WRITE_AFTER: &str = r#"EXAMPLES:
  cs terminal write --tab-name @@Alice $'git status\n'
    runs it in @@Alice's shell; prints "queued at position 1"

  cs terminal write --tab-name @@Alice --submit claude \
    'rebase onto main, then report'
    claude receives the text, one newline, then its submit chord

  cs terminal write --tab-name @@Alice 'draft: '
    parks "draft: " in the compose box, unsubmitted

  printf 'review %s\n' notes.md \
    | cs te w --tab-group alpha --stdin --submit codex
    one poke broadcast to every tab of group alpha; each tab
    gets its own server-derived chord, mixed agents included

SIDE EFFECTS:
  Enqueues the bytes onto each matching session's write queue; the
  PTY sees them later, when the drainer fires. The ack ("queued at
  position N" for a single match, "queued to N terminal session(s)"
  for a fan-out) goes to stderr; stdout stays empty. When a
  target's derived agent is not the one --submit named, the ack
  appends the correction (e.g. "; @@B runs codex, not claude: the
  codex chord was applied").

  --submit gemini is one logical queued message and one ack, but it
  occupies TWO entries: text, then a bare CR after a full idle gate.
  A 0.51 live sweep found no fixed sub-idle gap safe at 64 KiB.

CAUTIONS:
  Message cap: 4096 UTF-8 bytes before any submit newline or chord.
  Put longer content in a file and poke the target with its path.

  Queue cap: 100 entries per target. A write to a full queue is
  dropped ("N at queue cap (dropped)"), and when every match is
  full the command fails with "matched session(s) at the 100-write
  queue cap; nothing queued". A restart respawns the session, so
  anything still queued for it is lost. No selector match is an
  error ("no live terminal session matched"), not a silent no-op.

CAVEATS:
  Idle is inferred from output quiescence, so a target parked at
  its prompt with a paused, half-typed buffer reads as idle and
  gets written into anyway. Selection spans the whole server, so a
  duplicated tab name is written to twice.

SEE ALSO:
  cs terminal survey (ask and BLOCK for an answer), cs terminal scrollback
  (read what came back), cs terminal restart.
"#;

/// `cs tunnel` long help (manpage head).
pub(crate) const CS_TUNNEL: &str = r#"Forward a port of the desktop machine back to this devserver host.

`cs tunnel 8080:3000` asks the chan-desktop app viewing this window
to listen on 127.0.0.1:8080 of ITS machine and forward every
connection back to 127.0.0.1:3000 on this host -- the `ssh -R` shape,
with the window standing in for the SSH connection. A dev web server
running next to this terminal becomes reachable in the desktop
machine's own browser.

SPEC is [bind-address:]desktop-port:devserver-port, or one port for
both ends: 3000 reads as 3000:3000. The bind address defaults to
loopback; an explicit non-loopback address is accepted with a
warning, because it exposes the forwarded port to the desktop
machine's network. Desktop port 0 asks the OS there for a free port;
the acknowledgement names the port that was bound.

The command IS the tunnel: it stays in the foreground for the
tunnel's whole life, the tunnel dies when it exits (Ctrl-C), and it
exits when the tunnel dies (the desktop app disconnects, or the
window closes). Today the tunnel carries TCP only; --proto udp is
recognized but refused as not implemented yet.
"#;

/// `cs tunnel` examples, side effects, and caveats.
pub(crate) const CS_TUNNEL_AFTER: &str = r#"EXAMPLES:
  cs tunnel 3000
    Shorthand for 3000:3000: the desktop machine's 127.0.0.1:3000
    reaches port 3000 on this host.

  cs tunnel 8080:3000
    The desktop machine's 127.0.0.1:8080 now reaches port 3000 on
    this host; open http://127.0.0.1:8080 in a browser there.

  cs tunnel 0:3000
    The OS on the desktop machine picks a free port; read it from
    the ack on stderr.

  cs tunnel 0.0.0.0:8080:3000
    Listens on every interface of the desktop machine. Warns:
    whoever reaches that machine's network reaches this host's
    port 3000.

SIDE EFFECTS:
  The desktop app binds a listening socket on its machine and keeps
  it while this command runs. Each accepted connection dials
  127.0.0.1:<devserver-port> on this host. The ack goes to stderr;
  stdout stays empty and carries no tunnel traffic.

CAUTIONS:
  The command BLOCKS for the tunnel's whole life; Ctrl-C tears the
  tunnel down. A bind failure on the desktop fails the command with
  the desktop's error, and no listener acknowledged within 10
  seconds exits 124. When the tunnel dies first (the desktop app
  quits, the window closes), the command exits 1 with the reason.

CAVEATS:
  The window must be viewed by the chan-desktop app; a browser tab
  cannot listen on your machine, so the request is refused there.
  TCP only today: --proto udp is recognized but refused. One spec
  per invocation; run one `cs tunnel` per forwarded port.

SEE ALSO:
  cs download, cs upload; chan devserver.
"#;

/// `cs upload` long help (manpage head).
pub(crate) const CS_UPLOAD: &str = r#"Raise this window's file-upload UI, targeting a directory.

The same UI the Inspector's upload pill raises: a file picker opens in
the window, then the picked files stream in behind the shared
transfer-progress bubble. The files come off the machine VIEWING the
window, so a workspace served from a devserver receives files from
your laptop.

PATH is required and names the destination DIRECTORY: "." is the
terminal's current directory, and a file path targets its parent so an
upload always lands in a folder. In a workspace window the destination
is resolved workspace-relative and must stay inside the workspace root;
in a standalone terminal it is the absolute path the shell itself can
reach, and the transfer route pre-flights that the directory is
writable before writing anything.
"#;

/// `cs upload` examples, side effects, and caveats.
pub(crate) const CS_UPLOAD_AFTER: &str = r#"EXAMPLES:
  cs upload .
    Opens the picker; picked files land in the current directory.
  cs upload notes/inbox
    Targets that folder instead.
  cs upload notes/plan.md
    Targets notes/ -- a file argument resolves to its parent.

SIDE EFFECTS:
  Queues ONE window command and returns; the picker and the transfer
  both happen in the window. The ack ("upload request queued for
  <dir>") goes to stderr. The uploaded bytes are written by the
  window's transfer, not by this process.

CAUTIONS:
  Fire-and-forget: exit 0 means the picker was raised, not that
  anything transferred. One upload at a time -- a second one reports
  "upload already in progress" in the window. Nothing is ever
  overwritten: an upload whose name already exists in the destination
  is refused.

CAVEATS:
  Works in workspace windows and standalone terminals, but with
  different roots: workspace-relative and walled at the workspace root
  in one, plain filesystem paths under the shell's own reach in the
  other. Picker cancels and transfer errors surface in the window's
  status bar, never on this terminal.

SEE ALSO:
  cs download, cs copy, cs paste.
"#;

/// `cs window` long help (manpage head).
pub(crate) const CS_WINDOW: &str = r"Read the window registry and drive the desktop's OS windows.

DESCRIPTION:
`cs window list` (or `cs w l`) prints the library's authoritative
window set -- every window across every tenant, with its library,
kind, title, ordinal and status. The status is `connected` when a
live event socket is tagged with that window right now (including a
window chan-desktop has hidden with its close button), else
`offline`. `--json [--pretty]` emits the raw records.

The lifecycle verbs drive real windows. `new` opens one whose kind
is derived from the calling tenant: a standalone terminal spawns
another terminal window, a workspace spawns another window of that
workspace. `open <id>` focuses a window, un-hiding it if it was
hidden. `hide <id>` is the OS close-button behavior: terminals and
layout stay warm and reopenable. `rm <id>` destroys the window and
deletes its saved layout. Titles are library-owned and
auto-derived; there is no rename verb.

Session-scoped like `cs terminal list`: needs $CHAN_CONTROL_SOCKET
only, no window id.
";

/// `cs window` examples, side effects, and caveats.
pub(crate) const CS_WINDOW_AFTER: &str = r#"EXAMPLES:
  cs window list
    a | window | library | kind | title | # | status | table;
    status is connected or offline

  cs window new
    -> the new window id, printed on stdout

  cs window hide win-3
    -> "hid window win-3"; bring it back with
       `cs window open win-3`

  cs window rm win-3
    -> "removed window win-3", or "deleted saved layout for
       win-3 (no live window)" when nothing was live

SIDE EFFECTS:
  `new` spawns an OS window; `open` and `hide` change a window's
  visibility. `rm` drops the persisted registry row, reaps that
  window's terminal sessions and its saved layout, then closes any
  live native window. Each verb prints one line on stdout (`new`
  prints the id); failures go to stderr and exit non-zero.

CAUTIONS:
  `rm` is destructive and has no undo: the saved layout is gone, so
  the window cannot be reopened. Use `hide` when you want it back.
  `rm` of a window with live terminals is REFUSED -- "window <id>
  has N live terminal session(s); re-run with --force to remove
  them" -- so a removal never kills a running agent by surprise.
  `--force` removes it and those shells with it. The guard runs
  server-side, so it holds headless too.
  `rm` of an id with neither a window nor a saved layout errors:
  "no window or saved layout for <id>".

CAVEATS:
  `new`, `open` and `hide` need the chan desktop app; with no
  desktop attached they refuse with "window management requires the
  chan desktop app". `rm` still works headless, because the server
  (not the desktop) owns the registry row.
  A standalone `chan open` serve has no library window set, so
  `cs window list` is empty there.
  Subcommands infer (`cs w l`, `cs w n`, `cs w o`, `cs w r`), but
  `hide` needs at least `cs w hi`: a bare `h` is ambiguous with
  the auto-generated `help` subcommand.

SEE ALSO:
  cs pane (the layout inside a window), cs session.
"#;
