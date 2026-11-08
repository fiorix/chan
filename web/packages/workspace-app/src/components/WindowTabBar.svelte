<script lang="ts">
  // The window tab bar: a band across the top of the window holding the pane
  // tree button and the slot the active pane's tab strip moves into (see
  // Pane.svelte). In chan-desktop's title bar its insets keep clear of the
  // window controls, its content row sits on their centre line, and its empty
  // stretches drag the window. Where the desktop asks for it (Windows, whose
  // window has no frame in the mode) the right inset holds the window
  // controls. The band is opaque: terminal background opacity cuts its holes
  // behind terminal panes only. While the window's Computers launcher is
  // shown over the page, the band holds neither the tree button nor the
  // strip: they belong to the covered window.

  import {
    isTauriDesktop,
    titlebarWindowControl,
    type TitlebarWindowAction,
  } from "../api/desktop";
  import { LAUNCHER_SHOWN_ATTR, launcherShownOverWindow } from "../state/focusGuard";
  import {
    closePaneTree,
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

  // The desktop marks the page's root while the window's Computers launcher
  // is shown over it, from before the launcher slides in until after it has
  // slid away. The tree and the strip are hidden in place, so the strip keeps
  // its size and the band stays the window's drag space; an open tree closes.
  let covered = $state(launcherShownOverWindow());
  $effect(() => {
    const read = () => {
      covered = launcherShownOverWindow();
    };
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [LAUNCHER_SHOWN_ATTR],
    });
    read();
    return () => observer.disconnect();
  });
  $effect(() => {
    if (covered) closePaneTree();
  });

  // The miniature's drawing box in SVG units, and the gap kept between two
  // panes so each reads as its own tile.
  const MINI_W = 22;
  const MINI_H = 14;
  const MINI_GAP = 1.5;

  const maximizeLabel = $derived(chrome.maximized ? "Restore" : "Maximize");
  // Each window control is a third of the right inset.
  const controlWidth = $derived(`${chrome.insetRight / 3}px`);

  function windowControl(action: TitlebarWindowAction): void {
    titlebarWindowControl(action).catch((err) => {
      console.warn(`[chan] titlebar_window_control ${action} failed`, err);
    });
  }

  // A press on a window control keeps the focus where it is, as a native
  // one does, and stops at the controls, so neither the bar nor the
  // document, where Tauri's drag script listens, hears it. The listener is
  // the element's own because Svelte's delegated handlers run only once a
  // press has reached the app's root.
  function holdPresses(node: HTMLElement): () => void {
    const hold = (e: MouseEvent): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    node.addEventListener("mousedown", hold);
    return () => node.removeEventListener("mousedown", hold);
  }
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
    class:covered
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
  <div class="slot" class:covered data-tauri-drag-region={drag} {@attach windowTabBarSlot}></div>
  {#if covered && chrome.drawControls && windowTabBar.title}
    <!-- A frameless window has no title of its own, so while the launcher
         covers the page the band names the window at its left, as Windows
         places a title, clear of the window controls. It takes no press, so
         the band stays the drag space. -->
    <div class="window-title" style:right={`${chrome.insetRight + 8}px`} aria-hidden="true">
      <span>{windowTabBar.title}</span>
    </div>
  {/if}
  {#if chrome.drawControls}
    <!-- The window's own controls, drawn in the look of Windows 11 caption
         buttons: out of the tab order, never a drag region, each a third of
         the inset and the bar's full height. -->
    <div class="inset window-controls" style:width={`${chrome.insetRight}px`} {@attach holdPresses}>
      <button
        type="button"
        class="window-control"
        data-action="minimize"
        tabindex="-1"
        title="Minimize"
        aria-label="Minimize"
        style:width={controlWidth}
        onclick={() => windowControl("minimize")}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5.5h10" />
        </svg>
      </button>
      <button
        type="button"
        class="window-control"
        data-action="toggleMaximize"
        tabindex="-1"
        title={maximizeLabel}
        aria-label={maximizeLabel}
        style:width={controlWidth}
        onclick={() => windowControl("toggleMaximize")}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          data-glyph={chrome.maximized ? "restore" : "maximize"}
          aria-hidden="true"
        >
          {#if chrome.maximized}
            <rect x="0.5" y="2.5" width="7" height="7" rx="1" />
            <path d="M2.5 2.5v-1a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" />
          {:else}
            <rect x="0.5" y="0.5" width="9" height="9" rx="1" />
          {/if}
        </svg>
      </button>
      <button
        type="button"
        class="window-control close"
        data-action="close"
        tabindex="-1"
        title="Close"
        aria-label="Close"
        style:width={controlWidth}
        onclick={() => windowControl("close")}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
        </svg>
      </button>
    </div>
  {:else}
    <div class="inset" style:width={`${chrome.insetRight}px`} data-tauri-drag-region={drag}></div>
  {/if}
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
  /* Windows 11 caption buttons: square-cornered, clear at rest, a light
     wash under the pointer and a lighter one with a dimmed glyph while
     pressed; close turns red with a white glyph. */
  .window-controls {
    display: flex;
    align-items: stretch;
  }
  .window-control {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--text);
    cursor: default;
  }
  .window-control svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1;
  }
  .window-control:hover {
    background: var(--hover-bg);
  }
  .window-control:active {
    background: color-mix(in srgb, var(--hover-bg) 70%, transparent);
    color: var(--text-secondary);
  }
  .window-control.close:hover {
    background: #c42b1c;
    color: #fff;
  }
  .window-control.close:active {
    background: color-mix(in srgb, #c42b1c 90%, transparent);
    color: rgba(255, 255, 255, 0.7);
  }
  .covered {
    visibility: hidden;
  }
  .window-title {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    display: flex;
    align-items: center;
    padding-left: 12px;
    min-width: 0;
    font-size: 12px;
    color: var(--text);
    pointer-events: none;
  }
  .window-title span {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
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
