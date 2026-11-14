import { describe, expect, it } from "vitest";
import { anchorOpeningBeat, beatIndex, beatPosition, moveProgress } from "./tourProgress";

describe("beatPosition", () => {
  const centers = [100, 300, 400, 1000];

  it("is a beat's index at its centre", () => {
    centers.forEach((center, index) => expect(beatPosition(centers, center)).toBe(index));
  });

  it("is linear between neighbours whatever their spacing", () => {
    expect(beatPosition(centers, 200)).toBeCloseTo(0.5);
    expect(beatPosition(centers, 325)).toBeCloseTo(1.25);
    expect(beatPosition(centers, 850)).toBeCloseTo(2.75);
  });

  it("stays on the first and last beat outside the tour", () => {
    expect(beatPosition(centers, -5000)).toBe(0);
    expect(beatPosition(centers, 5000)).toBe(3);
  });

  it("is zero for a tour with fewer than two beats", () => {
    expect(beatPosition([], 10)).toBe(0);
    expect(beatPosition([50], 500)).toBe(0);
  });
});

describe("moveProgress", () => {
  it("holds both poses around the beat centres", () => {
    expect(moveProgress(2, 2)).toBe(0);
    expect(moveProgress(2.15, 2)).toBe(0);
    expect(moveProgress(2.85, 2)).toBe(1);
    expect(moveProgress(3, 2)).toBe(1);
  });

  it("is halfway at the midpoint and never runs backwards", () => {
    expect(moveProgress(2.5, 2)).toBeCloseTo(0.5);
    let previous = 0;
    for (let position = 2; position <= 3; position += 0.01) {
      const progress = moveProgress(position, 2);
      expect(progress).toBeGreaterThanOrEqual(previous);
      previous = progress;
    }
  });

  it("is finished for every move the tour is already past", () => {
    expect(moveProgress(4.1, 1)).toBe(1);
    expect(moveProgress(0.3, 1)).toBe(0);
  });

  it("can leave a beat sooner than it settles on the next", () => {
    expect(moveProgress(0.1, 0, 0.02, 0.2)).toBeGreaterThan(0);
    expect(moveProgress(0.1, 0)).toBe(0);
    expect(moveProgress(0.85, 0, 0.02, 0.2)).toBe(1);
  });
});

describe("anchorOpeningBeat", () => {
  it("holds a first beat that starts on the first screen until the page scrolls", () => {
    const { centers, opensPage } = anchorOpeningBeat([290, 1200, 1800], 72, 700);
    expect(opensPage).toBe(true);
    expect(centers).toEqual([700, 1200, 1800]);
    expect(beatPosition(centers, 0 + 700)).toBe(0);
    expect(beatPosition(centers, 10 + 700)).toBeGreaterThan(0);
  });

  it("leaves a first beat below the focus line where it is", () => {
    const { centers, opensPage } = anchorOpeningBeat([486, 1305], 72, 450);
    expect(opensPage).toBe(true);
    expect(centers).toEqual([486, 1305]);
  });

  it("leaves a tour that starts further down the page alone", () => {
    const { centers, opensPage } = anchorOpeningBeat([2400, 3200], 2000, 450);
    expect(opensPage).toBe(false);
    expect(centers).toEqual([2400, 3200]);
  });

  it("does not anchor a first beat past the second", () => {
    expect(anchorOpeningBeat([100, 300], 20, 400).opensPage).toBe(false);
  });
});

describe("beatIndex", () => {
  it("reads a position as its nearest beat, inside the tour", () => {
    expect(beatIndex(1.49, 4)).toBe(1);
    expect(beatIndex(1.51, 4)).toBe(2);
    expect(beatIndex(-1, 4)).toBe(0);
    expect(beatIndex(9, 4)).toBe(3);
  });
});
