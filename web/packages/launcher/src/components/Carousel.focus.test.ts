// @vitest-environment jsdom
//
// The keyboard a card's own action asks onto the card in front (`showCard`
// with `focus`). The request can be made while the deck is not on screen:
// `Show on Computers screen`, run from the Gateways screen, turns to the
// Computers screen and asks in one step, before that deck has mounted.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRawSnippet, flushSync, mount, tick, unmount } from "svelte";
import Carousel from "./Carousel.svelte";
import { decks, resetDeck, showCard } from "../state/deck.svelte";

type Card = { key: string; label: string };

const CARDS: Card[] = [
  { key: "local", label: "This machine" },
  { key: "ds-a", label: "alpha" },
  { key: "ds-b", label: "beta" },
];

const card = createRawSnippet<[Card, boolean]>((item) => ({
  render: () => `<button type="button">${item().label}</button>`,
}));

let target: HTMLElement;
let mounted: Record<string, unknown> | null = null;

function mountDeck(): void {
  mounted = mount(Carousel<Card>, {
    target,
    props: { deck: "computers", items: CARDS, label: "Computers", card },
  }) as Record<string, unknown>;
  flushSync();
}

function unmountDeck(): void {
  if (mounted) unmount(mounted);
  mounted = null;
}

/// The key of the card that holds focus, null when none does.
function focusedCard(): string | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.classList.contains("slot")
    ? (active.dataset.key ?? null)
    : null;
}

async function settle(): Promise<void> {
  await tick();
  await tick();
}

beforeEach(() => {
  resetDeck();
  target = document.createElement("div");
  document.body.append(target);
});

afterEach(() => {
  unmountDeck();
  target.remove();
});

describe("focus asked onto the card in front", () => {
  it("moves onto the card when the deck is on screen", async () => {
    mountDeck();
    await settle();
    expect(focusedCard(), "a deck that mounts takes no focus by itself").toBeNull();
    showCard("computers", "ds-a", { focus: true });
    flushSync();
    await settle();
    expect(focusedCard()).toBe("ds-a");
  });

  it("moves onto the card when it was asked before the deck mounted", async () => {
    showCard("computers", "ds-b", { focus: true });
    mountDeck();
    await settle();
    expect(decks.computers.activeKey).toBe("ds-b");
    expect(focusedCard()).toBe("ds-b");
  });

  it("is answered once: a deck that mounts again takes no focus for the same request", async () => {
    mountDeck();
    showCard("computers", "ds-a", { focus: true });
    flushSync();
    await settle();
    expect(focusedCard()).toBe("ds-a");
    unmountDeck();
    expect(focusedCard()).toBeNull();
    mountDeck();
    await settle();
    expect(focusedCard(), "the screen came back; nothing asked again").toBeNull();
  });

  it("takes no focus after the decks' positions are forgotten", async () => {
    mountDeck();
    showCard("computers", "ds-a", { focus: true });
    flushSync();
    await settle();
    unmountDeck();
    // A position that starts over has answered nothing and asks for nothing.
    resetDeck();
    mountDeck();
    await settle();
    expect(focusedCard()).toBeNull();
    showCard("computers", "ds-b", { focus: true });
    flushSync();
    await settle();
    expect(focusedCard()).toBe("ds-b");
  });
});
