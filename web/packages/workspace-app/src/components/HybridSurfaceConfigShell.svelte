<script lang="ts">
  import type { Snippet } from "svelte";
  import type { SaveStatus } from "./settings/commit";

  let {
    title,
    ariaLabel = `${title} configuration`,
    saveStatus = "idle",
    onDone,
    children,
    footerCenter,
    footerBorder = true,
  }: {
    title: string;
    ariaLabel?: string;
    saveStatus?: SaveStatus;
    onDone?: () => void;
    children?: Snippet;
    // Optional content centered in the footer row, sharing it with the
    // right-aligned OK (e.g. the Dashboard back's carousel navigator).
    footerCenter?: Snippet;
    // The footer's top divider. On by default; a back that pulls its own
    // controls into the footer row can drop it for a seamless single row.
    footerBorder?: boolean;
  } = $props();
</script>

<section class="hybrid-config" aria-label={ariaLabel}>
  <header class="config-header">
    <h2 class="config-title">{title}</h2>
    <div class="header-spacer" aria-hidden="true"></div>
    <div class="save-status" aria-live="polite">
      {#if saveStatus === "saving"}
        <span class="muted">saving...</span>
      {:else if saveStatus === "saved"}
        <span class="ok">saved</span>
      {:else if typeof saveStatus === "object"}
        <span class="err" title={saveStatus.error}>save failed</span>
      {/if}
    </div>
  </header>
  <div class="config-body">
    {#if children}
      {@render children()}
    {/if}
  </div>
  <footer class="config-footer" class:bordered={footerBorder}>
    {#if footerCenter}
      <div class="config-footer-center">{@render footerCenter()}</div>
    {/if}
    <button type="button" class="config-ok" onclick={() => onDone?.()}>OK</button>
  </footer>
</section>

<style>
  .hybrid-config {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .config-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
  }
  .config-title {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: var(--text);
  }
  .header-spacer {
    flex: 1;
    min-width: 0;
  }
  .save-status {
    min-width: 60px;
    font-size: 14px;
    text-align: right;
  }
  .save-status .ok {
    color: var(--accent);
  }
  .save-status .err {
    color: #d33;
  }
  .save-status .muted {
    color: var(--text-secondary);
  }
  .config-body {
    flex: 1;
    overflow: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }
  .config-body :global(section) {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .config-body :global(section h3) {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }
  /* Three tracks so optional centered content (footerCenter) sits in the
     middle while OK stays pinned right; the empty left track balances the
     right one so the center is true-centered across the whole row. With
     no footerCenter the middle track collapses and OK is still right. */
  .config-footer {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    padding: 12px 20px 16px;
  }
  .config-footer.bordered {
    border-top: 1px solid var(--border);
  }
  /* Renamed off the bare `.footer-center`: excalidraw's index.css ships
     a global `.footer-center` rule (unscoped) that would otherwise match
     this element once the canvas CSS loads. */
  .config-footer-center {
    grid-column: 2;
    justify-self: center;
  }
  .config-ok {
    grid-column: 3;
    justify-self: end;
    background: var(--btn-bg);
    color: var(--text);
    border: 1px solid var(--btn-border);
    border-radius: 4px;
    padding: 5px 12px;
    font: inherit;
    cursor: pointer;
  }
  .config-ok:hover {
    border-color: var(--btn-hover);
  }
  @media (max-width: 520px) {
    .config-header {
      align-items: flex-start;
      flex-wrap: wrap;
    }
    .header-spacer {
      flex-basis: 100%;
      height: 0;
    }
    .save-status {
      text-align: left;
    }
  }
</style>
