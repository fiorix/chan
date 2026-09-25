import { describe, expect, test } from "vitest";
import matrix from "./screensaver/MatrixRain.svelte?raw";
import matrixHelper from "./screensaver/matrixRain.ts?raw";
import matrixPreview from "./screensaver/MatrixRainPreview.svelte?raw";

// The matrix rain engine - alphabet, spacing/size/cadence/density constants,
// color tiers, the column model (`createRainColumns`), one-frame step
// (`stepRain`), and the static snapshot (`drawStaticMatrix`) - lives in the
// shared `matrixRain.ts` helper (`matrixHelper`). The fullscreen screensaver
// (`matrix`) and the config-panel preview (`matrixPreview`) both drive their
// animation off that one engine so they can never drift. The intro and
// canvas markup/CSS stay in the screensaver component.

describe("screensaver canvas themes", () => {
  test("MatrixRain is a full-bleed canvas with reduced-motion handling", () => {
    expect(matrix).toMatch(/<canvas bind:this=\{canvas\} class="matrix-rain"/);
    expect(matrix).toMatch(/prefers-reduced-motion: reduce/);
    // Shared engine lives in the helper; MatrixRain imports + drives it.
    expect(matrixHelper).toMatch(/export function drawStaticMatrix\(/);
    expect(matrixHelper).toMatch(/export function createRainColumns\(/);
    expect(matrixHelper).toMatch(/export function stepRain\(/);
    expect(matrixHelper).toMatch(/abcdefghijklmnopqrstuvwxyz123456789890/);
    expect(matrix).toMatch(/from "\.\/matrixRain"/);
    expect(matrix).toMatch(/columns = createRainColumns\(numCols, numChars\)/);
    expect(matrix).toMatch(
      /setInterval\([\s\S]{1,120}stepRain\(ctx, columns, numCols, numChars\)[\s\S]{1,40}DRAW_INTERVAL_MS/,
    );
    expect(matrix).toMatch(/font-family: "matrix_code"/);
    expect(matrix).toMatch(/font-family: "matrix_courier"/);
    expect(matrix).toMatch(/LICENSE-MatrixScreensaver\.txt/);
  });

  test("Matrix intro matches the reference message sequence and timing", () => {
    expect(matrix).toMatch(/INTRO_MESSAGES = \["Wake up, Neo\.\.\.", "The Matrix has you\.\.\."\]/);
    expect(matrix).toMatch(/INTRO_START_DELAY_MS = 500/);
    expect(matrix).toMatch(/INTRO_HOLD_MS = 2000/);
    expect(matrix).toMatch(/TYPE_DELAY_SLOW_MS = 300/);
    expect(matrix).toMatch(/TYPE_DELAY_FAST_MS = 100/);
    expect(matrix).toMatch(/INTRO_FONT_SIZE_PX = 22/);
    expect(matrix).toMatch(/document\.fonts\.load\(`\$\{INTRO_FONT_SIZE_PX\}px matrix_courier`\)/);
    expect(matrix).toMatch(/index \* \(COLUMN_SPACING_PX \+ 2\) \+ 30/);
    expect(matrix).toMatch(/outputChar\([\s\S]{1,120}40,/);
  });

  test("Matrix rain follows the dcragusa reference spacing, cadence, and color tiers", () => {
    // Spacing/size/cadence/density + the color tiers + the per-cell color roll
    // are all shared constants/logic in the helper now.
    expect(matrixHelper).toMatch(/DRAW_INTERVAL_MS = 40/);
    expect(matrixHelper).toMatch(/COLUMN_SPACING_PX = 11/);
    expect(matrixHelper).toMatch(/ROW_SPACING_PX = 19/);
    expect(matrixHelper).toMatch(/RAIN_FONT_SIZE_PX = 20/);
    expect(matrixHelper).toMatch(/RAIN_DENSITY = 4/);
    expect(matrixHelper).toMatch(/HEAD_COLOR = "#f6f6f4"/);
    expect(matrixHelper).toMatch(/LEAD_COLOR = "#c9cfb9"/);
    expect(matrixHelper).toMatch(/MID_COLOR = "#95a297"/);
    expect(matrixHelper).toMatch(/BODY_COLOR = "#2cb231"/);
    expect(matrix).toMatch(/document\.fonts\.load\(`\$\{RAIN_FONT_SIZE_PX\}px matrix_code`\)/);
    expect(matrixHelper).toMatch(/!randInt\(15\)/);
    expect(matrixHelper).toMatch(/rgba\(0, 0, 0, 0\.30\)/);
    expect(matrixHelper).toMatch(/rgba\(0, 0, 0, 0\.05\)/);
  });

  test("the static snapshot seeds sparse falling columns, not a full grid", () => {
    // The old static frame filled EVERY cell. The snapshot now builds the rain
    // columns and scatters their heads so it reads as a moment of falling rain.
    expect(matrixHelper).toMatch(
      /export function drawStaticMatrix\([\s\S]{1,400}createRainColumns\(numCols, numChars\)[\s\S]{1,300}col\.position = randInt\(numChars \+ 10\)[\s\S]{1,200}stepRain\(ctx, columns, numCols, numChars\)/,
    );
  });

  test("the config preview animates the real rain via the shared engine", () => {
    // Preview drives the same engine (not a re-rolled static grid) and gates on
    // visibility (IntersectionObserver + document visibility + reduced-motion).
    expect(matrixPreview).toMatch(
      /import \{[\s\S]{1,200}createRainColumns,[\s\S]{1,160}stepRain,[\s\S]{1,120}\} from "\.\/matrixRain"/,
    );
    expect(matrixPreview).toMatch(
      /setInterval\([\s\S]{1,200}stepRain\(ctx, columns, grid\.numCols, grid\.numChars\)[\s\S]{1,80}DRAW_INTERVAL_MS/,
    );
    expect(matrixPreview).toMatch(/new IntersectionObserver\(/);
    expect(matrixPreview).toMatch(/prefers-reduced-motion: reduce/);
    expect(matrixPreview).toMatch(/drawStaticMatrix\(ctx, grid\.numCols, grid\.numChars\)/);
  });
});
