<script lang="ts">
  // The window tab bar: a band across the top of the window holding the pane
  // tree button, the window's title and the slot the active pane's tab strip
  // moves into (see Pane.svelte). The title sits after the tree button while
  // the window has no tabs and at the bar's end, left of the strip's actions,
  // once it has one. In chan-desktop's title bar its insets keep clear of the
  // window controls, its content row sits on their centre line, and its empty
  // stretches drag the window. Where the desktop asks for it (Windows, whose
  // window has no frame in the mode) the window controls sit over the right
  // inset, in a layer of their own above every overlay. The band is opaque: terminal background opacity cuts its holes
  // behind terminal panes only. While the window's Computers launcher is
  // shown over the page, the band holds neither the tree button nor the
  // strip: they belong to the covered window. On Windows it holds the
  // launcher menubar's menus there instead, since the frameless window wears
  // no menubar, and the window's title after them. A tmux pane has no strip,
  // so while one is active the band marks the window as tmux's and names no
  // pane: the window's title names the window.

  import { untrack } from "svelte";
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
  import { ui } from "../state/store.svelte";
  import { activeLayout, paneShowsTmux } from "../state/tabs.svelte";
  import {
    WINDOW_CONTROLS_Z_INDEX,
    WINDOW_TITLE_MOVE,
    WINDOW_TITLE_READ_RETRIES,
    WINDOW_TITLE_READ_RETRY_MS,
    WINDOW_TITLE_RESERVE_PX,
    WINDOW_TITLE_ROLL,
    WINDOW_TITLE_ROLL_PX_PER_S,
    WINDOW_TITLE_SLIDE_MS,
    windowTabBar,
    windowTabBarCenterPad,
    windowTabBarSlot,
  } from "../state/windowTabBar.svelte";
  import { loadWindowTitle, windowName } from "../state/windowTitle.svelte";
  import { privacy } from "@chan/web-shared/privacy";
  import { WINDOW_TITLE_END_ATTR, windowTitleMover, type WindowTitlePlace } from "./windowBarTitle";

  // `restored` is false until the boot has restored the window's layout:
  // the tabs that restore brings are not a first tab opening, so the title
  // takes its place among them without a slide.
  let { restored = true }: { restored?: boolean } = $props();

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
  // same test), so while one is active, a pane Hybrid Nav stages in a tmux
  // window included, the bar marks the window as tmux's where a window with
  // sides has its A and B toggle. The bar names no pane: the window's title
  // ends in its caption, a label given in Computers or else tmux's name for
  // the window (with automatic renaming, its active pane's command), and
  // the pane tree names each pane.
  const tmuxWindow = $derived(paneShowsTmux(viewLayout.nodes[viewLayout.activePaneId]));

  // The window's title: the one the desktop sends, or in privacy mode the
  // generated name alone. Display only.
  const title = $derived(windowName());
  // The naming fields behind the privacy form, and behind the name of a
  // window no title has reached, are read once they are needed: when privacy
  // mode is on, and at a pane tree open. A read fails while the window has no
  // live presence, as at boot, and leaves no title, so it is tried again when
  // the window's socket changes state, a bounded number of times after that
  // (the socket opens a moment before the server counts the presence), and
  // at the next pane tree open.
  let titleReadTick = $state(0);
  let titleReadsLeft = WINDOW_TITLE_READ_RETRIES;
  let titleReadSocket: string | null = null;
  $effect(() => {
    if (title !== null) return;
    if (!(privacy.enabled || paneTree.open)) return;
    void titleReadTick;
    if (ui.ws !== titleReadSocket) {
      titleReadSocket = ui.ws;
      titleReadsLeft = WINDOW_TITLE_READ_RETRIES;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    untrack(() => {
      // A read that found the window names it, which ends this effect.
      void loadWindowTitle().then(() => {
        if (!live || titleReadsLeft <= 0) return;
        titleReadsLeft -= 1;
        timer = setTimeout(() => {
          titleReadTick += 1;
        }, WINDOW_TITLE_READ_RETRY_MS);
      });
    });
    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
    };
  });

  // With no tab in any pane of the window, on either side, the title sits
  // after the tree button; one tab anywhere sends it to the bar's end.
  const titlePlace: WindowTitlePlace = $derived(
    Object.values(viewLayout.nodes).some(
      (node) => node.kind === "leaf" && (node.tabs.length > 0 || (node.bTabs?.length ?? 0) > 0),
    )
      ? "end"
      : "start",
  );
  const placeTitle = windowTitleMover();
  // The title box's padding at each end, in CSS px.
  const TITLE_PADDING_PX = 8;
  const endPlace = { [WINDOW_TITLE_END_ATTR]: "" };

  // How far the title's text runs past its box, in CSS px; 0 when it fits. A
  // title that runs past rolls by that distance (see the roll rules below).
  // And the width the title's box takes to show the text whole, 0 until it
  // is measured, which bounds how far a short title gives way to the tabs:
  // the text's width, rounded up, and the box's padding. The text's width is
  // read from the inline run that holds it, whose width is the text's
  // whatever the box around it: the box's own scroll width is never less
  // than the box, and the box is never narrower than this floor, so a floor
  // read from the box could only grow.
  let titleText = $state<HTMLElement | null>(null);
  let titleRun = $state<HTMLElement | null>(null);
  let titleOverflow = $state(0);
  let titleNatural = $state(0);
  function measureTitle(): void {
    const text = titleText;
    const run = titleRun;
    if (!text || !run) return;
    const width = run.getBoundingClientRect().width;
    const past = Math.ceil(width - text.clientWidth);
    titleOverflow = past > 1 ? past : 0;
    titleNatural = width > 0 ? Math.ceil(width) + 2 * TITLE_PADDING_PX : 0;
  }
  $effect(() => {
    void title;
    void titlePlace;
    measureTitle();
  });
  $effect(() => {
    const text = titleText;
    if (!text || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureTitle);
    observer.observe(text);
    // A face that loads late changes the text's width under a box the
    // floor may be holding still.
    document.fonts?.addEventListener?.("loadingdone", measureTitle);
    return () => {
      observer.disconnect();
      document.fonts?.removeEventListener?.("loadingdone", measureTitle);
    };
  });
  // A roll is head to tail and back, each way over about a third of the
  // cycle, with a rest at each end (the keyframes below).
  const rollSeconds = $derived(Math.max(4, (titleOverflow / WINDOW_TITLE_ROLL_PX_PER_S) * 3));

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
  // window wearing no menubar gets, and the title of a frameless window, the
  // one the bar shows uncovered, so privacy mode masks it here as well from
  // the moment the page hears of it.
  const menus = $derived(covered ? chrome.menus : []);
  const titleShown = $derived(covered && chrome.drawControls && title !== null);

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
  style:--window-title-reserve={`${WINDOW_TITLE_RESERVE_PX}px`}
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
  <!-- The window's title, display only: a press on it drags the window as
       the band around it does, so the box, its text and the run inside all
       carry the drag attribute, which Tauri's drag script reads on the element pressed.
       This is its place while the window has no tabs; with tabs the mover
       takes it to the bar's end. It is always rendered, and hidden while
       there is no title, so the mover never moves a block's boundary. -->
  <div
    class="bar-title"
    class:covered
    hidden={title === null}
    title={title ?? undefined}
    data-place={titlePlace}
    data-roll={WINDOW_TITLE_ROLL}
    data-overflow={titleOverflow > 0 ? "" : undefined}
    style:--window-title-natural={titleNatural > 0 ? `${titleNatural}px` : undefined}
    style:padding={`0 ${TITLE_PADDING_PX}px`}
    style:--window-title-roll-distance={`${-titleOverflow}px`}
    style:--window-title-roll-duration={`${rollSeconds}s`}
    data-tauri-drag-region={drag}
    {@attach placeTitle(
      titlePlace,
      windowTabBar.titleSlot,
      restored && WINDOW_TITLE_MOVE === "slide" ? WINDOW_TITLE_SLIDE_MS : 0,
    )}
  >
    <span class="bar-title-text" bind:this={titleText} data-tauri-drag-region={drag}
      ><span bind:this={titleRun} data-tauri-drag-region={drag}>{title ?? ""}</span></span
    >
  </div>
  <div
    class="slot"
    class:covered
    class:beside-title={titlePlace === "start" && title !== null}
    data-tauri-drag-region={drag}
    {@attach windowTabBarSlot}
  ></div>
  <!-- The title's place at the bar's end while no strip shows in the bar to
       take it: a tmux window, whose title then sits before the badge. -->
  <div class="title-end" {...endPlace}></div>
  {#if tmuxWindow}
    <!-- Where the A and B toggle sits in a window whose panes have sides;
         a tmux window's have none. Display only, so nothing here reopens
         the hidden strip or offers a tab action tmux cannot take; on the
         desktop a press on it drags the window as the band around it does.
         It holds its text directly, since Tauri's drag script reads the
         attribute on the element pressed. -->
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
          <span>{title}</span>
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
  /* Beside a leading title the slot keeps the width of what the strip
     holds, so a long title gives way to the strip's actions. */
  .slot.beside-title {
    flex: 1 0 auto;
  }
  /* The title is a flex item of the row it sits in: the bar's at the start
     and, through places that draw no box of their own, the strip's or the
     bar's at the end. At the start it takes the room the strip leaves and
     ends in an ellipsis. At the end it shows whole while the tabs leave it
     the room. When they do not, it gives way before any tab does: its
     shrink factor dwarfs the tabs' viewport's, so the row's shortfall falls
     on the title until it reaches its floor, and only then do the tabs
     overflow and scroll. The floor is the reserve, or two fifths of the row
     in a narrow window, or the title's own width when that is smaller, all
     of the whole box, its padding included. */
  .title-end {
    display: contents;
  }
  .bar-title {
    box-sizing: border-box;
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    font-size: 12px;
    color: var(--text);
  }
  .bar-title[hidden] {
    display: none;
  }
  .bar-title[data-place="end"] {
    flex: 0 100000 auto;
    min-width: min(var(--window-title-natural, 0px), var(--window-title-reserve), 40%);
    /* Any width the box has over its text lies at its start, so the text
       sits flush with the strip's actions; text that runs past the box
       still starts at the box's start. */
    text-align: right;
  }
  .bar-title-text {
    display: block;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  /* A title that runs past its box rolls to its tail and back inside the
     box: under the pointer in the "hover" variant, all the time in "auto",
     never in "off" or under reduced motion, where the ellipsis and the
     tooltip stand. */
  @media (prefers-reduced-motion: no-preference) {
    .bar-title[data-roll="hover"][data-overflow]:hover .bar-title-text,
    .bar-title[data-roll="auto"][data-overflow] .bar-title-text {
      overflow: visible;
      text-overflow: clip;
      animation: window-title-roll var(--window-title-roll-duration) linear infinite;
    }
  }
  @keyframes window-title-roll {
    0%,
    12% {
      transform: translateX(0);
    }
    45%,
    60% {
      transform: translateX(var(--window-title-roll-distance));
    }
    93%,
    100% {
      transform: translateX(0);
    }
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
