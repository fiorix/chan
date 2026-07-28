import { describe, expect, test } from "vitest";
import {
  buildPenguinTiles,
  PENGUIN_CELL_SIZE,
  PENGUIN_GRID_SIZE,
} from "./penguinGrid";

describe("Penguin Grid", () => {
  test("keeps the renderer tuning and source attribution", async () => {
    const renderer = (await import("./PenguinGrid.svelte?raw"))
      .default as string;
    const geometry = (await import("./penguinGrid.ts?raw"))
      .default as string;

    expect(renderer).toMatch(/const PHASE_SPEED = 0\.3;/);
    expect(geometry).toContain(
      "https://x.com/hisadan/status/2009225496039706731",
    );
  });

  test("builds the source sketch's 16 by 16 alternating grid", () => {
    const tiles = buildPenguinTiles(Math.PI / 2);
    const cellsPerSide = PENGUIN_GRID_SIZE / PENGUIN_CELL_SIZE;

    expect(tiles).toHaveLength(cellsPerSide ** 2);
    expect(tiles[0].start.x).toBeCloseTo(0);
    expect(tiles[cellsPerSide].start.x).toBeCloseTo(50);
    expect(tiles[0].eyeStrokeStrength).toBe(0);
    expect(tiles[cellsPerSide].eyeStrokeStrength).toBeCloseTo(1);
  });

  test("collapses to vertical threads at phase zero", () => {
    const tile = buildPenguinTiles(0)[0];

    expect(tile.start).toEqual({ x: 25, y: 0 });
    expect(tile.firstControl).toEqual(tile.start);
    expect(tile.end).toEqual({ x: 25, y: 50 });
    expect(tile.secondControl).toEqual(tile.end);
  });
});
