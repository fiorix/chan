// A deck's Add card scrolls a form taller than its slot inside the card, and
// focusing a field never scrolls the deck's stage, which has no scrollbar to
// bring it back. jsdom lays out nothing, so no mounted test can see either;
// this reads the two components' stylesheets.

import { describe, expect, it } from "vitest";
import addCardSource from "./AddCard.svelte?raw";
import carouselSource from "./Carousel.svelte?raw";

function rule(source: string, selector: string): string {
  const style = source.slice(source.indexOf("<style>"));
  const at = style.indexOf(`${selector} {`);
  expect(at, `${selector} has a rule`).toBeGreaterThanOrEqual(0);
  return style.slice(at, style.indexOf("}", at));
}

describe("the Add card's layout", () => {
  // Contract: the flip's flex wrappers shrink below their content, so the card,
  // not an ancestor, is the box that scrolls a tall form.
  it("lets the flip's wrappers shrink so the card scrolls its form", () => {
    const wrappers = rule(
      addCardSource,
      ".add-deck-card :global(.screen-flip-inner),\n  .add-deck-card :global(.screen-flip-face)",
    );
    expect(wrappers).toMatch(/min-height:\s*0;/);
    const card = rule(addCardSource, ".add-deck-card .add-card");
    expect(card).toMatch(/min-height:\s*0;/);
    expect(card).toMatch(/overflow-y:\s*auto;/);
  });

  // Contract: the stage clips without being a scroll container, so focus moving
  // past its edge cannot shift the deck.
  it("clips the deck's stage without making it scrollable", () => {
    const stage = rule(carouselSource, ".stage");
    expect(stage).toMatch(/overflow:\s*clip;/);
    // `clip` comes last, so it wins wherever the engine knows it.
    expect(stage.lastIndexOf("overflow: clip")).toBeGreaterThan(stage.lastIndexOf("overflow: hidden"));
  });
});
