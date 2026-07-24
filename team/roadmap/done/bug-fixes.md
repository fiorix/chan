# v0.75.0 bug fixes

> Status: shipped in [v0.75.0](../../release/release-v0.75.0.md).

Branch `v075/bug-fixes-1`, one commit per fix. Every fix carries unit or route tests plus, where the symptom is user-visible in the browser, a committed browser-smoke check that reproduces the observable. This file records what shipped and the proof behind it; the reports themselves are in [bug-reports.md](bug-reports.md).

## Editor: unclickable line after a table

Root cause, confirmed with a headless-Chrome repro against the pinned @codemirror/view 6.43.3: the table, diagram, and in-edit image block widgets carried vertical CSS margins, which CM6's height map excludes (getBoundingClientRect), so every rendered table left the click-mapping coordinate space about 1em short of the visual layout. The drift is cumulative: with 3+ tables, clicks on a later heading resolved into the following paragraph or the next table's atomic range (collapsing it to pipe source). Headings are hit worst because GFM absorbs a bare paragraph after a table into the table itself, so the line after a table is almost always a heading.

Fix: vertical margin swapped for padding (which the height map includes) on all three block-widget roots; a source test pins "no vertical margins on block-widget roots" for the known classes. Proof: in the repro, heading click probes with margins resolved up to a full block away; with padding every probe resolves exactly to its line, matching the margin-free control. Browser-smoke check 101 clicks the heading after each of four tables in the real app and types a marker there.

## Editor: errored mermaid blocks trap navigation

Root cause, confirmed in headless Chrome against the real renderer: CM6 maps any click on a block widget to the nearest block edge (top half opener, bottom half closer). The errored diagram face echoes the failing line and invites a click on it, but the caret could only land on a fence line: from the invisible opener landing, ArrowUp exited above the diagram; the lower half landed after the error; ArrowLeft from the following line was the only way in.

Fix: the whole errored face is click-through; mousedown resolves the block via posAtDOM, clamps the blamed line inside the fence (mermaid EOF errors blame past the source), refines the column from errorCol, and drops the caret on the failing line; the widget then de-renders. Success faces and arrow-key entry are untouched. Proof: before/after harness flows show clicks on the head, source, and reason rows landing on the blamed line (previously the fence edges), with ArrowUp staying inside the block. jsdom tests cover the landing, column, and clamp; browser-smoke check 102 covers it in the real app.

## dump-skill: materialized marker forms

@pagebreak, @break, @today, and @date are Space/Enter typing macros; nothing ever expands them in a written file (one asymmetry: deck split and PDF export do honor a literal @pagebreak line, but the editor shows it as raw text). The cs-export help (the dump-skill authoring corpus) now says exactly that and teaches agents what to write instead: `<hr class="chan-page-break">` alone on a line, and a concrete date in one of the seven pill-recognized shapes (listed with examples, ISO preferred). A skill test pins the hr literal and the ISO example against future help edits. The date table is hand-copied from the web date-format catalog; drift protection covers the pinned entries only.

## Slides: spacer band above headings

Root cause, confirmed by executing the real render pipeline: the deck split keeps the blank separator lines around each page break inside the page markdown, and the blank-run preserver emitted spacer divs for a leading 2+ blank run, i.e. before the slide's first heading: a ~50px band at default zoom in preview, present, and PDF alike. The @pagebreak macro manufactured exactly that pattern on every use above existing content.

Fix: boundary blank runs (leading and trailing) collapse to a plain blank line; interior runs keep the pinned N-1 spacer behavior; the macro now sizes its newline suffix from context so it stops writing double blanks. Proof: `"\n\n# Sec 3"` renders `<h1>` first (was: spacer div then h1); the interior pin renders unchanged. Browser-smoke check 103 walks a three-slide deck: the slide behind a break + two blanks starts at its H1, the interior gap keeps its two spacers.

## Slides: PDF export diagram sizing

Root cause: the deck export laid slides out in the A4-at-96dpi pixel box (~516px content column) while the preview at a 1920x1080 screen lays out ~772px, and diagrams and #w= images size at min(native px, container px), so their fraction of the slide differed ~1.5x (the v0.70.2 fix only stopped overflow).

Fix: deck pages lay out at the preview page box evaluated at a 1920x1080 reference viewport (the pageStyle formula mirrored as numbers, both sides pinned by a test) with the preview's 54px reference padding, and rasterize at a compensating per-page scale. The PDF page geometry, raster pixel size, and the single-document export path are unchanged. Proof, headless Chrome at 1920x1080 with a max-width:420px SVG: preview fraction 54.43%, old export 81.34%, new export 54.43% (0.00% drift); raster output identical at 2246x1588 device px. Out of scope, flagged as follow-up: preview-vs-play drift and non-reference viewports (the principled fix is one fixed design box for all three modes).

## Editor: saves flake under network latency

Reproduced with a TCP delay proxy in front of a real server (WebSockets included; CDP emulation cannot delay them): at 1500ms one-way, typing then closing the tab raised the "External edit detected" conflict modal for a file nobody else touched, while two-client convergence and latency spikes during typing stayed clean. Mechanism: the attached save funnel gave up on a fixed 4s wall clock with no RTT budget, degraded, and fell through to a classic CAS PUT stamped with a stale flush token; the server answered 409 even though the PUT body matched the text it already had.

Fix, four changes closing the chain: the server token-adopts a stale-token PUT whose body is byte-identical to the authority text (equal bytes cannot lose an update; text and token read under one lock); the flush funnel's 4s deadline became a quiet window restarted by sync-progress frames with a 30s absolute cap, so a slow-but-live channel never degrades mid-save; a degrade now stops the collab pump (single writer), the fallback waits out any in-flight push and stamps the freshest token at PUT time, and a successful classic save heals a socket-open degraded session back to attached; an attach-timeout close no longer latches doc sync off for the whole page load.

Proof: after the fix, close-under-latency at 800 and 1500ms one-way reports no modal with exactly one marker on disk and on reopen; two-client convergence (2.8s at 800ms) and mid-session latency spikes stay clean. A pre-fix rebuild also explained the one flaky repro run: the spurious modal itself blocked the tab close and the reopen flow. docSync tests pin the new funnel, settle, heal, and latch behavior (the reachable-degrade pin now asserts the freshest token, deliberately reversing the old pin); a route test pins token-adopt for equal bodies and 409 for different ones; browser-smoke check 54 replays type-then-close through the delay proxy. Follow-ups flagged: sceneSync still has the old fixed-wall-clock funnel shape, and the doc WS has no heartbeat for gateway-tunneled devservers (300s idle cut).

## devserver --join: watchdog too sensitive

Root cause: the join watchdog was the only liveness layer in the stack with no retry semantics: single-strike backend-liveness, three 2s-capped health misses (~6s grace), no re-attach, and the chan backend pinned the attach-time pid so `--restart` always killed a join at the next tick; the desktop then blocked reconnect until the control terminal was closed by hand.

Fix: a pure failure-window state machine bails only after 30s of continuous failure; liveness loss and health misses share the window and any success resets it; a chan-backend join adopts a restarted daemon on the same address and narrates the re-pin; the probe timeout rises to 5s decoupled from the 2s tick; entering the window, recovery, and re-pin each narrate one stderr line. Exit codes are unchanged, so the desktop contract holds. Proof: a resilience integration test SIGSTOPs the daemon past the old ~6s bail point (stall narrated, recovery narrated), then restarts on the same port and asserts the join stays attached, re-pins to the new pid, and detaches cleanly; five unit tests pin the grace arithmetic. A live manual transcript shows attach, lost-contact, re-pin, and clean detach across a real `--restart`.

## Rich prompt: image paste plus submit chord opened view mode

Root cause, confirmed in headless Chrome: a pasted image deterministically leaves its atom ring-selected (the insert places the caret on the atom edge, and the caret-redirect stamps the ring), and the image widget's document-level keydown listener claims any bubbling Cmd/Ctrl+Enter as the View chord while a ring exists, without checking defaultPrevented. CM6 keymaps preventDefault but do not stop propagation, so one press submitted the Rich Prompt and opened the fullscreen image zoom on top of it.

Fix: the Rich Prompt's Mod-Enter submit binding sets CM6's per-binding stopPropagation (verified in the pinned @codemirror/view: it fires only when that binding handled the key), and Wysiwyg's shared chat-host submit entries do the same only when an onSubmit host is wired. The file editor's ring + Mod-Enter View chord keeps working; it relies on the bubbling and is pinned by a test. Proof: pre-fix repro screenshots show the zoom takeover with the submit simultaneously queued; jsdom tests pin both sides of the interplay; browser-smoke check 104 replays the exact flow (terminal, rich prompt, synthetic clipboard paste, chord) and asserts submit-without-zoom. Follow-up flagged: the image widget's document-level listeners are installed once per view but never removed on view destroy.

## Terminal: reattach replay ring 1 MB to 2 MB

Agent sessions routinely emit more than 1 MB between detach and reattach, so the ring dropped the oldest output and reattach opened mid-stream. Default doubled to 2 MB per session (at most 64 MB under the default 32-session cap); config reference updated.

## Terminal: scrollback budget 10 MB default, 50 MB cap

The Settings slider offered up to 500 MB of per-terminal xterm.js scrollback with a 50 MB default. New range 10..=50 MB, default 10 MB (~11k lines at the 80-col baseline); existing configs above the cap clamp to 50 on read. Rust and web bound mirrors moved in lockstep, and the web test pins the default's line translation.

## Environment note

`/tmp/.git` exists on this host as a stray empty directory (dated Jul 21), which makes chan's vcs-parent check refuse workspaces created under `/tmp`, including the browser-smoke harness's default mkdtemp. Runs here set `TMPDIR=$HOME/tmp`; the README documents the knob. Consider deleting the stray directory.
