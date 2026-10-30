import { describe, expect, test } from "vitest";
import { GhosttyWheelRows, ghosttyWheelArrow } from "./ghosttyWheel";

const PIXEL = 0;
const LINE = 1;
const PAGE = 2;

function pixel(deltaY: number, shiftKey = false) {
  return { deltaY, deltaMode: PIXEL, shiftKey };
}

describe("GhosttyWheelRows", () => {
  test("a trackpad's small pixel deltas carry until a whole row builds up", () => {
    const rows = new GhosttyWheelRows();
    // 10 px on a 20 px row, scaled by 0.3: 0.15 of a row per event.
    const steps = Array.from({ length: 7 }, () => rows.consume(pixel(10), 20, 24));
    expect(steps).toEqual([0, 0, 0, 0, 0, 0, 1]);
  });

  test("a swipe of many small events yields far fewer rows than events", () => {
    const rows = new GhosttyWheelRows();
    const steps = Array.from({ length: 40 }, () => rows.consume(pixel(30), 16, 24));
    // 30 / 16 * 0.3 = 0.5625 of a row per event.
    expect(steps.filter((n) => n !== 0)).toHaveLength(22);
    expect(steps.every((n) => n === 0 || n === 1)).toBe(true);
  });

  test("a large pixel delta is not scaled and scrolls its whole rows", () => {
    const rows = new GhosttyWheelRows();
    expect(rows.consume(pixel(100), 20, 24)).toBe(5);
    expect(rows.consume(pixel(-100), 20, 24)).toBe(-5);
  });

  test("an upward gesture yields negative rows", () => {
    const rows = new GhosttyWheelRows();
    const steps = Array.from({ length: 7 }, () => rows.consume(pixel(-10), 20, 24));
    expect(steps.at(-1)).toBe(-1);
  });

  test("a reversal spends the carried fraction first", () => {
    const rows = new GhosttyWheelRows();
    for (let i = 0; i < 6; i++) rows.consume(pixel(10), 20, 24);
    expect(rows.consume(pixel(-10), 20, 24)).toBe(0);
  });

  test("line deltas pass through and page deltas scale by the grid", () => {
    const rows = new GhosttyWheelRows();
    expect(rows.consume({ deltaY: 3, deltaMode: LINE, shiftKey: false }, 20, 24)).toBe(3);
    expect(rows.consume({ deltaY: -1, deltaMode: PAGE, shiftKey: false }, 20, 24)).toBe(-24);
  });

  test("no delta, a shifted wheel or an unknown cell height scroll nothing", () => {
    const rows = new GhosttyWheelRows();
    expect(rows.consume(pixel(0), 20, 24)).toBe(0);
    expect(rows.consume(pixel(100, true), 20, 24)).toBe(0);
    expect(rows.consume(pixel(100), 0, 24)).toBe(0);
  });
});

describe("ghosttyWheelArrow", () => {
  test("is CSI by default and SS3 under application cursor keys", () => {
    expect(ghosttyWheelArrow(true, false)).toBe("\x1b[A");
    expect(ghosttyWheelArrow(false, false)).toBe("\x1b[B");
    expect(ghosttyWheelArrow(true, true)).toBe("\x1bOA");
    expect(ghosttyWheelArrow(false, true)).toBe("\x1bOB");
  });
});
