<script lang="ts">
  // A deck's last card: Add devserver on the Computers deck, Add gateway on the
  // Gateways deck. Its front is one large button; pressing it turns the card
  // over with the launcher's A/B flip (ScreenFlip, the workspace pane flip's
  // copy) to the screen's form, which the `form` snippet renders with the
  // card's save and dismiss callbacks. Cancel or Escape turns it back; a save
  // turns it back and brings the saved entry's card, which the registry re-list
  // dealt into the deck by name, to the front. The deck can also ask for the
  // form (showAddForm), which turns the card over without moving focus.
  import { tick, untrack, type Snippet } from "svelte";
  import { Plus } from "@lucide/svelte";
  import ScreenFlip from "./ScreenFlip.svelte";
  import { decks, showCard, type DeckName } from "../state/deck.svelte";

  interface Props {
    deck: DeckName;
    /** Names the front button's class: `add-devserver`, `add-gateway`. */
    kind: string;
    /** The front button's text and the form's title. */
    label: string;
    hint: string;
    /** The form, given its save and dismiss callbacks. */
    form: Snippet<[(id: string) => void, () => void]>;
  }

  let { deck, kind, label, hint, form }: Props = $props();

  let flips = $state(0);
  let face = $state<"front" | "form">("front");
  let formFace: HTMLElement | null = $state(null);
  let frontButton: HTMLButtonElement | null = $state(null);

  async function turn(to: "front" | "form", focus = true): Promise<void> {
    face = to;
    flips += 1;
    await tick();
    if (!focus) return;
    if (to === "form") {
      formFace?.querySelector<HTMLInputElement>("input:not([disabled])")?.focus({ preventScroll: true });
    } else {
      frontButton?.focus({ preventScroll: true });
    }
  }

  $effect(() => {
    if (!decks[deck].openForm) return;
    decks[deck].openForm = false;
    untrack(() => {
      if (face !== "form") void turn("form", false);
    });
  });

  function saved(id: string): void {
    face = "front";
    flips += 1;
    showCard(deck, id, { focus: true });
  }

  function dismiss(): void {
    void turn("front");
  }

  function onFormKey(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    dismiss();
  }
</script>

<div class="add-deck-card">
  <ScreenFlip {flips} backLabel={label}>
    <section class="card add-card">
      {#if face === "front"}
        <div class="front" data-deck-row tabindex="-1">
          <button
            class="add-card-button add-{kind}"
            type="button"
            bind:this={frontButton}
            onclick={() => void turn("form")}>
            <Plus size={30} strokeWidth={1.6} />
            <span>{label}</span>
          </button>
          <p class="hint">{hint}</p>
        </div>
      {:else}
        <!-- Escape inside the form turns the card back; the form's own fields
             and buttons carry the keyboard, so the face takes no role. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="form-face" bind:this={formFace} onkeydown={onFormKey}>
          <h2 class="form-title">{label}</h2>
          {@render form(saved, dismiss)}
        </div>
      {/if}
    </section>
  </ScreenFlip>
</div>

<style>
  .add-deck-card {
    height: 100%;
  }

  .add-deck-card > :global(.screen-flip) {
    height: 100%;
  }

  /* The flip's wrappers are flex items, whose default min-height is their
     content's; letting them shrink keeps the card the box that scrolls, so a
     form taller than a short window scrolls inside the card. */
  .add-deck-card :global(.screen-flip-inner),
  .add-deck-card :global(.screen-flip-face) {
    min-height: 0;
  }

  /* The flip's back face reads as this card's back, not as a page. */
  .add-deck-card :global(.screen-flip-inner::before) {
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--bg-card);
    font-size: 22px;
  }

  .add-deck-card :global(.screen-flip-face) {
    background: transparent;
  }

  /* Outranks the shared sheet's `.content .card` margin. */
  .add-deck-card .add-card {
    flex: 1;
    box-sizing: border-box;
    min-height: 0;
    margin: 0;
    overflow-y: auto;
  }

  .front {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    height: 100%;
    padding: 1rem;
    box-sizing: border-box;
  }

  .add-card-button {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.6rem;
    width: min(16rem, 100%);
    aspect-ratio: 1;
    border: 1.5px dashed var(--border);
    border-radius: 18px;
    background: transparent;
    color: var(--text-secondary);
    font: inherit;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition:
      border-color 160ms ease,
      color 160ms ease,
      background 160ms ease;
  }

  .add-card-button:hover,
  .add-card-button:focus-visible {
    border-color: var(--accent);
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    outline: none;
  }

  .hint {
    max-width: 18rem;
    margin: 0;
    text-align: center;
    color: var(--text-secondary);
    font-size: 0.85rem;
    line-height: 1.45;
  }

  .form-face {
    padding: 0.6rem 0.5rem 0.3rem;
  }

  .form-title {
    margin: 0 0 0.8rem;
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--text);
  }
</style>
