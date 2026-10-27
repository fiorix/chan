<script lang="ts">
  import { PanelsTopLeft } from "@lucide/svelte";
  import WindowRow from "./WindowRow.svelte";
  import { windowOverview, type MachineTree } from "../lib/machineTree";
  import { rootName } from "../lib/windowLabel";

  let { tree }: { tree: MachineTree } = $props();
  const rows = $derived(windowOverview(tree));
</script>

<section class="card all-windows" aria-label="All windows">
  <header class="card-header">
    <PanelsTopLeft size={19} aria-hidden="true" />
    <h2>All windows</h2>
    <span class="count">{rows.length}</span>
  </header>
  <p class="hint">↑ ↓ rows · ← → controls · Enter activates</p>
  {#if rows.length === 0}
    <p class="empty">No windows yet. Open one from a machine card.</p>
  {:else}
    <ul class="windows">
      {#each rows as { window: w, machine } (w.window_id)}
        <li
          data-window-id={w.window_id}
          data-deck-row
          tabindex="-1">
          <WindowRow
            {w}
            icon
            context={`${machine}${w.workspace_path ? ` / ${rootName(w.workspace_path)}` : ""} · ${w.hidden ? "Hidden" : "Shown"}`} />
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .all-windows { display: flex; flex-direction: column; }
  .card-header { flex-shrink: 0; gap: 0.6rem; }
  h2 { font-size: 0.95rem; font-weight: 600; margin: 0; flex: 1; }
  .count { color: var(--text-secondary); font-size: 0.8rem; }
  .hint, .empty { color: var(--text-secondary); font-size: 0.78rem; }
  .hint { margin: 0.35rem 0 0.9rem; }
  .windows { list-style: none; padding: 2px; margin: 0; overflow-y: auto; min-height: 0; }
  li { border-radius: 8px; outline: none; }
  li + li { margin-top: 4px; }
  li:focus, li:focus-within { outline: 1px solid var(--launcher-focus-color, var(--brand)); outline-offset: -1px; }
  li :global(.row) { border-radius: inherit; gap: 0.6rem; padding: 0.65rem 0.55rem; }
  li:focus :global(.row), li:focus-within :global(.row) { background: color-mix(in srgb, var(--launcher-focus-color, var(--brand)) 8%, var(--bg-card)); }
  li :global(.row-sub) { max-width: 100%; }
</style>
