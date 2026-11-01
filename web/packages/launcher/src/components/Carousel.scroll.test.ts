// The card in front scrolls its rows inside the deck. Its scroller ends in a
// padding, so the last row stops clear of the card's border at the end of the
// range, and that same length is the scroller's end scroll padding, so keyboard
// selection of the last row (scrollIntoView) parks it above the border instead
// of on it. jsdom lays out nothing, so no mounted test can see either; this
// reads the carousel's stylesheet.

import { describe, expect, it } from "vitest";
import carouselSource from "./Carousel.svelte?raw";

function rule(source: string, selector: string): string {
  const style = source.slice(source.indexOf("<style>"));
  const at = style.indexOf(`${selector} {`);
  expect(at, `${selector} has a rule`).toBeGreaterThanOrEqual(0);
  return style.slice(at, style.indexOf("}", at));
}

describe("the deck card's scroller", () => {
  // Contract: the scroller's end padding and its end scroll padding are one
  // length, so the wheel's end of range and the keyboard's last-row alignment
  // leave the same margin under the last row.
  it("pads its end and scroll-pads it by the same length", () => {
    const scroller = rule(carouselSource, ".slot-body > :global(.card)");
    const padding = scroller.match(/padding-bottom:\s*([^;]+);/)?.[1];
    expect(padding, "the scroller has a bottom padding").toBeDefined();
    const scrollPadding = scroller.match(/scroll-padding-block-end:\s*([^;]+);/)?.[1];
    expect(scrollPadding, "the scroller has an end scroll padding").toBeDefined();
    expect(scrollPadding).toBe(padding);
  });
});
