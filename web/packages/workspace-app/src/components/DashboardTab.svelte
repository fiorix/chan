<script lang="ts">
  // Dashboard tab body. The rotating carousel lives only INSIDE
  // this tab (the welcome surface is the static chan mark + animation via
  // EmptyPaneWelcome.svelte). The full carousel widget (rotation +
  // play/pause + pagination + 3 slides: Workspace / Search /
  // About) renders here.
  //
  import { Check, RefreshCw, Settings2 } from "lucide-svelte";
  import { reloadWindow } from "../api/desktop";
  import { chordFor } from "../state/shortcuts";
  import {
    scheduleSessionSave,
    surfaceThemeOverride,
  } from "../state/store.svelte";
  import {
    type DashboardTab,
    dashboardSlotEnabled,
    firstEnabledSlot,
    flipHybrid,
    layout,
    toggleDashboardSlot,
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
  type Props = { tab: DashboardTab; active?: boolean };
  let { tab, active = true }: Props = $props();

  function onCarouselSlideChange(i: number): void {
    if (tab.carouselSlide === i) return;
    tab.carouselSlide = i;
    scheduleSessionSave();
  }

  let menu: HamburgerMenu | undefined = $state();
  let menuOpen = $state(false);

  // Chord lookup so the Reload row in the right-click menu renders its
  // Cmd+R hint alongside the row label, matching the pane top-bar pattern
  // in Pane.svelte. Override-aware (user assignment first, then built-in).
  function chordLabel(id: string): string {
    return chordFor(id) ?? "";
  }

  function onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    menu?.openAtCursor(e.clientX, e.clientY);
  }

  async function doReload(): Promise<void> {
    menu?.close();
    await reloadWindow();
  }

  // Slot labels mirror the carousel slide titles; the array index is the
  // slide identity (0 Workspace, 1 Search, 2 About).
  const SLOTS = ["Workspace", "Search", "About"] as const;

  function onSlotToggle(i: number): void {
    toggleDashboardSlot(tab, i);
    // If the active slide just got switched off, move the cursor to the
    // first still-enabled slot so the persisted slide stays valid;
    // otherwise persist the toggled set on its own.
    if (!dashboardSlotEnabled(tab, tab.carouselSlide ?? 0)) {
      onCarouselSlideChange(firstEnabledSlot(tab));
    } else {
      scheduleSessionSave();
    }
  }

  function doSettings(): void {
    menu?.close();
    flipHybrid(layout.activePaneId);
  }

  // Tab-title right-click parity: Pane.svelte routes every tab kind
  // through the shared `tabMenu` state. Translate a request targeting
  // this dashboard tab into opening its HamburgerMenu at the click point,
  // so the slot toggles + Flip + Reload are reachable from the tab
  // title (not only the body). Reuses the same menu rows.
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
    height={200}
  >
    <!-- Right-click menu for the Dashboard tab: a per-slot on/off
         checkbox row for each carousel slide (at least one stays on,
         enforced in toggleDashboardSlot); unchecked slots drop out of
         auto-rotation and the dots. A separator, then Flip and Reload. -->
    {#each SLOTS as label, i}
      <li>
        <button
          role="menuitemcheckbox"
          aria-checked={dashboardSlotEnabled(tab, i)}
          onclick={() => onSlotToggle(i)}
        >
          {#if dashboardSlotEnabled(tab, i)}
            <Check size={16} strokeWidth={2} aria-hidden="true" />
          {:else}
            <span class="slot-check-spacer" aria-hidden="true"></span>
          {/if}
          <span class="menu-row-label">{label}</span>
          <span class="menu-row-chord"></span>
        </button>
      </li>
    {/each}
    <li class="sep" role="separator"></li>
    <li>
      <button role="menuitem" onclick={doSettings}>
        <Settings2 size={16} strokeWidth={1.75} aria-hidden="true" />
        <span class="menu-row-label">Flip</span>
        <span class="menu-row-chord">{chordLabel("app.pane.flip")}</span>
      </button>
    </li>
    <li>
      <button role="menuitem" onclick={doReload}>
        <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
        <span class="menu-row-label">Reload</span>
        <span class="menu-row-chord">{chordLabel("app.window.reload")}</span>
      </button>
    </li>
  </HamburgerMenu>

  <EmptyPaneCarousel
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
