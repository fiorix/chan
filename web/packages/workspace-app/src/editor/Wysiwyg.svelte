<script lang="ts">
  // CodeMirror 6 WYSIWYG editor. The doc IS the markdown source per
  // editor-cm6/design.md spec #1; rendered appearance is a pure
  // decoration layer built from @lezer/markdown's syntax tree.

  import { onDestroy, onMount } from "svelte";
  import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
  import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";
  import { syntaxTree } from "@codemirror/language";
  import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
  import { workspace, effectiveHybridSurfaceTheme } from "../state/store.svelte";
  import {
    createValueSync,
    findField,
    makeFindAdapter,
    makeThemeCompartment,
  } from "./base";
  import { chanMarkdown } from "./markdown/grammar";
  import { chanDecorations } from "./decorations";
  import { tagDecorations } from "./widgets/tag";
  import {
    mentionDecorations,
    type MentionClickArgs,
  } from "./widgets/mention";
  import { dateDecorations } from "./widgets/date";
  import {
    inlineCodeLinkClickHandler,
    inlineCodeLinkDecorations,
    inlineCodeLinkTarget,
    kindResolvedEffect,
    wikiLinkDecorations,
    type WikiLinkClickArgs,
  } from "./widgets/wikilink";
  import {
    collectDocImageSrcs,
    imageCaretRedirect,
    imageDecorations,
    selectedImageMarkdown as imageSelectedMarkdown,
    type ImageClickArgs,
  } from "./widgets/image";
  import { writeClipboardText } from "../api/desktop";
  import { tableDecorations } from "./widgets/table";
  import { mermaidDecorations, excalidrawDecorations } from "./widgets/diagram";
  import { bubbleKeymap, bubbleListener } from "./bubbles/controller";
  import type { BubbleHandle, BubbleSpec } from "./bubbles/types";
  import { openWikiBubble } from "./bubbles/wiki";
  import { openTagBubble } from "./bubbles/tag";
  import { openContactBubble } from "./bubbles/contact";
  import { openImageBubble } from "./bubbles/image";
  import { imageDropHandlers } from "./bubbles/image_drop";
  import { imageDragIndicator } from "./image_drag_indicator";
  import { pasteHandler } from "./paste_html";
  import { copyHandlers, type ChanClipboardContext } from "./copy_html";
  import { openImageZoom } from "../state/imageZoom";
  import { openDiagramZoom } from "../state/diagramZoom";
  import { headingFold } from "./fold";
  import * as fmt from "./commands/format";
  import * as clip from "./clipboard";
  import type { BlockKind } from "./commands/format";
  import { expandDateMacro, openDateAtCaret } from "./commands/date_macros";
  import {
    expandPageBreakMacro,
    pageBreakDecorations,
  } from "./commands/page_break";
  import {
    continueListOnEnter,
    indentListItem,
    outdentListItem,
    stripUnusedInlineImageSpaceOnEnter,
  } from "./commands/list";
  import type { FindAdapter } from "./find";
  import { breathingRoom } from "./breathing_room";
  import { selectionLayerRepaintFix } from "./selection_repaint";
  import { clickToPlaceCaret } from "./click_caret";
  import {
    externalLinkClickHandler,
    externalUrlAtCoords as resolveExternalUrlAtCoords,
  } from "./external_links";
  import { rightClickNoSelect } from "./right_click_no_select";
  import {
    removeTrailingWhitespace,
    toggleCodeBlocks,
    trailingWhitespaceHighlight,
  } from "./tools";

  let {
    value = $bindable(""),
    readonly = false,
    currentPath = null,
    wikiPickerPrefix = null,
    highlightTrailingWhitespace = false,
    initialCaret = null,
    autoFocus = true,
    placeholderText,
    extraExtensions = [],
    surface = "editor",
    onSubmit,
    onSelectionChange,
    onCaretChange,
    onTagClick = () => {},
    onWikiClick = () => {},
    onImageClick = () => {},
    onMentionClick = () => {},
  }: {
    value: string;
    readonly?: boolean;
    currentPath?: string | null;
    wikiPickerPrefix?: string | null;
    highlightTrailingWhitespace?: boolean;
    initialCaret?: { from: number; to: number } | null;
    /// When false, the editor skips the mount-time `view.focus()`.
    /// Hosts that own their own focus policy pass false to keep the
    /// editor unfocused on mount; otherwise the unconditional mount
    /// focus would race past the host's gate.
    autoFocus?: boolean;
    /// Empty-state placeholder text. When set the editor adds CM6's
    /// `placeholder` extension which renders at the cursor position
    /// (cursor + placeholder share the same x/y). Unset = no
    /// placeholder.
    placeholderText?: string;
    /// Host-provided CM6 extensions for editor variants that need one-off
    /// keymaps or event handlers while still using the full WYSIWYG stack.
    extraExtensions?: Extension[];
    /// Hybrid-theme surface this editor's syntax highlight + image/diagram
    /// dark-mode follow. File tabs are the "editor" surface; the Rich Prompt
    /// composer floats over a terminal and passes "terminal" so it matches the
    /// surface beneath it in a split light/dark hybrid theme.
    surface?: "editor" | "terminal";
    onSubmit?: () => void;
    onSelectionChange?: () => void;
    onCaretChange?: (from: number, to: number) => void;
    onTagClick?: (tag: string) => void;
    onWikiClick?: (args: WikiLinkClickArgs) => void;
    onImageClick?: (args: ImageClickArgs) => void;
    onMentionClick?: (args: MentionClickArgs) => void;
  } = $props();

  /// One-shot snapshot of the persisted caret captured at mount time.
  /// We cannot read `initialCaret` directly inside `maybeRestoreCaret`
  /// because every CM6 dispatch we issue along the way (the initial
  /// `selection: anchor 0` and the post-load `applyExternal`) fires a
  /// `selectionSet` update that mirrors back through `onCaretChange`
  /// → `setTabCaret` → `tab.caret = { from: 0, to: 0 }`. The parent's
  /// `initialCaret={tab.caret ?? null}` expression re-evaluates as
  /// soon as tab.caret changes, so by the time we'd read the prop the
  /// saved offset has already been overwritten with the doc-start
  /// fallback and the editor lands at the top.
  // svelte-ignore state_referenced_locally
  let caretPending: { from: number; to: number } | null = initialCaret;

  /// True once we've placed the caret at `initialCaret` after the
  /// first non-empty content apply. Same gate as Source.svelte.
  let caretRestored = false;

  function editorDensity(value: string | null | undefined): "standard" | "compact" {
    if (value === "compact" || value === "tight") return "compact";
    return "standard";
  }

  const density = $derived(editorDensity(workspace.info?.preferences?.line_spacing));

  let host: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  const sync = createValueSync();
  // Seed the theme with the surface's current light/dark; the $effect below
  // keeps it in sync on theme flips, and `surface` itself is fixed per mount.
  // svelte-ignore state_referenced_locally
  const theme = makeThemeCompartment(effectiveHybridSurfaceTheme(surface));
  const editableCompartment = new Compartment();
  const extraExtensionsCompartment = new Compartment();
  const trailingWhitespace = new Compartment();
  /// Compartment for the write-side bundle (bubble listener / bubble
  /// keymap / image drop / HTML paste). Wraps these so flipping
  /// `readonly` at runtime - e.g. user clicks the editor's "read"
  /// toggle, or the file's user-write bit flips off on disk - tears
  /// down the autocomplete pickers AND the paste/drop handlers
  /// without rebuilding the editor.
  const writeSideCompartment = new Compartment();

  /// Active bubble handle (or null when no bubble is open). Updated by
  /// the controller's onSpec callback; the keymap reads it via the
  /// `() => activeBubble` accessor so each keydown sees the live
  /// reference (no stale closure).
  let activeBubble: BubbleHandle | null = null;
  let activeKind: BubbleSpec["kind"] | null = null;
  /// The open bubble's trigger anchor + template mode. The reuse fast-path
  /// in handleSpec must match BOTH (not just the kind) before updating an
  /// open bubble in place: openWikiBubble captures triggerStart +
  /// templateMode as closure consts (used by commit / anchor / selfHit),
  /// so reusing the handle across a caret jump to a different construct or
  /// mode would commit against a stale range. A mismatch dismisses +
  /// remounts instead.
  let activeTriggerStart: number | null = null;
  let activeTemplateMode: BubbleSpec["templateMode"];

  function clearActiveBubble(): void {
    activeBubble = null;
    activeKind = null;
    activeTriggerStart = null;
    activeTemplateMode = undefined;
  }

  /// Image atom Cmd/Ctrl-click handler. The image widget only fires
  /// onImageClick on Cmd/Ctrl-click now (plain click drops the caret
  /// inside the URL so the image bubble auto-opens via the
  /// imageUrlAtCaret trigger). We treat Cmd/Ctrl-click as "open" -   /// route to the existing image-zoom modal.
  function handleImageClick(args: ImageClickArgs): void {
    // The viewer's prev/next set = every image in THIS document, in
    // document order, so paging stays within the open doc.
    const set = view
      ? collectDocImageSrcs(view).map((src) => ({ src, fromPath: currentPath }))
      : undefined;
    openImageZoom(args.src, currentPath, set);
    onImageClick(args);
  }

  function handleSpec(spec: BubbleSpec | null): void {
    if (!view) return;
    if (spec === null) {
      if (activeBubble) {
        activeBubble.dismiss();
        clearActiveBubble();
      }
      return;
    }
    // Same bubble kind AT THE SAME anchor + mode already open: update its
    // query / trigger end in place. A different kind, anchor, or mode (a
    // caret jump to another construct) dismisses the old and mounts fresh,
    // since the open bubble's triggerStart / templateMode are fixed at
    // open time.
    if (
      activeBubble &&
      activeKind === spec.kind &&
      activeTriggerStart === spec.triggerStart &&
      (activeTemplateMode ?? "wrap") === (spec.templateMode ?? "wrap")
    ) {
      // setTriggerEnd MUST run BEFORE setQuery: setQuery re-renders
      // the bubble (including the image preview, which reads
      // triggerStart..triggerEnd from the doc), and a stale
      // triggerEnd at that point produces a truncated URL preview.
      const ext = activeBubble as BubbleHandle & {
        setTriggerEnd?: (end: number) => void;
      };
      ext.setTriggerEnd?.(spec.triggerEnd);
      activeBubble.setQuery(spec.query);
      return;
    }
    if (activeBubble) {
      activeBubble.dismiss();
      clearActiveBubble();
    }
    const onDismiss = () => {
      clearActiveBubble();
    };
    if (spec.kind === "wiki") {
      activeBubble = openWikiBubble({
        view,
        triggerStart: spec.triggerStart,
        triggerEnd: spec.triggerEnd,
        initialQuery: spec.query,
        prefix: wikiPickerPrefix,
        templateMode: spec.templateMode ?? "wrap",
        fromPath: currentPath,
        onOpenLink: (target, anchor) =>
          onWikiClick({
            target,
            label: target,
            anchor: anchor ?? "",
            wasAbs: target.startsWith("/"),
            openInNewPane: false,
          }),
        onDismiss,
      });
      activeKind = "wiki";
    } else if (spec.kind === "tag") {
      activeBubble = openTagBubble({
        view,
        triggerStart: spec.triggerStart,
        triggerEnd: spec.triggerEnd,
        initialQuery: spec.query,
        onDismiss,
      });
      activeKind = "tag";
    } else if (spec.kind === "contact") {
      activeBubble = openContactBubble({
        view,
        triggerStart: spec.triggerStart,
        triggerEnd: spec.triggerEnd,
        initialQuery: spec.query,
        onDismiss,
      });
      activeKind = "contact";
    } else if (spec.kind === "mention") {
      // Same picker UI as @-contact, different commit shape: the
      // mention bubble writes `@@<alias-or-stem>` so the graph
      // resolver maps the sigil back to the contact file via the
      // contact's frontmatter aliases.
      activeBubble = openContactBubble({
        view,
        triggerStart: spec.triggerStart,
        triggerEnd: spec.triggerEnd,
        initialQuery: spec.query,
        mode: "mention",
        onDismiss,
      });
      activeKind = "mention";
    } else if (spec.kind === "image") {
      activeBubble = openImageBubble({
        view,
        triggerStart: spec.triggerStart,
        triggerEnd: spec.triggerEnd,
        initialQuery: spec.query,
        uploadDir: dirOf(currentPath),
        currentPath,
        // Images only ever carry "wrap"/"raw"; "code" is wiki-only.
        templateMode: spec.templateMode === "raw" ? "raw" : "wrap",
        onOpenLink: (path) => openImageZoom(path, currentPath),
        onDismiss,
      });
      activeKind = "image";
    }
    if (activeBubble) {
      activeTriggerStart = spec.triggerStart;
      activeTemplateMode = spec.templateMode;
    }
  }

  function dirOf(p: string | null): string | null {
    if (!p) return null;
    const idx = p.lastIndexOf("/");
    return idx <= 0 ? null : p.slice(0, idx);
  }

  /// Lazy context for the rich copy / paste path: the editing path, its
  /// directory (upload target), and the workspace root (the same-workspace
  /// short-circuit compares it against a pasted wrapper's root). Read
  /// lazily so a tab swap picks up the new values.
  function chanClipboardCtx(): ChanClipboardContext {
    return {
      getCurrentPath: () => currentPath,
      getUploadDir: () => dirOf(currentPath),
      getWorkspaceRoot: () => workspace.info?.root ?? null,
    };
  }

  /// Find-on-page adapter (same shape as Source.svelte and the legacy
  /// WYSIWYG; FileEditorTab passes whichever editor is mounted to
  /// FindBar).
  export const findAdapter: FindAdapter = makeFindAdapter(() => view);

  /// Style-toolbar contract. Each method routes to the corresponding
  /// editor-cm6/commands/format function with the live view ref.
  /// Mirrors the legacy editor's exported imperative API so
  /// StyleToolbar.svelte works at cutover with no edits.
  export function toggleBold(): void { if (view) fmt.toggleBold(view); }
  export function toggleItalic(): void { if (view) fmt.toggleItalic(view); }
  export function toggleStrike(): void { if (view) fmt.toggleStrike(view); }
  export function toggleInlineCode(): void { if (view) fmt.toggleInlineCode(view); }
  export function toggleBulletList(): void { if (view) fmt.toggleBulletList(view); }
  export function toggleOrderedList(): void { if (view) fmt.toggleOrderedList(view); }
  export function toggleTaskList(): void { if (view) fmt.toggleTaskList(view); }
  export function setBlockKind(kind: BlockKind): void {
    if (view) fmt.setBlockKind(view, kind);
  }
  export function insertHorizontalRule(): void {
    if (view) fmt.insertHorizontalRule(view);
  }
  export function insertImage(): void { if (view) fmt.insertImage(view); }
  export function toggleLink(url?: string): void {
    if (view) void fmt.toggleLink(view, url);
  }
  export function removeTrailingWhitespaceInEditor(): boolean {
    if (!view) return false;
    return removeTrailingWhitespace(view);
  }
  export function toggleCodeBlocksInEditor(): boolean {
    if (!view) return false;
    return toggleCodeBlocks(view);
  }
  export function isActive(name: string): boolean {
    return view ? fmt.isActive(view, name) : false;
  }
  // Body-context-menu clipboard entries. Keyboard Cmd+C/X/V keep their
  // own (rich) handlers; these back the right-click menu.
  export function selectionText(): string {
    return view ? clip.selectionText(view) : "";
  }
  // Markdown source of the ring-selected image, or null. Backs the
  // right-click Copy on an image, whose CM text selection is empty.
  export function selectedImageMarkdown(): string | null {
    return view ? imageSelectedMarkdown(view) : null;
  }
  export function copySelection(): Promise<void> {
    if (!view) return Promise.resolve();
    // An image atom carries an empty text selection, so fall back to its
    // markdown source: a paste re-inserts the markdown and re-renders.
    if (clip.selectionText(view) === "") {
      const md = imageSelectedMarkdown(view);
      if (md !== null) return writeClipboardText(md);
    }
    return clip.copySelection(view, chanClipboardCtx());
  }
  export function cutSelection(): Promise<void> {
    return view ? clip.cutSelection(view, chanClipboardCtx()) : Promise.resolve();
  }
  export function pasteClipboard(): Promise<void> {
    return view ? clip.pasteClipboard(view) : Promise.resolve();
  }
  // Body-context-menu link affordances: the openable external URL under
  // the right-click point (the body menu anchors there), or null.
  export function externalUrlAtCoords(x: number, y: number): string | null {
    return view ? resolveExternalUrlAtCoords(view, x, y) : null;
  }
  export function currentBlockKind(): BlockKind {
    return view ? fmt.currentBlockKind(view) : "normal";
  }
  /// Focus the editor without changing the selection. Used by
  /// FileEditorTab on chord-driven tab switches to land the caret
  /// on the editor surface immediately. Returns true if the view
  /// was ready; caller can short-circuit otherwise. Also calls
  /// `requestMeasure()` to force a viewport re-evaluation so image
  /// decorations render even when the measure cycle is stale from
  /// a tab switch.
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

  /// Place caret at end of doc and focus. Used by InlineAssist after
  /// content insertion / paste so the user can keep typing.
  export function focusEnd(): void {
    if (!view) return;
    const end = view.state.doc.length;
    focusAt(end);
  }

  /// Place caret at a specific document offset and focus.
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

  onMount(() => {
    if (!host) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        chanMarkdown(),
        headingFold(),
        theme.extension,
        trailingWhitespace.of(highlightTrailingWhitespace ? trailingWhitespaceHighlight() : []),
        EditorView.lineWrapping,
        // CM6's built-in placeholder. Renders at the cursor position
        // (inside the first line) when the doc is empty; hides on
        // first keystroke. Wired optionally because file editors
        // don't want a placeholder; only ephemeral surfaces do.
        ...(placeholderText ? [placeholder(placeholderText)] : []),
        extraExtensionsCompartment.of(extraExtensions),
        // Replace the browser-native text selection with CM6's
        // synthetic selection layer. Browser selection rectangles
        // are rendered per fragment and don't clear when the caret
        // moves to a non-CM target (e.g. focusing the FindBar
        // input), leaving stale blue rectangles around image
        // widgets visible across the canvas. The synthetic layer
        // tracks the editor's selection state directly and clears
        // on every selection change.
        drawSelection(),
        selectionLayerRepaintFix(),
        breathingRoom(),
        // Blank-area click helper: only fires when the precise hit-test
        // misses (a click past a short line's end or below the doc) to
        // drop the caret on the nearest row position. List markers are
        // real-width glyphs now, so list clicks need no special guard -
        // default CodeMirror placement handles them.
        clickToPlaceCaret(),
        findField,
        chanDecorations(),
        pageBreakDecorations(),
        tagDecorations({ onTagClick }),
        mentionDecorations({ onMentionClick }),
        dateDecorations(),
        externalLinkClickHandler(),
        inlineCodeLinkClickHandler({
          onWikiClick,
          getCurrentPath: () => currentPath,
        }),
        rightClickNoSelect(),
        wikiLinkDecorations({
          onWikiClick,
          getCurrentPath: () => currentPath,
        }),
        inlineCodeLinkDecorations({
          onWikiClick,
          getCurrentPath: () => currentPath,
        }),
        imageDecorations({
          getCurrentPath: () => currentPath,
          onImageClick: handleImageClick,
          isDark: () => effectiveHybridSurfaceTheme(surface) === "dark",
          onDiagramView: (svg) => openDiagramZoom(svg),
        }),
        imageCaretRedirect(),
        // Rich copy / cut lives in the ALWAYS-ON bundle (not the write-side
        // compartment) so a read-only doc still copies its images across
        // windows. Text-only selections defer to CM6's default copy.
        copyHandlers(chanClipboardCtx()),
        tableDecorations(),
        mermaidDecorations(
          () => effectiveHybridSurfaceTheme(surface) === "dark",
          (svg) => openDiagramZoom(svg),
        ),
        excalidrawDecorations(
          () => effectiveHybridSurfaceTheme(surface) === "dark",
          (svg) => openDiagramZoom(svg),
        ),
        // Inline edit bubbles + paste/drop handlers go through the
        // write-side compartment so toggling `readonly` at runtime
        // tears them down without rebuilding the editor.
        writeSideCompartment.of(writeSideExtensions(readonly)),
        editableCompartment.of(EditorView.editable.of(!readonly)),
        EditorView.updateListener.of((u) => {
          sync.onDocChanged(u, (s) => (value = s));
          if (u.docChanged || u.selectionSet) {
            onSelectionChange?.();
          }
          if (u.selectionSet && onCaretChange) {
            const sel = u.state.selection.main;
            onCaretChange(sel.from, sel.to);
          }
        }),
        // Cmd/Ctrl+Enter -> onSubmit. Registered
        // via Prec.high so it beats CM6 default Enter (which would
        // insert a newline first). Returning true consumes the event.
        Prec.high(
          keymap.of([
            // Conventional Bold / Italic chords. Registered in this
            // Prec.high block so CM6 consumes them before document-level
            // handlers; returning true preventDefaults.
            {
              key: "Mod-b",
              run: (view) => {
                fmt.toggleBold(view);
                return true;
              },
            },
            {
              key: "Mod-i",
              run: (view) => {
                fmt.toggleItalic(view);
                return true;
              },
            },
            // Mod-Enter at a date pill opens the calendar / format
            // popover (keyboard equivalent of clicking the pill).
            // Returns false when the caret isn't on a date so the
            // next entry below gets the keypress.
            {
              key: "Mod-Enter",
              run: (view) => openDateAtCaret(view),
            },
            // ArrowDown / Mod-Enter / Enter-on-closer escape a fenced
            // code block that sits at the end of the doc. Without
            // this, Enter inserts a literal newline inside the fence
            // and ArrowDown is a no-op - the user has no way out.
            // Each returns false when the trap conditions don't
            // apply so the keys keep their default behaviour
            // (cursorDown / caller submit / new line in code).
            { key: "ArrowDown", run: (view) => fmt.escapeFenceAtDocEnd(view) },
            // Mod-Enter inside any fenced code block: append a fresh
            // line just past the block end and place the caret
            // there. Always-on escape, independent of the block's
            // position in the doc - for cases the doc-end-only
            // rule above can't catch (unclosed fence followed by
            // content, opener inside a list, etc.).
            { key: "Mod-Enter", run: (view) => fmt.exitFenceAnywhere(view) },
            { key: "Mod-Enter", run: (view) => fmt.escapeFenceAtDocEnd(view) },
            // Submit when a host wires onSubmit; otherwise CONSUME the chord as
            // a no-op (return true) so it never falls through to CM6's default
            // Mod-Enter (insertBlankLine) in a plain file editor. RichPrompt
            // supplies its own higher-precedence submit, so this entry only
            // guards the no-onSubmit file-editor case. The date-pill and fence
            // Mod-Enter entries above are tried first and still win.
            // stopPropagation only for chat hosts: a submit must not bubble to
            // the image widget's document-level View chord (a pasted image is
            // ring-selected, so one press would submit AND open the zoom). The
            // no-onSubmit file editor keeps bubbling on purpose - the ring +
            // Mod-Enter View chord is a feature there and relies on it.
            {
              key: "Mod-Enter",
              run: () => {
                onSubmit?.();
                return true;
              },
              stopPropagation: !!onSubmit,
            },
            // `>` and `<` on a block selection (every line fully
            // covered) wrap / unwrap the lines in a `> ` blockquote
            // prefix. Returns false when the selection doesn't
            // qualify so the chars fall through to text input - a
            // user typing `>` mid-paragraph still gets a literal `>`.
            { key: ">", run: (view) => fmt.quoteLines(view) },
            { key: "<", run: (view) => fmt.unquoteLines(view) },
            // `@today`, `@date`, and page-break macros expand
            // when the user commits with Space or Enter. Returns
            // false on no match so the typed Space/Enter falls
            // through to normal input.
            { key: " ", run: (view) => expandDateMacro(view) },
            { key: " ", run: (view) => expandPageBreakMacro(view) },
            // Enter on the closing fence line at doc-end exits the
            // block. Mobile keyboards typically lack a reliable
            // Mod modifier and may not surface ArrowDown, so this
            // path is the touch-only escape hatch. Strictly limited
            // to the closer line so Enter inside the code body still
            // inserts a literal newline.
            {
              key: "Enter",
              run: (view) => fmt.escapeFenceOnEnterAtCloser(view),
            },
            { key: "Enter", run: (view) => expandDateMacro(view) },
            { key: "Enter", run: (view) => expandPageBreakMacro(view) },
            { key: "Enter", run: (view) => stripUnusedInlineImageSpaceOnEnter(view) },
            // List continuation: at end of a `- ` / `1. ` / `- [ ] `
            // line, Enter inserts a fresh marker on the next line;
            // on an empty bullet, Enter strips the prefix to exit
            // the list. Returns false on non-list lines so the
            // default Enter (newline) still fires.
            { key: "Enter", run: (view) => continueListOnEnter(view) },
            // Chat-style send chord. Only active when the host wires
            // an `onSubmit`; plain file editors leave `onSubmit` unset
            // so this entry returns false and Enter falls through to
            // CM6 default newline. Shift+Enter is registered separately
            // by CM6 as `"Shift-Enter"`, so the newline chord is
            // unaffected.
            {
              key: "Enter",
              run: () => {
                if (!onSubmit) return false;
                onSubmit();
                return true;
              },
              // Same containment as Mod-Enter above: a chat send must not
              // leak to document-level listeners. Inert in file editors
              // (the run returns false there, and the flag is off).
              stopPropagation: !!onSubmit,
            },
            // Tab inside a fenced code block inserts a literal tab.
            // Without this the keymap falls through to the browser's
            // default Tab (focus move), which makes it impossible to
            // indent code samples inside the editor.
            { key: "Tab", run: (view) => fmt.tabInFence(view) },
            // Tab / Shift-Tab on a list line bump the item's indent
            // by 2 spaces. Returns false for non-list lines so Tab
            // keeps its default behaviour outside lists.
            { key: "Tab", run: (view) => indentListItem(view) },
            { key: "Shift-Tab", run: (view) => outdentListItem(view) },
          ]),
        ),
      ],
    });
    view = new EditorView({ state, parent: host });
    view.dispatch({ selection: { anchor: 0 } });
    if (autoFocus) view.focus();
    // Force a viewport re-measure after mount. The editor frequently
    // mounts while the pane is still animating in (Hybrid Nav exit,
    // tab-switch transitions) so the initial viewport calculation
    // runs against a zero-size or hidden host. Without this, image
    // decorations skip rendering until the user pokes the cursor.
    view.requestMeasure();
    maybeRestoreCaret();
    // Unconditional deferred focus so brand-new docs (no persisted
    // caret) also re-claim focus once content has streamed in. The
    // mount-time view.focus() above runs while the doc is still
    // empty; on the New Draft path the Cmd+N chord handler parks
    // focus on <body> before content arrives, leaving the editor
    // unfocused. Gated on autoFocus so hosts that own their focus
    // policy stay unfocused.
    if (autoFocus) {
      requestAnimationFrame(() => {
        if (!view) return;
        view.focus();
      });
    }
  });

  /// Apply `initialCaret` once we have a doc to land it in. Idempotent;
  /// the `caretRestored` flag prevents a later content swap (autosave
  /// echo, sibling mirror) from yanking the caret back to the saved
  /// offset.
  function maybeRestoreCaret(): void {
    if (caretRestored || !view) return;
    const lim = view.state.doc.length;
    if (lim === 0) return;
    // No persisted caret (a plain open via the File Browser / `cs open`):
    // default to document start so the editor still places a caret AND
    // re-claims focus once content lands, mirroring the Draft path that
    // passes initialSelection. Without this an opener that omits a caret
    // leaves the note unfocused (caret unusable until the user clicks in).
    const target = caretPending ?? { from: 0, to: 0 };
    const from = Math.min(Math.max(0, target.from), lim);
    const to = Math.min(Math.max(0, target.to), lim);
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: "nearest" }),
    });
    caretRestored = true;
    caretPending = null;
    // The mount-time `view.focus()` runs while the doc is still
    // empty; content arrives async so focus falls back to <body> by
    // the time it lands. Re-assert focus once the caret is placed so
    // a freshly-opened note is typeable immediately. Deferred past
    // the current frame so it lands after any same-tick blur in the
    // open path and after layout settles. Gated on `autoFocus` so
    // hosts that own their focus policy stay unfocused.
    if (autoFocus) {
      requestAnimationFrame(() => {
        if (!view) return;
        view.focus();
      });
    }
  }

  onDestroy(() => {
    if (activeBubble) activeBubble.dismiss();
    view?.destroy();
  });

  $effect(() => {
    const before = view?.state.doc.toString();
    sync.applyExternal(view, value);
    // Only (re)place the caret when an EXTERNAL value change actually
    // applied content (the async file load), not on the keystroke echo
    // that writes `value` back from the live doc. Re-running on a keystroke
    // yanks the caret to document start mid-typing: on a new empty note the
    // first character flips the doc empty -> non-empty, maybeRestoreCaret
    // then resets the caret to 0, and the text reorders ("Hello" ->
    // "elloH").
    if (view && before !== view.state.doc.toString()) maybeRestoreCaret();
  });

  $effect(() => {
    if (!view) return;
    theme.reconfigure(view, effectiveHybridSurfaceTheme(surface));
  });

  $effect(() => {
    if (!view) return;
    view.dispatch({
      effects: trailingWhitespace.reconfigure(
        highlightTrailingWhitespace ? trailingWhitespaceHighlight() : [],
      ),
    });
  });

  // Reconfigure editability when the readonly prop flips. Runs in its
  // own effect so theme reconfigs don't bundle with it.
  $effect(() => {
    if (!view) return;
    view.dispatch({
      effects: editableCompartment.reconfigure(
        EditorView.editable.of(!readonly),
      ),
    });
  });

  $effect(() => {
    if (!view) return;
    view.dispatch({
      effects: extraExtensionsCompartment.reconfigure(extraExtensions),
    });
  });

  /// Build the write-side extension bundle. Inline edit bubbles
  /// (wiki / tag / contact / image / date pickers) and the
  /// paste/drop handlers only make sense when the document is
  /// editable. In read-only mode we hand back `[]` so clicks on
  /// widgets (which still set the caret via CM6's default
  /// behavior) can't accidentally trigger an autocomplete picker.
  function writeSideExtensions(ro: boolean): Extension[] {
    if (ro) return [];
    return [
      bubbleListener({
        onSpec: handleSpec,
        getCurrentPath: () => currentPath,
        // Resolution gate for the inline-code change picker: only a span
        // that resolves to a real file arms it (shares the decoration's
        // kind cache, so both agree on which spans are links).
        isInlineCodeFileLink: (text, path) =>
          inlineCodeLinkTarget(text, path) !== null,
        // A link kind resolving while the caret already sits inside it
        // is an effect-only transaction; recompute so the picker opens
        // without waiting for the next caret move.
        recomputeOn: (u) =>
          u.transactions.some((tr) =>
            tr.effects.some((e) => e.is(kindResolvedEffect)),
          ),
      }),
      bubbleKeymap(() => activeBubble),
      imageDropHandlers({
        getUploadDir: () => dirOf(currentPath),
        getCurrentPath: () => currentPath,
      }),
      // Live source-row indicator (drop-line + line badge) for the
      // image drag-to-move above. Write-side only: the drag affordance
      // exists solely in editable mode.
      imageDragIndicator,
      // HTML-paste handler runs ahead of CM6's default plain-text
      // paste so rich pastes get converted to markdown, and a chan-doc
      // wrapper carries its images across windows / workspaces. Image-file
      // pastes (clipboard with image/* MIME) are owned by
      // imageDropHandlers; the paste handler skips them. Both are
      // write-side, so they're disabled together.
      pasteHandler(chanClipboardCtx()),
    ];
  }

  /// Reconfigure the write-side bundle when readonly flips at
  /// runtime. Without this, toggling "read" mode on a file tab
  /// would leave the bubble listener mounted, and clicking a
  /// wiki-link / hashtag / date in the now-read-only view would
  /// still pop the autocomplete picker.
  $effect(() => {
    if (!view) return;
    // Also dismiss any open bubble at the moment of the flip; a
    // stale handle held across a reconfigure can't be dismissed
    // through the keymap anymore.
    if (activeBubble) {
      activeBubble.dismiss();
      clearActiveBubble();
    }
    view.dispatch({
      effects: writeSideCompartment.reconfigure(writeSideExtensions(readonly)),
    });
  });

  /// Scroll to the i-th heading (0-based, document order). Called by
  /// the inspector outline when the user picks a heading.
  export function scrollToHeading(i: number): void {
    if (!view) return;
    const headings: number[] = [];
    syntaxTree(view.state).iterate({
      enter(node) {
        if (
          node.name === "ATXHeading1" ||
          node.name === "ATXHeading2" ||
          node.name === "ATXHeading3" ||
          node.name === "ATXHeading4" ||
          node.name === "ATXHeading5" ||
          node.name === "ATXHeading6"
        ) {
          headings.push(node.from);
        }
      },
    });
    const target = headings[Math.max(0, Math.min(i, headings.length - 1))];
    if (target === undefined) return;
    view.dispatch({
      selection: { anchor: target },
      effects: EditorView.scrollIntoView(target, { y: "start" }),
    });
    view.focus();
  }
</script>

<div class="md-wysiwyg-cm6" data-density={density} data-file-drop-zone bind:this={host}></div>

<style>
  /* Step 4 styles. Each rule is scoped to .md-wysiwyg-cm6 so we don't
     bleed into Source mode or the legacy WYSIWYG. CSS variables come
     from the app theme (theme.css). */

  .md-wysiwyg-cm6 {
    flex: 1;
    min-width: 0;
    min-height: 0;
    height: 100%;
    overflow: auto;
    background: var(--bg);
    box-sizing: border-box;
  }

  :global(.md-wysiwyg-cm6 .cm-editor) {
    height: 100%;
    width: 100%;
    min-width: 0;
    font-size: var(--chan-editor-body-size, 16px);
    box-sizing: border-box;
  }
  :global(.md-wysiwyg-cm6 .cm-content) {
    font-family: var(--chan-editor-body-family);
    color: var(--chan-editor-body-color, var(--text));
    /* CodeMirror's scroller is a flex row. Without a zero min-width,
       the wide table widget becomes the content flex item's intrinsic
       minimum and normal paragraph lines stop wrapping at the page cap. */
    min-width: 0;
    /* The page-width cap lives on the content, so the "page" is the
       centered element while the scroller (.cm-editor / .cm-scroller)
       stays full width. The vertical scrollbar then sits at the
       viewport edge and the off-page shade fills the side margins.
       `min-height: 100%` keeps the white page spanning the viewport
       for a short document instead of stopping at the last line. */
    max-width: var(--chan-page-max-width, none);
    margin-inline: auto;
    min-height: 100%;
    /* `--editor-top-pad` is set by the host (FileEditorTab on its
       .editor-host, InlineAssist on the prompt wrap) and consumed
       here so the first line of the editor clears the floating
       style toolbar pill when it's enabled (2.5rem) and reclaims
       that space when it's hidden (0.5rem). The variable was
       orphaned during the CM6 migration - its old consumer lived
       on the legacy `.md-wysiwyg` class. Restoring the wiring
       lets the file editor's "Show Style Toolbar" toggle actually
       shift the document. */
    padding-top: var(--editor-top-pad, 0.5rem) !important;
    /* Always keep 60px below the last line. Combined with the 60px
       bottom scrollMargin in breathing_room.ts, this is what gives
       the Google Docs effect: the caret never sits flush with the
       bottom edge - when it would, CM scrolls so it stays 60px
       above, and this padding gives the scroll room to happen even
       at the doc's last line. */
    padding-bottom: 60px !important;
    transition: padding-top 180ms ease;
  }
  /* No `scroll-behavior: smooth` on `.cm-scroller`. `smooth` animates
     EVERY scrollTop write, including the height-estimation corrections
     CM6 makes itself while you scroll a tall, mostly-estimated document.
     During a trackpad pan those animated corrections fight the pan - a
     "scroll hangs, jumps the opposite way, then settles" stall.
     The Google-Docs page-lift effect comes from the 60px
     bottom padding + scrollMargin (breathing_room.ts), not from smooth,
     so leaving the scroller at its default (instant) scroll-behavior
     keeps the lift and removes the stall. */
  :global(.md-wysiwyg-cm6 .cm-editor),
  :global(.md-wysiwyg-cm6 .cm-editor .cm-scroller),
  :global(.md-wysiwyg-cm6 .cm-editor .cm-content),
  :global(.md-wysiwyg-cm6 .cm-editor .cm-line),
  :global(.md-wysiwyg-cm6 .cm-editor .cm-activeLine) {
    background-color: transparent !important;
  }
  /* When the page-width cap is active, paint the container with a
     subtle off-page tint and paint the centered "page" as a --bg
     layer BEHIND the text.

     The page fill must NOT live on .cm-content's own background:
     CodeMirror draws the selection highlight in .cm-selectionLayer, a
     sibling of .cm-content inside .cm-scroller at z-index:-1 (it sits
     *behind* .cm-content). An opaque .cm-content background paints over
     that layer and hides the selection entirely - which is exactly what
     broke once the 80% page cap became the default and every capped
     editor stopped showing selected text.

     Instead the fill lives on a .cm-content::before pseudo-element at
     z-index:-4: strictly behind the selection layer (-1) AND behind
     the code-block slab ::before (-3), which shares this stacking
     context because neither .cm-content nor .cm-line forms one. The
     opaque page fill must stay the BOTTOM layer - at -2 it buried the
     -3 slab and code blocks lost their background. Ordering, back to
     front: page fill (-4) < code slab (-3) < selection (-1) < text.
     Positioning it to .cm-content (which we make position:relative)
     keeps the page pixel-aligned with the text while .cm-content
     itself stays transparent. */
  :global(.chan-page-capped .md-wysiwyg-cm6) {
    background: var(--page-shade);
  }
  :global(.chan-page-capped .md-wysiwyg-cm6 .cm-content) {
    position: relative;
  }
  :global(.chan-page-capped .md-wysiwyg-cm6 .cm-content)::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -4;
    background: var(--bg);
    pointer-events: none;
  }
  /* CM6 paints `outline: 1px dotted` on .cm-editor.cm-focused as a
     focus indicator. We don't want it - the cursor itself is
     indicator enough, and the dotted outline spans the editor's
     entire bounding box including the gutter, which looks like a
     vertical divider in the gutter column. */
  :global(.md-wysiwyg-cm6 .cm-editor.cm-focused) {
    outline: none !important;
  }
  /* Heading-only fold gutter (custom). Strips the default gutter
     background + border so the chevron column blends into the
     editor canvas. */
  :global(.md-wysiwyg-cm6 .cm-gutters),
  :global(.md-wysiwyg-cm6 .cm-md-fold-gutter),
  :global(.md-wysiwyg-cm6 .cm-md-fold-gutter .cm-gutterElement) {
    background: transparent !important;
    border: none !important;
  }
  :global(.md-wysiwyg-cm6 .cm-md-fold-gutter .cm-gutterElement) {
    cursor: pointer;
    padding: 0 0.25em;
  }
  :global(.md-wysiwyg-cm6 .cm-md-fold-chevron) {
    color: var(--text-secondary, #aaa);
    transition: color 0.12s;
  }
  :global(.md-wysiwyg-cm6 .cm-md-fold-gutter .cm-gutterElement:hover .cm-md-fold-chevron) {
    color: var(--text);
  }
  /* Folded-heading inline placeholder ("..." dropped at EOL when a
     heading collapses). CM6's baseTheme paints it as a bordered chip
     with #eee bg + #ddd border which reads as too heavy. Switch to a
     light, borderless `...` that hints at the fold without competing
     with the heading text. */
  :global(.md-wysiwyg-cm6 .cm-foldPlaceholder) {
    background: transparent;
    border: none;
    color: var(--text-secondary, #aaa);
    margin: 0 0.25em;
    padding: 0 0.2em;
    font-weight: normal;
    cursor: pointer;
  }
  :global(.md-wysiwyg-cm6 .cm-foldPlaceholder:hover) {
    color: var(--text);
  }
  :global(.md-wysiwyg-cm6[data-density="standard"] .cm-line) { line-height: 1.8; }
  :global(.md-wysiwyg-cm6[data-density="compact"] .cm-line) { line-height: 1.65; }

  /* ---- mark decoration classes ---- */
  :global(.md-wysiwyg-cm6 .cm-md-bold) { font-weight: 700; }
  :global(.md-wysiwyg-cm6 .cm-md-italic) { font-style: italic; }
  :global(.md-wysiwyg-cm6 .cm-md-strike) { text-decoration: line-through; }
  :global(.md-wysiwyg-cm6 .cm-md-code) {
    font-family: var(--chan-editor-code-family, monospace);
    font-size: var(--chan-editor-code-size, 0.92em);
    background: var(--chan-editor-inline-code-bg, var(--bg-card, rgba(0,0,0,0.06)));
    color: var(--chan-editor-inline-code-color, inherit);
    padding: 0.05em 0.25em;
    border-radius: 3px;
  }
  /* An inline code span whose text resolves to a real workspace file:
     coloured like a link with a dotted underline to signal it is a
     Cmd/Ctrl-clickable reference, while the code text stays editable. */
  :global(.md-wysiwyg-cm6 .cm-md-code-link) {
    color: var(--chan-editor-link-color, var(--link, #0a64c8));
    text-decoration: underline dotted;
    text-underline-offset: 2px;
  }
  :global(.md-wysiwyg-cm6 .cm-md-link) {
    color: var(--chan-editor-link-color, var(--link, #0a64c8));
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  /* URL-when-revealed: dimmed so the user knows it's the URL portion
     they're editing, not the label. */
  :global(.md-wysiwyg-cm6 .cm-md-link-url) {
    color: var(--text-secondary, #888);
    opacity: 0.75;
  }

  /* ---- block-level line classes ---- */
  :global(.md-wysiwyg-cm6 .cm-md-quote) {
    border-left: 3px solid var(--chan-editor-quote-border, var(--text-secondary, #888));
    padding-left: 0.75em;
    color: var(--chan-editor-quote-color, var(--text-secondary, #888));
    font-style: italic;
  }
  /* Opener / closer / content rows share the code-block background
     so the whole fenced block reads as one continuous slab.
     The slab is painted by a ::before (further down), NOT by a
     `background` on the line itself: CodeMirror's drawSelection layer
     sits at z-index -1, so an opaque line background buried the
     selection highlight - text selected inside a code block was
     invisible. `position: relative` (no z-index, so it forms no
     stacking context) anchors the ::before and the floating badge
     widget on the opener row. */
  :global(.md-wysiwyg-cm6 .cm-editor .cm-line.cm-md-fence-opener),
  :global(.md-wysiwyg-cm6 .cm-editor .cm-line.cm-md-fence-closer),
  :global(.md-wysiwyg-cm6 .cm-editor .cm-line.cm-md-code-block) {
    position: relative;
    color: var(--chan-editor-code-block-color, inherit);
    font-family: var(--chan-editor-code-family, monospace);
    font-size: var(--chan-editor-code-size, 0.92em);
    /* Equal gutters on both sides so the body doesn't visually
       crash into the slab's right edge (the floating badge sits in
       this padded zone too). padding-left + padding-right written
       out separately because `padding-inline` was being overridden
       by CM6's own `.cm-line` default `padding: 0 2px` - separate
       longhand props beat the shorthand-default cascade order. */
    padding-left: 0.75em !important;
    padding-right: 0.75em !important;
    /* The code-block line lives inside .cm-content, which has no
       horizontal padding, so the slab (::before, inset:0 on this line's
       padding box) already sits flush to the content column's left edge
       - the same edge the paragraphs and dividers use. The CM6 fold
       gutter is a SEPARATE column to the LEFT of .cm-content, NOT a left
       inset of this line, so nothing pulls the slab's left edge in; a
       right border would only shorten the right and make it lopsided.
       So no right inset: the slab spans the content column flush on both
       sides, symmetric with body text. Scoped to this code-block line
       rule alone - the fold gutter, diagrams, and everything else are
       untouched. */
    border-right: 0;
    box-sizing: border-box;
  }
  /* The slab itself: a non-interactive layer pinned to the line's
     padding box, sitting at z-index -3: BEHIND the selection layer
     (-1, so selecting text inside a code block stays visible) but
     ABOVE the opaque page fill (-4, or the slab itself disappears).
     `inset: 0` resolves against the padding box, which the 18px
     transparent right border already shortens. */
  :global(.md-wysiwyg-cm6 .cm-editor .cm-line.cm-md-fence-opener::before),
  :global(.md-wysiwyg-cm6 .cm-editor .cm-line.cm-md-fence-closer::before),
  :global(.md-wysiwyg-cm6 .cm-editor .cm-line.cm-md-code-block::before) {
    content: "";
    position: absolute;
    inset: 0;
    background: var(
      --chan-editor-code-block-bg,
      var(--bg-card, rgba(0, 0, 0, 0.04))
    );
    z-index: -3;
    pointer-events: none;
  }
  :global(.md-wysiwyg-cm6 .cm-editor .cm-line.cm-md-fence-opener),
  :global(.md-wysiwyg-cm6 .cm-editor .cm-line.cm-md-fence-closer) {
    color: var(--text-secondary, #888);
    /* Opener row hosts the floating badge widget. */
    position: relative;
  }
  :global(.md-wysiwyg-cm6 .cm-md-fence-info) {
    color: var(--chan-editor-link-color, var(--link, #0a64c8));
    font-weight: 500;
  }
  /* Floating lang + copy badge anchored to the top-right of the
     fenced block. Lives at the end of the opener line via a CM6
     widget decoration; the opener row carries `position: relative`
     above so this absolute position resolves against it. */
  :global(.md-wysiwyg-cm6 .cm-md-fence-badge) {
    position: absolute;
    top: 2px;
    right: 6px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--chan-editor-code-family, monospace);
    font-size: 11px;
    line-height: 1;
    color: var(--text-secondary, #888);
    user-select: none;
    pointer-events: auto;
  }
  :global(.md-wysiwyg-cm6 .cm-md-fence-badge-lang) {
    text-transform: lowercase;
    letter-spacing: 0.04em;
  }
  :global(.md-wysiwyg-cm6 .cm-md-fence-badge-copy) {
    background: transparent;
    border: 0;
    border-radius: 3px;
    color: inherit;
    cursor: pointer;
    padding: 2px;
    line-height: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  :global(.md-wysiwyg-cm6 .cm-md-fence-badge-copy:hover) {
    color: var(--text);
    background: var(--hover-bg, rgba(127, 127, 127, 0.12));
  }
  :global(.md-wysiwyg-cm6 .cm-md-fence-badge-copy.copied) {
    color: var(--accent, #3fb950);
  }
  :global(.md-wysiwyg-cm6 .cm-md-fence-badge-copy.copy-failed) {
    color: var(--danger-text, #f85149);
  }
  /* Ghost closer for an unclosed fenced code block. Dimmed `\`\`\``
     pinned at the end of the fence's last body line so the user can
     see at a glance that the block isn't terminated. Click-to-close
     handler lives on the widget itself. */
  :global(.md-wysiwyg-cm6 .cm-md-fence-ghost-closer) {
    margin-left: 0.5em;
    padding: 0 0.35em;
    font-family: var(--chan-editor-code-family, monospace);
    font-size: var(--chan-editor-code-size, 0.92em);
    color: var(--danger-text, #b3261e);
    background: transparent;
    border: 1px dashed var(--danger-text, #b3261e);
    border-radius: 3px;
    opacity: 0.7;
    cursor: pointer;
    user-select: none;
  }
  :global(.md-wysiwyg-cm6 .cm-md-fence-ghost-closer:hover) {
    opacity: 1;
  }
  /* Indent + hanging indent for list item lines at every depth. Source
     whitespace around the marker is hidden (blocks.ts decorateListHang), so the
     text starts at exactly the fixed marker column (marker width + gap) and
     nesting is driven by syntactic depth here: each level adds one marker
     column, so a nested marker sits under its parent's text. We pad the line by
     (depth + 1) marker columns and pull the first line back by one column with
     text-indent, so the marker and first line stay put while every wrapped
     visual line hangs under the text. The 6px restores the base .cm-line gutter
     that the !important padding-left override would otherwise drop. */
  :global(.md-wysiwyg-cm6 .cm-line.cm-md-list-hang) {
    --cm-md-list-hang-col: calc(
      var(--chan-editor-list-marker-width, 2ch) +
        var(--chan-editor-list-marker-gap, 3ch)
    );
    padding-left: calc(
      6px + (var(--cm-md-list-level, 0) + 1) * var(--cm-md-list-hang-col)
    ) !important;
    text-indent: calc(-1 * var(--cm-md-list-hang-col));
  }
  /* Shared list marker column (bullets, hyphens, ordered numbers, task
     checkbox). The source whitespace after the marker is hidden by the
     decoration layer, so --cm-md-list-marker-gap alone is the gap to the text. */
  :global(.md-wysiwyg-cm6 .cm-md-list-marker) {
    --cm-md-list-marker-width: var(--chan-editor-list-marker-width, 2ch);
    --cm-md-list-marker-gap: var(--chan-editor-list-marker-gap, 3ch);
    display: inline-block;
    width: var(--cm-md-list-marker-width);
    margin-right: var(--cm-md-list-marker-gap);
    text-align: center;
    /* Reset the list line's hanging-indent text-indent (which is inherited into
       this inline-block) so the marker glyph / task checkbox positions normally
       inside the column instead of being shifted into the gutter. nowrap keeps
       a wide marker (e.g. a two-digit "10.") on one line: it overflows the
       fixed column width rather than breaking, since the line's pre-wrap
       white-space is otherwise inherited here. */
    text-indent: 0;
    white-space: nowrap;
    font-family: var(--chan-editor-list-marker-family, inherit);
    color: inherit;
    box-sizing: border-box;
    vertical-align: baseline;
  }
  :global(.md-wysiwyg-cm6 .cm-md-ol-marker) {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  :global(.md-wysiwyg-cm6 .cm-md-task-checkbox) {
    --cm-md-task-checkbox-width: var(--chan-editor-task-checkbox-width, 1em);
    display: inline;
    width: var(--cm-md-task-checkbox-width);
    height: var(--cm-md-task-checkbox-width);
    margin: 0;
    vertical-align: -0.08em;
    color: inherit;
    cursor: pointer;
  }
  /* `*`/`+` bullet markers render as a REAL glyph CHARACTER carried by a
     replace-widget (blocks.ts BulletGlyphWidget): ● disc / ○ circle / ■
     square by nesting depth (Google Docs). The glyph is real inline text
     with real width, so it is positioned exactly like the hyphen `-` and
     ordered `1.` markers and gets default CodeMirror cursor / click /
     arrow behavior (no caret-snap scaffolding). The DOCUMENT keeps the
     literal `*`/`+` (the widget is render-only; source mode + round-trip
     are unchanged).
     Geometric glyphs fill most of the em box, so they read larger than a
     normal bullet; keep them deliberately smaller than surrounding text
     while inheriting the same body colour. */
  :global(.md-wysiwyg-cm6 .cm-md-ul-glyph) {
    color: inherit;
    font-size: inherit;
    line-height: inherit;
    transform: scale(var(--chan-editor-list-glyph-scale, 0.5));
    transform-origin: center;
    vertical-align: baseline;
  }
  /* The square's solid ink area reads heavier than a circle of equal box,
     so trim + recenter it. */
  :global(.md-wysiwyg-cm6 .cm-md-ul-glyph.cm-md-ul-square) {
    transform: scale(var(--chan-editor-list-square-glyph-scale, 0.44));
  }
  :global(.md-wysiwyg-cm6 .cm-md-frontmatter) {
    color: var(--text-secondary, #888);
    font-family: var(--chan-editor-code-family, monospace);
    font-size: 0.88em;
    opacity: 0.7;
  }
  :global(.md-wysiwyg-cm6 .cm-md-page-break) {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--text-secondary);
    font-family: var(--chan-editor-body-family);
    font-size: 12px;
    line-height: 1;
    padding: 12px 0;
    user-select: none;
  }
  :global(.md-wysiwyg-cm6 .cm-md-page-break-rule) {
    height: 1px;
    flex: 1;
    background: repeating-linear-gradient(
      to right,
      var(--chan-editor-hr-color, var(--border, #ddd)) 0,
      var(--chan-editor-hr-color, var(--border, #ddd)) 6px,
      transparent 6px,
      transparent 10px
    );
  }
  :global(.md-wysiwyg-cm6 .cm-md-page-break-label) {
    border: 1px solid var(--chan-editor-hr-color, var(--border, #ddd));
    border-radius: 999px;
    padding: 3px 8px;
    background: var(--chan-editor-bg, var(--bg));
  }
  :global(.md-wysiwyg-cm6 .cm-md-tag) {
    background: var(--pill-tag-bg);
    color: var(--pill-tag-fg);
    padding: 0.05em 0.4em;
    border-radius: 999px;
    font-size: 0.92em;
    cursor: pointer;
  }
  :global(.md-wysiwyg-cm6 .cm-md-tag:hover) {
    background: var(--pill-tag-bg-hover);
  }
  /* `@@mention` pills. Same shape as tag pills, separate palette
     (--pill-contact-*) so contacts read as a distinct kind from
     hashtags. Both kinds use Decoration.mark, so the underlying
     text remains source-editable; the pill is pure styling. */
  :global(.md-wysiwyg-cm6 .cm-md-mention) {
    background: var(--pill-contact-bg);
    color: var(--pill-contact-fg);
    padding: 0.05em 0.4em;
    border-radius: 999px;
    font-size: 0.92em;
    cursor: pointer;
  }
  :global(.md-wysiwyg-cm6 .cm-md-mention:hover) {
    background: var(--pill-contact-bg, var(--pill-contact-bg));
    filter: brightness(1.08);
  }
  :global(.md-wysiwyg-cm6 .cm-md-date-pill) {
    background: var(--pill-date-bg);
    color: var(--pill-date-fg);
    padding: 0.05em 0.4em;
    border-radius: 4px;
    font-size: 0.92em;
    cursor: text;
  }
  :global(.md-wysiwyg-cm6 .cm-md-wiki-pill) {
    background: var(--pill-wiki-bg);
    color: var(--pill-wiki-fg);
    padding: 0.05em 0.4em;
    border-radius: 4px;
    font-size: 0.95em;
    cursor: pointer;
  }
  :global(.md-wysiwyg-cm6 .cm-md-wiki-pill:hover) {
    background: var(--pill-wiki-bg-hover);
  }
  /* Kind variants. data-refkind populates after the async resolve
     lands; pills default to file styling until then. */
  :global(.md-wysiwyg-cm6 .cm-md-wiki-pill[data-refkind="contact"]) {
    background: var(--pill-contact-bg);
    color: var(--pill-contact-fg);
  }
  /* Lucide `user` glyph leading the contact pill. Sized to the
     pill's line-height; stroke = currentColor so it follows the
     pill's text colour automatically. */
  :global(.md-wysiwyg-cm6 .cm-md-wiki-pill-icon) {
    width: 0.95em;
    height: 0.95em;
    vertical-align: -0.15em;
    margin-right: 0.25em;
    display: inline-block;
  }
  :global(.md-wysiwyg-cm6 .cm-md-wiki-pill[data-refkind="image"]) {
    background: var(--pill-image-bg);
    color: var(--pill-image-fg);
  }
  :global(.md-wysiwyg-cm6 .cm-md-wiki-pill-image) {
    display: inline-block;
    padding: 0;
    background: none;
    line-height: 0;
    vertical-align: middle;
    border-radius: 4px;
    overflow: hidden;
    max-width: 160px;
    max-height: 96px;
  }
  :global(.md-wysiwyg-cm6 .cm-md-wiki-pill-image img) {
    max-width: 160px;
    max-height: 96px;
    object-fit: contain;
    display: block;
  }
  :global(.md-wysiwyg-cm6 .cm-md-wiki-pill[data-refkind="broken"]) {
    background: var(--pill-broken-bg);
    color: var(--pill-broken-fg);
    text-decoration: line-through;
  }
  :global(.md-wysiwyg-cm6 .cm-md-image-wrap) {
    display: inline-block;
    position: relative;
    line-height: 0;
    max-width: 100%;
  }
  /* Drag-to-move affordance: a writable image atom is draggable to a
     different row (the source markdown relocates; alignment + width
     ride along). The draggable lives on the IMG (CodeMirror resets the
     property on the widget root). Grab cursor signals it; the source
     dims while a drag is in flight so the user sees what they picked
     up. */
  :global(.md-wysiwyg-cm6 .cm-md-image-wrap img[draggable="true"]) {
    cursor: grab;
  }
  :global(.md-wysiwyg-cm6 .cm-md-image-wrap[data-dragging="true"]) {
    opacity: 0.4;
  }
  /* Live source-row indicator while dragging an image to a new row. The
     drop-line marks the target line's top (where moveImageSource
     inserts); the muted variant means dropping there is a no-op (the
     image's own row). Drawn as an inset top shadow so it adds no height
     and never reflows the line under the pointer. */
  :global(.md-wysiwyg-cm6 .cm-md-image-drop-line) {
    box-shadow: inset 0 2px 0 0 var(--accent);
  }
  :global(.md-wysiwyg-cm6 .cm-md-image-drop-line.cm-md-image-drop-noop) {
    box-shadow: inset 0 2px 0 0 var(--text-secondary);
    opacity: 0.7;
  }
  /* The pointer-following badge naming the target row. Appended to
     <body> (so a transformed pane ancestor can't break position:fixed),
     hence global + colour fallbacks in case the theme vars don't reach
     it. pointer-events:none so it never intercepts the drag. */
  :global(.cm-md-image-drop-badge) {
    position: fixed;
    z-index: 40000;
    pointer-events: none;
    max-width: 340px;
    padding: 3px 8px;
    border-radius: 5px;
    background: var(--bg-card, #222);
    color: var(--text, #eee);
    border: 1px solid var(--accent, #4a9eff);
    font-size: 12px;
    line-height: 1.5;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
  }
  :global(.cm-md-image-drop-badge.cm-md-image-drop-badge-noop) {
    border-color: var(--text-secondary, #888);
    opacity: 0.9;
  }
  /* Diagram cursor-render (mermaid, mermaid-to-excalidraw): a closed
     diagram fence is replaced by its rendered diagram when the cursor
     LEAVES it (the source code block is blocks.ts's own, untouched, while
     the cursor is inside). The diagram flips in on the HORIZONTAL (rotateX)
     axis -- like the image atom's cursor-in-source / cursor-out-render. A
     hover "View" button opens the pan/zoom overlay. */
  :global(.md-wysiwyg-cm6 .cm-md-diagram-rendered) {
    /* Vertical spacing is padding, never margin: CM6's height map measures
       block widgets via getBoundingClientRect (margins excluded), so any
       vertical margin drifts click-to-caret mapping for everything below. */
    padding: 0.4rem 0;
    perspective: 1200px;
    /* Mirror the code-block slab's right inset. The CM6 fold gutter eats
       ~18px on the LEFT, so the diagram's left edge already sits flush with
       the post-gutter content edge (correct). The right side has no gutter,
       so without this the diagram bleeds to the editor's right edge while the
       left is inset - lopsided, right margin too short. An 18px transparent
       right border (with border-box) shortens the diagram's box by 18px on
       the right, mirroring the left gutter exactly like .cm-md-code-block. */
    border-right: 18px solid transparent;
    box-sizing: border-box;
  }
  :global(.md-wysiwyg-cm6 .cm-md-diagram-inner) {
    position: relative;
    transform-origin: center top;
    animation: cm-md-diagram-flip-in 0.45s ease;
  }
  /* Hover actions row over a rendered diagram: "View" (pan/zoom overlay)
     plus explicit SVG / PNG copy choices. Hidden until the diagram is
     hovered (or a button is keyboard-focused), mirroring the image row. */
  :global(.md-wysiwyg-cm6 .cm-md-diagram-actions) {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity 0.15s ease;
  }
  :global(.md-wysiwyg-cm6 .cm-md-diagram-inner:hover .cm-md-diagram-actions),
  :global(.md-wysiwyg-cm6 .cm-md-diagram-actions:focus-within) {
    opacity: 1;
  }
  :global(.md-wysiwyg-cm6 .cm-md-diagram-view) {
    padding: 2px 10px;
    border: 1px solid var(--border, #ddd);
    border-radius: 6px;
    background: var(--bg-card, rgba(0, 0, 0, 0.04));
    color: var(--text, inherit);
    font: 12px/1.4 var(--chan-editor-body-family);
    cursor: pointer;
  }
  :global(.md-wysiwyg-cm6 .cm-md-diagram-view:focus-visible) {
    outline: 2px solid var(--focus, #0a66ff);
  }
  :global(.md-wysiwyg-cm6 .cm-md-diagram-view:hover) {
    background: var(--bg-hover, rgba(0, 0, 0, 0.08));
  }
  /* Format buttons briefly show a 12px Check after copying. */
  :global(.md-wysiwyg-cm6 .cm-md-diagram-view.cm-md-diagram-copy) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 2px 7px;
  }
  @keyframes cm-md-diagram-flip-in {
    from {
      transform: rotateX(-90deg);
      opacity: 0.2;
    }
    to {
      transform: rotateX(0);
      opacity: 1;
    }
  }
  :global(.md-wysiwyg-cm6 .cm-md-diagram-body) {
    display: flex;
    justify-content: center;
    min-height: 40px;
    padding: 8px 0;
    color: var(--text-secondary);
  }
  :global(.md-wysiwyg-cm6 .cm-md-diagram-body svg) {
    max-width: 100%;
    height: auto;
  }
  :global(.md-wysiwyg-cm6 .cm-md-diagram-body.cm-md-diagram-error) {
    display: block;
    color: var(--danger-text, #d33);
    font-family: ui-monospace, monospace;
    font-size: 12px;
    white-space: pre-wrap;
    /* The whole errored face is click-through to the failing source line
       (diagram.ts placeCaretOnErrorLine); advertise the press. */
    cursor: pointer;
  }
  /* Actionable error face: the line number leads, the offending
     source line is echoed verbatim, then the renderer's reason follows. */
  :global(.md-wysiwyg-cm6 .cm-md-diagram-error-head) {
    font-weight: 600;
    margin-bottom: 2px;
  }
  :global(.md-wysiwyg-cm6 .cm-md-diagram-error-src) {
    padding: 2px 6px;
    margin-bottom: 4px;
    border-left: 2px solid var(--danger-text, #d33);
    background: var(--bg-card, rgba(0, 0, 0, 0.04));
    white-space: pre;
    overflow-x: auto;
  }
  /* Failing-line accent: a left-border bar on the source line the
     renderer blamed, shown only while the cursor is in the block's
     source. A gutter-less linter marker - no global code-block restyle,
     no line-number column. `box-shadow` (not `border`) so the line
     doesn't reflow, and a faint tint to draw the eye. */
  :global(.md-wysiwyg-cm6 .cm-editor .cm-line.cm-md-diagram-error-line) {
    box-shadow: inset 2px 0 0 0 var(--danger-text, #d33);
    /* Faint translucent tint (not an opaque background) so a selection
       on this line still shows through - see the code-block ::before
       slab note above. */
    background: rgba(211, 51, 51, 0.12);
  }
  /* Selected ring: lit by clicking on the image (sets
     data-selected on the wrap). Click-outside clears it. The ring
     is a 2px outline so it sits on top of the image without
     reflowing the surrounding layout, and uses --link to read as a
     focus / selection state. */
  :global(.md-wysiwyg-cm6 .cm-md-image-wrap[data-selected="true"]) {
    outline: 2px solid var(--link);
    outline-offset: 2px;
    border-radius: 2px;
  }
  /* Broken-image placeholder. Renders when the image's URL 404s
     or resolution returned empty (relative path with no
     resolvable fromPath, missing attachment, etc.). The icon +
     label give the user a visible signal of where the bad ref
     is in the source, instead of an invisible empty span. */
  :global(.md-wysiwyg-cm6 .cm-md-image-wrap[data-broken="true"]) {
    /* Block-style so the badge takes a clean row aligned with
       surrounding paragraph margins. Inline-block (the writable
       default) leaves it dangling at the wrong width. */
    display: block;
    line-height: 1.4;
    background: var(--pill-broken-bg, rgba(220, 50, 50, 0.08));
    color: var(--pill-broken-fg, #b00020);
    border: 1px dashed var(--pill-broken-fg, #b00020);
    border-radius: 4px;
    padding: 4px 8px;
    max-width: 100%;
    box-sizing: border-box;
  }
  /* Hide the hover overlay (Edit / View) and the resize handle
     on a broken image - there's no image to edit or view, and
     the controls competed with the badge's own right edge. */
  :global(.md-wysiwyg-cm6 .cm-md-image-wrap[data-broken="true"] .cm-md-image-actions),
  :global(.md-wysiwyg-cm6 .cm-md-image-wrap[data-broken="true"] .cm-md-image-handle) {
    display: none;
  }
  :global(.md-wysiwyg-cm6 .cm-md-image-wrap[data-excalidraw="true"]) {
    line-height: normal;
  }
  :global(.md-wysiwyg-cm6 .cm-md-excalidraw-embed) {
    display: flex;
    justify-content: center;
    min-width: 120px;
    max-width: 100%;
    min-height: 40px;
    padding: 8px 0;
    color: var(--text-secondary);
  }
  :global(.md-wysiwyg-cm6 .cm-md-excalidraw-embed svg) {
    max-width: 100%;
    height: auto;
  }
  /* The error face is clickable (reveal the source, caret in the URL),
     mirroring the broken-raster badge; the pointer advertises it. */
  :global(.md-wysiwyg-cm6 .cm-md-excalidraw-embed.cm-md-excalidraw-embed-error) {
    display: block;
    color: var(--danger-text, #d33);
    font-family: ui-monospace, monospace;
    font-size: 12px;
    white-space: pre-wrap;
    line-height: 1.4;
    cursor: pointer;
  }
  :global(.md-wysiwyg-cm6 .cm-md-image-broken) {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-family: var(--chan-editor-body-family);
  }
  :global(.md-wysiwyg-cm6 .cm-md-image-broken-icon) {
    font-size: 18px;
    filter: grayscale(0.8);
    opacity: 0.7;
  }
  :global(.md-wysiwyg-cm6 .cm-md-image-broken-label) {
    word-break: break-all;
  }
  /* Inline mode (image mixed with paragraph text). Alignment makes
     the image float so surrounding text wraps around it. */
  :global(.md-wysiwyg-cm6 .cm-md-image-wrap:not([data-standalone])[data-align="left"]) {
    display: block;
    float: left;
    margin-right: 1em;
  }
  :global(.md-wysiwyg-cm6 .cm-md-image-wrap:not([data-standalone])[data-align="right"]) {
    display: block;
    float: right;
    margin-left: 1em;
  }
  /* Standalone mode (image alone on its source line). Alignment
     positions the image within the line via margin - no float, no
     text wrap. The wrap is shrink-to-fit so the absolutely
     positioned overlay (Edit / View / resize handle) anchors to
     the IMAGE'S edges, not the line's full width. */
  :global(.md-wysiwyg-cm6 .cm-md-image-wrap[data-standalone="true"]) {
    display: block;
    width: fit-content;
    margin: 0 auto; /* center */
  }
  :global(.md-wysiwyg-cm6 .cm-md-image-wrap[data-standalone="true"][data-align="left"]) {
    margin-left: 0;
    margin-right: auto;
  }
  :global(.md-wysiwyg-cm6 .cm-md-image-wrap[data-standalone="true"][data-align="right"]) {
    margin-left: auto;
    margin-right: 0;
  }
  /* In-edit preview: image stays visible AS A BLOCK above the
     editable source line. Fade slightly so the user reads it as a
     preview, not a final commit. Pointer events stay enabled so the
     hover Edit / View overlay still works on the preview. Cap the
     thumbnail to ~160px so a wide image (`#w=250` / `#w=346`)
     doesn't dominate the canvas - the preview is a reference, not
     the rendered version; the user is typing the URL right below
     it. The !important beats the inline `width: <N>px` the widget
     sets from the src fragment. */
  :global(.md-wysiwyg-cm6 .cm-md-image-wrap[data-editing="true"]) {
    /* Block-level row of its own, but `fit-content` shrinks the
       box to the thumbnail's dimensions so the selection ring + the
       hover action overlay anchor to the image, not the full line
       width. Without `fit-content` the wrap stretched the editor
       column and a freshly-uploaded image's selection ring (or any
       absolute child) painted across the whole canvas. */
    display: block;
    width: fit-content;
    opacity: 0.55;
    /* padding, not margin: block widgets must not carry vertical margins
       (CM6 height-map drift breaks click mapping below the widget). */
    padding: 0.25em 0;
  }
  :global(.md-wysiwyg-cm6 .cm-md-image-wrap[data-editing="true"] img) {
    max-width: 160px !important;
    max-height: 160px;
    width: auto !important;
    height: auto;
    object-fit: contain;
  }
  :global(.md-wysiwyg-cm6 .cm-md-image-wrap[data-editing="true"] .cm-md-excalidraw-embed) {
    max-width: 160px !important;
    max-height: 160px;
    width: auto !important;
    overflow: hidden;
  }
  /* Hide the resize handle on the edit-mode thumbnail - the
     thumbnail isn't the rendered version, so committing a new
     width by dragging here would set `#w=N` to the THUMBNAIL's
     dimensions, not the user's intent. The handle reappears once
     editing exits and the widget snaps back to the inline view. */
  :global(.md-wysiwyg-cm6 .cm-md-image-wrap[data-editing="true"] .cm-md-image-handle) {
    display: none;
  }
  /* Line after a floated inline image: clear the float so following
     lines drop BELOW the image instead of continuing to wrap. */
  :global(.md-wysiwyg-cm6 .cm-md-image-clear-after) {
    clear: both;
  }
  :global(.md-wysiwyg-cm6 .cm-md-image-wrap img) {
    max-width: 100%;
    height: auto;
    display: block;
    border-radius: 4px;
  }
  :global(.md-wysiwyg-cm6 .cm-md-image-handle) {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 0;
    height: 0;
    /* Lower-right triangle "tick" - drag handle that mirrors the
       legacy editor's resize affordance. Built with CSS borders so
       the shape scales cleanly without a glyph. The colored bottom
       border + transparent right form the hypotenuse running
       top-left → bottom-right. */
    border-style: solid;
    border-width: 0 0 12px 12px;
    border-color: transparent transparent var(--text-secondary, #888)
      transparent;
    cursor: nwse-resize;
    opacity: 0;
    transition: opacity 0.15s;
  }
  :global(.md-wysiwyg-cm6 .cm-md-image-wrap:hover .cm-md-image-handle) {
    opacity: 1;
  }
  /* Hover action overlay (Edit / Zoom). Visible only when the mouse
     is over the image wrap; uses the same bouncy reveal as the other
     bubble surfaces. */
  :global(.md-wysiwyg-cm6 .cm-md-image-actions) {
    position: absolute;
    top: 4px;
    right: 4px;
    display: flex;
    gap: 4px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s, transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
    transform: scale(0.95);
    transform-origin: top right;
    line-height: 1;
  }
  :global(.md-wysiwyg-cm6 .cm-md-image-wrap:hover .cm-md-image-actions) {
    opacity: 1;
    pointer-events: auto;
    transform: scale(1);
  }
  :global(.md-wysiwyg-cm6 .cm-md-image-action) {
    background: var(--bg-card, #fff);
    border: 1px solid var(--border, #ddd);
    border-radius: 4px;
    padding: 3px 10px;
    font-family: inherit;
    font-size: 12px;
    color: var(--text);
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
    transition: transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1),
      background 0.12s;
  }
  :global(.md-wysiwyg-cm6 .cm-md-image-action:hover) {
    /* --bg-elev is opaque; --hover-bg is translucent and would let
       the image behind bleed through, washing the label out. */
    background: var(--bg-elev, #fff);
    transform: scale(1.05);
  }
  /* Icon-only Copy button. The 12px SVG would otherwise sit lower
     than the text labels; flex centering + a tighter horizontal
     padding keeps the row visually balanced. */
  :global(.md-wysiwyg-cm6 .cm-md-image-action.cm-md-image-copy) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 3px 7px;
  }
  /* Format-labelled pixel-copy buttons (SVG / PNG) briefly show the
     same 12px Check after copying; flex centering keeps the icon from
     sitting lower than the text label did. */
  :global(.md-wysiwyg-cm6 .cm-md-image-action.cm-md-image-copy-format) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  /* ---- table widget ---- */
  :global(.md-wysiwyg-cm6 .cm-md-table-wrap) {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    overflow-x: auto;
    /* padding, not margin: block widgets must not carry vertical margins
       (CM6 height-map drift breaks click mapping below the widget). */
    padding: 0.5em 0;
    contain: inline-size;
  }
  :global(.md-wysiwyg-cm6 .cm-md-table) {
    border-collapse: collapse;
    font-size: 0.95em;
    /* Size to content so a wide table overflows .cm-md-table-wrap (which
       scrolls) instead of letting the editor's lineWrapping collapse every
       column into char-by-char wrapping; min-width keeps a narrow table
       filling the row. */
    width: max-content;
    min-width: 100%;
  }
  :global(.md-wysiwyg-cm6 .cm-md-table th),
  :global(.md-wysiwyg-cm6 .cm-md-table td) {
    border: 1px solid var(--chan-editor-table-border, var(--border, #ddd));
    padding: 0.3em 0.6em;
    text-align: left;
    vertical-align: top;
    /* Undo the editor's inherited overflow-wrap (lineWrapping sets it to
       anywhere) so cell text wraps on words, never mid-word. */
    overflow-wrap: normal;
    word-break: normal;
  }
  :global(.md-wysiwyg-cm6 .cm-md-table th) {
    background: var(--chan-editor-table-header-bg, var(--bg-card, rgba(0, 0, 0, 0.04)));
    font-weight: 600;
  }
  :global(.md-wysiwyg-cm6 .cm-md-table tr:nth-child(even) td) {
    background: var(--chan-editor-table-stripe-bg, var(--bg-card, rgba(0, 0, 0, 0.02)));
  }

  /* ---- bubble shells ---- */
  :global(.md-bubble.cm-bubble) {
    background: var(--bg-card, #fff);
    border: 1px solid var(--border, #ddd);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
    min-width: 240px;
    max-width: 480px;
    padding: 4px;
    font-family: var(--chan-editor-body-family);
    font-size: 14px;
    /* Bouncy reveal + hover wobble - matches the tab-menu bubble's
       easeOutBack motion so the editor's pickers feel of-a-piece. */
    transform-origin: top left;
    animation: cm-bubble-pop 260ms cubic-bezier(0.34, 1.56, 0.64, 1);
    transition: transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  :global(.md-bubble.cm-bubble:hover) {
    transform: scale(1.015);
  }
  @keyframes cm-bubble-pop {
    0% {
      opacity: 0;
      transform: scale(0.92);
    }
    100% {
      opacity: 1;
      transform: scale(1);
    }
  }
  :global(.md-bubble .md-bubble-list) {
    display: flex;
    flex-direction: column;
  }
  :global(.md-bubble .md-bubble-row) {
    padding: 6px 8px;
    border-radius: 4px;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  :global(.md-bubble .md-bubble-row:hover) {
    background: var(--hover-bg, rgba(0, 0, 0, 0.04));
  }
  :global(.md-bubble .md-bubble-row-selected) {
    background: var(--accent-bg, rgba(106, 168, 255, 0.18));
    color: var(--accent, #2563b8);
  }
  :global(.md-bubble .md-bubble-status) {
    padding: 4px 8px;
    color: var(--text-secondary, #888);
    font-size: 12px;
    border-top: 1px solid var(--border, #eee);
    margin-top: 2px;
  }
  :global(.md-bubble .md-bubble-row-sub) {
    color: var(--text-secondary, #888);
    font-size: 12px;
  }
  /* Mention-only rows surface tokens that have no contact file
     backing them. Dimmer than contact-file rows so the user reads
     "body-text mention, not a first-class contact" at a glance. */
  :global(.md-bubble .md-bubble-row-mention-only) {
    opacity: 0.7;
  }
  :global(.md-bubble .md-bubble-row-mention-only.md-bubble-row-selected) {
    opacity: 1;
  }
  :global(.md-bubble .md-bubble-row-level) {
    display: inline-block;
    min-width: 2em;
    margin-right: 0.5em;
    color: var(--text-secondary, #888);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }
  :global(.md-bubble .md-bubble-actions) {
    border-bottom: 1px solid var(--border, #eee);
    margin-bottom: 4px;
    padding-bottom: 4px;
  }
  :global(.md-bubble .md-bubble-action) {
    color: var(--accent, #2563b8);
    font-weight: 500;
  }
  :global(.md-image-preview) {
    display: block;
    max-width: 100%;
    margin-bottom: 4px;
    border-bottom: 1px solid var(--border, #eee);
    padding-bottom: 4px;
    text-align: center;
    line-height: 0;
  }
  :global(.md-image-preview img) {
    max-width: 100%;
    max-height: 140px;
    object-fit: contain;
    border-radius: 4px;
  }
  :global(.md-image-align-row) {
    display: flex;
    gap: 4px;
    padding: 4px;
    border-bottom: 1px solid var(--border, #eee);
    margin-bottom: 4px;
  }
  :global(.md-image-align-btn) {
    flex: 1;
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 4px 6px;
    font-family: inherit;
    font-size: 14px;
    color: var(--text);
    cursor: pointer;
  }
  :global(.md-image-align-btn:hover) {
    background: var(--hover-bg, rgba(0, 0, 0, 0.06));
    border-color: var(--border, #ddd);
  }
  :global(.md-image-align-btn-active) {
    background: var(--accent-bg, rgba(106, 168, 255, 0.18));
    color: var(--accent, #2563b8);
    border-color: var(--accent, #2563b8);
  }
  :global(.md-image-action-overlay) {
    display: flex;
    gap: 4px;
    background: var(--bg-card, #fff);
    border: 1px solid var(--border, #ddd);
    border-radius: 6px;
    padding: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }
  :global(.md-image-action-btn) {
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 4px 10px;
    font-family: inherit;
    font-size: 12px;
    color: var(--text);
    cursor: pointer;
  }
  :global(.md-image-action-btn:hover) {
    background: var(--hover-bg, rgba(0, 0, 0, 0.06));
    border-color: var(--border, #ddd);
  }

  /* ---- link action popover ---- */
  :global(.md-link-action) {
    background: var(--bg-card, #fff);
    border: 1px solid var(--border, #ddd);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
    padding: 6px;
    min-width: 220px;
    max-width: 360px;
    font-family: var(--chan-editor-body-family);
    font-size: 13px;
  }
  :global(.md-link-action-target) {
    padding: 4px 6px 6px;
    color: var(--text-secondary, #666);
    font-family: var(--chan-editor-code-family, monospace);
    font-size: 12px;
    border-bottom: 1px solid var(--border, #eee);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  :global(.md-link-action-buttons) {
    display: flex;
    flex-direction: column;
    margin-top: 4px;
  }
  :global(.md-link-action-btn) {
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 6px 8px;
    text-align: left;
    font-family: inherit;
    font-size: 13px;
    color: var(--text);
    cursor: pointer;
  }
  :global(.md-link-action-btn:hover) {
    background: var(--hover-bg, rgba(0, 0, 0, 0.06));
  }

  /* ---- date popover ---- */
  :global(.md-date-popover) {
    background: var(--bg-card, #fff);
    border: 1px solid var(--border, #ddd);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
    padding: 8px;
    min-width: 240px;
    font-family: var(--chan-editor-body-family);
    font-size: 13px;
    transform-origin: top left;
    animation: cm-bubble-pop 260ms cubic-bezier(0.34, 1.56, 0.64, 1);
    transition: transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  :global(.md-date-popover:hover) {
    transform: scale(1.015);
  }
  :global(.md-date-header) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px 6px;
    border-bottom: 1px solid var(--border, #eee);
    margin-bottom: 6px;
  }
  :global(.md-date-title) {
    font-weight: 600;
  }
  :global(.md-date-nav) {
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 2px 8px;
    font-size: 16px;
    line-height: 1;
    color: var(--text);
    cursor: pointer;
  }
  :global(.md-date-nav:hover) {
    background: var(--hover-bg, rgba(0, 0, 0, 0.06));
    border-color: var(--border, #ddd);
  }
  :global(.md-date-grid) {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 2px;
  }
  :global(.md-date-dow) {
    text-align: center;
    color: var(--text-secondary, #888);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    padding: 4px 0;
  }
  :global(.md-date-blank) {
    visibility: hidden;
  }
  :global(.md-date-day) {
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 6px 0;
    font-family: inherit;
    font-size: 13px;
    color: var(--text);
    cursor: pointer;
    text-align: center;
  }
  :global(.md-date-day:hover) {
    background: var(--hover-bg, rgba(0, 0, 0, 0.06));
  }
  :global(.md-date-day-today) {
    border-color: var(--accent, #2563b8);
  }
  :global(.md-date-day-selected) {
    background: var(--accent, #2563b8);
    color: var(--bg-card, #fff);
  }
  :global(.md-date-format-row) {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px solid var(--border, #eee);
  }
  :global(.md-date-format-label) {
    color: var(--text-secondary, #888);
    font-size: 12px;
  }
  :global(.md-date-format-select) {
    flex: 1;
    background: var(--bg-card, #fff);
    border: 1px solid var(--border, #ddd);
    border-radius: 4px;
    padding: 4px 6px;
    color: var(--text);
    font-family: inherit;
    font-size: 12px;
  }
  /* Quick flip between DD/MM and MM/DD when a slash numeric format
     is selected. Disabled (greyed) for any other format so the
     button still occupies its slot and the row doesn't reflow. */
  :global(.md-date-region-flip) {
    background: var(--bg-card, #fff);
    border: 1px solid var(--border, #ddd);
    border-radius: 4px;
    padding: 4px 8px;
    color: var(--text);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    min-width: 56px;
    text-align: center;
  }
  :global(.md-date-region-flip:disabled) {
    cursor: default;
    opacity: 0.45;
  }
  :global(.md-date-region-flip:hover:not(:disabled)) {
    background: var(--hover-bg, #f0f0f0);
  }

  /* ---- preview popover ---- */
  /* File preview popover anchored under a clicked widget (wiki /
     contact / image) in read-only contexts. Same chrome family as
     the date popover; wider so a markdown body has room to breathe. */
  :global(.md-preview-popover) {
    background: var(--bg-card, #fff);
    color: var(--text, #111);
    border: 1px solid var(--border, #ddd);
    border-radius: 6px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.22);
    width: 560px;
    max-width: 80vw;
    max-height: 60vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: var(--chan-editor-body-family);
    font-size: 14px;
    animation: cm-bubble-pop 260ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  :global(.md-preview-header) {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border, #eee);
    background: var(--bg-elev, var(--bg-card));
  }
  :global(.md-preview-path) {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, monospace;
    font-size: 13px;
    color: var(--text);
  }
  :global(.md-preview-open) {
    background: var(--link, #0a66ff);
    color: #fff;
    border: 1px solid var(--link, #0a66ff);
    border-radius: 4px;
    padding: 2px 10px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    flex-shrink: 0;
  }
  :global(.md-preview-open:hover) {
    opacity: 0.92;
  }
  :global(.md-preview-body) {
    padding: 8px 12px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    line-height: 1.5;
  }
  /* Body markdown rendering scoped to the preview body so the rules
     apply to children sanitized by DOMPurify. */
  :global(.md-preview-md p) { margin: 0 0 0.4em 0; }
  :global(.md-preview-md p:last-child) { margin-bottom: 0; }
  :global(.md-preview-md h1),
  :global(.md-preview-md h2),
  :global(.md-preview-md h3),
  :global(.md-preview-md h4) {
    margin: 0.4em 0 0.2em 0;
    font-weight: 600;
  }
  :global(.md-preview-md h1) { font-size: 17px; }
  :global(.md-preview-md h2) { font-size: 15px; }
  :global(.md-preview-md h3),
  :global(.md-preview-md h4) { font-size: 14px; }
  :global(.md-preview-md ul),
  :global(.md-preview-md ol) {
    margin: 0.2em 0;
    padding-left: 1.4em;
  }
  :global(.md-preview-md li) { margin: 0.1em 0; }
  :global(.md-preview-md code) {
    font-family: ui-monospace, monospace;
    font-size: 0.92em;
  }
  :global(.md-preview-md pre) {
    background: var(--bg, #f5f5f7);
    border: 1px solid var(--border, #eee);
    border-radius: 4px;
    padding: 6px 8px;
    overflow-x: auto;
    margin: 0.4em 0;
  }
  :global(.md-preview-md a) {
    color: var(--link, #0a66ff);
    text-decoration: underline;
  }
  :global(.md-preview-md blockquote) {
    margin: 0.3em 0;
    padding: 0.1em 0.6em;
    border-left: 3px solid var(--border, #ddd);
    color: var(--text-secondary, #666);
  }
  :global(.md-preview-img) {
    display: block;
    max-width: 100%;
    max-height: 55vh;
    margin: 0 auto;
    border-radius: 3px;
  }
  :global(.md-preview-binary) {
    color: var(--text-secondary, #666);
    font-style: italic;
    text-align: center;
    padding: 16px;
  }
  :global(.md-preview-footer) {
    padding: 5px 10px;
    border-top: 1px solid var(--border, #eee);
    background: var(--bg-elev, var(--bg-card));
    color: var(--text-secondary, #666);
    font-size: 12px;
  }
  :global(.md-preview-hint) {
    font-variant-numeric: tabular-nums;
  }

  /* ---- heading line classes ---- */
  :global(.md-wysiwyg-cm6 .cm-md-h1),
  :global(.md-wysiwyg-cm6 .cm-md-h2),
  :global(.md-wysiwyg-cm6 .cm-md-h3),
  :global(.md-wysiwyg-cm6 .cm-md-h4),
  :global(.md-wysiwyg-cm6 .cm-md-h5),
  :global(.md-wysiwyg-cm6 .cm-md-h6) {
    font-family: var(--chan-editor-heading-family);
    color: var(--chan-editor-heading-color, var(--text));
  }
  :global(.md-wysiwyg-cm6 .cm-md-h1) {
    font-size: var(--chan-editor-h1-size);
    font-weight: var(--chan-editor-h1-weight);
    line-height: var(--chan-editor-h1-line-height);
    /* GitHub-style page-title rule. Themes that don't want this
       set --chan-editor-h1-border-bottom: none in their own block.
       padding-bottom adds to CM6's `.cm-line` padding without
       clobbering the horizontal padding shorthand. */
    border-bottom: var(--chan-editor-h1-border-bottom);
    padding-bottom: var(--chan-editor-h1-padding-bottom);
  }
  :global(.md-wysiwyg-cm6 .cm-md-h2) {
    font-size: var(--chan-editor-h2-size);
    font-weight: var(--chan-editor-h2-weight);
    line-height: var(--chan-editor-h2-line-height);
    border-bottom: var(--chan-editor-h2-border-bottom);
    padding-bottom: var(--chan-editor-h2-padding-bottom);
  }
  :global(.md-wysiwyg-cm6 .cm-md-h3) {
    font-size: var(--chan-editor-h3-size);
    font-weight: var(--chan-editor-h3-weight);
    line-height: var(--chan-editor-h3-line-height);
  }
  :global(.md-wysiwyg-cm6 .cm-md-h4) {
    font-size: var(--chan-editor-h4-size);
    font-weight: var(--chan-editor-h4-weight);
    line-height: var(--chan-editor-h4-line-height);
  }
  :global(.md-wysiwyg-cm6 .cm-md-h5) {
    font-size: var(--chan-editor-h5-size);
    font-weight: var(--chan-editor-h5-weight);
    line-height: var(--chan-editor-h5-line-height);
  }
  :global(.md-wysiwyg-cm6 .cm-md-h6) {
    font-size: var(--chan-editor-h6-size);
    font-weight: var(--chan-editor-h6-weight);
    line-height: var(--chan-editor-h6-line-height);
    color: var(--chan-editor-h6-color, var(--text-secondary));
  }
  /* defaultHighlightStyle paints tags.heading with text-decoration:
     underline. Strip it on every descendant of the heading line so
     the styled spans CM6 injects don't show the underline either. */
  :global(.md-wysiwyg-cm6 .cm-md-h1),
  :global(.md-wysiwyg-cm6 .cm-md-h2),
  :global(.md-wysiwyg-cm6 .cm-md-h3),
  :global(.md-wysiwyg-cm6 .cm-md-h4),
  :global(.md-wysiwyg-cm6 .cm-md-h5),
  :global(.md-wysiwyg-cm6 .cm-md-h6) {
    text-decoration: none;
  }
  :global(.md-wysiwyg-cm6 [class*="cm-md-h"] > span) {
    text-decoration: none !important;
  }
  /* Same defense for color: CM6's defaultHighlightStyle (registered
     with fallback: true in base.ts) paints inner heading tokens
     using whatever tag @lezer/markdown puts on them, which in
     practice leaks a salmon / pink hue onto heading text in dark
     mode. Force every descendant of a heading line to inherit the
     heading's color so the heading is monochrome regardless of how
     the markdown grammar tags inner spans. */
  :global(.md-wysiwyg-cm6 [class*="cm-md-h"] *) {
    color: inherit !important;
  }

  /* find-on-page (mirror of Source/WYSIWYG) */
  :global(.md-wysiwyg-cm6 .find-match) {
    background: var(--find-match-bg, rgba(255, 213, 0, 0.45));
    border-radius: 2px;
  }
  :global(.md-wysiwyg-cm6 .find-match--current) {
    background: var(--find-match-current-bg, rgba(255, 140, 0, 0.65));
    outline: 1px solid var(--find-match-current-border, rgba(180, 80, 0, 0.9));
  }
  :global(.md-wysiwyg-cm6 .cm-trailing-whitespace) {
    background: rgba(220, 38, 38, 0.22);
    border-radius: 2px;
  }
</style>
