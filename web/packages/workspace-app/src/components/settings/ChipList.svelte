<script lang="ts">
  // A list of value chips for Settings, in read-only form (a baseline
  // the row only displays) or with a per-chip remove button. The list
  // itself is one-way: `onremove` reports the click and the parent
  // owns the names.

  let {
    names,
    readonly = false,
    ariaLabel,
    onremove,
  }: {
    names: readonly string[];
    readonly?: boolean;
    ariaLabel?: string;
    onremove?: (name: string) => void;
  } = $props();
</script>

<ul class="chips" class:readonly aria-label={ariaLabel}>
  {#each names as name (name)}
    <li class="chip">
      <span class="chip-name">{name}</span>
      {#if !readonly}
        <button
          type="button"
          class="chip-x"
          onclick={() => onremove?.(name)}
          aria-label={`Remove ${name}`}
          title={`Remove ${name}`}>×</button
        >
      {/if}
    </li>
  {/each}
</ul>

<style>
  .chips {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--bg-card, rgba(0, 0, 0, 0.04));
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 2px 4px 2px 10px;
    font-size: 13px;
    color: var(--text);
  }
  .chips.readonly .chip {
    padding: 2px 10px;
    color: var(--text-secondary);
  }
  .chip-name {
    font-family: var(--chan-editor-code-family, monospace);
  }
  .chip-x {
    background: none;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 0 4px;
    border-radius: 50%;
  }
  .chip-x:hover {
    color: var(--text);
    background: var(--border);
  }
</style>
