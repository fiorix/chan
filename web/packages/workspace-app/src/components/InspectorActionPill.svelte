<script module lang="ts">
  /// One inspector action: a label, a click handler, and optional tooltip +
  /// disabled state. Shared by the inspector bodies that render the
  /// primary-action pill.
  export type InspectorAction = {
    label: string;
    onClick: () => void;
    title?: string;
    disabled?: boolean;
  };
</script>

<script lang="ts">
  // Primary-action "pill" plus a caret that drops the secondary actions. The
  // category logic lives in each caller's action model; this component owns
  // only the markup, the dropdown open/close state, and the outside-click /
  // Escape dismissal. Extracted from FileInfoBody's inline action row so the
  // workspace-root inspector renders the identical control.
  import { ChevronDown } from "@lucide/svelte";

  let {
    main,
    secondary = [],
  }: {
    main: InspectorAction;
    secondary?: InspectorAction[];
  } = $props();

  /// Dropdown open state. Reset whenever the action set changes so a new
  /// selection doesn't inherit an open menu.
  let menuOpen = $state(false);
  let actionsEl = $state<HTMLDivElement | null>(null);
  $effect(() => {
    void main;
    void secondary;
    menuOpen = false;
  });
  $effect(() => {
    if (!menuOpen) return;
    const onDocPointer = (e: MouseEvent) => {
      if (actionsEl && !actionsEl.contains(e.target as Node)) menuOpen = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") menuOpen = false;
    };
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  });
</script>

<div class="action-actions" bind:this={actionsEl}>
  <div class="action-pill" class:has-caret={secondary.length > 0}>
    <button
      class="pill-main"
      type="button"
      onclick={main.onClick}
      disabled={main.disabled}
      title={main.title}>{main.label}</button
    >
    {#if secondary.length > 0}
      <button
        class="pill-caret"
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="More actions"
        onclick={() => (menuOpen = !menuOpen)}
      ><ChevronDown size={15} aria-hidden="true" /></button>
    {/if}
  </div>
  {#if menuOpen && secondary.length > 0}
    <div class="action-menu" role="menu">
      {#each secondary as item (item.label)}
        <button
          class="action-menu-item"
          type="button"
          role="menuitem"
          disabled={item.disabled}
          title={item.title}
          onclick={() => {
            menuOpen = false;
            item.onClick();
          }}>{item.label}</button
        >
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Anchor for the absolutely-positioned dropdown. */
  .action-actions {
    position: relative;
    margin-top: 0.2rem;
  }
  .action-pill {
    display: flex;
    align-items: stretch;
    width: 100%;
  }
  .pill-main {
    flex: 1;
    min-width: 0;
    background: var(--btn-bg);
    color: var(--text);
    border: 1px solid var(--btn-border);
    border-radius: 4px;
    padding: 5px 0;
    cursor: pointer;
    font: inherit;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pill-main:hover { border-color: var(--btn-hover); }
  .pill-main:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .pill-main:disabled:hover { border-color: var(--btn-border); }
  /* With a caret present the two halves merge into one control: square the
     shared edge and drop the doubled border between them. */
  .action-pill.has-caret .pill-main {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
    border-right: none;
  }
  .pill-caret {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    background: var(--btn-bg);
    color: var(--text);
    border: 1px solid var(--btn-border);
    border-top-right-radius: 4px;
    border-bottom-right-radius: 4px;
    cursor: pointer;
    line-height: 0;
  }
  .pill-caret:hover { border-color: var(--btn-hover); }
  .action-menu {
    position: absolute;
    top: calc(100% + 3px);
    left: 0;
    right: 0;
    z-index: 5;
    display: flex;
    flex-direction: column;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 3px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
  }
  .action-menu-item {
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 3px;
    color: var(--text);
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    padding: 5px 8px;
  }
  .action-menu-item:hover { background: var(--hover-bg, rgba(127, 127, 127, 0.15)); }
  .action-menu-item:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .action-menu-item:disabled:hover { background: transparent; }
</style>
