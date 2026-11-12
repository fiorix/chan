<script lang="ts">
  // The dashboard stays mounted while hidden, preserving its selected slide.
  import { Check, Command as CommandIcon, RefreshCw, Settings2, X } from "@lucide/svelte";
  import { reloadWindow } from "../api/desktop";
  import { commandTitle } from "../state/commands";
  import { shownSlideOptions } from "../state/commands/dashboard";
  // The menu names its rows through the catalog, which this fills.
  import "../state/commands/install";
  import { chordFor, shortcutLabel } from "../state/shortcuts";
  import {
    openCommandLauncherFromMenu,
    scheduleSessionSave,
    surfaceThemeOverride,
  } from "../state/store.svelte";
  import {
    closeTab,
    type DashboardTab,
    flipHybrid,
    panesHaveSides,
  } from "../state/tabs.svelte";
  import EmptyPaneCarousel from "./EmptyPaneCarousel.svelte";
  import HamburgerMenu from "./HamburgerMenu.svelte";
  import { closeTabMenu, tabMenu } from "../state/tabMenu.svelte";

  // The parent passes the live DashboardTab so the carousel slide
  // cursor persists across window reloads. The tab is a $state
  // proxy from tabs.svelte.ts; mutating `tab.carouselSlide`
  // reactively updates the layout snapshot the next session save
  // observes. `active` is the keep-alive visibility gate: the tab stays
  // MOUNTED across tab switches and side flips (so the Indexing graph keeps
  // its force layout + poll state and never reloads on its own), hiding via
  // the visibility contract when it is not the active tab on the visible side.
  // The carousel force-pauses when inactive so it does not auto-rotate or poll
  // the indexer in the background.
  type Props = { tab: DashboardTab; paneId: string; active?: boolean };
  let { tab, paneId, active = true }: Props = $props();

  function onCarouselSlideChange(i: number): void {
    if (tab.carouselSlide === i) return;
    tab.carouselSlide = i;
    scheduleSessionSave();
  }

  let menu: HamburgerMenu | undefined = $state();
  let menuOpen = $state(false);

  // Chord lookup so a row in the right-click menu renders its chord beside
  // its label, matching the pane top-bar pattern in Pane.svelte.
  // Override-aware (user assignment first, then built-in).
  function chordLabel(id: string): string {
    return chordFor(id) ?? "";
  }

  // The launcher's own toggle has no catalog row; the shortcut table names it.
  const launcherLabel = shortcutLabel("app.launcher.toggle");

  // The slide rows are the options of Shown slides, read for this tab.
  const slideOptions = $derived(shownSlideOptions(tab));

  // First-placement estimate for the menu, which measures itself once open.
  const menuHeight = $derived(
    40 + 30 * (slideOptions.length + 3 + (panesHaveSides() ? 1 : 0)),
  );

  function onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    menu?.openAtCursor(e.clientX, e.clientY);
  }

  async function doReload(): Promise<void> {
    menu?.close();
    await reloadWindow();
  }

  function doFlip(): void {
    menu?.close();
    flipHybrid(paneId);
  }

  function doCloseTab(): void {
    menu?.close();
    void closeTab(paneId, tab.id);
  }

  function openCommands(e: MouseEvent): void {
    const row = e.currentTarget as Element;
    menu?.close();
    openCommandLauncherFromMenu(row);
  }

  // Tab-title right-click parity: Pane.svelte routes every tab kind
  // through the shared `tabMenu` state. Translate a request targeting
  // this dashboard tab into opening its HamburgerMenu at the click point,
  // so its rows are reachable from the tab title (not only the body).
  $effect(() => {
    if (tabMenu.openForTabId !== tab.id || !tabMenu.anchor) return;
    // Wait until the menu instance is bound (it renders unconditionally,
    // so this only matters on the activate-and-open-in-one-tick path).
    if (!menu) return;
    const { left, top } = tabMenu.anchor;
    // Consume the request first so the effect settles in one pass (it
    // reads openForTabId); the HamburgerMenu owns the open + dismiss
    // state from here.
    closeTabMenu();
    menu.openAtCursor(left, top);
  });
</script>

<div
  class="dashboard"
  class:active
  aria-label="Dashboard"
  aria-hidden={!active}
  data-theme={surfaceThemeOverride("dashboard")}
  oncontextmenu={onContextMenu}
  role="region"
>
  <HamburgerMenu
    bind:this={menu}
    bind:open={menuOpen}
    showTrigger={false}
    width={220}
    height={menuHeight}
  >
    <!-- Right-click menu for the Dashboard tab: a per-slot on/off
         checkbox row for each carousel slide (at least one stays on,
         enforced in toggleDashboardSlot); unchecked slots drop out of
         auto-rotation and the dots. A separator, then Reload window and
         the tail every tab menu ends with (Flip pane where the window's
         panes have sides, Close tab), then the launcher row. -->
    {#each slideOptions as option (option.id)}
      <li>
        <button
          role="menuitemcheckbox"
          aria-checked={option.checked}
          onclick={() => void option.run()}
        >
          {#if option.checked}
            <Check size={16} strokeWidth={2} aria-hidden="true" />
          {:else}
            <span class="slot-check-spacer" aria-hidden="true"></span>
          {/if}
          <span class="menu-row-label">{option.label}</span>
          <span class="menu-row-chord"></span>
        </button>
      </li>
    {/each}
    <li class="sep" role="separator"></li>
    <li>
      <button role="menuitem" onclick={doReload}>
        <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
        <span class="menu-row-label">{commandTitle("app.window.reload")}</span>
        <span class="menu-row-chord">{chordLabel("app.window.reload")}</span>
      </button>
    </li>
    {#if panesHaveSides()}
      <li>
        <button role="menuitem" onclick={doFlip}>
          <Settings2 size={16} strokeWidth={1.75} aria-hidden="true" />
          <span class="menu-row-label">{commandTitle("app.pane.flip")}</span>
          <span class="menu-row-chord">{chordLabel("app.pane.flip")}</span>
        </button>
      </li>
    {/if}
    <li>
      <button role="menuitem" onclick={doCloseTab}>
        <X size={16} strokeWidth={1.75} aria-hidden="true" />
        <span class="menu-row-label">{commandTitle("app.tab.close")}</span>
        <span class="menu-row-chord">{chordLabel("app.tab.close")}</span>
      </button>
    </li>
    <li class="sep" role="separator"></li>
    <li>
      <button role="menuitem" onclick={openCommands}>
        <CommandIcon size={16} strokeWidth={1.75} aria-hidden="true" />
        <span class="menu-row-label">{launcherLabel}</span>
        <span class="menu-row-chord">{chordLabel("app.launcher.toggle")}</span>
      </button>
    </li>
  </HamburgerMenu>

  <EmptyPaneCarousel
    bind:selectedIndexId={() => tab.indexingSelectedId ?? null, (id) => (tab.indexingSelectedId = id)}
    bind:inspectorWidth={() => tab.inspectorWidth ?? 320, (width) => (tab.inspectorWidth = width)}
    slide={tab.carouselSlide ?? 0}
    onSlideChange={onCarouselSlideChange}
    {active}
    disabledSlots={tab.disabledSlots ?? []}
    autoRotate={tab.autoRotate ?? true}
  />
</div>

<style>
  /* Keep-alive contract, mirroring .graph-tab / .editor-tab in Pane.svelte:
     every dashboard tab in the pane stays mounted so the Indexing carousel
     graph keeps its force layout + 3s poll across tab switches; inactive
     ones hide via visibility (NEVER display:none; a 0x0 host would make
     the indexing GraphCanvas refit to nothing and lose its layout). The
     `active` prop additionally pauses the carousel + poll while hidden. */
  .dashboard {
    position: absolute;
    inset: 0;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--text);
    visibility: hidden;
    pointer-events: none;
  }
  .dashboard.active {
    visibility: visible;
    pointer-events: auto;
  }
  /* Keeps an unchecked slot row's label aligned with the checked rows'
     (the Check icon is 14px via the shared .hamburger-menu svg rule). */
  .slot-check-spacer {
    width: 14px;
    flex-shrink: 0;
  }
</style>
