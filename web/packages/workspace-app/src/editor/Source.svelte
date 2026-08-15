<script lang="ts">
  // CodeMirror 6 source mode. Same backing buffer as the WYSIWYG view; the
  // user toggles per-tab. Syntax highlighting follows the file's
  // extension (markdown for .md/.txt; lazy-loaded language packs for
  // .py / .rs / .json / ... via `editor/markdown/code_languages.ts`).
  //
  // Compartments keep us from rebuilding the editor across toggles:
  //   - theme: app theme flips (light <-> dark).
  //   - language: syntax-highlight toggle + per-tab path change.

  import { onDestroy, onMount } from "svelte";
  import { Compartment, EditorState, type Extension, Prec } from "@codemirror/state";
  import { EditorView, keymap, lineNumbers, placeholder } from "@codemirror/view";
  import {
    defaultKeymap,
    history,
    historyKeymap,
    indentWithTab,
  } from "@codemirror/commands";
  import { markdown } from "@codemirror/lang-markdown";
  import { currentPreferences, workspace, effectiveHybridSurfaceTheme } from "../state/store.svelte";
  import {
    createValueSync,
    findField,
    makeFindAdapter,
    makeThemeCompartment,
  } from "./base";
  import type { FindAdapter } from "./find";
  import { breathingRoom } from "./breathing_room";
  import { codeLanguages } from "./markdown/code_languages";
  import {
    removeTrailingWhitespace,
    toggleCodeBlocks,
    trailingWhitespaceHighlight,
  } from "./tools";
  import { rightClickNoSelect } from "./right_click_no_select";
  import * as clip from "./clipboard";
  import { externalUrlAtCoords as resolveExternalUrlAtCoords } from "./external_links";

  // Editor density follows the user's line_spacing pref. Same hook
  // the Wysiwyg side uses, exposed here as a `data-density` attribute
  // on .md-source so CSS can dial line-height without rebuilding the
  // CodeMirror editor. Legacy `tight` reads as canonical `compact`.
  function editorDensity(value: string | null | undefined): "standard" | "compact" {
    if (value === "compact" || value === "tight") return "compact";
    return "standard";
  }
  const density = $derived(editorDensity(currentPreferences()?.line_spacing));

  let {
    value = $bindable(""),
    path = "",
    readonly = false,
    syntaxHighlight = true,
    highlightTrailingWhitespace = false,
    initialCaret = null,
    autoFocus = true,
    placeholderText,
    extraExtensions = [],
    onCaretChange,
    onSubmit,
  }: {
    value: string;
    /// Workspace-relative file path. Workspaces the language pack picked for
    /// syntax highlighting. Empty / pathless callers get plain text.
    path?: string;
    readonly?: boolean;
    /// User-toggled syntax highlighting. When false the language
    /// compartment reconfigures to an empty extension array so CM
    /// renders plain text. Default true.
    syntaxHighlight?: boolean;
    highlightTrailingWhitespace?: boolean;
    initialCaret?: { from: number; to: number } | null;
    /// When false, skip the mount-time `view.focus()`. Hosts
    /// that own their own focus policy pass false to keep the
    /// editor unfocused on mount; otherwise the unconditional
    /// mount focus would race past the host's gate.
    autoFocus?: boolean;
    /// Empty-state placeholder text. Mirrors the same prop on
    /// `Wysiwyg.svelte` so a mode-toggle keeps the placeholder
    /// visible in either mode. Unset = no placeholder (the file
    /// editor's source view doesn't want one).
    placeholderText?: string;
    /// Host-provided CM6 extensions for editor variants that need one-off
    /// keymaps or event handlers while still using the full source stack.
    /// Mirrors the same prop on `Wysiwyg.svelte` so hosts can wire both
    /// editors identically.
    extraExtensions?: Extension[];
    onCaretChange?: (from: number, to: number) => void;
    /// Chat-style send chord. When wired, plain Enter calls this
    /// (Shift+Enter still inserts a newline via CM6 default). The
    /// file editor's source view leaves it unset so Enter keeps
    /// inserting a newline.
    onSubmit?: () => void;
  } = $props();

  /// True once we've placed the caret at `initialCaret` after the
  /// first non-empty content apply. Prevents the next external
  /// content update (autosave echo, sibling mirror) from snapping
  /// the caret back to the saved position.
  let caretRestored = false;
  /// Snapshot of the prop captured at mount; see Wysiwyg.svelte for
  /// why we cannot read `initialCaret` directly inside
  /// `maybeRestoreCaret` (CM6 dispatches fire `onCaretChange(0, 0)`,
  /// which overwrites `tab.caret` and the prop re-evaluates to the
  /// doc-start fallback before we get to use it).
  // svelte-ignore state_referenced_locally
  let caretPending: { from: number; to: number } | null = initialCaret;

  let host: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  const sync = createValueSync();
  const theme = makeThemeCompartment(effectiveHybridSurfaceTheme("editor"));
  // Language compartment lets the syntax-highlight toggle + per-tab
  // path change re-pick the active language pack without rebuilding
  // the editor. Initial extension covers the synchronous cases
  // (markdown + "no highlight"); text-class language packs land via
  // an async reconfigure after mount.
  const language = new Compartment();
  const trailingWhitespace = new Compartment();
  const editableCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();
  const extraExtensionsCompartment = new Compartment();
  // Track the language we last asked for; used to dedupe redundant
  // reconfigures when reactive deps re-fire without an actual change
  // (Svelte runs $effect on any prop touch).
  let lastLanguageKey: string | null = null;

  /// Find-on-page adapter. FileEditorTab passes whichever editor is
  /// currently visible to FindBar; the bar workspaces matches + decorations
  /// through this surface. Shared shape with the WYSIWYG adapter via
  /// editor-cm6/base.ts.
  export const findAdapter: FindAdapter = makeFindAdapter(() => view);

  /// Scroll to a specific line (0-based). Called by the inspector
  /// (outline view) when the user picks a heading and this tab is
  /// in source mode.
  export function scrollToLine(line: number): void {
    if (!view) return;
    const total = view.state.doc.lines;
    const target = Math.min(Math.max(0, line), Math.max(0, total - 1));
    const pos = view.state.doc.line(target + 1).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "start" }),
    });
    view.focus();
  }

  /// Focus the editor without changing the selection. Used by
  /// FileEditorTab on chord-driven tab switches to land the
  /// caret on the editor surface immediately. Returns true if
  /// the view was ready; caller can short-circuit otherwise.
  /// Also calls `requestMeasure()` for viewport parity with
  /// Wysiwyg's `focus()`.
  export function focus(): boolean {
    if (!view) return false;
    view.focus();
    view.requestMeasure();
    return true;
  }

  /// Re-measure without focusing. Used by FileEditorTab's keep-alive
  /// host when this tab becomes active WITHOUT gaining keyboard focus
  /// (flip-back, pane-mode exit, tab switch in a non-active pane):
  /// the visibility flip alone fires no resize/focus event, so this
  /// nudges CM6 to converge any viewport work deferred while hidden.
  export function remeasure(): void {
    view?.requestMeasure();
  }

  /// Place caret at a specific document offset and focus. Used by
  /// prompt surfaces that programmatically seed text before the
  /// editor mounts.
  export function focusAt(pos: number): void {
    if (!view) return;
    const lim = view.state.doc.length;
    const anchor = Math.min(Math.max(0, pos), lim);
    view.dispatch({ selection: { anchor } });
    view.focus();
  }

  /// Imperatively re-place the caret at a doc-offset range, scrolling it
  /// into view and refocusing. Unlike `maybeRestoreCaret` this is NOT gated
  /// by the one-shot `caretRestored` latch - it is the live channel the tab
  /// host drives on an explicit reopen of this kept-alive editor (the prop
  /// `initialCaret` was snapshotted once at mount and can no longer move the
  /// caret). Clamps to the current doc, so a command that arrives before
  /// content streams in is a harmless near-no-op; the real placement then
  /// still comes from `maybeRestoreCaret` once content lands.
  export function resetCaret(from: number, to: number): void {
    if (!view) return;
    const lim = view.state.doc.length;
    const f = Math.min(Math.max(0, from), lim);
    const t = Math.min(Math.max(0, to), lim);
    view.dispatch({
      selection: { anchor: f, head: t },
      effects: EditorView.scrollIntoView(f, { y: "nearest" }),
    });
    if (autoFocus) {
      requestAnimationFrame(() => {
        if (!view) return;
        view.focus();
      });
    }
  }

  export function removeTrailingWhitespaceInEditor(): boolean {
    if (!view) return false;
    return removeTrailingWhitespace(view);
  }

  export function toggleCodeBlocksInEditor(): boolean {
    if (!view) return false;
    return toggleCodeBlocks(view);
  }

  // Body-context-menu clipboard entries (mirror Wysiwyg). Keyboard
  // Cmd+C/X/V keep their own handlers; these back the right-click menu.
  export function selectionText(): string {
    return view ? clip.selectionText(view) : "";
  }
  export function copySelection(): Promise<void> {
    return view ? clip.copySelection(view) : Promise.resolve();
  }
  export function cutSelection(): Promise<void> {
    return view ? clip.cutSelection(view) : Promise.resolve();
  }
  export function pasteClipboard(): Promise<void> {
    return view ? clip.pasteClipboard(view) : Promise.resolve();
  }
  // Body-context-menu link affordances: the openable external URL under
  // the right-click point (the body menu anchors there), or null.
  export function externalUrlAtCoords(x: number, y: number): string | null {
    return view ? resolveExternalUrlAtCoords(view, x, y) : null;
  }

  onMount(() => {
    if (!host) return;
    // Seed the language compartment with whatever we can resolve
    // synchronously (markdown for .md/.txt; empty for everything
    // else, including text-class langs that load async below). The
    // async pass kicks in immediately after mount via applyLanguage.
    const { extension: initialLang, key: initialKey } = pickInitialLanguage();
    lastLanguageKey = initialKey;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        // `indentWithTab` first so Tab inserts an indent everywhere
        // in source mode (raw-text editing - no list / fence
        // detection like the WYSIWYG side). Shift-Tab outdents.
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
        // Chat-style send chord. High-prec so it beats defaultKeymap's
        // Enter -> insertNewlineAndIndent. Shift+Enter is registered
        // separately by CM6 as `"Shift-Enter"` (defaultKeymap `shift:`
        // alt), so the newline chord is unaffected. Falls through with
        // false when no host wired `onSubmit`, leaving the editor's
        // Enter behaviour as plain newline for file-editor callers.
        Prec.high(
          keymap.of([
            {
              key: "Enter",
              run: () => {
                if (!onSubmit) return false;
                onSubmit();
                return true;
              },
            },
          ]),
        ),
        language.of(initialLang),
        trailingWhitespace.of(highlightTrailingWhitespace ? trailingWhitespaceHighlight() : []),
        editableCompartment.of(EditorView.editable.of(!readonly)),
        readOnlyCompartment.of(EditorState.readOnly.of(readonly)),
        theme.extension,
        EditorView.lineWrapping,
        // Optional empty-state placeholder. Same shape as
        // Wysiwyg.svelte's wiring; both modes expose the prop
        // so a mode-toggle keeps the placeholder visible in
        // either.
        ...(placeholderText ? [placeholder(placeholderText)] : []),
        extraExtensionsCompartment.of(extraExtensions),
        breathingRoom(),
        findField,
        rightClickNoSelect(),
        EditorView.updateListener.of((u) => {
          sync.onDocChanged(u, (s) => (value = s));
          if (u.selectionSet && onCaretChange) {
            const sel = u.state.selection.main;
            onCaretChange(sel.from, sel.to);
          }
        }),
      ],
    });
    view = new EditorView({ state, parent: host });
    // Drop cursor at start of doc and focus so the editor is ready to
    // type immediately after opening / switching tabs. The restore
    // pass (below) will move it again once the persisted caret is
    // available and the doc is non-empty.
    view.dispatch({ selection: { anchor: 0 } });
    if (autoFocus) view.focus();
    maybeRestoreCaret();
    // Unconditional deferred focus so brand-new docs (no persisted
    // caret) also re-claim focus once content has streamed in. The
    // mount-time view.focus() above runs while the doc is still
    // empty; by the time content arrives the New Draft chord handler
    // has parked focus on <body>, leaving the editor unfocused.
    // Gated on autoFocus so hosts that own their focus policy stay
    // unfocused.
    if (autoFocus) {
      requestAnimationFrame(() => {
        if (!view) return;
        view.focus();
      });
    }
    // Kick off the async resolve for text-class langs. No-op for
    // markdown (already seeded) and for "no extension" / unknown
    // extensions (the initial empty stays).
    void applyLanguage();
  });

  /// Pick the synchronous language extension for the current path +
  /// syntaxHighlight prop. Returns `key` alongside so $effect can
  /// dedupe when nothing meaningful changed.
  ///
  /// `addKeymap: false` keeps source mode as a raw editor:
  /// `@codemirror/lang-markdown` defaults to wiring `Enter` to
  /// `insertNewlineContinueMarkup` (auto-continue lists + quotes).
  /// Wysiwyg lives in a separate component with its own
  /// `chanMarkdown()` (also addKeymap=false), so this only affects
  /// source mode.
  function pickInitialLanguage(): { extension: Extension; key: string } {
    if (!syntaxHighlight) return { extension: [], key: "off" };
    const ext = extOf(path);
    if (ext === "md" || ext === "txt") {
      return { extension: markdown({ addKeymap: false }), key: "markdown" };
    }
    return { extension: [], key: ext ? `pending:${ext}` : "plain" };
  }

  function extOf(p: string): string | null {
    const dot = p.lastIndexOf(".");
    if (dot < 0 || dot === p.length - 1) return null;
    return p.slice(dot + 1).toLowerCase();
  }

  /// Resolve the language for the current props and reconfigure the
  /// compartment. Markdown is synchronous (statically imported);
  /// every other language pack lives in `codeLanguages` and loads
  /// via dynamic import on first use. The function is idempotent:
  /// `lastLanguageKey` dedupes a redundant call when Svelte re-runs
  /// the $effect without an actual prop change.
  async function applyLanguage(): Promise<void> {
    if (!view) return;
    const target = await resolveLanguage();
    if (!view) return;
    if (target.key === lastLanguageKey) return;
    lastLanguageKey = target.key;
    view.dispatch({ effects: language.reconfigure(target.extension) });
  }

  async function resolveLanguage(): Promise<{ extension: Extension; key: string }> {
    if (!syntaxHighlight) return { extension: [], key: "off" };
    const ext = extOf(path);
    if (!ext) return { extension: [], key: "plain" };
    if (ext === "md" || ext === "txt") {
      return { extension: markdown({ addKeymap: false }), key: "markdown" };
    }
    const desc = codeLanguages.find((l) => l.extensions?.includes(ext));
    if (!desc) return { extension: [], key: `unknown:${ext}` };
    try {
      const support = await desc.load();
      return { extension: support, key: `lang:${desc.name}` };
    } catch (err) {
      console.error("[chan] language pack failed to load", ext, err);
      return { extension: [], key: `failed:${ext}` };
    }
  }

  /// Apply `initialCaret` once we have a doc to land it in. Idempotent;
  /// subsequent calls no-op via the `caretRestored` flag.
  function maybeRestoreCaret(): void {
    if (caretRestored || !view) return;
    const lim = view.state.doc.length;
    if (lim === 0) return;
    // No persisted caret (a plain open via the File Browser / `cs open`):
    // default to document start so the editor still places a caret AND
    // re-claims focus once content lands, mirroring the Draft path that
    // passes initialSelection. Without this an opener that omits a caret
    // leaves the file unfocused (caret unusable until the user clicks in).
    const target = caretPending ?? { from: 0, to: 0 };
    const from = Math.min(Math.max(0, target.from), lim);
    const to = Math.min(Math.max(0, target.to), lim);
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: "nearest" }),
    });
    caretRestored = true;
    caretPending = null;
    // The mount-time `view.focus()` runs on an empty doc; content
    // arrives async so focus falls back to <body> by the time it
    // lands. Re-assert focus once the caret is placed so a freshly-
    // opened source-mode file is typeable right away. Deferred past
    // the current frame so it lands after any same-tick blur in the
    // open path. Gated on `autoFocus` to respect hosts that own
    // their focus policy.
    if (autoFocus) {
      requestAnimationFrame(() => {
        if (!view) return;
        view.focus();
      });
    }
  }

  onDestroy(() => view?.destroy());

  $effect(() => {
    const before = view?.state.doc.toString();
    sync.applyExternal(view, value);
    // Only (re)place the caret when an EXTERNAL value change actually
    // applied content (the async file load), not on the keystroke echo
    // that writes `value` back from the live doc. Re-running on a keystroke
    // yanks the caret to document start mid-typing: on a new empty file the
    // first character flips the doc empty -> non-empty, maybeRestoreCaret
    // then resets the caret to 0, and the text reorders ("Hello" ->
    // "elloH"). We read `initialCaret` lazily (no $effect dep) so a later
    // prop update doesn't re-restore.
    if (view && before !== view.state.doc.toString()) maybeRestoreCaret();
  });

  // Reconfigure the theme compartment whenever the editor body
  // theme flips.
  $effect(() => {
    if (!view) return;
    theme.reconfigure(view, effectiveHybridSurfaceTheme("editor"));
  });

  // Re-pick the language pack when either the file path (different
  // extension => different language) or the user-toggled
  // syntaxHighlight switch changes. `applyLanguage` dedupes via
  // `lastLanguageKey` so a repeated re-run with no real change is
  // a no-op rather than a CM6 dispatch.
  $effect(() => {
    void path;
    void syntaxHighlight;
    void applyLanguage();
  });

  $effect(() => {
    if (!view) return;
    view.dispatch({
      effects: trailingWhitespace.reconfigure(
        highlightTrailingWhitespace ? trailingWhitespaceHighlight() : [],
      ),
    });
  });

  $effect(() => {
    if (!view) return;
    view.dispatch({
      effects: [
        editableCompartment.reconfigure(EditorView.editable.of(!readonly)),
        readOnlyCompartment.reconfigure(EditorState.readOnly.of(readonly)),
      ],
    });
  });

  $effect(() => {
    if (!view) return;
    view.dispatch({
      effects: extraExtensionsCompartment.reconfigure(extraExtensions),
    });
  });
</script>

<div class="md-source" data-density={density} data-file-drop-zone bind:this={host}></div>

<style>
  /* Keep the CodeMirror chrome wrapper themed. The CM6 editor itself
     uses its default light highlight style for now (see v1.1 polish). */
  .md-source {
    /* `flex: 1` so the wrapper always spans the full pane width
       (matches `.md-wysiwyg`). Without it, the wrapper shrinks to
       its content's intrinsic width - and once we cap `.cm-editor`
       via `--chan-page-max-width`, that intrinsic width becomes
       the cap, leaving the source view left-aligned in the pane
       instead of centered within the page-width column. */
    flex: 1;
    min-height: 0;
    height: 100%;
    overflow: auto;
    background: var(--bg);
    box-sizing: border-box;
  }
  /* Source mode uses the workspace's "code" font preference (it is
     a code editor, after all). */
  :global(.md-source .cm-editor) {
    height: 100%;
    font-size: var(--chan-editor-source-size, 14px);
    /* Center the whole CM editor (gutter + content together) within
       the cap when --chan-page-max-width is set (per-device pref
       written by state/pageWidth). Putting the cap on .cm-content
       instead would only narrow where lines wrap, leaving the
       gutter glued to the left edge and an empty band on the
       right. The scroll container .md-source stays full-width so
       the scrollbar sits at the viewport edge, matching the
       Wysiwyg side. */
    max-width: var(--chan-page-max-width, none);
    margin-inline: auto;
  }
  :global(.md-source .cm-content) {
    font-family: var(--chan-editor-code-family);
    /* Always keep 60px below the last line. See the matching rule
       in Wysiwyg.svelte for rationale. */
    padding-bottom: 60px;
  }
  /* No `scroll-behavior: smooth` on `.cm-scroller`. `smooth` animates
     EVERY scrollTop write, including CM6's own height-estimation
     corrections while scrolling a tall doc; during a trackpad pan those
     animated corrections fight the pan (the "hang, jump opposite,
     settle" stall). Removed for parity with Wysiwyg.svelte's
     `.cm-scroller`, where the same stall was reported and fixed. The
     60px bottom padding keeps the off-the-edge clearance. */
  /* Force every CM internal that could paint a background to
     transparent so `.md-source`'s `var(--bg)` shows uniformly,
     even past the longest line. CM injects theme rules as
     generated classes whose ordering we can't depend on; an
     `!important` at this static layer wins regardless. The
     gutter keeps its own bg (set on `.cm-gutters` in the theme
     extension) because its rule has higher specificity than
     these. */
  :global(.md-source .cm-editor),
  :global(.md-source .cm-editor .cm-scroller),
  :global(.md-source .cm-editor .cm-content),
  :global(.md-source .cm-editor .cm-line),
  :global(.md-source .cm-editor .cm-activeLine) {
    background-color: transparent !important;
  }
  /* Off-page tint while the page-width cap is active. See the
     matching rule in Wysiwyg.svelte for rationale. */
  :global(.chan-page-capped .md-source) {
    background: var(--page-shade);
  }
  :global(.chan-page-capped .md-source .cm-editor) {
    background-color: var(--bg) !important;
  }
  /* Line-spacing pref. Mirrors the Wysiwyg data-density rules so
     standard and compact flip both editors in lockstep. */
  :global(.md-source[data-density="standard"] .cm-line) { line-height: 1.7; }
  :global(.md-source[data-density="compact"] .cm-line) { line-height: 1.55; }

  /* Find-on-page highlight (mirror of the Wysiwyg rule). The
     CodeMirror Decoration.mark wraps each match in a <span> with
     these classes; the active match also picks up the orange ring.
     Same CSS variables as the WYSIWYG side so both modes look the
     same across a Wysiwyg <-> Source toggle. */
  :global(.md-source .find-match) {
    background: var(--find-match-bg, rgba(255, 213, 0, 0.45));
    border-radius: 2px;
  }
  :global(.md-source .find-match--current) {
    background: var(--find-match-current-bg, rgba(255, 140, 0, 0.65));
    outline: 1px solid var(--find-match-current-border, rgba(180, 80, 0, 0.9));
  }
  :global(.md-source .cm-trailing-whitespace) {
    background: rgba(220, 38, 38, 0.22);
    border-radius: 2px;
  }
</style>
