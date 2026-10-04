<script lang="ts">
  // Chrome-only host for an inspector pane. Renders the resize
  // handle on the edge facing the workspace, an aside container,
  // and a title bar; the body is supplied by the caller via
  // children. Used by:
  //   - FileEditorTab (right: file info; left: outline)
  //   - FileBrowserSurface (right: file/directory metadata for the current
  //     selection)
  //   - SearchPanel (right: selected result details)
  //   - GraphPanel (right: selected graph entity details)
  //
  // Width is bound by the caller so each surface can persist into
  // its own preference slot (file editor info uses
  // paneWidths.inspector; outline uses paneWidths.outline; file
  // browser uses paneWidths.browser; search uses paneWidths.search;
  // graph uses paneWidths.graph or its own inspector width; defaults differ).
  //
  // `side` controls which edge the pane sits on. The resize handle
  // always lives on the workspace-facing side; the close glyph
  // points outward (toward the screen edge the pane will slide off
  // to when collapsed).

  import type { Snippet } from "svelte";
  import { ArrowLeft, ArrowRight } from "lucide-svelte";
  import ResizeHandle from "./ResizeHandle.svelte";

  let {
    title,
    width = $bindable(220),
    side = "right",
    onResize,
    onClose,
    children,
  }: {
    title: string;
    width?: number;
    side?: "left" | "right";
    onResize?: () => void;
    onClose?: () => void;
    children?: Snippet;
  } = $props();
</script>

{#if side === "left"}
  <aside class="inspector left" style="width: {width}px">
    <div class="title">
      <span class="title-text">{title}</span>
      {#if onClose}
        <button
          class="close"
          type="button"
          title="Close"
          aria-label="Close {title}"
          onclick={onClose}
        >
          <!-- Left-pointing arrow matches the panel's collapse
               direction (the pane lives on the left edge and slides
               off to the left when closed). -->
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      {/if}
    </div>
    <div class="body">
      {#if children}
        {@render children()}
      {/if}
    </div>
  </aside>
  <ResizeHandle bind:width onChange={onResize} side="left" />
{:else}
  <ResizeHandle bind:width onChange={onResize} />
  <aside class="inspector right" style="width: {width}px">
    <div class="title">
      <span class="title-text">{title}</span>
      {#if onClose}
        <button
          class="close"
          type="button"
          title="Close"
          aria-label="Close {title}"
          onclick={onClose}
        >
          <!-- Right-pointing arrow matches the panel's collapse
               direction (the inspector lives on the right edge and
               slides off to the right when closed). Visual idiom
               copied from Google Docs' left-panel close (which uses
               a left-pointing arrow because that panel sits on the
               left). -->
          <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      {/if}
    </div>
    <div class="body">
      {#if children}
        {@render children()}
      {/if}
    </div>
  </aside>
{/if}

<style>
  .inspector {
    /* width is set inline by the parent so the resize handle's
       drag updates apply without a CSS rule rewrite. */
    flex-shrink: 0;
    background: var(--inspector-bg);
    color: var(--text);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    font-size: 15px;
  }
  .inspector.right {
    border-left: 1px solid var(--separator);
  }
  .inspector.left {
    border-right: 1px solid var(--separator);
  }
  .title {
    padding: 0.4rem 0.6rem;
    font-size: 14px;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--separator);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .title-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .close {
    flex-shrink: 0;
    background: transparent;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    padding: 0.15rem 0.25rem;
    border-radius: 3px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 0;
  }
  .close:hover {
    background: var(--hover-bg, rgba(127, 127, 127, 0.15));
    color: var(--text);
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
</style>
