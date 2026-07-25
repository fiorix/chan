// Shared draw primitives + the falling-column engine for the MatrixRain
// screensaver. Extracted so the fullscreen screensaver (MatrixRain.svelte) and
// the small config-panel preview (MatrixRainPreview.svelte) render the SAME
// rain from one source of truth and can never drift. The column state machine
// lives here, not inline in MatrixRain.svelte, so the preview animates the
// real rain instead of faking it with a static grid.
//
// High-fidelity Svelte adaptation of the MIT-licensed
// dcragusa/MatrixScreensaver project:
// https://github.com/dcragusa/MatrixScreensaver
// License notice: /static/matrix/LICENSE-MatrixScreensaver.txt

export const MATRIX_ALPHABET =
  "abcdefghijklmnopqrstuvwxyz123456789890~!#$%^&*()-_=+[]{};:'\",.<>/?\\|".split(
    "",
  );

export const COLUMN_SPACING_PX = 11;
export const ROW_SPACING_PX = 19;
export const RAIN_FONT_SIZE_PX = 20;
// Tick cadence (ms) for one rain frame. Shared so the preview falls at the
// same speed as the fullscreen screensaver.
export const DRAW_INTERVAL_MS = 40;
// Spreads out column start delays and respawn pauses. Higher = sparser starts.
export const RAIN_DENSITY = 4;

export const HEAD_COLOR = "#f6f6f4";
export const LEAD_COLOR = "#c9cfb9";
export const MID_COLOR = "#95a297";
export const BODY_COLOR = "#2cb231";

export function randInt(max: number): number {
  return Math.floor(Math.random() * max);
}

export function randomChar(): string {
  return MATRIX_ALPHABET[randInt(MATRIX_ALPHABET.length)] ?? "0";
}

function randomChars(count: number): string[] {
  const chars: string[] = [];
  for (let index = 0; index < count; index += 1) {
    chars.push(randomChar());
  }
  return chars;
}

// Grid dimensions derived from a canvas size. Both the screensaver and the
// preview size their canvas first, then ask for the column/row counts so the
// glyph grid lines up with the same spacing constants.
export function gridDimensions(width: number, height: number): {
  numCols: number;
  numChars: number;
} {
  return {
    numCols: Math.floor(width / COLUMN_SPACING_PX) + 1,
    numChars: Math.floor(height / ROW_SPACING_PX) + 1,
  };
}

// One falling column: its glyphs, a start/tick delay, a per-tick speed gate,
// and the row index of its bright head.
export type RainColumn = {
  chars: string[];
  delay: number;
  speed: number;
  position: number;
};

// Build one column per grid column with randomized start delays so they don't
// all fall in lockstep. Mirrors the original inline `newColumn` exactly
// (chars sized to numCols, delay scaled by numChars) so the look is unchanged.
export function createRainColumns(
  numCols: number,
  numChars: number,
): RainColumn[] {
  const columns: RainColumn[] = [];
  for (let index = 0; index < numCols; index += 1) {
    columns.push({
      chars: randomChars(numCols),
      delay: randInt(numChars * RAIN_DENSITY * 2),
      speed: !randInt(4) ? 1 : 0,
      position: 0,
    });
  }
  return columns;
}

function clearCell(
  ctx: CanvasRenderingContext2D,
  horpos: number,
  verpos: number,
): void {
  ctx.clearRect(horpos, verpos, COLUMN_SPACING_PX, ROW_SPACING_PX);
}

// Advance + paint one rain frame in place. This is an INCREMENTAL renderer: it
// clears and repaints only the cells that change each tick and relies on the
// canvas retaining the prior frame (it does NOT clear the whole canvas), so the
// caller must clear once before the first tick and never between ticks. Mutates
// each column's `position`/`delay`/`chars`. Identical logic to the original
// inline `drawScreen`; only the closure vars became parameters.
export function stepRain(
  ctx: CanvasRenderingContext2D,
  columns: RainColumn[],
  numCols: number,
  numChars: number,
): void {
  ctx.font = `${RAIN_FONT_SIZE_PX}px matrix_code`;

  for (let colIndex = 0; colIndex < columns.length; colIndex += 1) {
    const col = columns[colIndex]!;

    if (col.delay) {
      col.delay -= 1;
      continue;
    }

    for (let rowIndex = 0; rowIndex < col.chars.length; rowIndex += 1) {
      const char = col.chars[rowIndex] ?? randomChar();
      const horpos = colIndex * COLUMN_SPACING_PX;
      const verpos = rowIndex * ROW_SPACING_PX;
      const verout = verpos + ROW_SPACING_PX;

      if (rowIndex > col.position) {
        break;
      } else if (rowIndex === col.position) {
        clearCell(ctx, horpos, verpos);
        ctx.fillStyle = HEAD_COLOR;
        ctx.fillText(char, horpos, verout);
      } else if (rowIndex === col.position - 1) {
        clearCell(ctx, horpos, verpos);
        ctx.fillStyle = LEAD_COLOR;
        ctx.fillText(char, horpos, verout);
      } else if (rowIndex === col.position - 2) {
        clearCell(ctx, horpos, verpos);
        ctx.fillStyle = MID_COLOR;
        ctx.fillText(char, horpos, verout);
      } else if (rowIndex === col.position - 3) {
        clearCell(ctx, horpos, verpos);
        ctx.fillStyle = BODY_COLOR;
        ctx.fillText(char, horpos, verout);
      } else if (
        rowIndex < col.position - 3 &&
        rowIndex >= col.position - numChars + 10 &&
        !randInt(15)
      ) {
        const newChar = randomChar();
        clearCell(ctx, horpos, verpos);
        ctx.fillStyle = BODY_COLOR;
        ctx.fillText(newChar, horpos, verout);
      } else if (
        rowIndex < col.position - numChars + 10 &&
        rowIndex > col.position - numChars - 10
      ) {
        ctx.fillStyle = !randInt(5)
          ? "rgba(0, 0, 0, 0.30)"
          : "rgba(0, 0, 0, 0.05)";
        ctx.fillRect(horpos, verpos, COLUMN_SPACING_PX, ROW_SPACING_PX);
      } else if (rowIndex === col.position - numChars - 10) {
        clearCell(ctx, horpos, verpos);
      }
    }

    col.delay = col.speed;
    col.position += 1;

    if (col.position > numChars * 2 + 10) {
      col.chars = randomChars(numChars);
      col.position = 0;
      col.delay = randInt((numCols * RAIN_DENSITY) / 2);
    }
  }
}

// A single frozen frame of the rain, for the reduced-motion path (both the
// fullscreen screensaver and the preview fallback). Seeds columns at random
// fall depths so the still reads as a moment of falling rain (sparse heads +
// trails over black), NOT the dense full grid this used to draw. The caller
// owns the canvas; we clear the grid extent first.
export function drawStaticMatrix(
  ctx: CanvasRenderingContext2D,
  numCols: number,
  numChars: number,
): void {
  ctx.clearRect(0, 0, numCols * COLUMN_SPACING_PX, numChars * ROW_SPACING_PX);
  const columns = createRainColumns(numCols, numChars);
  // Drop the start delays and scatter the heads so every column paints a trail
  // at a different depth in this one frame instead of most sitting un-started.
  for (const col of columns) {
    col.delay = 0;
    col.position = randInt(numChars + 10);
  }
  stepRain(ctx, columns, numCols, numChars);
}
