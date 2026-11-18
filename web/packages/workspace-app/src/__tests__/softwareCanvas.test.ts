// @vitest-environment jsdom
//
// The software canvas reads sizes back the way the element does.
import { describe, expect, test } from "vitest";
import { SoftwareCanvasContext } from "./softwareCanvas";

describe("the software canvas size", () => {
  test("a fractional assigned width reads back truncated", () => {
    const canvas = document.createElement("canvas");
    new SoftwareCanvasContext(canvas, 8);
    canvas.width = 1364.9999999999998;
    expect(canvas.width).toBe(1364);
  });
});
