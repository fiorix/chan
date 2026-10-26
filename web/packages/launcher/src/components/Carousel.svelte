<script lang="ts" generics="T extends { key: string; label: string }">
  // A ring of cards around a vertical axis, one card in front. The layout is a
  // port of a 3D circular gallery: each card stands at `index * step` degrees,
  // `radius` out from the axis, under a 2000px perspective, and the ring turns
  // to bring a card forward, dimming the others by their angle from the front
  // (lib/carousel). The ring sits `radius` back from the viewer, so the card in
  // front renders at its natural size.
  //
  // Left and Right arrows turn the ring one card and move focus onto the card
  // in front; Tab then walks that card's controls. Every other card is inert,
  // so focus and the accessibility tree hold only the card in front. A click
  // on a side card, a dot, or the side buttons turns to it. Arrows typed into a
  // field, or pressed with a modifier, are left alone.
  import { tick, type Snippet } from "svelte";
  import { ChevronLeft, ChevronRight } from "@lucide/svelte";
  import { decks, type DeckName } from "../state/deck.svelte";
  import {
    HIDE_BEYOND_DEG,
    cardWidth,
    mod,
    relativeAngle,
    ringLayout,
    ringRadius,
    shortestDelta,
    slotBrightness,
  } from "../lib/carousel";

  interface Props {
    /** Which screen's deck this is; its position lives in state/deck. */
    deck: DeckName;
    items: T[];
    /** The carousel's accessible name. */
    label: string;
    card: Snippet<[T, boolean]>;
  }

  let { deck: deckName, items, label, card }: Props = $props();
  const deck = $derived(decks[deckName]);

  let root: HTMLElement | null = $state(null);
  let stage: HTMLElement | null = $state(null);
  let stageWidth = $state(0);
  const slotEls: HTMLElement[] = $state([]);

  const count = $derived(items.length);
  const layout = $derived(ringLayout(count));
  const keyedIndex = $derived(items.findIndex((item) => item.key === deck.activeKey));
  // The card a key names stays in front as cards come and go; a card that left
  // the deck hands the front to whatever now holds its place.
  const activeIndex = $derived(
    count === 0 ? 0 : keyedIndex >= 0 ? keyedIndex : Math.min(mod(deck.turn, count), count - 1),
  );
  // The ring's turn in steps. A full ring keeps the running count, so turning
  // past its last card carries on round instead of spinning back; an arc sits
  // at the front card's own index.
  const position = $derived(
    count === 0
      ? 0
      : layout.fullRing
        ? deck.turn - mod(deck.turn, count) + activeIndex
        : activeIndex,
  );
  const width = $derived(cardWidth(stageWidth));
  const radius = $derived(ringRadius(width, layout.slots));

  function move(delta: number): void {
    if (count === 0) return;
    const next = position + delta;
    const index = mod(next, count);
    deck.turn = layout.fullRing ? next : index;
    deck.activeKey = items[index].key;
  }

  function activate(index: number): void {
    move(shortestDelta(activeIndex, index, count, layout.fullRing));
  }

  function focusFront(): void {
    void tick().then(() => slotEls[activeIndex]?.focus({ preventScroll: true }));
  }

  // Keys typed into these belong to the field: a text caret, a select, a
  // radio group and a range all move on arrows.
  const KEYLESS_INPUTS = new Set(["checkbox", "button", "submit", "reset", "image", "color", "file"]);
  function ownsArrows(el: EventTarget | null): boolean {
    if (!(el instanceof HTMLElement)) return false;
    if (el.isContentEditable) return true;
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
    return el instanceof HTMLInputElement && !KEYLESS_INPUTS.has(el.type);
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const target = e.target;
    // The page itself, or something inside the deck: a dialog, the command
    // deck or a notice keeps its own arrows.
    const here =
      target === document.body ||
      target === document.documentElement ||
      (target instanceof Node && root?.contains(target) === true);
    if (!here || ownsArrows(target)) return;
    e.preventDefault();
    move(e.key === "ArrowRight" ? 1 : -1);
    focusFront();
  }

  // A card's own action asked for focus on the card in front (showCard). The
  // first run only records where the count stands.
  let seenFocusSeq: number | null = null;
  $effect(() => {
    const seq = deck.focusSeq;
    const asked = seenFocusSeq !== null && seq !== seenFocusSeq;
    seenFocusSeq = seq;
    if (asked) focusFront();
  });

  $effect(() => {
    const el = stage;
    if (!el) return;
    const measure = (): void => {
      stageWidth = el.clientWidth;
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  });
</script>

<svelte:window onkeydown={onKey} />

<div
  class="carousel"
  bind:this={root}
  role="region"
  aria-roledescription="carousel"
  aria-label={label}>
  <div class="stage" bind:this={stage} style:--card-width={`${width}px`}>
    <div
      class="ring"
      style:transform={`translateZ(${-radius}px) rotateY(${-position * layout.step}deg)`}>
      {#each items as item, i (item.key)}
        {@const angle = relativeAngle(i, position, layout.step)}
        {@const active = i === activeIndex}
        <!-- A side card is a pointer target that turns the ring to it; the
             keyboard reaches it through the arrows, so the card itself takes
             no key handler and is focused only programmatically. -->
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
        <div
          class="slot"
          class:active
          class:away={Math.abs(angle) > HIDE_BEYOND_DEG}
          role="group"
          aria-roledescription="card"
          aria-label={`${item.label}, ${i + 1} of ${count}`}
          aria-current={active ? "true" : undefined}
          data-key={item.key}
          tabindex="-1"
          bind:this={slotEls[i]}
          style:transform={`rotateY(${i * layout.step}deg) translateZ(${radius}px)`}
          style:filter={active ? undefined : `brightness(${slotBrightness(angle)})`}
          onclick={() => {
            if (active) return;
            activate(i);
            focusFront();
          }}>
          <div class="slot-body" inert={!active}>
            {@render card(item, active)}
          </div>
        </div>
      {/each}
    </div>
    {#if count > 1}
      <button
        class="icon-btn nav prev"
        type="button"
        title="Previous"
        aria-label="Previous card"
        onclick={() => move(-1)}>
        <ChevronLeft size={18} />
      </button>
      <button
        class="icon-btn nav next"
        type="button"
        title="Next"
        aria-label="Next card"
        onclick={() => move(1)}>
        <ChevronRight size={18} />
      </button>
    {/if}
  </div>
  {#if count > 1}
    <!-- Pointer convenience mirroring the arrows: hidden from assistive tech
         and out of the tab order, since the arrows and the side buttons
         already turn the ring. -->
    <div class="dots" aria-hidden="true">
      {#each items as item, i (item.key)}
        <button
          class="dot"
          class:active={i === activeIndex}
          type="button"
          tabindex="-1"
          title={item.label}
          onclick={() => {
            activate(i);
            focusFront();
          }}></button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .carousel {
    --deck-height: clamp(22rem, calc(100vh - 11rem), 48rem);

    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  /* The viewport onto the ring. It clips without being a scroll container:
     a hidden overflow can still be scrolled by focusing something past its
     edge, and with no scrollbar to bring it back the deck would stay shifted.
     `hidden` stands in where `clip` is unknown. */
  .stage {
    position: relative;
    height: var(--deck-height);
    perspective: 2000px;
    overflow: hidden;
    overflow: clip;
  }

  .ring {
    position: absolute;
    inset: 0;
    transform-style: preserve-3d;
    transition: transform 600ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  .slot {
    position: absolute;
    top: 0.75rem;
    bottom: 0.75rem;
    left: 50%;
    width: var(--card-width);
    margin-left: calc(var(--card-width) / -2);
    outline: none;
    cursor: pointer;
    transition: filter 300ms linear;
  }

  .slot.active {
    cursor: auto;
  }

  .slot.away {
    visibility: hidden;
  }

  .slot-body {
    height: 100%;
  }

  /* A card fills its slot and scrolls inside it, so every card in the ring
     has one size whatever it holds. */
  .slot-body > :global(.card) {
    box-sizing: border-box;
    height: 100%;
    margin: 0;
    overflow-y: auto;
  }

  /* The ring moves the cards; a card does not also grow under the pointer. */
  .slot :global(.card:hover) {
    transform: none;
  }

  .slot.active:focus-visible :global(.card) {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }

  .nav {
    position: absolute;
    top: 50%;
    z-index: 2;
    transform: translateY(-50%);
    background: var(--bg-card);
  }

  .nav.prev {
    left: 0.75rem;
  }

  .nav.next {
    right: 0.75rem;
  }

  .dots {
    display: flex;
    justify-content: center;
    gap: 0.45rem;
  }

  .dot {
    width: 0.5rem;
    height: 0.5rem;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: color-mix(in srgb, var(--text-secondary) 35%, transparent);
    cursor: pointer;
    transition: background 160ms ease;
  }

  .dot.active {
    background: var(--brand);
  }

  @media (prefers-reduced-motion: reduce) {
    .ring,
    .slot {
      transition: none;
    }
  }
</style>
