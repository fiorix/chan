// Geometry adapted from Hisadan's Processing sketch and attached video:
// https://x.com/hisadan/status/2009225496039706731
export const PENGUIN_GRID_SIZE = 800;
export const PENGUIN_CELL_SIZE = 50;

export interface Point {
  x: number;
  y: number;
}

export interface PenguinTile {
  start: Point;
  firstControl: Point;
  secondControl: Point;
  end: Point;
  eyes: [Point, Point];
  eyeStrokeStrength: number;
}

export function buildPenguinTiles(phase: number): PenguinTile[] {
  const tiles: PenguinTile[] = [];

  for (let y = 0; y < PENGUIN_GRID_SIZE; y += PENGUIN_CELL_SIZE) {
    const direction = (y / PENGUIN_CELL_SIZE) % 2 === 0 ? -1 : 1;
    const sway = 25 * Math.sin(phase * direction);
    const middleBend = 25 * Math.sin(-phase * direction * 2);

    for (let x = 0; x < PENGUIN_GRID_SIZE; x += PENGUIN_CELL_SIZE) {
      tiles.push({
        start: { x: x + sway + 25, y: y + sway },
        firstControl: {
          x: x - sway + 25,
          y: y - sway,
        },
        secondControl: {
          x: x + middleBend + 25,
          y: y + sway + 50,
        },
        end: {
          x: x - sway + 25,
          y: y - sway + 50,
        },
        eyes: [
          { x: x + 25, y: y + 20 },
          { x: x + 30, y: y + 20 },
        ],
        eyeStrokeStrength: Math.max(0, sway / 25),
      });
    }
  }

  return tiles;
}
