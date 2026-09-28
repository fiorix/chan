# chan editor (CM6) design

Load-bearing reference for the chan editor. Mirrors the workspace design doc's role for the editor surface.

## Model

The document text IS the markdown source. `view.state.doc.toString()` is the file on disk; there is no separate rendered tree and no serialization layer. The editor decorates the source in place (hide markers, render widgets) so it reads like rendered markdown while every character stays editable. This is the Live Preview model, the same architecture as Obsidian's.

Because the source is the single source of truth, the editor sidesteps a class of structural bugs a rendered-tree model is prone to: editing 1-char marks like `*a*`, flickering pending-mark heuristics, and markdown round-trip escape gymnastics. See "Why 1-char marks work" below.

## The contract (10 invariants)

1. **Doc invariant.** `view.state.doc.toString()` is the markdown source. Always. No transform layer. Autosave writes it directly.

2. **Token detection.** `syntaxTree(state).iterate({from, to, enter})` from `@codemirror/lang-markdown` + GFM, extended with three custom lezer extensions: `[[wikilink]]` (inline), YAML frontmatter (block-start, so headings inside `---...---` are not promoted), and a ref-aware link interceptor so `[label with [inner]](path)` still forms the outer link. Fenced code bodies parse with lazy-loaded per-language packs. Tokens that are not lezer nodes - `#tag`, `@@mention`, dates - are matched by regex in their own ViewPlugins, skipping code ranges.

3. **Decoration taxonomy.**
   - **Hide markers**: `Decoration.replace({})` over `*`, `**`, `~~`, `` ` ``, `[`, `](`, `)`, and `# ` heading prefixes. Blockquote `>`, list markers, `---` rules, and ```` ``` ```` fences are NOT hidden: the marker is the visual cue (Obsidian convention) and hiding `---` / fences makes the block structure harder to edit.
   - **Inline marks**: `Decoration.mark({class})` over the *content* between markers - emphasis, strong, strike, inline-code, link-label.
   - **Line decorations**: heading levels (`cm-md-h1..6`), list lines, blockquote lines, fence opener/content/closer rows - CSS paints size, indent, borders, slab background.
   - **Atomic widgets**: `Decoration.replace({widget})` over the *whole* range - wikilink/internal-link pill, image, date pill, GFM table grid, mermaid diagram, page break. `EditorView.atomicRanges` registered for each so caret motion skips them in one keystroke. The task checkbox is a replace widget over just the `[ ]` / `[x]` marker (not atomic; the click toggles the source).

4. **Visibility rule (per token kind).**
   - **Marks** (bold/italic/strike/code/link markers): hide unless the active selection intersects the OUTER token range `[from, to]`. Equality at the boundary counts as intersection, and the outer-range rule (not per-marker) means a caret near `*a*` reveals both `*` together instead of `*a` then `a*`.
   - **Heading prefixes** (`# `): hide unless the caret line intersects the heading's line. Selection-intersect alone causes flicker as the caret crosses the prefix mid-line.
   - **Atom widgets**: show widget unless selection intersects the source range; on intersect, suppress the widget and reveal source so the user can edit literally.
   - **Always-visible markers** (`>`, list markers, `---`, fences): styled via marks/line decorations, never hidden.

5. **Atom strategy (split by token type).** A widget dispatches a document change only into a view the user can edit, and `widgets/writable.ts` is the one predicate that answers it: read-only is spelled two ways, `EditorState.readOnly` for the prompt composer and the `EditorView.editable` facet for the document surfaces, and CodeMirror enforces neither against a programmatic dispatch. Selection and effect dispatches are not writes and do not consult it.
   - **Wikilinks (`[[note|alias#anchor]]` and `[label](path)` where `path` is internal)**: atomic pill widget. Pill kind (file / contact / image / broken) resolves via `GET /api/resolve-link`, cached per target. Editing means caret-adjacent reveals raw text, OR click pill -> wiki bubble.
   - **External markdown links `[label](https://...)`**: hide markers only (`[`, `](`, `)`); `link` mark on label; URL editable in place.
   - **Naked URLs**: mark only, no hide.
   - **Tables**: read-only grid widget; click drops the caret at the source start, which reveals the pipe form for editing.
   - **Diagrams (mermaid, mermaid-to-excalidraw)**: a closed ```` ```mermaid ```` or ```` ```mermaid-to-excalidraw ```` fence renders as a diagram atom while the caret is outside; caret inside reveals source. A hover "View" button opens a fullscreen pan/zoom overlay, always on a light panel with a light render so a dark-theme diagram never vanishes on the dark backdrop. Both fences share one widget (`widgets/diagram.ts`, one decoration field per fence language with its own caches) over per-renderer render modules (`mermaid_render.ts`, `excalidraw_render.ts`); each library is dynamic-imported on first render.
   - **Tag `#word` / mention `@@{name}` pills**: mark-based (no replace), with click handling delegated through one content-DOM listener.

6. **Selection rule for ranges.** A non-empty selection that crosses any token's range reveals all of those tokens uniformly. No special cases.

7. **Bubbles** (`[[`, `![`, `@@`, `@`, `#`) open/close from `computeBubbleSpec`, which inspects the doc text around `state.selection.main.head` on every transaction via `bubbleListener`; the editor host mounts/reuses the bubble UI. Triggers also fire in "raw" mode when the caret sits inside an existing Link/Image URL slot or `[[...]]` body, so commit replaces the right range. Triggers never fire inside code ranges, and the reserved macro words (`@today`, `@date`, `@pagebreak`, `@break`) suppress the contact bubble. The bubble keymap intercepts before CM6's defaults via a high-precedence `keymap.of`. Bubbles must NOT call `view.focus()` mid-flow - the caret stays in the document and the popover runs alongside it.

8. **Find** uses one shared `scanMatches` pipeline. The `findField` and `FindAdapter` shape are shared by both Source and WYSIWYG modes.

9. **Fold** uses `@codemirror/language` `foldService` with a heading-aware computer. Heading detection has one source of truth: the lezer syntax tree. A line is a heading iff the tree resolves it to a non-empty `ATXHeading1..6` node, so a `#` inside a fenced block, a tilde fence, an indented fence, an inline code span, or frontmatter is never a heading; the gutter marker, the fold service, and the gutter click all read the same `headingLevelAt` / `headingFoldRange` helpers. A heading folds end-of-line -> start of the next `ATXHeading{<=n}` line (or doc end); the forward scan runs to doc end so it forces the parse past the lazy viewport (`ensureSyntaxTree`). Three recorded decisions: indented ATX headings (up to three leading spaces, CommonMark) fold, matching the tree; an empty heading (a bare `#` with no text, which lezer still parses as `ATXHeading1`) does not fold, since it has no section under it; and Setext headings (`===` / `---` underlines) are out of the fold gutter. The chevron gutter is custom (headings only): `foldGutter()` would chevron every foldable block because lang-markdown marks paragraphs, quotes, and fences foldable too. The same tree-based code-node guard stops the block-formatting chords (`setBlockKind`, `toggleLinePrefix` in `commands/format.ts`) from rewriting a fenced `#` comment.

10. **Autosave** writes `view.state.doc.toString()` on `update.docChanged` to the bindable `value` prop. The echo guard prevents prop write-back from clobbering the caret, and the debounced autosave pipeline owns the server write. No serialize step. While a tab is attached to its doc session (`/api/doc/ws`), edits ride `@codemirror/collab` update logs (remote peers paint as cursors) and saves are flush confirmations; the debounced autosave + CAS `PUT` below is the fallback when the channel is unavailable. The write contract on `PUT /api/fs/<path>` is server-authority per path: a read of the path returns `authority_version` + `disk_conflicted`, and a changed-content write echoes the `authority_version` it last saw (alongside `expected_mtime_ns`). The server answers `428 PRECONDITION_REQUIRED` when that authority precondition is required but missing, and `409` on a version mismatch, carrying `current_authority_version` + `current_mtime_ns`. A watcher event for a non-self write flags a "changed on disk" banner instead of auto-reloading; once a session goes dirty/conflicted, the divergence is resolved explicitly via `POST /api/session-conflicts/resolve` with `{action: reload | overwrite}`. A debounced localStorage mirror keyed by path is kept for hang-recovery.

## Decoration pipeline

Every ViewUpdate re-walks the viewport syntax tree and merges the four decoration kinds, plus the regex tag/mention/date plugins, into the one DecorationSet CM6 paints.

```mermaid
flowchart TD
  subgraph TRIG["ViewUpdate re-run triggers"]
    direction LR
    T1["docChanged"]
    T2["viewportChanged"]
    T3["selectionSet"]
    T4["geometryChanged"]
  end
  TRIG --> Walker["walker ViewPlugin (decorationWalker)"]
  Walker --> Iter["iterate viewport syntaxTree, dispatch by node name"]
  Iter --> Reg["chanDecorations registry: marks + headings + blocks"]
  Reg --> K1["hide markers: Decoration.replace empty"]
  Reg --> K2["inline marks: Decoration.mark class"]
  Reg --> K3["line decorations: Decoration.line class"]
  Reg --> K4["atomic widgets: Decoration.replace widget"]
  TRIG -->|"minus geometryChanged"| Regex["regex ViewPlugins: tag / mention / date"]
  Regex --> Skip["scan viewport text, skip code ranges"]
  Skip --> K2
  Skip --> K4
  K1 --> DSet["DecorationSet"]
  K2 --> DSet
  K3 --> DSet
  K4 --> DSet
  DSet --> Render["CM6 paints the viewport"]
```

## Why 1-char marks work

`*a*` is three real characters in the doc: `*`, `a`, `*`. The `*` markers at `[0, 1]` and `[2, 3]` get hide-decorations whenever the selection does NOT intersect them. A caret at offset 1 (between `*` and `a`) intersects both `[0, 1]` (caret == to) and `[2, 3]` (caret == from), so both markers reveal. No special case. Backspace deletes a real `*` character the user can see, and round-trip is the identity function. A rendered-tree model that represents `*a*` as a single marked node has no integer caret position satisfying `from < caret < to` when `to - from == 1`, which is the structural reason that model needs a per-pattern boundary patch and this one does not.

## Modes

The file editor host owns a per-tab mode: `wysiwyg` | `source` | `pretty` | `table` | `canvas`. Markdown (.md) pairs WYSIWYG with source; Excalidraw scenes open as the interactive canvas board; JSON opens as a collapsible tree and CSV/TSV as an editable grid, each with source as the toggle. Any other text-kind file (.txt included) is source-only - source IS the sensible surface for a .py / .toml / Makefile. Source mode highlights by extension via the same lazy language packs.

A drawing's canvas (`ExcalidrawCanvas.svelte`) writes the tab's buffer only from a seeded board. Seeded means the drawing library, past its own init, holds the whole buffer of a finished load as its init would restore it (the elements, the files, and the part of the appState its serializer keeps: the grid and the background; a file whose id the board already holds keeps its bytes), and the canvas holds the library's serialization of it as the baseline. The canvas seeds when the library first reports that its loading state has cleared, which is its init's own change, and after that whenever the tab's load finishes or its buffer changes without the board, as a reload, a conflict's resolution or a sibling pane's mirror does. Every seed puts the buffer on the board through the library's restore, whatever the board was built from, and takes the baseline in the same synchronous run, so no stroke lands between them; a stroke begun before the seed is replaced by it. The library shows an update's appState only at its next render, which for a seed made outside the library's own change comes in a later task, so the canvas keeps the appState a seed handed until the library's next reported change and lays it over what the library reports in every serialization, the baseline's and every flush's alike: a flush between the seed and that render publishes nothing. Until the library hands its API over, which its App's constructor does in the same synchronous commit in which the App mounts and reads its initial data, every render of the board carries the buffer as its initial data, so the App is built from the buffer whichever render it mounts with; that decides what the first frame shows, and nothing rests on it. The canvas publishes a serialization only while it is seeded and its tab is not loading, and only one that differs from the baseline or from the last it published, so a board nobody drew on writes nothing and never dirties its tab: neither the empty scene of a load in flight nor the library's rewrite of a file it did not write. The exception is an image whose file fails to decode: the library marks the image after the load, and that mark is a change the canvas publishes. A load in flight unseeds the board, which keeps the drawing on screen in view mode until the load ends and seeds it again, and a tab reopened after a close during its load reads its file again. The library's order of events this rests on (the imperative API handed over before the init, the App built with the props of the render in effect when it mounts, the init replacing every element set before it, no change reported before it, an update's appState shown at the next render) is read from `@excalidraw/excalidraw` 0.18.1's source and was not run in a browser; `src/__tests__/excalidrawLibrary.ts` models it, and a test fails when the installed version is another.

With a live scene session, the board takes the authority's appState from a snapshot or an update as the library keeps it: the canvas restores and serializes that appState as the seed does a buffer's, so only the grid and the background reach the board, each at the library's default where the file lacks it (and the grid's size and step also where they are not finite numbers, then rounded and clamped to 1..100), and a view key in a file's appState never does. That value becomes, at once, the appState the authority is known to hold, the appState the next push offers, and the appState laid over the board's in every serialization until the library's next reported change, so a flush or a push made before the library renders the adopt sends nothing older over it. The canvas pushes an appState only when the board's, as the serializer keeps it, differs from the authority's as a value, both compared as JSON with sorted keys, so the authority is not handed, and does not write, an appState nobody changed on the board, whether the file's is `{}`, carries keys the serializer drops, or lists its keys in another order; a change of the grid or the background is pushed. While this window's own appState push is on the wire, or queued behind one, the session hands the canvas an update's elements and files and withholds its appState: the authority applies that push after the update, so this window's value is the one that stands. A peer's edit reaches the tab's buffer only through the canvas's flush, and no push-ok follows it, so after each flush that writes the buffer and leaves none of its appState unpushed the canvas asks the session to mark the buffer saved, which the session does only while attached and with nothing of this window on the wire, queued or not yet handed over; a local change keeps waiting for its own push-ok.

A live board binds to its scene session once it has taken its first seed, and not before: the library hands its API over before its init, whose apply replaces every element put on the board before it, and the seed at the init's first change then hands the buffer's appState. Until the bind, every snapshot and update waits in the session's scene, which holds those frames and this window's own pushes, each with its elements, its appState and its files, taken when the session takes the push. The bind replays that scene onto the seeded board as an adopt, so the board shows what the session holds beyond the file, an older copy the file carries loses to the session's, and a board nobody touched pushes nothing, but for two things a file can hold: an element with no `version`, which the server reads as 0 and the library restores as 1, so the board pushes it and the authority takes it, and a file's image the authority does not hold. A first seed at the library's change runs in the library's task and the bind in the microtask after it; a first seed made when a tab's load ends after the library's init is followed by the bind in a later pass of the same flush. No frame lands between them in either. The bind depends on the session and that first seed alone: it binds again when the session is replaced or its prop goes through null and back, and not when the roster or the tab changes, though the replay reads both. A board that has not taken its first seed pushes nothing. A later reseed keeps the binding: a conflict's resolution or a sibling's mirror reseeds from the buffer and replays nothing, so no replay brings back an element that buffer deleted, and a reload releases the session while the tab loads and binds it again when the load ends. That leaves a reseed from a buffer older than the authority, which a conflict's resolution answered before a peer's push can hand a bound board, on the board with the scene's marks: its older elements are offered, the authority discards them and the canvas marks them as sent, so the board shows them until their next update, and its older appState is pushed over the peer's. While this window's appState claim stands, an update's appState stays out of the scene as it stays off the board, since the claim is what the authority keeps. A snapshot belongs to the socket it came on: until the current socket's has landed, the session takes no push and replays nothing, so no push that leaves on a socket is handed back by that socket's first snapshot, which hands back as unaccepted only what an earlier socket carried, and a push that a drop discarded, which stays in the scene until the next snapshot replaces it, never reaches a replay. The server also fans a snapshot to every attachment, on the socket each has, when a conflict's resolution leaves the scene unchanged or overwrites the disk. Such a later snapshot ends none of this window's pushes, since the authority applies those it reads after it and acks them on that socket: they stay claimed, their parts stay in the scene over the snapshot's but for an element the snapshot holds that the authority keeps against the push's, a newer one or one of the same version with the lower nonce, and while this window's appState claim stands the snapshot's appState stays off the board, as an update's does. The claim then ends as any push on the wire ends: at its push-ok, at the socket's close, or at the next socket's first snapshot.

That has three costs. An appState this window picks between a socket's opening and its snapshot, like one picked while the socket is down, is replaced by the snapshot's when the snapshot is applied; elements and files that stayed local are reconciled with the snapshot and pushed. A save that waits on such a push waits for the snapshot for at most `SCENE_FLUSH_TIMEOUT_MS` (4 s), after which the session degrades and the save falls back to the classic PUT, or until the socket closes and the reconnect's grace (two attempts or 3 s) runs out, which degrades the session with its socket down: the save then writes nothing, as a save does during any outage that is still retrying, and the tab reads unsaved until the reattach pushes the elements and files that stayed local. And a tab can hold a session with no seeded board: a board whose library never reports its init's change never seeds, and a restored drawing tab that was never brought to the front has a session and no board, since the host loads the canvas at the tab's first showing and acquires the session whether or not it is shown. Neither binds, pushes or publishes, and an explicit save of such a tab whose session flush fails, by the timeout or a flush error, falls back to the classic PUT of the buffer, which is the load's text, with the tokens of the session's last frame. The server applies such a PUT to the live scene when those tokens pass its check, and its replace makes a deletion of every element the text lacks, so a peer's edit made after the load can be deleted; that path is read and not run.

Two things stay open. A grid or background changed while the network is down, or in the moment it drops, turns back when the network returns, and the tab reads saved: the authority never took it, the reattach's snapshot carries the older value, the session hands the canvas that snapshot before it takes a push, and an appState is one value with no version, so nothing offers the change again; the elements drawn with it are pushed. And, read and not run, the library can report a change from a discrete event's render before the render that shows a handed appState, which drops the handed value early, for an adopt as for a seed, and a flush in that window pushes the board's earlier appState.

`FileEditorTab` picks the initial mode by file class, then toggles source against the single rendered surface each class pairs with; plain text is source-only.

```mermaid
stateDiagram-v2
    [*] --> pick
    pick: open via defaultModeForPath(path, fileKind)
    pick --> Markdown: md
    pick --> Json: json
    pick --> Csv: csv / tsv
    pick --> Canvas: excalidraw
    pick --> Text: other text

    state "Markdown class" as Markdown {
        [*] --> wysiwyg
        wysiwyg: wysiwyg surface
        mdsrc: source surface
        wysiwyg --> mdsrc: Show Source
        mdsrc --> wysiwyg: Show Rendered
    }

    state "JSON class" as Json {
        [*] --> pretty
        pretty: pretty tree surface
        jsonsrc: source surface
        pretty --> jsonsrc: Show Source
        jsonsrc --> pretty: Show Pretty Tree
    }

    state "CSV / TSV class" as Csv {
        [*] --> table
        table: editable grid surface
        csvsrc: source surface
        table --> csvsrc: Show Source
        csvsrc --> table: Show Table
    }

    state "Excalidraw class" as Canvas {
        [*] --> canvas
        canvas: canvas board surface
        canvassrc: source surface
        canvas --> canvassrc: Show Source
        canvassrc --> canvas: Show Canvas
    }

    Text: source only - no rendered toggle
```

## Bubbles

Each transaction recomputes the bubble spec; the host mounts or reuses one popover and commits a range replace through a high-precedence keymap, never stealing focus from the document.

```mermaid
sequenceDiagram
    actor User
    participant View as CM6 EditorView
    participant Listener as bubbleListener
    participant Triggers as computeBubbleSpec
    participant Host as Wysiwyg handleSpec
    participant Popover as bubble UI
    participant Keymap as bubbleKeymap

    User->>View: type or move caret
    View->>Listener: ViewUpdate per transaction
    Note over Listener: recompute only on docChanged, selectionSet, or recomputeOn
    Listener->>Triggers: computeBubbleSpec(state)
    Note over Triggers: caret-context scan, URL slot or wikilink body becomes raw mode, code ranges and reserved macros suppress
    Triggers-->>Listener: BubbleSpec or null
    Listener->>Host: onSpec(spec)
    alt same kind, anchor and mode
        Host->>Popover: setTriggerEnd then setQuery, reuse popover
    else different kind or null
        Host->>Popover: dismiss old, mount fresh at caret anchor
    end
    Note over Host,Popover: caret stays in the doc, never calls view.focus
    User->>Keymap: keydown Enter, Escape or arrows
    Keymap->>Popover: handleKey before CM6 defaults
    Popover->>View: dispatch replace triggerStart..triggerEnd
    Note over Popover,View: commit without view.focus
```

## Server contract

The editor relies on three server contracts: file reads/writes with optimistic CAS, picker/classification lookups for links, contacts, tags, headings, and images, and a watch stream whose self-write filtering keeps autosave from reloading the buffer it just wrote.

## Autosave and conflicts

This is the detached/fallback path; an attached doc session replaces the PUT with collab pushes and flush confirmations. A keystroke flows through the echo guard and debounced autosave to `PUT /api/fs/<path>`, carrying `expected_mtime_ns` + the last-read `authority_version`; a missing authority precondition returns 428, a version mismatch returns 409 and opens the conflict dialog, and a non-self `/ws` event only raises the changed-on-disk banner. A dirty/conflicted session is resolved explicitly through `POST /api/session-conflicts/resolve` (`reload` | `overwrite`).

A drawing's save checks its text first. Text that does not parse is not written: the tab keeps its editor with the text as typed and says on its toolbar that the file was not saved and why, and in board mode it shows that the drawing does not parse in place of the board. The reason follows the text within one autosave debounce: the check clears it when the text parses, and a load, a rename out of the check and an edit back to the file's text clear it too. Until a write of the refused text lands, the tab takes no live document or scene session, so the write carries the tokens of its load and meets the conflict check; the cost is that the tab shows no peer's cursors and merges no live edits until then. A close of such a tab asks whether to keep editing or close without saving, and a close that also ends a running terminal asks "Close tabs?"; a draft, which has its own close flow, and a move to another window stay open instead and say that the file was not saved.

```mermaid
sequenceDiagram
    actor User
    participant CM as "Editor (CM6)"
    participant Sync as "createValueSync"
    participant Tab as "tab.content (App effect)"
    participant Save as "scheduleAutosave"
    participant LS as "editorBuffer (localStorage)"
    participant Srv as "PUT /api/fs/<path>"
    participant Res as "POST /api/session-conflicts/resolve"
    participant WS as "/ws watcher"

    User->>CM: type (docChanged)
    CM->>Sync: onDocChanged(update)
    Note over Sync: echo guard skips self-applied external writes
    Sync->>Tab: value = doc.toString()
    Tab->>Save: scheduleAutosave debounced
    Tab->>LS: queueBufferWrite debounced mirror
    Save->>Srv: write content + expected_mtime_ns + authority_version
    alt precondition met
        Srv-->>Save: 200 OK + mtime_ns + authority_version
        Note over Save: t.saved updated, mirrorToSiblings
    else authority precondition required
        Srv-->>Save: 428 PRECONDITION_REQUIRED + current_authority_version
        Note over Save: resend the write echoing current_authority_version
    else version mismatch
        Srv-->>Save: 409 + current_authority_version + current_mtime_ns
        Save->>User: open conflictDialog Reload or Overwrite
        User->>Res: {path, action: reload | overwrite}
        Res-->>Tab: resolved read view (authority_version, disk_conflicted)
    end
    WS-->>Tab: non-self write event
    Note over Tab: flagExternalChange raises changed-on-disk banner, no reload
```

## Implementation notes

- List continuation and indent/outdent match the current line with a regex, not the syntax tree, so the edit stays cheap and local.
- Heavy or optional modules load lazily on first use: mermaid and mermaid-to-excalidraw + excalidraw (diagram render; excalidraw carries React, so both are dynamic-imported and code-split out of the eager editor bundle), turndown (HTML-paste -> markdown), HEIC -> WebP conversion before image upload, and the per-language code packs (one vite chunk each).

## Out of scope

- In-cell table editing: the grid atom is read-only; edits happen in the revealed pipe/dash source.
- YAML highlighting inside frontmatter: the block is isolated and dimmed, the body is unstyled.
