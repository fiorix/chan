<script lang="ts">
  // Layout wrapper for one setting: a title + hint on the left, the
  // control on the right. Owns the descendant styling for the native
  // controls a section nests inside it (select, text/number input,
  // range) so each section stays declarative and the control look is
  // defined once. The per-workspace band's shared vocabulary (hint
  // modifiers, the key/value grid, error lines) is styled once here
  // too, through the same :global descendant trick.

  import type { Snippet } from "svelte";

  let {
    label,
    hint,
    children,
  }: {
    label: string;
    /// Plain text, or a snippet when the hint carries markup (<code>).
    hint?: string | Snippet;
    children: Snippet;
  } = $props();
</script>

<section class="field">
  <div class="meta">
    <h3>{label}</h3>
    {#if hint}
      <p class="hint">
        {#if typeof hint === "string"}
          {hint}
        {:else}
          {@render hint()}
        {/if}
      </p>
    {/if}
  </div>
  <div class="control">
    {@render children()}
  </div>
</section>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  }
  .field:last-child {
    border-bottom: 0;
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }
  .hint {
    margin: 0;
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.4;
  }
  /* A snippet hint renders its markup in the caller's scope, so the
     code-chip styling reaches it through :global. */
  .hint :global(code),
  .control :global(.hint code) {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    background: var(--bg-card);
    padding: 0 4px;
    border-radius: 3px;
  }
  .control {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  /* Native controls a section nests here are styled once, so sections
     don't each re-declare select / input chrome. `:global` reaches the
     descendants the section renders into this scope. */
  .control :global(select),
  .control :global(input[type="text"]),
  .control :global(input[type="number"]) {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 5px 8px;
    font: inherit;
    min-width: 14em;
  }
  .control :global(input[type="range"]) {
    flex: 1;
    min-width: 12em;
    accent-color: var(--link);
  }
  /* Sections whose body is a column of blocks (the per-workspace band)
     wrap it in one .stack child so the flex row above does not lay the
     blocks out side by side. */
  .control :global(.stack) {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    width: 100%;
  }
  /* The per-workspace band's shared vocabulary: status and error lines
     under a control, and the key/value fact grid. Declared once here;
     the band's sections used to each re-declare these. */
  .control :global(.hint) {
    margin: 0;
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.4;
  }
  .control :global(.hint.muted) {
    font-style: italic;
  }
  .control :global(.hint.err),
  .control :global(.err) {
    color: var(--warn-text);
  }
  .control :global(.hint.sub-hint) {
    font-size: 11.5px;
  }
  .control :global(.grid) {
    display: grid;
    grid-template-columns: 8em minmax(0, 1fr);
    gap: 4px 10px;
    font-size: 14px;
    width: 100%;
  }
  .control :global(.grid .k) {
    color: var(--text-secondary);
  }
  .control :global(.grid .v) {
    color: var(--text);
    min-width: 0;
  }
  .control :global(.mono) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .control :global(.path) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The pill vocabulary, once. PillToggle and PillRadio render the
     bare markup and this is the single .pill block under
     components/settings/ - the two components, and the two
     per-workspace copies before them, each used to re-declare it. */
  .control :global(.pills) {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .control :global(.pill) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border: 1px solid var(--btn-border);
    border-radius: 4px;
    background: var(--btn-bg);
    cursor: pointer;
    font-size: 14px;
  }
  .control :global(.pill input[type="checkbox"]),
  .control :global(.pill input[type="radio"]) {
    width: auto;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
  }
  .control :global(.pill > span) {
    color: var(--text);
  }
  .control :global(.pill:hover) {
    border-color: var(--btn-hover);
  }
  .control :global(.pill.on) {
    background: var(--hover-bg);
  }
  .control :global(.pill:has(input:disabled)) {
    cursor: not-allowed;
    opacity: 0.7;
  }
</style>
