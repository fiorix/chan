# chan editor (CM6) - design

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

5. **Atom strategy (split by token type).**
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

10. **Autosave** writes `view.state.doc.toString()` on `update.docChanged` to the bindable `value` prop. The echo guard prevents prop write-back from clobbering the caret, and the debounced autosave pipeline owns the server write. No serialize step. While a tab is attached to its doc session (`/api/doc/ws`), edits ride `@codemirror/collab` update logs (remote peers paint as cursors) and saves are flush confirmations; the debounced autosave + CAS `PUT` below is the fallback when the channel is unavailable. The write contract on `PUT /api/files/<path>` is server-authority per path: a read of the path returns `authority_version` + `disk_conflicted`, and a changed-content write echoes the `authority_version` it last saw (alongside `expected_mtime_ns`). The server answers `428 PRECONDITION_REQUIRED` when that authority precondition is required but missing, and `409` on a version mismatch, carrying `current_authority_version` + `current_mtime_ns`. A watcher event for a non-self write flags a "changed on disk" banner instead of auto-reloading; once a session goes dirty/conflicted, the divergence is resolved explicitly via `POST /api/session-conflicts/resolve` with `{action: reload | overwrite}`. A debounced localStorage mirror keyed by path is kept for hang-recovery.

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

This is the detached/fallback path; an attached doc session replaces the PUT with collab pushes and flush confirmations. A keystroke flows through the echo guard and debounced autosave to `PUT /api/files/<path>`, carrying `expected_mtime_ns` + the last-read `authority_version`; a missing authority precondition returns 428, a version mismatch returns 409 and opens the conflict dialog, and a non-self `/ws` event only raises the changed-on-disk banner. A dirty/conflicted session is resolved explicitly through `POST /api/session-conflicts/resolve` (`reload` | `overwrite`).

```mermaid
sequenceDiagram
    actor User
    participant CM as "Editor (CM6)"
    participant Sync as "createValueSync"
    participant Tab as "tab.content (App effect)"
    participant Save as "scheduleAutosave"
    participant LS as "editorBuffer (localStorage)"
    participant Srv as "PUT /api/files/<path>"
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
