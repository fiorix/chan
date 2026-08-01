import { describe, expect, test } from "vitest";
import { fitPointCloudCover } from "./pointCloudCover";

describe("point-cloud cover fit", () => {
  test("covers both pane axes with one undistorted scale", () => {
    const bounds = {
      minX: 50,
      maxX: 350,
      minY: 20,
      maxY: 380,
    };
    const transform = fitPointCloudCover(1400, 900, bounds);

    expect(transform).toEqual({
      centerX: 700,
      centerY: 450,
      sourceCenterX: 200,
      sourceCenterY: 200,
      scale: 1400 / 300,
    });
    expect((bounds.maxX - bounds.minX) * transform.scale).toBeGreaterThanOrEqual(
      1400,
    );
    expect((bounds.maxY - bounds.minY) * transform.scale).toBeGreaterThanOrEqual(
      900,
    );
  });
});
