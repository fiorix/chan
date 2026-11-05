// A pane body's drop zones: a band along each edge, a quarter of the body's
// extent across it and at most 120px, and the centre inside them.

import { describe, expect, test } from "vitest";

import { edgeBand, paneBodyDropZone } from "./paneDropZone";

describe("the edge band", () => {
  test.each([
    [80, 20],
    [240, 60],
    [480, 120],
    [1600, 120],
  ])("a body %ipx across has a %ipx band", (extent, band) => {
    expect(edgeBand(extent)).toBe(band);
  });
});

describe("the zone under a point", () => {
  test.each([
    // A small pane: the bands are a quarter of each axis.
    [240, 160, 59, 80, "left"],
    [240, 160, 60, 80, "centre"],
    [240, 160, 181, 80, "right"],
    [240, 160, 120, 39, "top"],
    [240, 160, 120, 121, "bottom"],
    [240, 160, 120, 80, "centre"],
    // A large pane: the bands stop at 120px, so the centre is most of it.
    [1600, 900, 119, 450, "left"],
    [1600, 900, 120, 450, "centre"],
    [1600, 900, 400, 450, "centre"],
    [1600, 900, 1481, 450, "right"],
    [1600, 900, 800, 119, "top"],
    [1600, 900, 800, 781, "bottom"],
    // A tiny pane still keeps half of each axis as its centre.
    [60, 40, 30, 20, "centre"],
    [60, 40, 14, 20, "left"],
    // In a corner both bands hold the point and the nearer edge wins.
    [1600, 900, 30, 10, "top"],
    [1600, 900, 10, 30, "left"],
    [240, 160, 230, 150, "right"],
  ] as const)("in %ix%i, (%i, %i) is %s", (width, height, x, y, zone) => {
    expect(paneBodyDropZone(x, y, width, height)).toBe(zone);
  });
});
