<script lang="ts">
  // The window tab bar: a band across the top of the window holding the pane
  // tree button and the slot the active pane's tab strip moves into (see
  // Pane.svelte). In chan-desktop's title bar its insets keep clear of the
  // window controls, its content row sits on their centre line, and its empty
  // stretches drag the window. The band is opaque: terminal background
  // opacity cuts its holes behind terminal panes only.

  import { isTauriDesktop } from "../api/desktop";
  import {
    hiddenTabStatus,
    PANE_TREE_ANCHOR_ATTR,
    PANE_TREE_COMMAND_ID,
    paneRects,
    paneTree,
    togglePaneTree,
  } from "../state/paneTree.svelte";
  import { chordFor } from "../state/shortcuts";
  import { activeLayout } from "../state/tabs.svelte";
  import {
    windowTabBar,
    windowTabBarCenterPad,
    windowTabBarSlot,
  } from "../state/windowTabBar.svelte";

  // Tauri's drag script starts a window drag on a direct press on an element
  // carrying the attribute, and zooms the window on a double click there.
  const drag = isTauriDesktop() ? "" : undefined;

  const viewLayout = $derived(activeLayout());
  const rects = $derived(Object.entries(paneRects(viewLayout)));
  const status = $derived(hiddenTabStatus());
  const chrome = $derived(windowTabBar.chrome);
  const centerPad = $derived(windowTabBarCenterPad(chrome, windowTabBar.height));
  const label = $derived(
    status ? `Panes and tabs: a tab out of view is ${status}` : "Panes and tabs",
  );
  const chord = $derived(chordFor(PANE_TREE_COMMAND_ID) ?? "");
  // The overlay hangs its dropdown under the element carrying this.
  const anchor = { [PANE_TREE_ANCHOR_ATTR]: "" };

  // The miniature's drawing box in SVG units, and the gap kept between two
  // panes so each reads as its own tile.
  const MINI_W = 22;
  const MINI_H = 14;
  const MINI_GAP = 1.5;
</script>

<div
  class="window-tab-bar"
  style:height={`${windowTabBar.height}px`}
  style:padding-bottom={`${centerPad}px`}
  data-tauri-drag-region={drag}
>
  <div class="inset" style:width={`${chrome.insetLeft}px`} data-tauri-drag-region={drag}></div>
  <button
    type="button"
    class="tree-button"
    class:open={paneTree.open}
    onclick={togglePaneTree}
    {...anchor}
    title={chord ? `${label} (${chord})` : label}
    aria-label={label}
    aria-haspopup="dialog"
    aria-expanded={paneTree.open}
  >
    <svg
      width={MINI_W + 2}
      height={MINI_H + 2}
      viewBox={`-1 -1 ${MINI_W + 2} ${MINI_H + 2}`}
      aria-hidden="true"
    >
      {#each rects as [id, r] (id)}
        <rect
          class="mini-pane"
          class:active={id === viewLayout.activePaneId}
          data-pane-id={id}
          x={r.x * MINI_W + MINI_GAP / 2}
          y={r.y * MINI_H + MINI_GAP / 2}
          width={Math.max(1, r.w * MINI_W - MINI_GAP)}
          height={Math.max(1, r.h * MINI_H - MINI_GAP)}
          rx="1.5"
        />
      {/each}
    </svg>
    {#if status}
      <span class="badge" data-status={status} aria-hidden="true"></span>
    {/if}
  </button>
  <div class="slot" data-tauri-drag-region={drag} {@attach windowTabBarSlot}></div>
  <div class="inset" style:width={`${chrome.insetRight}px`} data-tauri-drag-region={drag}></div>
</div>

<style>
  /* Fixed over the top of the window; the app below starts under it. Above
     the pane tree and below every menu and overlay. */
  .window-tab-bar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 40;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 4px;
    padding-left: 6px;
    background: var(--bg-card);
    color: var(--text);
    user-select: none;
    -webkit-user-select: none;
  }
  .inset {
    flex: 0 0 auto;
    align-self: stretch;
  }
  .slot {
    flex: 1;
    min-width: 0;
    align-self: stretch;
    display: flex;
    align-items: center;
  }
  .tree-button {
    position: relative;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 24px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .tree-button:hover,
  .tree-button.open {
    background: var(--hover-bg);
    color: var(--text);
  }
  .tree-button.open {
    border-color: var(--border);
  }
  .mini-pane {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.1;
  }
  .mini-pane.active {
    fill: var(--pane-highlight-color, var(--pane-active-focus, var(--pane-focus)));
    stroke: var(--pane-highlight-color, var(--pane-active-focus, var(--pane-focus)));
  }
  /* The most urgent program status among the tabs the bar does not show,
     in the colours the tab strip's own marks use. */
  .badge {
    position: absolute;
    top: 0;
    right: 1px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    box-shadow: 0 0 0 1.5px var(--bg-card);
    background: var(--text-secondary);
  }
  .badge[data-status="working"] {
    background: var(--link);
  }
  .badge[data-status="done"] {
    background: var(--info-text);
  }
  .badge[data-status="blocked"] {
    background: var(--warn-text);
  }
  .badge[data-status="error"] {
    background: var(--danger-text);
  }
</style>
