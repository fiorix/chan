<script lang="ts">
  // Rich Prompt: a floating, inset markdown bubble over the bottom of a
  // terminal. It edits a real per-terminal draft (`draft.md`) with the same
  // WYSIWYG editor used by file tabs, so pasted images are markdown image embeds
  // and render immediately. Mod+Enter sends the backing text through the
  // terminal prompt queue; each image embed is delivered as the bare absolute
  // on-disk path the receiving target reads, while the composer keeps showing
  // the image.

  import { onDestroy, onMount } from "svelte";
  import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
  import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
  import { indentLess, indentMore } from "@codemirror/commands";
  import Wysiwyg from "../editor/Wysiwyg.svelte";
  import { indentListItem, outdentListItem } from "../editor/commands/list";
  import { rewriteImagePathsForDelivery } from "../editor/deliver_images";
  import { workspace } from "../state/store.svelte";
  import { filesContext } from "../state/fileContext.svelte";
  import { currentOS } from "../state/shortcuts";
  import { hideRichPromptForTab } from "../state/richPrompt.svelte";
  import {
    beginPendingPrompt,
    failPendingPrompt,
    sendCancelToTerminal,
    sendPromptToTerminal,
    setRichPromptCaret,
    setRichPromptHeight,
    tabFocusPulse,
    type TerminalTab,
  } from "../state/tabs.svelte";
  import { api } from "../api/client";
  import {
    submitAgentForTerminal,
    type SubmitAgent,
  } from "../terminal/submitMode";

  // `focused` is true only while this bubble's terminal is the active tab
  // of the active pane. It gates the editor's mount autofocus and the
  // refocus effect below: the bubble stays mounted while its tab is hidden
  // (keep-alive, like the terminal body), so an ungated focus would let a
  // background tab's composer steal the keyboard.
  let { tab, focused = false }: { tab: TerminalTab; focused?: boolean } =
    $props();

  let rootEl = $state<HTMLDivElement>();
  let editor = $state<Wysiwyg>();
  let content = $state("");
  let loaded = $state(false);
  let mounting = $state(false);
  let mountError = $state<string | null>(null);
  // Seeded from the persisted per-terminal height so a restored bubble
  // reopens at the size the user left it; drag-resize commits back on end.
  // svelte-ignore state_referenced_locally
  let customHeight = $state<number | null>(tab.richPromptHeight ?? null);
  const MIN_PROMPT_HEIGHT = 56;
  let resizing = false;
  let resizeStartY = 0;
  let resizeStartHeight = 0;
  let destroyed = false;
  let draftPath = $state("");
  let writeTimer: ReturnType<typeof setTimeout> | null = null;

  const submitLabel =
    currentOS() === "mac" ? "submit with cmd+enter" : "submit with ctrl+enter";

  // ---- Pending-message state machine (queue visibility) -----------------
  const PENDING_CHIP_GRACE_MS = 300;
  const PROMPT_ACK_TIMEOUT_MS = 5000;
  const TRANSIENT_NOTE_MS = 5000;

  let pendingChipVisible = $state(false);
  let transientNote = $state<string | null>(null);
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let ackTimer: ReturnType<typeof setTimeout> | null = null;
  let noteTimer: ReturnType<typeof setTimeout> | null = null;

  const isPending = $derived.by(() => {
    const phase = tab.pendingPrompt?.phase;
    return phase === "sent" || phase === "queued";
  });

  // Reactive because the strip's recall control is only offered when this
  // client actually holds a message to pull back: `queuedCount` alone can be a
  // teammate's `cs terminal write`, which nothing here can recall.
  let lastQueued = $state<{ id: string; text: string } | null>(null);

  const lockCompartment = new Compartment();
  function lockExtensions(locked: boolean): Extension[] {
    return [EditorState.readOnly.of(locked), EditorView.editable.of(true)];
  }

  // The strip's buttons run the same actions the keymap runs, and those take
  // the live view. Wysiwyg keeps its view private, so a plugin self-registers
  // it here the way docSync's does. This bundle is reconfigured rather than
  // remounted when the lock flips, so the plugin is rebuilt against the same
  // view and the ref never goes stale while the composer is alive.
  let promptView: EditorView | undefined;

  function richPromptExtensions(locked: boolean): Extension[] {
    return [
      lockCompartment.of(lockExtensions(locked)),
      ViewPlugin.define((view) => {
        promptView = view;
        return {};
      }),
      EditorView.domEventHandlers({
        beforeinput: (event, view) => {
          if (!isPending) return false;
          event.preventDefault();
          const seeds = [
            "insertText",
            "insertReplacementText",
            "insertFromPaste",
            "insertFromDrop",
            "insertCompositionText",
          ];
          if (seeds.includes(event.inputType) && event.data) {
            const seed = event.data;
            enterLocalEdit();
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: seed },
              selection: { anchor: seed.length },
              effects: lockCompartment.reconfigure(lockExtensions(false)),
            });
            scheduleWrite();
            view.focus();
          }
          return true;
        },
      }),
      Prec.high(
        keymap.of([
          // stopPropagation: a pasted image leaves its atom ring-selected,
          // and the image widget's document-level keydown listener treats a
          // bubbling Mod-Enter as the View chord (fullscreen zoom). The
          // composer's submit must consume the chord entirely or one press
          // both submits and opens the overlay.
          { key: "Mod-Enter", run: submitFromView, stopPropagation: true },
          { key: "ArrowUp", run: recallFromView },
          { key: "Escape", run: dropOrAbandonFromView },
          // Tab indents (list item, else plain indent) and NEVER escapes to
          // the browser's focus nav: the composer is a chat box, not a
          // document, so Tab must stay inside it. indentMore/indentLess are
          // the fallback that make Tab/Shift-Tab always consume off-list.
          {
            key: "Tab",
            run: (v) => indentListItem(v) || indentMore(v),
            shift: (v) => outdentListItem(v) || indentLess(v),
          },
        ]),
      ),
    ];
  }

  const editorExtensions = $derived(richPromptExtensions(isPending));

  const queuedCount = $derived(
    Math.max(tab.queueDepth ?? 0, isPending && pendingChipVisible ? 1 : 0),
  );
  // The strip renders independent slots rather than one composite string: the
  // text slot is advisory, and each affordance it used to merely name is a
  // real control, so a pointer-only user can reach every one of them.
  const textSlot = $derived(
    transientNote ?? (queuedCount > 0 ? `${queuedCount} queued` : null),
  );
  // No secondary control while a message is in flight: stopping the send and
  // pulling it back for editing are the same action there, so the strip would
  // otherwise offer the same thing twice. Recall stays its own control only
  // once nothing is pending, where it does something submit does not.
  const secondaryAction = $derived.by(() => {
    if (isPending) return null;
    if (queuedCount > 0 && lastQueued)
      return { label: "↑ recall", disabled: content.length > 0 };
    return null;
  });
  // Pending is the only stop state, so one control carries both: submitting
  // turns it into stop, and stopping turns it back into submit.
  const primaryAction = $derived.by(() =>
    isPending
      ? { label: "esc cancel", disabled: false }
      : { label: submitLabel, disabled: content.trim().length === 0 },
  );

  function clearPendingTimers(): void {
    if (graceTimer !== null) clearTimeout(graceTimer);
    if (ackTimer !== null) clearTimeout(ackTimer);
    graceTimer = null;
    ackTimer = null;
  }

  function showTransientNote(text: string): void {
    transientNote = text;
    if (noteTimer !== null) clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      noteTimer = null;
      transientNote = null;
    }, TRANSIENT_NOTE_MS);
  }

  function consumeTerminalPhase(phase: "delivered" | "rejected" | "failed"): void {
    // Defer until the draft is loaded. The phase effect runs at mount before the
    // async onMount sets `draftPath` and loads `content`; consuming then would
    // clear `tab.pendingPrompt` while `flushWrite` no-ops (no draftPath), and the
    // subsequent load would restore the already-delivered text into an editable
    // composer. onMount re-runs this once loaded, when the clear actually lands.
    if (!loaded) return;
    clearPendingTimers();
    pendingChipVisible = false;
    tab.pendingPrompt = undefined;
    if (phase === "delivered") {
      content = "";
      void flushWrite();
      lastQueued = null;
      // The cleared composer restarts at offset 0: reset the persisted
      // caret with it, and only refocus when this terminal is the focused
      // one - a delivery landing on a background tab's kept-mounted bubble
      // must not steal the keyboard.
      setRichPromptCaret(tab, 0, 0);
      if (focused) queueMicrotask(() => editor?.focusAt(0));
    } else {
      showTransientNote(
        phase === "rejected"
          ? "queue full, try again"
          : "connection lost, message may still be queued",
      );
    }
  }

  $effect(() => {
    const phase = tab.pendingPrompt?.phase;
    if (phase === "queued") {
      if (ackTimer !== null) clearTimeout(ackTimer);
      ackTimer = null;
    } else if (phase === "delivered" || phase === "rejected" || phase === "failed") {
      consumeTerminalPhase(phase);
    }
  });

  // Pull keyboard focus back into the composer whenever this terminal
  // becomes the focused tab again (tab switch back, pane focus). The bubble
  // stays mounted while hidden, so no mount autofocus fires on the way
  // back; this effect restores focus without touching the editor's
  // selection, so the caret stays exactly where the user left it. Mirrors
  // FileEditorTab's focus effect (same pulse + same !focused gates); the
  // terminal's own pulse effect defers to the bubble while it is open.
  $effect(() => {
    if (!focused) return;
    tabFocusPulse.value;
    queueMicrotask(() => {
      if (!focused) return;
      editor?.focus();
    });
  });

  function recallFromView(view: EditorView): boolean {
    if (isPending) {
      if (lastQueued) sendCancelToTerminal(tab.id, lastQueued.id);
      lastQueued = null;
      enterLocalEdit();
      view.dispatch({
        selection: { anchor: view.state.doc.length },
        effects: lockCompartment.reconfigure(lockExtensions(false)),
      });
      queueMicrotask(() => view.focus());
      return true;
    }
    if (content.length > 0 || !lastQueued) return false;
    const { id, text } = lastQueued;
    lastQueued = null;
    sendCancelToTerminal(tab.id, id);
    content = text;
    void flushWrite();
    queueMicrotask(() => editor?.focusEnd());
    return true;
  }

  function enterLocalEdit(): void {
    clearPendingTimers();
    if (noteTimer !== null) {
      clearTimeout(noteTimer);
      noteTimer = null;
    }
    pendingChipVisible = false;
    transientNote = null;
    tab.pendingPrompt = undefined;
  }

  function scheduleWrite(): void {
    if (!loaded) return;
    if (writeTimer !== null) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => void flushWrite(), 400);
  }

  async function flushWrite(): Promise<void> {
    if (writeTimer !== null) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    if (!draftPath) return;
    try {
      await api.write(draftPath, content);
    } catch {
      // best-effort; leave the in-memory draft intact.
    }
  }

  $effect(() => {
    content;
    if (!loaded) return;
    scheduleWrite();
  });

  function submitAgent(): SubmitAgent {
    return submitAgentForTerminal(tab.submitAgent, tab.keyboardProtocol);
  }

  function submitFromView(view: EditorView): boolean {
    if (isPending) return true;
    const text = view.state.doc.toString();
    if (!text.trim()) return true;
    const id = crypto.randomUUID();
    const delivered = rewriteImagePathsForDelivery(
      text,
      draftPath,
      // The display root the delivered absolute paths hang off: the
      // workspace root in a workspace window, "/" in a standalone one
      // (whose draft paths are wire paths over the machine root).
      workspace.info?.root ?? filesContext.current?.rootDisplay ?? null,
    );
    if (!sendPromptToTerminal(tab.id, delivered, submitAgent(), id)) return true;
    content = text;
    lastQueued = { id, text };
    beginPendingPrompt(tab, id);
    void flushWrite();
    view.focus();
    pendingChipVisible = false;
    if (graceTimer !== null) clearTimeout(graceTimer);
    graceTimer = setTimeout(() => {
      graceTimer = null;
      pendingChipVisible = true;
    }, PENDING_CHIP_GRACE_MS);
    if (ackTimer !== null) clearTimeout(ackTimer);
    ackTimer = setTimeout(() => {
      ackTimer = null;
      failPendingPrompt(tab);
    }, PROMPT_ACK_TIMEOUT_MS);
    return true;
  }

  async function ensureDraft(): Promise<string> {
    if (tab.richPromptDraftPath) return tab.richPromptDraftPath;
    const { path } = await api.createDraft();
    tab.richPromptDraftPath = path;
    try {
      await api.write(path, "");
    } catch {
      // best-effort; an unclear seed just shows once.
    }
    return path;
  }

  async function loadContent(path: string): Promise<string> {
    return (await api.read(path)).content ?? "";
  }

  function mountFailure(operation: "create" | "load", error: unknown): string {
    const detail =
      error instanceof Error && error.message
        ? error.message
        : typeof error === "string" && error
          ? error
          : "unknown error";
    return `Could not ${operation} Rich Prompt draft: ${detail}`;
  }

  async function mountDraft(): Promise<void> {
    if (mounting) return;
    mounting = true;
    let operation: "create" | "load" = tab.richPromptDraftPath
      ? "load"
      : "create";
    try {
      const path = await ensureDraft();
      if (destroyed) return;
      operation = "load";
      const nextContent = await loadContent(path);
      if (destroyed) return;
      draftPath = path;
      content = nextContent;
      loaded = true;
      mountError = null;
      const phase = tab.pendingPrompt?.phase;
      if (phase === "delivered" || phase === "rejected" || phase === "failed") {
        consumeTerminalPhase(phase);
      } else if (phase === "sent" || phase === "queued") {
        pendingChipVisible = true;
        // Seed from the id, never from whether the draft survived. The message
        // is queued on the server either way, so a blank draft must still leave
        // a bubble that can stop it; gating this on the text was what stranded
        // a queued message behind a composer that could only hide itself.
        lastQueued = { id: tab.pendingPrompt!.id, text: content };
        if (phase === "sent" && ackTimer === null) {
          ackTimer = setTimeout(() => {
            ackTimer = null;
            failPendingPrompt(tab);
          }, PROMPT_ACK_TIMEOUT_MS);
        }
      }
    } catch (error) {
      if (destroyed) return;
      draftPath = "";
      loaded = false;
      mountError = mountFailure(operation, error);
    } finally {
      if (!destroyed) mounting = false;
    }
  }

  onMount(() => {
    void mountDraft();
  });

  onDestroy(() => {
    destroyed = true;
    clearPendingTimers();
    if (noteTimer !== null) clearTimeout(noteTimer);
    noteTimer = null;
    void flushWrite();
  });

  function maxPromptHeight(): number {
    const parent = rootEl?.offsetParent as HTMLElement | null;
    const ph = parent?.clientHeight ?? window.innerHeight;
    return Math.max(MIN_PROMPT_HEIGHT, ph - 24);
  }

  function onResizeStart(e: PointerEvent): void {
    if (!rootEl) return;
    resizing = true;
    resizeStartY = e.clientY;
    resizeStartHeight = rootEl.offsetHeight;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function onResizeMove(e: PointerEvent): void {
    if (!resizing) return;
    const next = resizeStartHeight + (resizeStartY - e.clientY);
    customHeight = Math.min(maxPromptHeight(), Math.max(MIN_PROMPT_HEIGHT, next));
  }
  function onResizeEnd(e: PointerEvent): void {
    if (!resizing) return;
    resizing = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // capture may already be released; ignore.
    }
    // Commit the final height once per drag so a reload / cross-window
    // restore reopens the bubble at this size.
    if (customHeight !== null) setRichPromptHeight(tab, customHeight);
  }

  function dropOrAbandonFromView(view: EditorView): boolean {
    // Stopping a send is one action whichever key runs it: the message leaves
    // the queue and its text stays in the composer, ready to edit and send
    // again. The text is the user's work and a stop is not a discard.
    if (isPending) return recallFromView(view);
    if (lastQueued && content.length === 0) {
      sendCancelToTerminal(tab.id, lastQueued.id);
      lastQueued = null;
      enterLocalEdit();
      content = "";
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "" },
        effects: lockCompartment.reconfigure(lockExtensions(false)),
      });
      void flushWrite();
      return true;
    }
    abandonDraft();
    return true;
  }

  // The strip's stop runs `recallFromView`, never `dropOrAbandonFromView`:
  // that handler's fallthrough reaches `abandonDraft()` and hides the whole
  // bubble, which a stop control must never do.
  function onPrimaryClick(): void {
    if (!promptView) return;
    if (isPending) recallFromView(promptView);
    else submitFromView(promptView);
  }

  function onSecondaryClick(): void {
    if (!promptView) return;
    recallFromView(promptView);
  }

  // Keep the caret where it is: a button that took focus would blur the
  // composer, and every action below returns focus to the editor itself.
  function keepComposerFocus(e: PointerEvent): void {
    e.preventDefault();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    // The composer's CM6 keymap owns Escape: an open inline picker dismisses
    // (Prec.highest bubbleKeymap), otherwise dropOrAbandonFromView drops the
    // queued message or abandons the draft. Both preventDefault, so a press
    // CM6 already handled is only kept out of the app-global Escape here -
    // re-running the drop/abandon would turn one Escape into cancel AND hide.
    // The container acts itself only when the editor was not focused and no
    // CM6 handler ran.
    e.stopPropagation();
    if (e.defaultPrevented) return;
    e.preventDefault();
    if (isPending) {
      if (promptView) recallFromView(promptView);
      return;
    }
    if (lastQueued && content.length === 0) {
      sendCancelToTerminal(tab.id, lastQueued.id);
      lastQueued = null;
      enterLocalEdit();
      content = "";
      void flushWrite();
      return;
    }
    abandonDraft();
  }

  function abandonDraft(): void {
    content = "";
    void flushWrite();
    hideRichPromptForTab(tab.id);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_no_noninteractive_element_interactions -->
<div
  class="rich-prompt"
  class:resized={customHeight !== null}
  class:pending={isPending}
  role="group"
  aria-label="Rich Prompt"
  bind:this={rootEl}
  style:height={customHeight !== null ? `${customHeight}px` : null}
  onkeydown={onKeydown}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="rp-resize"
    role="separator"
    aria-orientation="horizontal"
    aria-label="Resize Rich Prompt"
    onpointerdown={onResizeStart}
    onpointermove={onResizeMove}
    onpointerup={onResizeEnd}
    onpointercancel={onResizeEnd}
  ></div>
  <div class="rp-editor">
    {#if mountError}
      <div class="rp-load-error" role="alert" aria-busy={mounting}>
        <span>{mountError}</span>
        <button
          class="rp-retry"
          type="button"
          disabled={mounting}
          onclick={() => void mountDraft()}
        >
          {mounting ? "Retrying..." : "Retry"}
        </button>
      </div>
    {:else if draftPath}
      <Wysiwyg
        bind:this={editor}
        bind:value={content}
        currentPath={draftPath}
        autoFocus={focused}
        initialCaret={tab.richPromptCaret ?? null}
        onCaretChange={(from, to) => setRichPromptCaret(tab, from, to)}
        extraExtensions={editorExtensions}
        surface="terminal"
        placeholderText=""
      />
    {/if}
  </div>
  <div class="rp-strip" class:queued={queuedCount > 0}>
    {#if textSlot}
      <span class="rp-text" aria-live="polite">{textSlot}</span>
    {/if}
    {#if secondaryAction}
      <button
        type="button"
        class="rp-action"
        disabled={secondaryAction.disabled}
        onpointerdown={keepComposerFocus}
        onclick={onSecondaryClick}
      >
        {secondaryAction.label}
      </button>
    {/if}
    <button
      type="button"
      class="rp-action rp-primary"
      disabled={primaryAction.disabled}
      onpointerdown={keepComposerFocus}
      onclick={onPrimaryClick}
    >
      {primaryAction.label}
    </button>
  </div>
</div>

<style>
  .rich-prompt {
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: 12px;
    max-height: calc(100% - 24px);
    z-index: 20;
    display: flex;
    flex-direction: column;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
    overflow: hidden;
  }
  .rp-resize {
    flex: 0 0 auto;
    height: 8px;
    cursor: ns-resize;
    touch-action: none;
  }
  .rp-resize::before {
    content: "";
    display: block;
    width: 28px;
    height: 3px;
    margin: 2px auto 0;
    border-radius: 2px;
    background: var(--border);
  }
  .rp-editor {
    min-height: 2.4em;
    max-height: 32vh;
    overflow-y: auto;
    padding: 8px 10px;
  }
  .rich-prompt.resized .rp-editor {
    flex: 1 1 auto;
    min-height: 0;
    max-height: none;
  }
  .rp-editor :global(.md-wysiwyg-cm6) {
    height: auto;
    min-height: 2.4em;
    overflow: visible;
    background: transparent;
  }
  .rich-prompt.resized .rp-editor :global(.md-wysiwyg-cm6) {
    height: 100%;
  }
  .rp-editor :global(.cm-editor) {
    background: transparent;
  }
  .rp-editor :global(.cm-editor.cm-focused) {
    outline: none;
  }
  .rp-editor :global(.cm-content) {
    padding: 0 !important;
  }
  .rp-load-error {
    min-height: 2.4em;
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--text-secondary);
    font-size: 12px;
  }
  .rp-load-error span {
    flex: 1 1 auto;
    overflow-wrap: anywhere;
  }
  .rp-retry {
    flex: 0 0 auto;
    padding: 4px 9px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: var(--text-primary);
    cursor: pointer;
  }
  .rp-retry:disabled {
    opacity: 0.6;
    cursor: default;
  }
  /* Flush-left composer lines, EXCEPT list-hang lines: the Wysiwyg hang rule
     pairs padding-left (the marker column) with a negative text-indent, and
     zeroing only the padding here leaves the indent winning alone, which
     yanks the marker out of the scroller's left edge (clipped invisible) and
     bounces the caret to column 0 the moment `1. ` / `- ` parses as a list. */
  .rp-editor :global(.cm-line:not(.cm-md-list-hang)) {
    padding-left: 0 !important;
    padding-right: 0 !important;
  }
  .rp-strip {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    padding: 4px 10px 6px;
    font-size: 11px;
    color: var(--text-secondary);
    border-top: 1px solid var(--border);
    user-select: none;
  }
  .rp-strip.queued {
    color: var(--text-primary);
  }
  /* The tap target is the button's own box, not an absolutely positioned
     overlay. An overlay tall enough to matter would reach past the strip and
     swallow taps aimed at the composer's last line, which sits directly
     above with only its 8px padding in between. */
  .rp-action {
    margin: 0;
    padding-block: 0;
    padding-inline: 2px;
    min-height: 24px;
    border: 0;
    background: none;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }
  .rp-action:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .rp-action:not(:disabled):hover {
    color: var(--text-primary);
  }
  .rp-primary:not(:disabled) {
    color: var(--text-primary);
  }
  .rich-prompt.pending .rp-editor {
    opacity: 0.55;
  }
  .rich-prompt.pending .rp-editor :global(.cm-content) {
    caret-color: transparent !important;
  }
  .rich-prompt.pending .rp-editor :global(.cm-cursor) {
    border-left-color: transparent !important;
  }
</style>
