// A 2D context for tests that compare what two terminal renderers left on
// their canvases cell by cell. Each cell's picture is the list of calls that
// painted it since anything last covered it: a clear, or an opaque fill over
// the whole cell, replaces the picture, and every other call is added to the
// pictures of the cells it lands in. A canvas painted by a run of frames that
// each repaint only some rows then reads as the same pictures as one frame
// that repaints everything over the same terminal, unless a frame left a row
// unrepainted that had changed. Glyph rasterization is not modelled: a text
// belongs to the cell its origin is in and a path to the cell its middle is
// in, so ink a glyph spills into a neighbouring row is not part of either.

/// What a canvas showed, by row and column: each cell's calls, in order.
export type CellPictures = string[][][];

/// Whether a colour paints opaquely: hex, rgb(), or rgba() with alpha 1.
function opaque(style: string): boolean {
  const rgba = style.match(/^rgba\(([^)]+)\)$/);
  if (!rgba) return true;
  return Number(rgba[1].split(",")[3]) === 1;
}

export class CellPictureContext {
  fillStyle = "#000000";
  strokeStyle = "#000000";
  font = "";
  globalAlpha = 1;
  lineCap = "butt";
  lineJoin = "miter";
  lineWidth = 1;
  textAlign = "left";
  textBaseline = "alphabetic";

  readonly #canvas: HTMLCanvasElement;
  #cells: string[][][] = [];
  #width = -1;
  #height = -1;
  #path: number[][] = [];
  #saved: Pick<CellPictureContext, "fillStyle" | "strokeStyle" | "font" | "globalAlpha" | "lineWidth">[] = [];
  /// The grid the pictures are kept on, in the renderer's CSS pixels; set
  /// once the renderer has measured its font.
  cell = { width: 8, height: 16 };

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
  }

  /// The pictures of every cell of a `cols` by `rows` grid.
  pictures(cols: number, rows: number): CellPictures {
    this.#resync();
    return Array.from({ length: rows }, (_, row) =>
      Array.from({ length: cols }, (_, col) => [...(this.#cells[row]?.[col] ?? [])]),
    );
  }

  measureText(text: string): TextMetrics {
    return { width: 8 * text.length, actualBoundingBoxAscent: 11, actualBoundingBoxDescent: 3 } as TextMetrics;
  }

  scale(): void {
    this.#resync();
  }

  save(): void {
    const { fillStyle, strokeStyle, font, globalAlpha, lineWidth } = this;
    this.#saved.push({ fillStyle, strokeStyle, font, globalAlpha, lineWidth });
  }

  restore(): void {
    const state = this.#saved.pop();
    if (state) Object.assign(this, state);
  }

  clearRect(x: number, y: number, width: number, height: number): void {
    this.#cover(x, y, width, height, null);
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    const solid = this.globalAlpha === 1 && opaque(this.fillStyle);
    this.#cover(x, y, width, height, solid ? `fill ${this.fillStyle}` : null, `fill ${this.fillStyle} alpha ${this.globalAlpha}`);
  }

  fillText(text: string, x: number, y: number): void {
    const col = Math.floor(x / this.cell.width);
    const row = Math.floor(y / this.cell.height);
    const dx = x - col * this.cell.width;
    const dy = y - row * this.cell.height;
    this.#add(row, col, `text ${JSON.stringify(text)} ${this.font} ${this.fillStyle} alpha ${this.globalAlpha} at ${dx},${dy}`);
  }

  beginPath(): void {
    this.#path = [];
  }

  moveTo(x: number, y: number): void {
    this.#path.push([x, y]);
  }

  lineTo(x: number, y: number): void {
    this.#path.push([x, y]);
  }

  bezierCurveTo(...points: number[]): void {
    for (let i = 0; i + 1 < points.length; i += 2) this.#path.push([points[i], points[i + 1]]);
  }

  rect(): void {}

  clip(): void {}

  stroke(): void {
    if (this.#path.length === 0) return;
    const xs = this.#path.map(([x]) => x);
    const ys = this.#path.map(([, y]) => y);
    const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const col = Math.floor(midX / this.cell.width);
    const row = Math.floor(midY / this.cell.height);
    const ox = col * this.cell.width;
    const oy = row * this.cell.height;
    const points = this.#path.map(([x, y]) => `${x - ox},${y - oy}`).join(" ");
    this.#add(row, col, `stroke ${this.strokeStyle} width ${this.lineWidth} alpha ${this.globalAlpha} ${points}`);
  }

  /// A rectangle over the cells it lands in: `solid` replaces the picture of
  /// a cell it covers whole (null for a clear), and every cell it covers in
  /// part adds `partial` with the part it covers, or the clear's rectangle.
  #cover(x: number, y: number, width: number, height: number, solid: string | null, partial?: string): void {
    this.#resync();
    const { width: cw, height: ch } = this.cell;
    const firstCol = Math.max(0, Math.floor(x / cw));
    const firstRow = Math.max(0, Math.floor(y / ch));
    const lastCol = Math.ceil((x + width) / cw) - 1;
    const lastRow = Math.ceil((y + height) / ch) - 1;
    for (let row = firstRow; row <= lastRow; row++) {
      for (let col = firstCol; col <= lastCol; col++) {
        const left = Math.max(x, col * cw);
        const top = Math.max(y, row * ch);
        const right = Math.min(x + width, (col + 1) * cw);
        const bottom = Math.min(y + height, (row + 1) * ch);
        if (right <= left || bottom <= top) continue;
        const whole = left === col * cw && top === row * ch && right === (col + 1) * cw && bottom === (row + 1) * ch;
        const part = `${left - col * cw},${top - row * ch} ${right - left}x${bottom - top}`;
        if (partial === undefined) {
          // A clear: a whole cell starts over empty, part of one records it.
          if (whole) this.#set(row, col, []);
          else this.#add(row, col, `clear ${part}`);
        } else if (whole && solid !== null) {
          this.#set(row, col, [solid]);
        } else {
          this.#add(row, col, `${partial} ${part}`, solid !== null);
        }
      }
    }
  }

  #set(row: number, col: number, picture: string[]): void {
    (this.#cells[row] ??= [])[col] = picture;
  }

  /// Adds a call to a cell's picture. An opaque call the cell shows last
  /// already paints the same pixels again, so it is not added twice.
  #add(row: number, col: number, call: string, idempotent = false): void {
    const picture = ((this.#cells[row] ??= [])[col] ??= []);
    if (idempotent && picture[picture.length - 1] === call) return;
    picture.push(call);
  }

  // Assigning canvas.width or canvas.height reallocates the backing store and
  // resets the context state.
  #resync(): void {
    if (this.#canvas.width === this.#width && this.#canvas.height === this.#height) return;
    this.#width = this.#canvas.width;
    this.#height = this.#canvas.height;
    this.#cells = [];
    this.#saved = [];
  }
}
