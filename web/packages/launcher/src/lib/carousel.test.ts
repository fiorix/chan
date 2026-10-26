import { describe, expect, it } from "vitest";
import {
  HIDE_BEYOND_DEG,
  MIN_SLOTS,
  cardWidth,
  mod,
  relativeAngle,
  ringLayout,
  ringRadius,
  shortestDelta,
  slotBrightness,
} from "./carousel";

describe("ringLayout", () => {
  it("keeps a short deck on an arc with the step of a six-card ring", () => {
    expect(ringLayout(3)).toEqual({ slots: MIN_SLOTS, step: 60, fullRing: false });
    expect(ringLayout(1)).toEqual({ slots: MIN_SLOTS, step: 60, fullRing: false });
  });

  it("closes the ring once the cards fill it", () => {
    expect(ringLayout(6)).toEqual({ slots: 6, step: 60, fullRing: true });
    const seven = ringLayout(7);
    expect(seven.fullRing).toBe(true);
    expect(seven.slots).toBe(7);
    expect(seven.step).toBeCloseTo(360 / 7);
  });
});

describe("cardWidth", () => {
  it("leaves room for the neighbours, within readable bounds", () => {
    expect(cardWidth(0)).toBe(300);
    expect(cardWidth(640)).toBe(416);
    expect(cardWidth(1200)).toBe(560);
    expect(cardWidth(4000)).toBe(560);
  });
});

describe("ringRadius", () => {
  it("parts neighbouring cards by the gap at their nearest edges", () => {
    // Half a card plus the gap, over tan(half the step).
    expect(ringRadius(560, 6)).toBe(Math.round(308 / Math.tan(Math.PI / 6)));
    // More slots pack the cards closer in angle, so the ring grows.
    expect(ringRadius(560, 12)).toBeGreaterThan(ringRadius(560, 6));
  });
});

describe("relativeAngle", () => {
  it("measures each card from the front on (-180, 180]", () => {
    expect(relativeAngle(0, 0, 60)).toBe(0);
    expect(relativeAngle(1, 0, 60)).toBe(60);
    expect(relativeAngle(5, 0, 60)).toBe(-60);
    expect(relativeAngle(3, 0, 60)).toBe(180);
  });

  it("follows a full ring's running turn past its seam", () => {
    // Seven cards, turned one card past the last: card 0 is in front again.
    expect(relativeAngle(0, 7, 360 / 7)).toBeCloseTo(0);
    expect(relativeAngle(6, 7, 360 / 7)).toBeCloseTo(-360 / 7);
  });
});

describe("visibility", () => {
  it("shows the front card and its nearest neighbours only", () => {
    const shown = (count: number): number[] => {
      const { step } = ringLayout(count);
      return Array.from({ length: count }, (_, i) => i).filter(
        (i) => Math.abs(relativeAngle(i, 0, step)) <= HIDE_BEYOND_DEG,
      );
    };
    // An arc of three, first card in front: the cards stand at 0, 60 and 120
    // degrees, so the third waits out of sight.
    expect(shown(3)).toEqual([0, 1]);
    // Seven and eight cards: one neighbour each side.
    expect(shown(7)).toEqual([0, 1, 6]);
    expect(shown(8)).toEqual([0, 1, 7]);
    // Twelve cards sit 30 degrees apart: two neighbours each side.
    expect(shown(12)).toEqual([0, 1, 2, 10, 11]);
  });

  it("dims a card with its angle and keeps a floor", () => {
    expect(slotBrightness(0)).toBe(1);
    expect(slotBrightness(-60)).toBe(slotBrightness(60));
    expect(slotBrightness(60)).toBeLessThan(1);
    expect(slotBrightness(180)).toBe(0.35);
  });
});

describe("shortestDelta", () => {
  it("goes the short way round a full ring", () => {
    expect(shortestDelta(0, 6, 7, true)).toBe(-1);
    expect(shortestDelta(6, 0, 7, true)).toBe(1);
    expect(shortestDelta(1, 3, 7, true)).toBe(2);
  });

  it("goes straight along an arc", () => {
    expect(shortestDelta(0, 2, 3, false)).toBe(2);
    expect(shortestDelta(2, 0, 3, false)).toBe(-2);
  });
});

describe("mod", () => {
  it("wraps negatives into range", () => {
    expect(mod(-1, 7)).toBe(6);
    expect(mod(7, 7)).toBe(0);
    expect(mod(9, 7)).toBe(2);
  });
});
