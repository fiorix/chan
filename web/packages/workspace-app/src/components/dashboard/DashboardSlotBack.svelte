<script lang="ts">
  // Per-slot Dashboard flip-back. Replaces the monolithic
  // HybridDashboardConfig: the back now mirrors the front carousel's
  // current slot (Workspace / Search / About) and shows that slot's own
  // body. A carousel navigator (prev/next chevrons + a dot pager +
  // a pause/play toggle) lets the user move between slots without
  // flipping back to the front; selecting a slot moves the shared
  // `tab.carouselSlide` cursor so the front carousel follows on flip-back
  // (the carousel is controlled off the same field). The shell (title band
  // and OK) is HybridSurfaceConfigShell, same as every other Hybrid back.

  import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-svelte";
  import {
    DASHBOARD_SLOT_COUNT,
    DASHBOARD_SLOT_LABELS,
    type DashboardTab,
  } from "../../state/tabs.svelte";
  import { scheduleSessionSave } from "../../state/store.svelte";
  import HybridSurfaceConfigShell from "../HybridSurfaceConfigShell.svelte";
  import WorkspaceSlotConfig from "./WorkspaceSlotConfig.svelte";

  type Props = { tab: DashboardTab; onDone?: () => void };
  let { tab, onDone }: Props = $props();

  // Clamp to the valid slot range; the front carousel uses the same
  // clamp so the two faces never disagree on which slot is active.
  const slot = $derived(
    Math.min(
      Math.max(0, Math.floor(tab.carouselSlide ?? 0)),
      DASHBOARD_SLOT_COUNT - 1,
    ),
  );
  // The pause/play toggle drives `tab.autoRotate`, the per-tab DashboardTab
  // field the FRONT carousel reads (its `paused` derived includes
  // `!autoRotate`). Default true. This is the per-tab auto-advance override;
  // the front's own inline play/pause stays wired to the global cycling pref.
  const autoRotate = $derived(tab.autoRotate ?? true);

  function selectSlot(i: number): void {
    if (tab.carouselSlide === i) return;
    tab.carouselSlide = i;
    scheduleSessionSave();
  }

  // Prev/next wrap across all three slots so the back can reach every slot
  // even when a slot is toggled off for the front rotation (the front carousel
  // filters its dots by disabledSlots; this navigator does not).
  function step(delta: number): void {
    selectSlot((slot + delta + DASHBOARD_SLOT_COUNT) % DASHBOARD_SLOT_COUNT);
  }

  function toggleAutoRotate(): void {
    tab.autoRotate = !autoRotate;
    scheduleSessionSave();
  }
</script>

<HybridSurfaceConfigShell
  title={DASHBOARD_SLOT_LABELS[slot]}
  ariaLabel="Dashboard settings"
  {onDone}
  footerBorder={false}
>
  {#if slot === 0}
    <WorkspaceSlotConfig />
  {/if}

  <!-- Carousel navigator. Mirrors the FRONT card's carousel controls
       (EmptyPaneCarousel.svelte): prev/next chevrons + a dot pager + a
       pause/play toggle. It rides in the shell's footer row (footerCenter)
       now - centered, sharing the row with the right-aligned OK - instead
       of a separate bottom row above a divider. Selecting a slot swaps the
       body above and moves tab.carouselSlide so the front lands on the
       same slot when flipped back; pause/play sets tab.autoRotate. The
       navigator itself does not auto-rotate (you are configuring, not
       watching). -->
  {#snippet footerCenter()}
    <div class="carousel-nav" aria-label="Dashboard slot navigator">
    <button
      class="nav-arrow"
      type="button"
      onclick={() => step(-1)}
      aria-label="previous slot"
    >
      <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
    </button>
    <div class="dots" role="tablist" aria-label="Dashboard slot">
      {#each DASHBOARD_SLOT_LABELS as label, i (label)}
        <button
          type="button"
          class="dot-btn"
          class:active={slot === i}
          role="tab"
          aria-selected={slot === i}
          aria-label={label}
          onclick={() => selectSlot(i)}
        ></button>
      {/each}
    </div>
    <button
      class="nav-arrow"
      type="button"
      onclick={() => step(1)}
      aria-label="next slot"
    >
      <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
    </button>
    <button
      class="cycle-toggle"
      type="button"
      onclick={toggleAutoRotate}
      aria-label={autoRotate
        ? "pause carousel auto-rotate"
        : "resume carousel auto-rotate"}
      title={autoRotate ? "Pause auto-rotate" : "Resume auto-rotate"}
    >
      {#if autoRotate}
        <Pause size={14} strokeWidth={1.75} aria-hidden="true" />
      {:else}
        <Play size={14} strokeWidth={1.75} aria-hidden="true" />
      {/if}
    </button>
    </div>
  {/snippet}
</HybridSurfaceConfigShell>

<style>
  /* Carousel navigator, styled to match the front carousel's
     `.carousel-controls` (EmptyPaneCarousel.svelte) so the two faces read
     as the same control family. It lives in the shell footer's centered
     slot now, so the row placement/centering is the footer grid's job;
     this just lays the controls out inline. */
  .carousel-nav {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .nav-arrow,
  .cycle-toggle {
    background: none;
    border: 0;
    padding: 4px;
    color: var(--text-secondary);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    opacity: 0.5;
    transition: opacity 120ms ease, background 120ms ease;
  }
  .nav-arrow:hover,
  .cycle-toggle:hover {
    opacity: 1;
    background: var(--hover-bg);
  }
  /* Soft separator between the navigation cluster and the pause/play
     toggle so they read as two control groups. */
  .cycle-toggle {
    margin-left: 6px;
    border-left: 1px solid var(--border);
    border-radius: 0 4px 4px 0;
    padding-left: 8px;
  }
  .dots {
    display: inline-flex;
    gap: 6px;
  }
  .dot-btn {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    border: 0;
    padding: 0;
    background: var(--text-secondary);
    opacity: 0.35;
    cursor: pointer;
    transition: opacity 120ms ease, transform 120ms ease;
  }
  .dot-btn:hover {
    opacity: 0.7;
  }
  .dot-btn.active {
    opacity: 0.9;
    transform: scale(1.2);
  }
</style>
