<script lang="ts">
  // Floating style toolbar pinned to the top-left of the editor
  // canvas. Three states:
  //
  //   - hidden: outside source mode, the toolbar fades out after
  //     the user has been idle for IDLE_HIDE_MS. Cursor activity from
  //     the editor (selVer bump on click / typing / arrow keys)
  //     brings it back. Keeps the editor's top corner clean when
  //     the user is reading. Source mode has no activity signal,
  //     so its toolbar stays visible to keep the mode switch reachable.
  //   - collapsed: a small "Aa" pill. Default visible state right
  //     after activity.
  //   - expanded: full formatting toolbar (block kind selector
  //     plus B/I/S/code/link/lists/HR/image). Reveals on hover or
  //     keyboard focus.
  //
  // Mouseleave starts a 2-second timer to collapse back. The delay
  // matches the user's mental model ("I'm done formatting, fade
  // away") without flapping while they reach for an editor word
  // mid-sentence. Pointer entry / focus cancels the timer; any
  // formatting click extends the expanded state (the toolbar keeps
  // capturing the cursor while clicked).
  //
  // The component reads back active-mark state from the Wysiwyg ref
  // (passed through `wysiwyg`) and re-runs every time `selVer` ticks
  // up. Owner re-emits selVer from the editor's selectionChange
  // callback so this toolbar reflects the live cursor position.

  import {
    Bold,
    Code2,
    Image,
    Italic,
    Link,
    List,
    ListOrdered,
    ListTodo,
    Minus,
    Strikethrough,
  } from "lucide-svelte";
  import type Wysiwyg from "../editor/Wysiwyg.svelte";
  import type { BlockKind } from "../editor/commands/format";

  let {
    wysiwyg,
    selVer,
    disabled = false,
    showImage = true,
    floating = true,
    mode,
    onModeToggle,
  }: {
    /// Live Wysiwyg ref. May be undefined during the first render
    /// pass before bind:this resolves; the buttons no-op until it's
    /// available.
    wysiwyg: Wysiwyg | undefined;
    /// Selection version tick. Reading this in derived expressions
    /// ties the active-state computations to the editor's selection
    /// updates so the toolbar reflects cursor moves.
    selVer: number;
    /// Greys out the controls when the tab is in source mode or the
    /// file is read-only. Kept as a single prop so the parent only
    /// needs to compute the gate once. The mode-toggle button, when
    /// present, ignores this so the user can always flip back.
    disabled?: boolean;
    /// Show the image-insert button. Defaults on for the file
    /// editor; opt out from contexts where pasting `![alt](url)`
    /// into the buffer doesn't make sense.
    showImage?: boolean;
    /// Floating pill (position: absolute over the editor canvas)
    /// vs in-flow row (block-level above the editor).
    floating?: boolean;
    /// Optional current rendering mode. When set together with
    /// `onModeToggle`, the toolbar grows a trailing source/wysiwyg
    /// toggle button after a vertical separator. Both props must
    /// be provided together; without `onModeToggle` the toggle is
    /// hidden.
    mode?: "wysiwyg" | "source";
    /// Click handler for the trailing mode toggle. Called with the
    /// new desired mode so callers don't need to invert state.
    onModeToggle?: (next: "wysiwyg" | "source") => void;
  } = $props();

  // Expanded vs collapsed pill. Hover or focus expand; a debounced
  // mouseleave (`COLLAPSE_DELAY_MS`) collapses back. Click-pressed
  // state also keeps it open: the editor's onmousedown=preventDefault
  // for formatting buttons can swallow the focus event, so we set
  // `clickPinned` explicitly on mousedown and clear it on mouseup.
  const COLLAPSE_DELAY_MS = 2000;
  // Idle-hide: the toolbar fades out after this long without any
  // selVer bump from the editor (i.e. no cursor activity). Picked
  // slightly longer than COLLAPSE_DELAY_MS so the user can hover
  // away from an expanded toolbar without it disappearing under
  // their cursor on the next move.
  const IDLE_HIDE_MS = 3000;
  let expanded = $state(false);
  let visible = $state(false);
  let clickPinned = $state(false);
  let collapseTimer: ReturnType<typeof setTimeout> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelCollapse(): void {
    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
  }

  function scheduleCollapse(): void {
    cancelCollapse();
    collapseTimer = setTimeout(() => {
      collapseTimer = null;
      // Late-stage click can re-pin the toolbar between
      // scheduleCollapse and the timer firing; the guard prevents
      // an in-flight click from being yanked out from under the
      // user.
      if (!clickPinned) expanded = false;
    }, COLLAPSE_DELAY_MS);
  }

  function cancelHide(): void {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function scheduleHide(): void {
    cancelHide();
    if (mode === "source") return;
    hideTimer = setTimeout(() => {
      hideTimer = null;
      // Keep the toolbar visible while the user is actively
      // pressing a button or hovering it expanded; the next
      // mouseleave / mouseup will re-arm the timer.
      if (clickPinned || expanded) return;
      visible = false;
    }, IDLE_HIDE_MS);
  }

  // Activity tracker: any selVer bump from the editor (click,
  // typing, arrow keys, etc.) re-shows the toolbar and re-arms
  // the idle-hide timer. The void cast keeps the expression
  // typed; reading selVer inside $effect is what creates the
  // reactive dependency.
  $effect(() => {
    void selVer;
    visible = true;
    scheduleHide();
  });

  function onEnter(): void {
    cancelCollapse();
    cancelHide();
    visible = true;
    expanded = true;
  }

  function onLeave(): void {
    scheduleCollapse();
    scheduleHide();
  }

  function onFocusIn(): void {
    cancelCollapse();
    cancelHide();
    visible = true;
    expanded = true;
  }

  function onFocusOut(e: FocusEvent): void {
    // Only collapse if focus left the toolbar entirely (not just
    // moved between buttons).
    const next = e.relatedTarget as Node | null;
    const root = e.currentTarget as HTMLElement | null;
    if (next && root && root.contains(next)) return;
    scheduleCollapse();
    scheduleHide();
  }

  // Active-mark / current-block derivations. Reading `selVer` ties
  // them to the editor's selection-change callback so the on-state
  // tracks cursor moves. The void cast keeps the expression typed
  // without tripping no-unused-expressions.
  const isBold = $derived.by(() => {
    void selVer;
    return wysiwyg?.isActive("bold") ?? false;
  });
  const isItalic = $derived.by(() => {
    void selVer;
    return wysiwyg?.isActive("italic") ?? false;
  });
  const isStrike = $derived.by(() => {
    void selVer;
    return wysiwyg?.isActive("strike") ?? false;
  });
  const isInlineCode = $derived.by(() => {
    void selVer;
    return wysiwyg?.isActive("code") ?? false;
  });
  const isBulletList = $derived.by(() => {
    void selVer;
    return wysiwyg?.isActive("bulletList") ?? false;
  });
  const isOrderedList = $derived.by(() => {
    void selVer;
    return wysiwyg?.isActive("orderedList") ?? false;
  });
  const isTaskList = $derived.by(() => {
    void selVer;
    return wysiwyg?.isActive("taskList") ?? false;
  });
  const isLink = $derived.by(() => {
    void selVer;
    return wysiwyg?.isActive("link") ?? false;
  });
  const blockKind = $derived.by<BlockKind>(() => {
    void selVer;
    return wysiwyg?.currentBlockKind() ?? "normal";
  });

  function onBlockKindChange(e: Event): void {
    const v = (e.currentTarget as HTMLSelectElement).value as BlockKind;
    wysiwyg?.setBlockKind(v);
  }

  // Pin/unpin around the editor's preventDefault dance: holding the
  // mouse down on a button keeps the toolbar from collapsing even if
  // the collapse timer is in flight.
  function onMouseDownPin(e: MouseEvent): void {
    e.preventDefault();
    clickPinned = true;
    cancelCollapse();
  }
  function onMouseUpUnpin(): void {
    clickPinned = false;
    // Pointer is still over the toolbar at this moment (mouseup
    // fires before any subsequent leave), so we leave `expanded`
    // alone; the eventual mouseleave will schedule the collapse.
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="style-toolbar"
  class:expanded
  class:hidden={!visible}
  class:disabled
  class:floating
  class:inflow={!floating}
  role="toolbar"
  tabindex="-1"
  aria-label="Style toolbar"
  onmouseleave={onLeave}
  onfocusout={onFocusOut}
>
  <!-- Expand trigger scoped to the Aa pill + the formatting row.
       Hovering the trailing mode button (rendered as a sibling
       below) does NOT expand: when the user is reaching for `</>`
       in source mode the row would otherwise pop open and shove
       the button to the right, making it impossible to click.
       mouseenter doesn't bubble, so attaching it to this wrapper
       is enough; mouseleave stays on the root so leaving past the
       mode button still collapses the toolbar. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="expand-zone"
    onmouseenter={onEnter}
    onfocusin={onFocusIn}
  >
  <span class="pill" aria-hidden="true">Aa</span>
  {#if expanded}
    <div class="fbtn-row">
    <span class="vsep" aria-hidden="true"></span>
    <select
      class="block-kind"
      value={blockKind}
      onchange={onBlockKindChange}
      onmousedown={(e) => e.stopPropagation()}
      disabled={disabled}
      title="block style"
    >
      <option value="h1">h1</option>
      <option value="h2">h2</option>
      <option value="h3">h3</option>
      <option value="normal">text</option>
      <option value="code">code</option>
      <option value="quote">quote</option>
    </select>
    <button
      class="fbtn"
      class:on={isBold}
      title="bold (Cmd/Ctrl+B)"
      aria-label="bold"
      disabled={disabled}
      onmousedown={onMouseDownPin}
      onmouseup={onMouseUpUnpin}
      onclick={() => wysiwyg?.toggleBold()}
    ><Bold size={15} strokeWidth={1.9} aria-hidden="true" /></button>
    <button
      class="fbtn"
      class:on={isItalic}
      title="italic (Cmd/Ctrl+I)"
      aria-label="italic"
      disabled={disabled}
      onmousedown={onMouseDownPin}
      onmouseup={onMouseUpUnpin}
      onclick={() => wysiwyg?.toggleItalic()}
    ><Italic size={15} strokeWidth={1.9} aria-hidden="true" /></button>
    <button
      class="fbtn"
      class:on={isStrike}
      title="strikethrough (Cmd/Ctrl+Shift+S)"
      aria-label="strikethrough"
      disabled={disabled}
      onmousedown={onMouseDownPin}
      onmouseup={onMouseUpUnpin}
      onclick={() => wysiwyg?.toggleStrike()}
    ><Strikethrough size={15} strokeWidth={1.9} aria-hidden="true" /></button>
    <button
      class="fbtn"
      class:on={isInlineCode}
      title="inline code (Cmd/Ctrl+E)"
      aria-label="inline code"
      disabled={disabled}
      onmousedown={onMouseDownPin}
      onmouseup={onMouseUpUnpin}
      onclick={() => wysiwyg?.toggleInlineCode()}
    ><Code2 size={15} strokeWidth={1.9} aria-hidden="true" /></button>
    <button
      class="fbtn"
      class:on={isLink}
      title="link"
      aria-label="toggle link"
      disabled={disabled}
      onmousedown={onMouseDownPin}
      onmouseup={onMouseUpUnpin}
      onclick={() => wysiwyg?.toggleLink()}
    ><Link size={15} strokeWidth={1.9} aria-hidden="true" /></button>
    <button
      class="fbtn"
      class:on={isBulletList}
      title="bullet list"
      aria-label="bullet list"
      disabled={disabled}
      onmousedown={onMouseDownPin}
      onmouseup={onMouseUpUnpin}
      onclick={() => wysiwyg?.toggleBulletList()}
    ><List size={15} strokeWidth={1.9} aria-hidden="true" /></button>
    <button
      class="fbtn"
      class:on={isOrderedList}
      title="ordered list"
      aria-label="ordered list"
      disabled={disabled}
      onmousedown={onMouseDownPin}
      onmouseup={onMouseUpUnpin}
      onclick={() => wysiwyg?.toggleOrderedList()}
    ><ListOrdered size={15} strokeWidth={1.9} aria-hidden="true" /></button>
    <button
      class="fbtn"
      class:on={isTaskList}
      title="task list"
      aria-label="task list"
      disabled={disabled}
      onmousedown={onMouseDownPin}
      onmouseup={onMouseUpUnpin}
      onclick={() => wysiwyg?.toggleTaskList()}
    ><ListTodo size={15} strokeWidth={1.9} aria-hidden="true" /></button>
    <button
      class="fbtn"
      title="horizontal rule (insert ---)"
      aria-label="insert horizontal rule"
      disabled={disabled}
      onmousedown={onMouseDownPin}
      onmouseup={onMouseUpUnpin}
      onclick={() => wysiwyg?.insertHorizontalRule()}
    ><Minus size={15} strokeWidth={1.9} aria-hidden="true" /></button>
    {#if showImage}
      <button
        class="fbtn"
        title="insert image"
        aria-label="insert image"
        disabled={disabled}
        onmousedown={onMouseDownPin}
        onmouseup={onMouseUpUnpin}
        onclick={() => wysiwyg?.insertImage()}
      ><Image size={15} strokeWidth={1.9} aria-hidden="true" /></button>
    {/if}
    </div>
  {/if}
  </div>
  {#if mode && onModeToggle}
    <!-- Mode toggle stays outside `.fbtn-row` so it's always
         visible: in source mode the row is collapsed and the user
         still needs a way back to wysiwyg without hover-expanding
         a toolbar that's mostly irrelevant. Also bypasses the
         `disabled` dim for the same reason. -->
    <span class="vsep mode-sep" aria-hidden="true"></span>
    <button
      class="fbtn mode"
      title={mode === "wysiwyg" ? "show source" : "show rendered"}
      aria-label={mode === "wysiwyg" ? "show source" : "show rendered"}
      onmousedown={onMouseDownPin}
      onmouseup={onMouseUpUnpin}
      onclick={() => onModeToggle?.(mode === "wysiwyg" ? "source" : "wysiwyg")}
    >{mode === "wysiwyg" ? "</>" : "¶"}</button>
  {/if}
</div>

<style>
  /* Shared style toolbar chrome. All control dimensions and states
     live here instead of in host-specific surfaces. */
  .style-toolbar {
    --toolbar-control-h: 24px;
    --toolbar-control-min-w: 26px;
    --toolbar-control-radius: 4px;

    display: inline-flex;
    align-items: center;
    gap: 3px;
    max-width: calc(100% - 16px);
    padding: 4px 6px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 999px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
    color: var(--text);
    font-size: 13px;
    transform-origin: top left;
    transition:
      transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1),
      box-shadow 160ms ease,
      opacity 180ms ease;
  }
  /* Idle-hidden state: the toolbar fades out after no editor
     activity for IDLE_HIDE_MS. pointer-events:none keeps an
     invisible pill from intercepting clicks meant for the first
     line of the document. */
  .style-toolbar.hidden {
    opacity: 0;
    pointer-events: none;
  }
  /* Floating: pinned over the editor canvas. Sits above the editor's
     own decoration layer (smart-node chevrons use ~z-index 1) without
     competing with the bottom pill (z-index 4500) or overlays
     (>= 25000). */
  .style-toolbar.floating {
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 30;
  }
  /* In-flow: rendered as a normal block above the editor (used by
     hosts that reserve layout space for the toolbar). Caller-owned
     spacing stays outside this component. */
  .style-toolbar.inflow {
    align-self: flex-start;
  }
  .style-toolbar:hover {
    transform: scale(1.02);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
  }
  .style-toolbar.disabled .fbtn:not(.mode),
  .style-toolbar.disabled .block-kind {
    opacity: 0.55;
  }
  /* Mode toggle stays at full opacity and clickable even when the
     rest of the toolbar is disabled (source mode greys formatting,
     but the user still needs to flip back). Monospace so `</>` and
     `¶` read cleanly. */
  .fbtn.mode {
    color: var(--text-secondary);
    font-family: ui-monospace, monospace;
    font-size: 12px;
  }
  .fbtn.mode:hover { color: var(--text); }
  /* Expand-trigger zone: the Aa pill plus the (possibly absent)
     formatting row. Sized as a flex inline group so the trailing
     mode button (sibling, not child) lines up flush. */
  .expand-zone {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    min-width: 0;
  }
  /* Wraps the block-kind + buttons so we can animate it as a unit
     with the same easeOutBack pop the tab-menu bubble uses. The
     `transform-origin: top left` anchors the scale to the toolbar's
     corner so the bounce grows away from the editor edge rather
     than from the center (which would visually drift the row). */
  .fbtn-row {
    display: flex;
    align-items: center;
    gap: 3px;
    min-width: 0;
    max-width: 100%;
    overflow-x: auto;
    scrollbar-width: none;
    transform-origin: top left;
  }
  .fbtn-row::-webkit-scrollbar { display: none; }
  /* Aa badge: always-on signal that the toolbar lives in this
     corner. Acts as the toolbar's left anchor; the formatting row
     opens to its right when expanded. */
  .pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: var(--toolbar-control-min-w);
    height: var(--toolbar-control-h);
    padding: 0 5px;
    color: var(--text-secondary);
    font-weight: 600;
    line-height: 1;
    user-select: none;
  }
  /* Vertical divider between the Aa badge and the heading selector
     when the toolbar is expanded. Thin, low-contrast hairline; sits
     inside the .fbtn-row so it scales with the wobble. */
  .vsep {
    align-self: stretch;
    width: 1px;
    margin: 2px 4px;
    background: var(--border);
    flex: 0 0 auto;
  }
  .block-kind {
    flex: 0 0 auto;
    height: var(--toolbar-control-h);
    min-width: 64px;
    margin-right: 1px;
    padding: 0 5px;
    background: transparent;
    color: var(--text);
    border: 1px solid var(--btn-border);
    border-radius: var(--toolbar-control-radius);
    font: inherit;
    font-size: 12px;
    line-height: 1;
  }
  .fbtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    min-width: var(--toolbar-control-min-w);
    height: var(--toolbar-control-h);
    padding: 0 5px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--toolbar-control-radius);
    color: var(--text);
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    line-height: 1;
    text-align: center;
  }
  .block-kind:hover:not(:disabled),
  .fbtn:hover:not(:disabled) {
    background: var(--hover-bg);
    border-color: var(--btn-border);
  }
  .block-kind:focus-visible,
  .fbtn:focus-visible {
    outline: 2px solid var(--btn-hover);
    outline-offset: 2px;
  }
  .fbtn.on {
    background: var(--hover-bg);
    border-color: var(--btn-hover);
    color: var(--text);
  }
  .fbtn :global(svg) {
    flex: 0 0 auto;
  }
  .block-kind:disabled,
  .fbtn:disabled {
    cursor: default;
    opacity: 0.55;
  }

  @media (prefers-reduced-motion: reduce) {
    .style-toolbar,
    .style-toolbar:hover {
      transition: none;
      transform: none;
    }
  }
</style>
