<script lang="ts">
  // Bottom-right collapsible status bar for the file editor:
  // backlinks count, word count, character count, plus a r/w
  // toggle "lamp" (green when writable, grey when read-only). The
  // toggle hides the floating format toolbar and the editor caret
  // for the spec's "maximize for reading" mode.
  //
  // Backlinks come from /api/backlinks/{path}. A rename keeps the displayed
  // count until a second query has allowed the indexer's debounce to pass.
  //
  // Collapse state is local to the component (no persistence): the
  // bar is small enough that re-expanding on each open is cheap,
  // and avoiding a serialized field keeps tab-state simple.

  import { api } from "../api/client";
  import { idle } from "../state/idle.svelte";

  let {
    path,
    content,
    fsWritable = true,
    readMode = $bindable(false),
  }: {
    /// Workspace-relative file path. Used as the backlinks query key.
    path: string;
    /// Live editor markdown buffer. Word / character counts derive
    /// from this; recompute is debounced so typing stays cheap.
    content: string;
    /// Filesystem-level writability. When false, the lamp is locked
    /// to read mode and clicking it does nothing: an unwritable
    /// file can't be flipped to write mode no matter what the user
    /// asks for.
    fsWritable?: boolean;
    /// Two-way: clicking the lamp flips this and the parent passes
    /// it on to Wysiwyg + uses it to hide the format toolbar.
    readMode?: boolean;
  } = $props();

  let collapsed = $state(false);
  let backlinkCount = $state<number | null>(null);

  // Word / character counts are derived from `content`. Words
  // strip leading/trailing whitespace and split on any run of
  // whitespace; an empty buffer counts as 0 (not 1, which a naive
  // split would yield).
  const words = $derived.by(() => {
    const t = content.trim();
    if (!t) return 0;
    return t.split(/\s+/).length;
  });
  const chars = $derived(content.length);

  let previousPath = "";
  $effect(() => {
    const target = path;
    const renamed = previousPath !== "";
    previousPath = target;
    let disposed = false;
    async function fetchBacklinks(publish: boolean): Promise<void> {
      try {
        const edges = await api.backlinks(target);
        if (!disposed && publish) backlinkCount = Array.isArray(edges) ? edges.length : 0;
      } catch {
        if (!disposed && publish) backlinkCount = null;
      }
    }
    const first = setTimeout(() => void fetchBacklinks(!renamed), 600);
    // Watch notifications precede indexing, and the graph cache invalidates
    // on that same notification. Allow even the conservative two-second
    // debounce and its worker tick before adopting a renamed path's count.
    const settled = renamed ? setTimeout(() => void fetchBacklinks(true), 2600) : null;
    return () => {
      disposed = true;
      clearTimeout(first);
      if (settled !== null) clearTimeout(settled);
    };
  });

  function toggleCollapse(): void {
    collapsed = !collapsed;
  }
  function toggleReadMode(): void {
    // OS-locked files can never be flipped to write mode; the lamp
    // stays in read state regardless of clicks. The button is also
    // disabled in the template, so this guard is belt-and-braces.
    if (!fsWritable) return;
    readMode = !readMode;
  }
  /// Effective lamp state: a tab whose file lost the user-write bit
  /// always reads as read-only even if the user hadn't toggled the
  /// lamp manually. Mirrors the FileEditorTab `readOnly` derivation
  /// so the status bar agrees with the editor surface above it.
  const effectiveRead = $derived(readMode || !fsWritable);
</script>

<div
  class="wiki-statusbar"
  class:collapsed
  class:read-mode={effectiveRead}
  class:idle={idle.active}
>
  <button
    class="collapse"
    title={collapsed ? "show stats" : "hide stats"}
    onclick={toggleCollapse}
    onmousedown={(e) => e.preventDefault()}
  >{collapsed ? "‹" : "›"}</button>
  {#if !collapsed}
    <div class="stats-row">
      <span class="stat" title="incoming links">
        {backlinkCount ?? "-"}
        <span class="lbl">backlinks</span>
      </span>
      <span class="sep"> - </span>
      <span class="stat" title="words">
        {words}
        <span class="lbl">words</span>
      </span>
      <span class="sep"> - </span>
      <span class="stat" title="characters">
        {chars}
        <span class="lbl">chars</span>
      </span>
      <span class="sep"> - </span>
      <button
        class="lamp"
        class:on={!effectiveRead}
        class:fs-locked={!fsWritable}
        disabled={!fsWritable}
        title={fsWritable
          ? effectiveRead
            ? "switch to write mode"
            : "switch to read-only"
          : "file is read-only on disk"}
        onclick={toggleReadMode}
        onmousedown={(e) => e.preventDefault()}
      >
        <span class="dot"></span>
        <span class="lamp-lbl"
          >{!fsWritable ? "locked" : effectiveRead ? "read" : "write"}</span
        >
      </button>
    </div>
  {/if}
</div>

<style>
  /* Anchored to the bottom-right by the parent (.editor-tab is
     position:relative). Sits above editor content but below the
     bottom-pill (which lives at z=20+). */
  .wiki-statusbar {
    position: absolute;
    right: 12px;
    bottom: 8px;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    background: color-mix(in srgb, var(--bg-elev) 88%, transparent);
    border: 1px solid var(--border);
    border-radius: 999px;
    box-shadow: 0 2px 6px rgba(0,0,0,.18);
    font-size: 12px;
    color: var(--muted);
    user-select: none;
    /* Hover wobble matches the tab-menu bubble + bottom pill:
       easeOutBack overshoot on enter, settles back on leave, with
       a tiny box-shadow lift so the bar reads as alive. */
    transform-origin: right bottom;
    transition:
      opacity 200ms ease,
      transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1),
      box-shadow 160ms ease;
  }
  .wiki-statusbar:hover {
    transform: scale(1.04);
    box-shadow: 0 4px 12px rgba(0,0,0,.24);
  }
  .wiki-statusbar.collapsed {
    padding: 6px;
    gap: 0;
  }
  /* Wraps the stats so the layout reads as one logical row beside
     the collapse handle. */
  .stats-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  /* Idle: fade out + drop pointer events so the status bar
     disappears alongside the floating fmt-bar and bottom-pill,
     keeping the writing surface clean while the user reads.
     Pinning isn't needed: hover over the surrounding canvas wakes
     the global tracker before the user can reach this bar. */
  .wiki-statusbar.idle {
    opacity: 0;
    pointer-events: none;
  }
  .wiki-statusbar.read-mode {
    /* Grey-out the whole bar in read mode so the lamp's grey state
       carries through to a cohesive "reading" appearance. */
    color: var(--muted);
    opacity: 0.85;
  }
  .stat {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .stat .lbl {
    color: var(--muted);
    margin-left: 2px;
    font-weight: normal;
  }
  .sep { color: var(--border); }
  .collapse {
    background: transparent;
    border: 0;
    color: var(--muted);
    cursor: pointer;
    padding: 0 4px;
    font: inherit;
    line-height: 1;
  }
  .collapse:hover { color: var(--text); }
  .lamp {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    border: 0;
    color: var(--muted);
    cursor: pointer;
    padding: 0;
    font: inherit;
  }
  .lamp .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    /* Grey by default = read mode. */
    background: var(--muted);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--text) 12%, transparent);
  }
  .lamp.on .dot {
    /* Green = write mode. The slight glow makes the "lit" state
       read as active without being aggressive. */
    background: #2ea043;
    box-shadow: 0 0 4px rgba(46, 160, 67, .55);
  }
  /* Filesystem-locked: the lamp is fixed in read state, the cursor
     becomes default-not-allowed, and the dot picks up the warn tint
     so the user can see at a glance that this isn't a user choice. */
  .lamp:disabled,
  .lamp.fs-locked {
    cursor: not-allowed;
    color: var(--warn-text);
  }
  .lamp.fs-locked .dot {
    background: var(--warn-text);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--warn-text) 35%, transparent);
  }
  .lamp-lbl { letter-spacing: 0.02em; }
  @media (prefers-reduced-motion: reduce) {
    .wiki-statusbar,
    .wiki-statusbar:hover {
      transition: opacity 120ms linear;
      transform: none;
    }
  }
</style>
