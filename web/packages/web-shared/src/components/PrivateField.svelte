<script lang="ts">
  import type { Snippet } from "svelte";
  import { privacy, isConcealed, toggleReveal } from "../privacy.svelte";

  let { field, label = "field", children }: { field: string; label?: string; children: Snippet } = $props();
  const concealed = $derived(isConcealed(field));
</script>

{#if privacy.enabled}
<span class="private-field">
  {#if concealed}
    <span class="redacted" aria-label={`${label} hidden`}>Hidden</span>
  {:else}
    {@render children()}
  {/if}
    <button
      type="button"
      class="reveal"
      aria-label={`${concealed ? "Reveal" : "Hide"} ${label}`}
      aria-pressed={!concealed}
      title={`${concealed ? "Reveal" : "Hide"} ${label}`}
      disabled={!privacy.ready}
      onclick={(event) => { event.stopPropagation(); toggleReveal(field); }}>
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
        {#if !concealed}<path d="m3 3 18 18" />{/if}
      </svg>
    </button>
</span>
{:else}
  {@render children()}
{/if}

<style>
  .private-field { display: inline-flex; align-items: center; gap: 0.35rem; min-width: 0; max-width: 100%; vertical-align: middle; }
  .redacted { display: inline-block; width: 5em; flex-shrink: 0; border-radius: 4px; color: transparent; user-select: none; background: repeating-linear-gradient(135deg, var(--text-secondary, #888) 0 2px, transparent 2px 4px); opacity: 0.55; }
  .reveal { display: inline-flex; align-items: center; justify-content: center; padding: 3px; flex-shrink: 0; color: var(--text-secondary, #888); background: transparent; border: 0; border-radius: 3px; cursor: pointer; }
  .reveal:hover { color: var(--text, inherit); }
  .reveal:focus-visible { outline: 2px solid var(--brand, #888); }
  .reveal:disabled { cursor: wait; }
</style>
