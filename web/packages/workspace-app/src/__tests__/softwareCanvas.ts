// A software 2D context for tests that read pixels back from a canvas
// renderer, with the colour helpers that compare them. jsdom implements no
// canvas; rectangle fills and clears are modelled exactly, with the canvas
// transform applied and source-over compositing over straight alpha. Glyph
// and path rasterization are not modelled, so nothing built on this asserts
// anything about drawn text.

import { expect } from "vitest";

export type Rgba = { r: number; g: number; b: number; a: number };

/// The canvas source-over rule over straight alpha. The expected pixels come
/// from the rule rather than from the adapter, so a change to the adapter
/// cannot move the target it is measured against.
export function sourceOver(source: Rgba, destination: Rgba): Rgba {
  const alpha = source.a + destination.a * (1 - source.a);
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const channel = (from: number, onto: number): number =>
    (from * source.a + onto * destination.a * (1 - source.a)) / alpha;
  return {
    r: channel(source.r, destination.r),
    g: channel(source.g, destination.g),
    b: channel(source.b, destination.b),
    a: alpha,
  };
}

export function expectPixel(actual: Rgba, expected: Rgba): void {
  expect(actual.r).toBeCloseTo(expected.r, 6);
  expect(actual.g).toBeCloseTo(expected.g, 6);
  expect(actual.b).toBeCloseTo(expected.b, 6);
  expect(actual.a).toBeCloseTo(expected.a, 6);
}

/// A software 2D context. jsdom implements no canvas, and the question here is
/// a compositing one: the overlay bar is translucent, so what separates the
/// fix from the defect it replaces is the color left in the pixel, not the
/// sequence of calls that produced it. Rectangle fills and clears are modeled
/// exactly, with the canvas transform applied and source-over compositing over
/// straight alpha. Glyph and path rasterization are not modeled, so nothing
/// here asserts anything about drawn text.
export class SoftwareCanvasContext {
  fillStyle = "#000000";
  strokeStyle = "#000000";
  font = "";
  globalAlpha = 1;
  lineCap = "butt";
  lineJoin = "miter";
  lineWidth = 1;
  textAlign = "left";
  textBaseline = "alphabetic";

  #canvas: HTMLCanvasElement;
  #pixels = new Float64Array(0);
  #width = -1;
  #height = -1;
  #scaleX = 1;
  #scaleY = 1;
  #saved: {
    fillStyle: string;
    globalAlpha: number;
    scaleX: number;
    scaleY: number;
  }[] = [];

  readonly #cellWidth: number;

  /// `cellWidth` is what measureText reports per character, so a renderer
  /// measuring its font lands on the cell the test expects.
  constructor(canvas: HTMLCanvasElement, cellWidth = 8) {
    this.#canvas = canvas;
    this.#cellWidth = cellWidth;
  }

  scale(x: number, y: number): void {
    this.#resync();
    this.#scaleX *= x;
    this.#scaleY *= y;
  }

  save(): void {
    this.#resync();
    this.#saved.push({
      fillStyle: this.fillStyle,
      globalAlpha: this.globalAlpha,
      scaleX: this.#scaleX,
      scaleY: this.#scaleY,
    });
  }

  restore(): void {
    const state = this.#saved.pop();
    if (!state) return;
    this.fillStyle = state.fillStyle;
    this.globalAlpha = state.globalAlpha;
    this.#scaleX = state.scaleX;
    this.#scaleY = state.scaleY;
  }

  clearRect(x: number, y: number, width: number, height: number): void {
    this.#composite(x, y, width, height, null);
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    const source = parseCanvasColor(this.fillStyle);
    this.#composite(x, y, width, height, {
      ...source,
      a: source.a * this.globalAlpha,
    });
  }

  measureText(text: string): TextMetrics {
    return {
      width: text.length * this.#cellWidth,
      actualBoundingBoxAscent: 13,
      actualBoundingBoxDescent: 4,
    } as TextMetrics;
  }

  /// Read a pixel back in CSS coordinates, the space the renderer draws in.
  pixelAt(x: number, y: number): Rgba {
    this.#resync();
    const at =
      (Math.floor(y * this.#scaleY) * this.#width +
        Math.floor(x * this.#scaleX)) *
      4;
    return {
      r: this.#pixels[at],
      g: this.#pixels[at + 1],
      b: this.#pixels[at + 2],
      a: this.#pixels[at + 3],
    };
  }

  beginPath(): void {}
  clip(): void {}
  fillText(): void {}
  lineTo(): void {}
  moveTo(): void {}
  rect(): void {}
  stroke(): void {}
  strokeText(): void {}

  // Assigning canvas.width or canvas.height reallocates the backing store and
  // resets the context state, which is why the renderer can call ctx.scale
  // after every resize without compounding its transform.
  #resync(): void {
    if (
      this.#canvas.width === this.#width &&
      this.#canvas.height === this.#height
    ) {
      return;
    }
    this.#width = this.#canvas.width;
    this.#height = this.#canvas.height;
    this.#pixels = new Float64Array(this.#width * this.#height * 4);
    this.#scaleX = 1;
    this.#scaleY = 1;
    this.#saved = [];
  }

  #composite(
    x: number,
    y: number,
    width: number,
    height: number,
    source: Rgba | null,
  ): void {
    this.#resync();
    const left = Math.max(0, Math.round(x * this.#scaleX));
    const top = Math.max(0, Math.round(y * this.#scaleY));
    const right = Math.min(
      this.#width,
      Math.round((x + width) * this.#scaleX),
    );
    const bottom = Math.min(
      this.#height,
      Math.round((y + height) * this.#scaleY),
    );
    for (let row = top; row < bottom; row++) {
      for (let column = left; column < right; column++) {
        const at = (row * this.#width + column) * 4;
        const blended = source
          ? sourceOver(source, {
              r: this.#pixels[at],
              g: this.#pixels[at + 1],
              b: this.#pixels[at + 2],
              a: this.#pixels[at + 3],
            })
          : { r: 0, g: 0, b: 0, a: 0 };
        this.#pixels[at] = blended.r;
        this.#pixels[at + 1] = blended.g;
        this.#pixels[at + 2] = blended.b;
        this.#pixels[at + 3] = blended.a;
      }
    }
  }
}

function parseCanvasColor(style: string): Rgba {
  const functional = style.match(/^rgba?\(([^)]+)\)$/);
  if (functional) {
    const parts = functional[1].split(",").map((part) => Number(part.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
  }
  const hex = style.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const value = Number.parseInt(hex[1], 16);
    return {
      r: (value >> 16) & 255,
      g: (value >> 8) & 255,
      b: value & 255,
      a: 1,
    };
  }
  // Any other notation would silently model the wrong color, which is worse
  // here than a failure: these tests exist to compare colors.
  throw new Error(`unsupported canvas color: ${style}`);
}
