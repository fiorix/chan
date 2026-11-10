<script lang="ts">
  // The window tab bar: a band across the top of the window holding the pane
  // tree button and the slot the active pane's tab strip moves into (see
  // Pane.svelte). In chan-desktop's title bar its insets keep clear of the
  // window controls, its content row sits on their centre line, and its empty
  // stretches drag the window. Where the desktop asks for it (Windows, whose
  // window has no frame in the mode) the window controls sit over the right
  // inset, in a layer of their own above every overlay. The band is opaque: terminal background opacity cuts its holes
  // behind terminal panes only. While the window's Computers launcher is
  // shown over the page, the band holds neither the tree button nor the
  // strip: they belong to the covered window. On Windows it holds the
  // launcher menubar's menus there instead, since the frameless window wears
  // no menubar, and the window's title after them. A tmux pane has no strip,
  // so while one is active the band names it and marks the window as tmux's.

  import {
    isTauriDesktop,
    titlebarMenuPopup,
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
  import { activeLayout, activeTabInPane, paneMode, paneShowsTmux, tabLabel } from "../state/tabs.svelte";
  import {
    WINDOW_CONTROLS_Z_INDEX,
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

  // A pane showing a tmux pane draws no strip (Pane.svelte hides it on the
  // same test), so while one is active the bar shows its name where the
  // strip would sit: the label the pane tree gives it, which is what tmux
  // calls that pane. A pane Hybrid Nav stages has no tmux pane yet and reads
  // as the mode names it; outside the mode a pane with no active tab reads
  // as the pane tree reads it. Null in any other pane.
  const tmuxName = $derived.by(() => {
    const id = viewLayout.activePaneId;
    if (!paneShowsTmux(id)) return null;
    const pane = viewLayout.nodes[id];
    const tab = pane?.kind === "leaf" ? activeTabInPane(pane) : null;
    if (tab) return tabLabel(tab);
    return paneMode.tmux !== null ? "New tmux pane" : "Empty pane";
  });

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

  // What the covered band holds: the menus the desktop lists, which only a
  // window wearing no menubar gets, and the title of a frameless window.
  const menus = $derived(covered ? chrome.menus : []);
  const titleShown = $derived(covered && chrome.drawControls && windowTabBar.title !== "");

  // The menu whose popup is up. The desktop answers once the menu has
  // closed, so its button stays pressed until then and another press waits.
  let openMenu = $state<string | null>(null);

  function popUpMenu(id: string, button: HTMLElement): void {
    if (openMenu !== null) return;
    openMenu = id;
    const at = button.getBoundingClientRect();
    titlebarMenuPopup(id, at.left, at.bottom)
      .catch((err) => {
        console.warn(`[chan] titlebar_menu_popup ${id} failed`, err);
      })
      .finally(() => {
        if (openMenu === id) openMenu = null;
      });
  }

  // A menu opens on the press, as a Windows menubar's does, under its
  // button. Like a window control's, the press keeps the page's focus where
  // it is and goes no further than the button, so it neither drags the
  // window nor reaches the bar. The launcher holds the keyboard, and the
  // desktop hands it back to the launcher before the menu opens.
  function opensMenu(id: string): (node: HTMLElement) => () => void {
    return (node) => {
      const press = (e: MouseEvent): void => {
        e.preventDefault();
        e.stopPropagation();
        if (e.button === 0) popUpMenu(id, node);
      };
      node.addEventListener("mousedown", press);
      return () => node.removeEventListener("mousedown", press);
    };
  }

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
  <!-- The name and the badge are display only, so nothing here reopens the
       hidden strip or offers a tab action tmux cannot take; on the desktop a
       press on either drags the window as the band around them does. Each
       holds its text directly, since Tauri's drag script reads the
       attribute on the element pressed. -->
  {#if tmuxName !== null}
    <div class="tmux-name" class:covered title={tmuxName} data-tauri-drag-region={drag}>{tmuxName}</div>
  {/if}
  <div class="slot" class:covered data-tauri-drag-region={drag} {@attach windowTabBarSlot}></div>
  {#if tmuxName !== null}
    <!-- Where the A and B toggle sits in a window whose panes have sides;
         a tmux window's have none. -->
    <div class="tmux-badge" class:covered title="tmux window" data-tauri-drag-region={drag}>tmux</div>
  {/if}
  {#if menus.length > 0 || titleShown}
    <!-- While the launcher covers the page the band belongs to the window.
         A frameless window has no menubar and no title of its own, so the
         band draws the launcher menubar's menus at its left, then names the
         window, as Windows places a title, all clear of the window controls.
         Only the menu buttons take a press, and none drags, so the rest of
         the band stays the drag space. -->
    <div class="covered-band" style:right={`${chrome.insetRight + 8}px`}>
      {#if menus.length > 0}
        <div class="window-menus">
          {#each menus as menu (menu.id)}
            <button
              type="button"
              class="window-menu"
              class:open={openMenu === menu.id}
              data-menu={menu.id}
              tabindex="-1"
              aria-haspopup="menu"
              aria-expanded={openMenu === menu.id}
              {@attach opensMenu(menu.id)}
            >
              {menu.label}
            </button>
          {/each}
        </div>
      {/if}
      {#if titleShown}
        <div class="window-title" aria-hidden="true">
          <span>{windowTabBar.title}</span>
        </div>
      {/if}
    </div>
  {/if}
  <!-- The window controls' room. Where the page draws them they sit in a
       layer of their own after the bar, so this stays clear and drags
       nothing; otherwise it keeps the native controls' room and drags. -->
  <div
    class="inset"
    style:width={`${chrome.insetRight}px`}
    data-tauri-drag-region={chrome.drawControls ? undefined : drag}
  ></div>
</div>
{#if chrome.drawControls}
  <!-- The window's own controls, drawn in the look of Windows 11 caption
       buttons: out of the tab order, never a drag region, each a third of
       the inset and the bar's full height. They are a layer of their own,
       outside the bar's stacking context and above every overlay, as a
       native window keeps its caption buttons above its content. -->
  <div
    class="window-controls"
    style:width={`${chrome.insetRight}px`}
    style:height={`${windowTabBar.height}px`}
    style:z-index={WINDOW_CONTROLS_Z_INDEX}
    {@attach holdPresses}
  >
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
{/if}

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
  /* In the strip's type, at its active tab's weight; a long name gives up
     the slot's empty stretch first, then ends in an ellipsis. */
  .tmux-name {
    flex: 0 1 auto;
    min-width: 0;
    padding: 0 8px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
  }
  /* Black with white text in either theme: it names tmux, not a state the
     theme colours. In the side toggle's type, and as far from the band's
     end (the bar's 4px gap and this margin) as the strip keeps its last
     control (its 8px padding and the same gap). */
  .tmux-badge {
    flex: none;
    margin-right: 8px;
    padding: 0 6px;
    height: 20px;
    border-radius: 4px;
    background: #000;
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    line-height: 20px;
  }
  /* Windows 11 caption buttons: square-cornered, clear at rest, a light
     wash under the pointer and a lighter one with a dimmed glyph while
     pressed; close turns red with a white glyph. */
  .window-controls {
    position: fixed;
    top: 0;
    right: 0;
    display: flex;
    align-items: stretch;
    user-select: none;
    -webkit-user-select: none;
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
  .covered-band {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    display: flex;
    align-items: center;
    min-width: 0;
    pointer-events: none;
  }
  /* Windows 11 menubar items: text buttons, clear at rest, a wash under the
     pointer and a lighter one while pressed or while their menu is open. */
  .window-menus {
    flex: none;
    display: flex;
    align-items: center;
    padding-left: 4px;
  }
  .window-menu {
    flex: none;
    height: 28px;
    margin: 0;
    padding: 0 10px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--text);
    font-family: inherit;
    font-size: 12px;
    line-height: 28px;
    white-space: nowrap;
    cursor: default;
    pointer-events: auto;
  }
  .window-menu:hover {
    background: var(--hover-bg);
  }
  .window-menu:active,
  .window-menu.open {
    background: color-mix(in srgb, var(--hover-bg) 70%, transparent);
  }
  .window-title {
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    padding-left: 12px;
    min-width: 0;
    font-size: 12px;
    color: var(--text);
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
