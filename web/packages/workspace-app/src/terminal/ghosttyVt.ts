/// Ghostty's VT core from Ghostty's own release build, bound to the
/// `Ghostty` instance ghostty-web's `Terminal` takes as its `ghostty`
/// option.
///
/// WHY: ghostty-web ships a wasm it compiles from a patched Ghostty
/// snapshot with its own C entry points: render-state getters, a polled
/// reply buffer, and a stream handler that dispatches a hand-picked
/// subset of Ghostty's actions. Ghostty's release wasm exposes the
/// libghostty-vt C API instead, with Ghostty's full stream handler.
/// ghostty-web keeps its renderer, input handler and selection; this
/// module gives them the terminal and key encoder they call, method for
/// method, over upstream's parser and terminal state.
///
/// The ABI numbers and struct offsets below are read off the pinned
/// build's `ghostty_type_json()`; `ghosttyVt.test.ts` checks each one
/// against that JSON, so a re-pin that moves one fails there and not in
/// a user's terminal.

import type { Ghostty, GhosttyCell, GhosttyTerminal, KeyEncoder } from "ghostty-web";

/// Enum values of the pinned build, by upstream C type.
export const ABI = {
  GhosttyResult: { SUCCESS: 0, OUT_OF_SPACE: -3 },
  GhosttyTerminalOption: {
    WRITE_PTY: 1,
    DEVICE_ATTRIBUTES: 8,
    COLOR_FOREGROUND: 11,
    COLOR_BACKGROUND: 12,
    COLOR_CURSOR: 13,
    COLOR_PALETTE: 14,
    SCROLLBACK_MAX_BYTES: 27,
    SCROLLBACK_MAX_LINES: 28,
    MODE_DEFAULT: 33,
    MODE: 34,
  },
  GhosttyTerminalData: {
    CURSOR_X: 3,
    CURSOR_Y: 4,
    ACTIVE_SCREEN: 6,
    SCROLLBACK_ROWS: 15,
    COLOR_PALETTE_DEFAULT: 25,
    MODE: 37,
  },
  GhosttyTerminalScreen: { ALTERNATE: 1 },
  GhosttyPointTag: { ACTIVE: 0, HISTORY: 3 },
  GhosttyRenderStateData: { DIRTY: 3, ROW_ITERATOR: 4, CURSOR_VISIBLE: 11, COLORS: 19 },
  GhosttyRenderStateDirty: { FALSE: 0, PARTIAL: 1, FULL: 2 },
  GhosttyRenderStateRowData: { DIRTY: 1, CELLS: 3 },
  GhosttyRenderStateRowCellsData: {
    RAW: 1,
    STYLE: 2,
    GRAPHEMES_LEN: 3,
    GRAPHEMES_BUF: 4,
    BG_COLOR: 5,
    FG_COLOR: 6,
  },
  GhosttyRowData: { WRAP_CONTINUATION: 2 },
  GhosttyStyleColorTag: { NONE: 0, PALETTE: 1, RGB: 2 },
  GhosttyCellContentTag: {
    CODEPOINT: 0,
    CODEPOINT_GRAPHEME: 1,
    BG_COLOR_PALETTE: 2,
    BG_COLOR_RGB: 3,
  },
  GhosttyCellWide: { NARROW: 0, WIDE: 1, SPACER_TAIL: 2, SPACER_HEAD: 3 },
} as const;

/// Struct sizes and field offsets of the pinned build, by upstream C type.
export const LAYOUT = {
  GhosttyStyle: {
    size: 72,
    fields: {
      size: 0,
      fg_color: 8,
      bg_color: 24,
      bold: 56,
      italic: 57,
      faint: 58,
      blink: 59,
      inverse: 60,
      invisible: 61,
      strikethrough: 62,
      underline: 64,
    },
  },
  GhosttyStyleColor: { size: 16, fields: { tag: 0, value: 8 } },
  GhosttyRenderStateColors: {
    size: 784,
    fields: { size: 0, background: 4, foreground: 7, palette: 14 },
  },
  GhosttyPoint: { size: 24, fields: { tag: 0, value: 8 } },
  GhosttyPointCoordinate: { size: 8, fields: { x: 0, y: 4 } },
  GhosttyGridRef: { size: 12, fields: { size: 0 } },
  GhosttyTerminalModeConfig: { size: 4, fields: { mode: 0, value: 2 } },
  GhosttyDeviceAttributes: { size: 148, fields: { primary: 0, secondary: 136 } },
  GhosttyDeviceAttributesPrimary: {
    size: 136,
    fields: { conformance_level: 0, features: 2, num_features: 132 },
  },
  GhosttyDeviceAttributesSecondary: {
    size: 6,
    fields: { device_type: 0, firmware_version: 2, rom_cartridge: 4 },
  },
} as const;

/// Bit ranges `[lsb, width]` of the packed 64-bit `GhosttyCell`.
export const CELL_BITS = {
  content_tag: [0, 2],
  content: [2, 24],
  style_id: [26, 16],
  wide: [42, 2],
  hyperlink: [45, 1],
} as const;

/// First ghostty-web `Key` value that upstream numbers one higher.
/// Upstream inserted `FN` at this value; every key before it keeps its
/// number (some under new names, such as `BACKQUOTE` for `GRAVE`).
export const KEY_SHIFT_FROM = 146;

export function upstreamKey(key: number): number {
  return key >= KEY_SHIFT_FROM ? key + 1 : key;
}

/// ghostty-web's `CellFlags` bits, the shape its renderer reads.
const FLAG = {
  BOLD: 1 << 0,
  ITALIC: 1 << 1,
  UNDERLINE: 1 << 2,
  STRIKETHROUGH: 1 << 3,
  INVERSE: 1 << 4,
  INVISIBLE: 1 << 5,
  BLINK: 1 << 6,
  FAINT: 1 << 7,
} as const;

/// The device attributes ghostty-web's build reports, kept so programs
/// that probe them see the same terminal: DA1 `CSI ? 62 ; 22 c` (a
/// VT220 with ANSI color) and DA2 `CSI > 1 ; 10 ; 0 c`.
const DA1_CONFORMANCE = 62;
const DA1_FEATURES = [22];
const DA2 = { device_type: 1, firmware_version: 10, rom_cartridge: 0 };

/// ghostty-web's build defaults, used when its config names no color.
const DEFAULT_FG = 0xcccccc;
const DEFAULT_BG = 0x000000;

/// DEC private mode 2027, grapheme clustering. ghostty-web's build turns
/// it on for every terminal so multi-codepoint clusters take one cell.
const MODE_GRAPHEME_CLUSTER = 2027;

/// Packs a mode as upstream's `GhosttyMode`: the number in bits 0-14,
/// bit 15 set for an ANSI mode.
function packMode(mode: number, ansi: boolean): number {
  return (mode & 0x7fff) | (ansi ? 0x8000 : 0);
}

type Fn = (...args: number[]) => number;

const FUNCTIONS = [
  "ghostty_wasm_alloc",
  "ghostty_wasm_free",
  "ghostty_wasm_alloc_opaque",
  "ghostty_wasm_free_opaque",
  "ghostty_wasm_take_opaque",
  "ghostty_terminal_new",
  "ghostty_terminal_free",
  "ghostty_terminal_set",
  "ghostty_terminal_get",
  "ghostty_terminal_resize",
  "ghostty_terminal_vt_write",
  "ghostty_terminal_grid_ref",
  "ghostty_grid_ref_cell",
  "ghostty_grid_ref_row",
  "ghostty_grid_ref_style",
  "ghostty_grid_ref_graphemes",
  "ghostty_grid_ref_hyperlink_uri",
  "ghostty_render_state_new",
  "ghostty_render_state_free",
  "ghostty_render_state_update",
  "ghostty_render_state_clean",
  "ghostty_render_state_get",
  "ghostty_render_state_row_iterator_new",
  "ghostty_render_state_row_iterator_free",
  "ghostty_render_state_row_iterator_next",
  "ghostty_render_state_row_get",
  "ghostty_render_state_row_cells_new",
  "ghostty_render_state_row_cells_free",
  "ghostty_render_state_row_cells_next",
  "ghostty_render_state_row_cells_get",
  "ghostty_key_encoder_new",
  "ghostty_key_encoder_free",
  "ghostty_key_encoder_setopt",
  "ghostty_key_encoder_encode",
  "ghostty_key_event_new",
  "ghostty_key_event_free",
  "ghostty_key_event_set_action",
  "ghostty_key_event_set_key",
  "ghostty_key_event_set_mods",
  "ghostty_key_event_set_utf8",
] as const;

type Fns = Record<(typeof FUNCTIONS)[number], Fn> & {
  /// Takes the 64-bit row by value, which JS passes as a BigInt.
  ghostty_row_get: (row: bigint, data: number, out: number) => number;
};

/// One wasm instance: its exports, typed views over its memory that
/// follow growth, and the host callbacks every terminal on it shares.
class VtWasm {
  readonly fn: Fns;
  readonly memory: WebAssembly.Memory;
  private readonly table: WebAssembly.Table;
  private buffer: ArrayBuffer | null = null;
  private u8 = new Uint8Array(0);
  private dv = new DataView(new ArrayBuffer(0));

  constructor(instance: WebAssembly.Instance) {
    const exports = instance.exports;
    const fn = {} as Record<string, unknown>;
    for (const name of [...FUNCTIONS, "ghostty_row_get"]) {
      const f = exports[name];
      if (typeof f !== "function") throw new Error(`ghostty-vt: missing export ${name}`);
      fn[name] = f;
    }
    this.fn = fn as Fns;
    this.memory = exports.memory as WebAssembly.Memory;
    this.table = exports.__indirect_function_table as WebAssembly.Table;
  }

  /// Views over the live memory. Any export that allocates can grow it
  /// and detach the previous buffer, so callers reacquire after calls.
  bytes(): Uint8Array {
    this.refresh();
    return this.u8;
  }

  view(): DataView {
    this.refresh();
    return this.dv;
  }

  private refresh(): void {
    const buffer = this.memory.buffer;
    if (buffer !== this.buffer) {
      this.buffer = buffer;
      this.u8 = new Uint8Array(buffer);
      this.dv = new DataView(buffer);
    }
  }

  alloc(len: number): number {
    const ptr = this.fn.ghostty_wasm_alloc(len);
    if (!ptr) throw new Error("ghostty-vt: out of memory");
    return ptr;
  }

  free(ptr: number, len: number): void {
    if (ptr) this.fn.ghostty_wasm_free(ptr, len);
  }

  /// Creates an opaque handle through a constructor that writes it to an
  /// out slot, as every `ghostty_*_new` does.
  newHandle(construct: (slot: number) => number, what: string): number {
    const slot = this.fn.ghostty_wasm_alloc_opaque();
    if (!slot) throw new Error("ghostty-vt: out of memory");
    try {
      const result = construct(slot);
      if (result !== ABI.GhosttyResult.SUCCESS) {
        throw new Error(`ghostty-vt: creating ${what} failed (${result})`);
      }
      return this.fn.ghostty_wasm_take_opaque(slot);
    } finally {
      this.fn.ghostty_wasm_free_opaque(slot);
    }
  }

  /// Puts a JS function in the module's function table, so its index can
  /// be handed to C as a callback pointer. A table only takes functions
  /// that came out of a wasm module, so a one-function module imports
  /// `f` and exports it back (all parameters i32, the wasm32 C ABI for
  /// pointers, sizes and handles).
  addFunction(f: (...args: number[]) => number | void, params: number, returns: boolean): number {
    const type = [0x60, params, ...Array<number>(params).fill(0x7f), ...(returns ? [1, 0x7f] : [0])];
    const bytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      // type section: one function type
      0x01, type.length + 1, 0x01, ...type,
      // import section: e.f, a function of type 0
      0x02, 0x07, 0x01, 0x01, 0x65, 0x01, 0x66, 0x00, 0x00,
      // export section: f, function 0
      0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00,
    ]);
    const module = new WebAssembly.Module(bytes);
    const wrapped = new WebAssembly.Instance(module, { e: { f } }).exports.f;
    const index = this.table.grow(1);
    this.table.set(index, wrapped);
    return index;
  }
}

/// The subset of ghostty-web's terminal config this binding honors; zero
/// means "keep the default", as in ghostty-web's own binding.
export type VtTerminalConfig = {
  scrollbackLimit?: number;
  fgColor?: number;
  bgColor?: number;
  cursorColor?: number;
  palette?: number[];
};

/// The `Ghostty` object ghostty-web's `Terminal` takes as `ghostty`.
export class GhosttyVt {
  private readonly wasm: VtWasm;
  private readonly terminals = new Map<number, VtTerminal>();
  readonly writePtyCallback: number;
  readonly deviceAttributesCallback: number;

  constructor(instance: WebAssembly.Instance) {
    this.wasm = new VtWasm(instance);
    this.writePtyCallback = this.wasm.addFunction(
      (terminal, _userdata, data, len) => {
        this.terminals.get(terminal >>> 0)?.queueReply(data >>> 0, len >>> 0);
      },
      4,
      false,
    );
    this.deviceAttributesCallback = this.wasm.addFunction(
      (_terminal, _userdata, out) => {
        writeDeviceAttributes(this.wasm, out >>> 0);
        return 1;
      },
      3,
      true,
    );
  }

  createKeyEncoder(): KeyEncoder {
    return new VtKeyEncoder(this.wasm) as unknown as KeyEncoder;
  }

  createTerminal(cols = 80, rows = 24, config?: VtTerminalConfig): GhosttyTerminal {
    const terminal = new VtTerminal(this.wasm, this, cols, rows, config);
    return terminal as unknown as GhosttyTerminal;
  }

  /// The binding as the type ghostty-web's `Terminal` option names. Its
  /// class has private fields, so no other object can be assignable to it.
  asGhostty(): Ghostty {
    return this as unknown as Ghostty;
  }

  register(handle: number, terminal: VtTerminal): void {
    this.terminals.set(handle, terminal);
  }

  unregister(handle: number): void {
    this.terminals.delete(handle);
  }
}

function writeDeviceAttributes(wasm: VtWasm, out: number): void {
  const L = LAYOUT;
  // Unset fields, the tertiary unit id among them, report as zero.
  wasm.bytes().fill(0, out, out + L.GhosttyDeviceAttributes.size);
  const view = wasm.view();
  const primary = out + L.GhosttyDeviceAttributes.fields.primary;
  view.setUint16(primary + L.GhosttyDeviceAttributesPrimary.fields.conformance_level, DA1_CONFORMANCE, true);
  DA1_FEATURES.forEach((feature, i) => {
    view.setUint16(primary + L.GhosttyDeviceAttributesPrimary.fields.features + i * 2, feature, true);
  });
  view.setUint32(primary + L.GhosttyDeviceAttributesPrimary.fields.num_features, DA1_FEATURES.length, true);
  const secondary = out + L.GhosttyDeviceAttributes.fields.secondary;
  const S = L.GhosttyDeviceAttributesSecondary.fields;
  view.setUint16(secondary + S.device_type, DA2.device_type, true);
  view.setUint16(secondary + S.firmware_version, DA2.firmware_version, true);
  view.setUint16(secondary + S.rom_cartridge, DA2.rom_cartridge, true);
}

type Rgb = { r: number; g: number; b: number };

function blankCell(fg: Rgb, bg: Rgb): GhosttyCell {
  return {
    codepoint: 0,
    fg_r: fg.r,
    fg_g: fg.g,
    fg_b: fg.b,
    bg_r: bg.r,
    bg_g: bg.g,
    bg_b: bg.b,
    flags: 0,
    width: 1,
    hyperlink_id: 0,
    grapheme_len: 0,
  };
}

/// A raw `GhosttyCell` split into the fields this binding reads.
type RawCell = {
  tag: number;
  content: number;
  styleId: number;
  wide: number;
  hyperlink: boolean;
};

function bits(lo: number, hi: number, [lsb, width]: readonly [number, number]): number {
  // Every field read here sits inside bits 0-47, so a JS number (exact to
  // 2^53) holds the whole value.
  const value = hi * 2 ** 32 + (lo >>> 0);
  return Math.floor(value / 2 ** lsb) % 2 ** width;
}

function decodeCell(view: DataView, ptr: number): RawCell {
  const lo = view.getUint32(ptr, true);
  const hi = view.getUint32(ptr + 4, true);
  return {
    tag: bits(lo, hi, CELL_BITS.content_tag),
    content: bits(lo, hi, CELL_BITS.content),
    styleId: bits(lo, hi, CELL_BITS.style_id),
    wide: bits(lo, hi, CELL_BITS.wide),
    hyperlink: bits(lo, hi, CELL_BITS.hyperlink) === 1,
  };
}

function cellWidth(wide: number): number {
  const W = ABI.GhosttyCellWide;
  return wide === W.WIDE ? 2 : wide === W.SPACER_TAIL || wide === W.SPACER_HEAD ? 0 : 1;
}

function codepointOf(raw: RawCell): number {
  const T = ABI.GhosttyCellContentTag;
  return raw.tag === T.CODEPOINT || raw.tag === T.CODEPOINT_GRAPHEME ? raw.content & 0x1fffff : 0;
}

/// ghostty-web's `CellFlags` from an upstream `GhosttyStyle` at `ptr`.
function styleFlags(view: DataView, ptr: number): number {
  const F = LAYOUT.GhosttyStyle.fields;
  let flags = 0;
  if (view.getUint8(ptr + F.bold)) flags |= FLAG.BOLD;
  if (view.getUint8(ptr + F.italic)) flags |= FLAG.ITALIC;
  if (view.getInt32(ptr + F.underline, true) !== 0) flags |= FLAG.UNDERLINE;
  if (view.getUint8(ptr + F.strikethrough)) flags |= FLAG.STRIKETHROUGH;
  if (view.getUint8(ptr + F.inverse)) flags |= FLAG.INVERSE;
  if (view.getUint8(ptr + F.invisible)) flags |= FLAG.INVISIBLE;
  if (view.getUint8(ptr + F.blink)) flags |= FLAG.BLINK;
  if (view.getUint8(ptr + F.faint)) flags |= FLAG.FAINT;
  return flags;
}

function readRgb(view: DataView, ptr: number): Rgb {
  return { r: view.getUint8(ptr), g: view.getUint8(ptr + 1), b: view.getUint8(ptr + 2) };
}

/// Byte size of the scratch area each terminal keeps for out parameters.
const SCRATCH = {
  slot: 0, // u32 handle or size_t out value
  slot2: 8, // second u32 out value
  raw: 16, // GhosttyCell / GhosttyRow (u64)
  rgb: 24, // GhosttyColorRgb
  mode: 28, // GhosttyTerminalModeConfig
  point: 32, // GhosttyPoint (24 bytes, 8-aligned)
  gridRef: 56, // GhosttyGridRef (12 bytes)
  style: 72, // GhosttyStyle (72 bytes, 8-aligned)
  colors: 144, // GhosttyRenderStateColors (784 bytes)
  graphemes: 928, // u32[GRAPHEME_CAP]
  size: 928 + 32 * 4,
} as const;
const GRAPHEME_CAP = 32;

/// ghostty-web's `GhosttyTerminal`, over an upstream terminal and render
/// state. ghostty-web scrolls in JS (it reads history rows itself), so
/// upstream's viewport never moves and its render state is the active
/// screen.
export class VtTerminal {
  private readonly wasm: VtWasm;
  private readonly owner: GhosttyVt;
  private handle: number;
  private renderState: number;
  private rowIterator: number;
  private rowCells: number;
  private readonly scratch: number;
  private writeBuf = 0;
  private writeCap = 0;
  private _cols: number;
  private _rows: number;

  /// Rows of the active screen as ghostty-web cells, refreshed from the
  /// render state for the rows it reports dirty.
  private rowCache: GhosttyCell[][] = [];
  /// Full grapheme text by column, for rows that hold clusters.
  private graphemeCache: Map<number, string>[] = [];
  /// Dirty state accumulated since ghostty-web last cleaned it.
  private dirty = 0;
  private rowDirty = new Uint8Array(0);
  /// Writes or a resize since the render state was last read.
  private stale = true;
  private forceFull = true;
  private lastScreenAlternate = false;
  private fg: Rgb = { r: 204, g: 204, b: 204 };
  private bg: Rgb = { r: 0, g: 0, b: 0 };
  private palette = new Uint8Array(768);
  private replies: Uint8Array[] = [];

  constructor(wasm: VtWasm, owner: GhosttyVt, cols: number, rows: number, config?: VtTerminalConfig) {
    this.wasm = wasm;
    this.owner = owner;
    this._cols = cols;
    this._rows = rows;
    const fn = wasm.fn;
    this.scratch = wasm.alloc(SCRATCH.size);
    this.handle = wasm.newHandle((slot) => fn.ghostty_terminal_new(0, slot, cols, rows), "terminal");
    owner.register(this.handle, this);
    this.renderState = wasm.newHandle((slot) => fn.ghostty_render_state_new(0, slot), "render state");
    this.rowIterator = wasm.newHandle((slot) => fn.ghostty_render_state_row_iterator_new(0, slot), "row iterator");
    this.rowCells = wasm.newHandle((slot) => fn.ghostty_render_state_row_cells_new(0, slot), "row cells");

    fn.ghostty_terminal_set(this.handle, ABI.GhosttyTerminalOption.WRITE_PTY, owner.writePtyCallback);
    fn.ghostty_terminal_set(this.handle, ABI.GhosttyTerminalOption.DEVICE_ATTRIBUTES, owner.deviceAttributesCallback);
    this.setMode(MODE_GRAPHEME_CLUSTER, false, true);
    this.applyConfig(config);
    this.resetCache();
  }

  get cols(): number {
    return this._cols;
  }

  get rows(): number {
    return this._rows;
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  write(data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (bytes.length === 0) return;
    if (bytes.length > this.writeCap) {
      this.wasm.free(this.writeBuf, this.writeCap);
      this.writeCap = Math.max(bytes.length, 4096);
      this.writeBuf = this.wasm.alloc(this.writeCap);
    }
    this.wasm.bytes().set(bytes, this.writeBuf);
    this.stale = true;
    this.wasm.fn.ghostty_terminal_vt_write(this.handle, this.writeBuf, bytes.length);
  }

  resize(cols: number, rows: number): void {
    if (cols === this._cols && rows === this._rows) return;
    this._cols = cols;
    this._rows = rows;
    this.wasm.fn.ghostty_terminal_resize(this.handle, cols, rows, 0, 0);
    this.resetCache();
  }

  free(): void {
    const fn = this.wasm.fn;
    this.owner.unregister(this.handle);
    fn.ghostty_render_state_row_cells_free(this.rowCells);
    fn.ghostty_render_state_row_iterator_free(this.rowIterator);
    fn.ghostty_render_state_free(this.renderState);
    fn.ghostty_terminal_free(this.handle);
    this.wasm.free(this.writeBuf, this.writeCap);
    this.wasm.free(this.scratch, SCRATCH.size);
    this.handle = this.renderState = this.rowIterator = this.rowCells = 0;
    this.writeBuf = this.writeCap = 0;
  }

  // ------------------------------------------------------------------
  // Render state
  // ------------------------------------------------------------------

  /// Brings the cached rows up to date and returns the dirty state
  /// accumulated since the last `markClean`. Cheap to call repeatedly:
  /// without a write or resize in between it reads nothing.
  update(): number {
    this.sync();
    return this.dirty;
  }

  getCursor(): {
    x: number;
    y: number;
    viewportX: number;
    viewportY: number;
    visible: boolean;
    blinking: boolean;
    style: "block";
  } {
    this.sync();
    const fn = this.wasm.fn;
    const s = this.scratch;
    fn.ghostty_terminal_get(this.handle, ABI.GhosttyTerminalData.CURSOR_X, s + SCRATCH.slot);
    fn.ghostty_terminal_get(this.handle, ABI.GhosttyTerminalData.CURSOR_Y, s + SCRATCH.slot2);
    fn.ghostty_render_state_get(this.renderState, ABI.GhosttyRenderStateData.CURSOR_VISIBLE, s + SCRATCH.rgb);
    const view = this.wasm.view();
    const x = view.getUint16(s + SCRATCH.slot, true);
    const y = view.getUint16(s + SCRATCH.slot2, true);
    // Blinking and shape stay ghostty-web's own options, as with its
    // binding, so the renderer draws the cursor it is configured for.
    return { x, y, viewportX: x, viewportY: y, visible: view.getUint8(s + SCRATCH.rgb) !== 0, blinking: false, style: "block" };
  }

  getColors(): { background: Rgb; foreground: Rgb; cursor: null } {
    this.sync();
    return { background: { ...this.bg }, foreground: { ...this.fg }, cursor: null };
  }

  isRowDirty(y: number): boolean {
    return this.dirty === ABI.GhosttyRenderStateDirty.FULL || this.rowDirty[y] === 1;
  }

  markClean(): void {
    this.dirty = ABI.GhosttyRenderStateDirty.FALSE;
    this.rowDirty.fill(0);
  }

  clearDirty(): void {
    this.markClean();
  }

  isDirty(): boolean {
    return this.update() !== ABI.GhosttyRenderStateDirty.FALSE;
  }

  needsFullRedraw(): boolean {
    return this.update() === ABI.GhosttyRenderStateDirty.FULL;
  }

  /// Every active-screen cell, row-major. ghostty-web's renderer reads
  /// rows through `getLine`; this flat form is its binding's older API.
  getViewport(): GhosttyCell[] {
    this.sync();
    return this.rowCache.flat();
  }

  /// A copy of row `y`, so a caller that keeps it is not handed cells the
  /// next update rewrites.
  getLine(y: number): GhosttyCell[] | null {
    if (y < 0 || y >= this._rows) return null;
    this.sync();
    return this.rowCache[y].map((cell) => ({ ...cell }));
  }

  getGraphemeString(row: number, col: number): string {
    this.sync();
    const cached = this.graphemeCache[row]?.get(col);
    if (cached !== undefined) return cached;
    const cell = this.rowCache[row]?.[col];
    return cell && cell.codepoint ? String.fromCodePoint(cell.codepoint) : " ";
  }

  // ------------------------------------------------------------------
  // Modes and screens
  // ------------------------------------------------------------------

  getDimensions(): { cols: number; rows: number } {
    return { cols: this._cols, rows: this._rows };
  }

  getMode(mode: number, isAnsi = false): boolean {
    const ptr = this.scratch + SCRATCH.mode;
    const F = LAYOUT.GhosttyTerminalModeConfig.fields;
    const view = this.wasm.view();
    view.setUint16(ptr + F.mode, packMode(mode, isAnsi), true);
    view.setUint8(ptr + F.value, 0);
    const result = this.wasm.fn.ghostty_terminal_get(this.handle, ABI.GhosttyTerminalData.MODE, ptr);
    return result === ABI.GhosttyResult.SUCCESS && this.wasm.view().getUint8(ptr + F.value) !== 0;
  }

  isAlternateScreen(): boolean {
    const ptr = this.scratch + SCRATCH.slot;
    this.wasm.fn.ghostty_terminal_get(this.handle, ABI.GhosttyTerminalData.ACTIVE_SCREEN, ptr);
    return this.wasm.view().getInt32(ptr, true) === ABI.GhosttyTerminalScreen.ALTERNATE;
  }

  hasBracketedPaste(): boolean {
    return this.getMode(2004);
  }

  hasFocusEvents(): boolean {
    return this.getMode(1004);
  }

  /// Normal, button and any-event tracking, as ghostty-web's binding
  /// counts them; X10 (mode 9) reports presses only and is left out.
  hasMouseTracking(): boolean {
    return this.getMode(1000) || this.getMode(1002) || this.getMode(1003);
  }

  // ------------------------------------------------------------------
  // Scrollback and grid lookups
  // ------------------------------------------------------------------

  getScrollbackLength(): number {
    const ptr = this.scratch + SCRATCH.slot;
    this.wasm.fn.ghostty_terminal_get(this.handle, ABI.GhosttyTerminalData.SCROLLBACK_ROWS, ptr);
    return this.wasm.view().getUint32(ptr, true);
  }

  /// History row `offset`, 0 the oldest.
  getScrollbackLine(offset: number): GhosttyCell[] | null {
    if (offset < 0 || offset >= this.getScrollbackLength()) return null;
    this.sync();
    const cells: GhosttyCell[] = [];
    for (let x = 0; x < this._cols; x++) {
      cells.push(this.gridCell(ABI.GhosttyPointTag.HISTORY, x, offset));
    }
    return cells;
  }

  /// Whether row `row` continues the row above it, the meaning xterm's
  /// `isWrapped` has and ghostty-web's buffer API passes on.
  isRowWrapped(row: number): boolean {
    if (!this.gridRef(ABI.GhosttyPointTag.ACTIVE, 0, row)) return false;
    const fn = this.wasm.fn;
    const s = this.scratch;
    if (fn.ghostty_grid_ref_row(s + SCRATCH.gridRef, s + SCRATCH.raw) !== ABI.GhosttyResult.SUCCESS) return false;
    const raw = this.wasm.view().getBigUint64(s + SCRATCH.raw, true);
    if (fn.ghostty_row_get(raw, ABI.GhosttyRowData.WRAP_CONTINUATION, s + SCRATCH.slot) !== ABI.GhosttyResult.SUCCESS) return false;
    return this.wasm.view().getUint8(s + SCRATCH.slot) !== 0;
  }

  getHyperlinkUri(row: number, col: number): string | null {
    return this.hyperlinkAt(ABI.GhosttyPointTag.ACTIVE, col, row);
  }

  getScrollbackHyperlinkUri(offset: number, col: number): string | null {
    return this.hyperlinkAt(ABI.GhosttyPointTag.HISTORY, col, offset);
  }

  getScrollbackGraphemeString(offset: number, col: number): string {
    if (!this.gridRef(ABI.GhosttyPointTag.HISTORY, col, offset)) return " ";
    return this.gridGraphemes() ?? " ";
  }

  // ------------------------------------------------------------------
  // Replies to the program (DSR, DA, mode reports, ...)
  // ------------------------------------------------------------------

  queueReply(ptr: number, len: number): void {
    this.replies.push(this.wasm.bytes().slice(ptr, ptr + len));
  }

  hasResponse(): boolean {
    return this.replies.length > 0;
  }

  /// Everything upstream asked to write back since the last read, as one
  /// string, or null when nothing is pending.
  readResponse(): string | null {
    if (this.replies.length === 0) return null;
    const total = this.replies.reduce((n, r) => n + r.length, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const reply of this.replies) {
      joined.set(reply, at);
      at += reply.length;
    }
    this.replies = [];
    return new TextDecoder().decode(joined);
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private applyConfig(config?: VtTerminalConfig): void {
    const fn = this.wasm.fn;
    const s = this.scratch;
    const O = ABI.GhosttyTerminalOption;
    // ghostty-web counts scrollback in lines, zero meaning unlimited.
    // Upstream also caps history in bytes, by default at one page (about
    // 1,100 lines at 80 columns), and the first cap reached wins; the byte
    // cap is lifted so the line count the user's setting maps to holds.
    fn.ghostty_terminal_set(this.handle, O.SCROLLBACK_MAX_BYTES, 0);
    const lines = config?.scrollbackLimit ?? 10_000;
    if (lines > 0) {
      this.wasm.view().setUint32(s + SCRATCH.slot, lines, true);
      fn.ghostty_terminal_set(this.handle, O.SCROLLBACK_MAX_LINES, s + SCRATCH.slot);
    } else {
      fn.ghostty_terminal_set(this.handle, O.SCROLLBACK_MAX_LINES, 0);
    }
    const setColor = (option: number, rgb: number) => {
      const view = this.wasm.view();
      view.setUint8(s + SCRATCH.rgb, (rgb >> 16) & 0xff);
      view.setUint8(s + SCRATCH.rgb + 1, (rgb >> 8) & 0xff);
      view.setUint8(s + SCRATCH.rgb + 2, rgb & 0xff);
      fn.ghostty_terminal_set(this.handle, option, s + SCRATCH.rgb);
    };
    setColor(O.COLOR_FOREGROUND, config?.fgColor || DEFAULT_FG);
    setColor(O.COLOR_BACKGROUND, config?.bgColor || DEFAULT_BG);
    if (config?.cursorColor) setColor(O.COLOR_CURSOR, config.cursorColor);
    const overrides = config?.palette ?? [];
    if (overrides.some((c) => c)) {
      const palette = this.wasm.alloc(768);
      try {
        fn.ghostty_terminal_get(this.handle, ABI.GhosttyTerminalData.COLOR_PALETTE_DEFAULT, palette);
        const bytes = this.wasm.bytes();
        overrides.slice(0, 16).forEach((rgb, i) => {
          if (!rgb) return;
          bytes[palette + i * 3] = (rgb >> 16) & 0xff;
          bytes[palette + i * 3 + 1] = (rgb >> 8) & 0xff;
          bytes[palette + i * 3 + 2] = rgb & 0xff;
        });
        fn.ghostty_terminal_set(this.handle, O.COLOR_PALETTE, palette);
      } finally {
        this.wasm.free(palette, 768);
      }
    }
  }

  private setMode(mode: number, ansi: boolean, value: boolean): void {
    const ptr = this.scratch + SCRATCH.mode;
    const F = LAYOUT.GhosttyTerminalModeConfig.fields;
    const view = this.wasm.view();
    view.setUint16(ptr + F.mode, packMode(mode, ansi), true);
    view.setUint8(ptr + F.value, value ? 1 : 0);
    // The reset default keeps it across a full reset (RIS); the mode
    // itself applies it now.
    this.wasm.fn.ghostty_terminal_set(this.handle, ABI.GhosttyTerminalOption.MODE_DEFAULT, ptr);
    this.wasm.fn.ghostty_terminal_set(this.handle, ABI.GhosttyTerminalOption.MODE, ptr);
  }

  private resetCache(): void {
    this.rowCache = Array.from({ length: this._rows }, () =>
      Array.from({ length: this._cols }, () => blankCell(this.fg, this.bg)),
    );
    this.graphemeCache = Array.from({ length: this._rows }, () => new Map());
    this.rowDirty = new Uint8Array(this._rows);
    this.stale = true;
    this.forceFull = true;
  }

  /// Reads the render state into the row cache when a write or resize
  /// changed the terminal since the last read.
  private sync(): void {
    if (!this.stale) return;
    this.stale = false;
    const fn = this.wasm.fn;
    const s = this.scratch;
    const D = ABI.GhosttyRenderStateDirty;
    fn.ghostty_render_state_update(this.renderState, this.handle);

    fn.ghostty_render_state_get(this.renderState, ABI.GhosttyRenderStateData.DIRTY, s + SCRATCH.slot);
    let dirty = this.wasm.view().getInt32(s + SCRATCH.slot, true);
    // A switch between the primary and alternate screen redraws
    // everything, as ghostty-web's binding reports it.
    const alternate = this.isAlternateScreen();
    if (alternate !== this.lastScreenAlternate || this.forceFull) dirty = D.FULL;
    this.lastScreenAlternate = alternate;
    this.forceFull = false;

    this.readColors();
    if (dirty !== D.FALSE) this.readRows(dirty === D.FULL);
    fn.ghostty_render_state_clean(this.renderState);
    if (dirty > this.dirty) this.dirty = dirty;
  }

  private readColors(): void {
    const s = this.scratch;
    const C = LAYOUT.GhosttyRenderStateColors;
    const ptr = s + SCRATCH.colors;
    this.wasm.view().setUint32(ptr + C.fields.size, C.size, true);
    this.wasm.fn.ghostty_render_state_get(this.renderState, ABI.GhosttyRenderStateData.COLORS, ptr);
    const view = this.wasm.view();
    this.bg = readRgb(view, ptr + C.fields.background);
    this.fg = readRgb(view, ptr + C.fields.foreground);
    this.palette = this.wasm.bytes().slice(ptr + C.fields.palette, ptr + C.fields.palette + 768);
  }

  private readRows(full: boolean): void {
    const fn = this.wasm.fn;
    const s = this.scratch;
    const view = () => this.wasm.view();
    view().setUint32(s + SCRATCH.slot, this.rowIterator, true);
    fn.ghostty_render_state_get(this.renderState, ABI.GhosttyRenderStateData.ROW_ITERATOR, s + SCRATCH.slot);
    let y = 0;
    while (y < this._rows && fn.ghostty_render_state_row_iterator_next(this.rowIterator)) {
      let rowDirty = full;
      if (!rowDirty) {
        fn.ghostty_render_state_row_get(this.rowIterator, ABI.GhosttyRenderStateRowData.DIRTY, s + SCRATCH.slot);
        rowDirty = view().getUint8(s + SCRATCH.slot) !== 0;
      }
      if (rowDirty) {
        this.rowDirty[y] = 1;
        view().setUint32(s + SCRATCH.slot, this.rowCells, true);
        fn.ghostty_render_state_row_get(this.rowIterator, ABI.GhosttyRenderStateRowData.CELLS, s + SCRATCH.slot);
        this.readRowCells(y);
      }
      y++;
    }
  }

  private readRowCells(y: number): void {
    const fn = this.wasm.fn;
    const s = this.scratch;
    const K = ABI.GhosttyRenderStateRowCellsData;
    const T = ABI.GhosttyCellContentTag;
    const ok = ABI.GhosttyResult.SUCCESS;
    const row = this.rowCache[y];
    const graphemes = this.graphemeCache[y];
    graphemes.clear();
    let x = 0;
    while (x < this._cols && fn.ghostty_render_state_row_cells_next(this.rowCells)) {
      fn.ghostty_render_state_row_cells_get(this.rowCells, K.RAW, s + SCRATCH.raw);
      const raw = decodeCell(this.wasm.view(), s + SCRATCH.raw);
      let fg = this.fg;
      let bg = this.bg;
      let flags = 0;
      if (raw.styleId !== 0) {
        const style = s + SCRATCH.style;
        this.wasm.view().setUint32(style, LAYOUT.GhosttyStyle.size, true);
        fn.ghostty_render_state_row_cells_get(this.rowCells, K.STYLE, style);
        flags = styleFlags(this.wasm.view(), style);
        if (fn.ghostty_render_state_row_cells_get(this.rowCells, K.FG_COLOR, s + SCRATCH.rgb) === ok) {
          fg = readRgb(this.wasm.view(), s + SCRATCH.rgb);
        }
      }
      if (raw.styleId !== 0 || raw.tag === T.BG_COLOR_PALETTE || raw.tag === T.BG_COLOR_RGB) {
        if (fn.ghostty_render_state_row_cells_get(this.rowCells, K.BG_COLOR, s + SCRATCH.rgb) === ok) {
          bg = readRgb(this.wasm.view(), s + SCRATCH.rgb);
        }
      }
      let graphemeLen = 0;
      if (raw.tag === T.CODEPOINT_GRAPHEME) {
        fn.ghostty_render_state_row_cells_get(this.rowCells, K.GRAPHEMES_LEN, s + SCRATCH.slot);
        const total = Math.min(this.wasm.view().getUint32(s + SCRATCH.slot, true), GRAPHEME_CAP);
        if (total > 1) {
          fn.ghostty_render_state_row_cells_get(this.rowCells, K.GRAPHEMES_BUF, s + SCRATCH.graphemes);
          const view = this.wasm.view();
          const cps: number[] = [];
          for (let i = 0; i < total; i++) cps.push(view.getUint32(s + SCRATCH.graphemes + i * 4, true));
          graphemes.set(x, String.fromCodePoint(...cps));
          graphemeLen = total - 1;
        }
      }
      const cell = row[x];
      cell.codepoint = codepointOf(raw);
      cell.fg_r = fg.r;
      cell.fg_g = fg.g;
      cell.fg_b = fg.b;
      cell.bg_r = bg.r;
      cell.bg_g = bg.g;
      cell.bg_b = bg.b;
      cell.flags = flags;
      cell.width = cellWidth(raw.wide);
      cell.hyperlink_id = raw.hyperlink ? 1 : 0;
      cell.grapheme_len = graphemeLen;
      x++;
    }
  }

  /// Points the scratch grid ref at a cell; false when the point is
  /// outside the screen.
  private gridRef(tag: number, x: number, y: number): boolean {
    const s = this.scratch;
    const view = this.wasm.view();
    const point = s + SCRATCH.point;
    const coord = point + LAYOUT.GhosttyPoint.fields.value;
    view.setInt32(point + LAYOUT.GhosttyPoint.fields.tag, tag, true);
    view.setUint16(coord + LAYOUT.GhosttyPointCoordinate.fields.x, x, true);
    view.setUint32(coord + LAYOUT.GhosttyPointCoordinate.fields.y, y, true);
    view.setUint32(s + SCRATCH.gridRef, LAYOUT.GhosttyGridRef.size, true);
    return this.wasm.fn.ghostty_terminal_grid_ref(this.handle, point, s + SCRATCH.gridRef) === ABI.GhosttyResult.SUCCESS;
  }

  /// A cell of the screen or history as ghostty-web's binding builds it:
  /// colors resolved against the current palette and defaults, inverse
  /// left to the renderer.
  private gridCell(tag: number, x: number, y: number): GhosttyCell {
    if (!this.gridRef(tag, x, y)) return blankCell(this.fg, this.bg);
    const fn = this.wasm.fn;
    const s = this.scratch;
    const ok = ABI.GhosttyResult.SUCCESS;
    if (fn.ghostty_grid_ref_cell(s + SCRATCH.gridRef, s + SCRATCH.raw) !== ok) return blankCell(this.fg, this.bg);
    const raw = decodeCell(this.wasm.view(), s + SCRATCH.raw);
    let fg = this.fg;
    let bg = this.bg;
    let flags = 0;
    const T = ABI.GhosttyCellContentTag;
    if (raw.styleId !== 0) {
      const style = s + SCRATCH.style;
      this.wasm.view().setUint32(style, LAYOUT.GhosttyStyle.size, true);
      if (fn.ghostty_grid_ref_style(s + SCRATCH.gridRef, style) === ok) {
        const view = this.wasm.view();
        flags = styleFlags(view, style);
        fg = this.styleColor(view, style + LAYOUT.GhosttyStyle.fields.fg_color) ?? this.fg;
        bg = this.styleColor(view, style + LAYOUT.GhosttyStyle.fields.bg_color) ?? this.bg;
      }
    }
    if (raw.tag === T.BG_COLOR_PALETTE) bg = this.paletteColor(raw.content & 0xff);
    if (raw.tag === T.BG_COLOR_RGB) {
      bg = { r: raw.content & 0xff, g: (raw.content >>> 8) & 0xff, b: (raw.content >>> 16) & 0xff };
    }
    let graphemeLen = 0;
    if (raw.tag === T.CODEPOINT_GRAPHEME) {
      const text = this.gridGraphemes();
      graphemeLen = text ? Math.max([...text].length - 1, 0) : 0;
    }
    return {
      codepoint: codepointOf(raw),
      fg_r: fg.r,
      fg_g: fg.g,
      fg_b: fg.b,
      bg_r: bg.r,
      bg_g: bg.g,
      bg_b: bg.b,
      flags,
      width: cellWidth(raw.wide),
      hyperlink_id: raw.hyperlink ? 1 : 0,
      grapheme_len: graphemeLen,
    };
  }

  private styleColor(view: DataView, ptr: number): Rgb | null {
    const C = LAYOUT.GhosttyStyleColor.fields;
    const tag = view.getInt32(ptr + C.tag, true);
    if (tag === ABI.GhosttyStyleColorTag.PALETTE) return this.paletteColor(view.getUint8(ptr + C.value));
    if (tag === ABI.GhosttyStyleColorTag.RGB) return readRgb(view, ptr + C.value);
    return null;
  }

  private paletteColor(index: number): Rgb {
    const p = this.palette;
    return { r: p[index * 3], g: p[index * 3 + 1], b: p[index * 3 + 2] };
  }

  /// The full cluster at the scratch grid ref, base codepoint first.
  private gridGraphemes(): string | null {
    const s = this.scratch;
    const result = this.wasm.fn.ghostty_grid_ref_graphemes(
      s + SCRATCH.gridRef,
      s + SCRATCH.graphemes,
      GRAPHEME_CAP,
      s + SCRATCH.slot,
    );
    if (result !== ABI.GhosttyResult.SUCCESS) return null;
    const view = this.wasm.view();
    const count = Math.min(view.getUint32(s + SCRATCH.slot, true), GRAPHEME_CAP);
    if (count === 0) return null;
    const cps: number[] = [];
    for (let i = 0; i < count; i++) cps.push(view.getUint32(s + SCRATCH.graphemes + i * 4, true));
    return String.fromCodePoint(...cps);
  }

  private hyperlinkAt(tag: number, x: number, y: number): string | null {
    if (!this.gridRef(tag, x, y)) return null;
    const fn = this.wasm.fn;
    const s = this.scratch;
    let want = 2048;
    for (let attempt = 0; attempt < 2; attempt++) {
      const cap = want;
      const buf = this.wasm.alloc(cap);
      try {
        const result = fn.ghostty_grid_ref_hyperlink_uri(s + SCRATCH.gridRef, buf, cap, s + SCRATCH.slot);
        const len = this.wasm.view().getUint32(s + SCRATCH.slot, true);
        if (result === ABI.GhosttyResult.OUT_OF_SPACE && len > cap) {
          want = len;
          continue;
        }
        if (result !== ABI.GhosttyResult.SUCCESS || len === 0) return null;
        return new TextDecoder().decode(this.wasm.bytes().slice(buf, buf + len));
      } finally {
        this.wasm.free(buf, cap);
      }
    }
    return null;
  }
}

/// ghostty-web's `KeyEncoder` over upstream's encoder. ghostty-web's
/// `Key` numbering is older than upstream's, so keys are renumbered on
/// the way in (see `KEY_SHIFT_FROM`).
export class VtKeyEncoder {
  private readonly wasm: VtWasm;
  private encoder: number;

  constructor(wasm: VtWasm) {
    this.wasm = wasm;
    this.encoder = wasm.newHandle((slot) => wasm.fn.ghostty_key_encoder_new(0, slot), "key encoder");
  }

  setOption(option: number, value: boolean | number): void {
    const ptr = this.wasm.alloc(8);
    try {
      this.wasm.view().setUint8(ptr, typeof value === "boolean" ? (value ? 1 : 0) : value);
      this.wasm.fn.ghostty_key_encoder_setopt(this.encoder, option, ptr);
    } finally {
      this.wasm.free(ptr, 8);
    }
  }

  setKittyFlags(flags: number): void {
    // KITTY_FLAGS, the same value in both numberings.
    this.setOption(5, flags);
  }

  encode(event: { action: number; key: number; mods: number; utf8?: string }): Uint8Array {
    const fn = this.wasm.fn;
    const ev = this.wasm.newHandle((slot) => fn.ghostty_key_event_new(0, slot), "key event");
    let utf8Ptr = 0;
    let utf8Len = 0;
    try {
      fn.ghostty_key_event_set_action(ev, event.action);
      fn.ghostty_key_event_set_key(ev, upstreamKey(event.key));
      fn.ghostty_key_event_set_mods(ev, event.mods);
      if (event.utf8) {
        const bytes = new TextEncoder().encode(event.utf8);
        utf8Len = bytes.length;
        utf8Ptr = this.wasm.alloc(utf8Len);
        this.wasm.bytes().set(bytes, utf8Ptr);
        fn.ghostty_key_event_set_utf8(ev, utf8Ptr, utf8Len);
      }
      let want = 64;
      for (let attempt = 0; attempt < 2; attempt++) {
        const cap = want;
        const buf = this.wasm.alloc(cap);
        const written = this.wasm.alloc(8);
        try {
          const result = fn.ghostty_key_encoder_encode(this.encoder, ev, buf, cap, written);
          const len = this.wasm.view().getUint32(written, true);
          if (result === ABI.GhosttyResult.OUT_OF_SPACE && len > cap) {
            want = len;
            continue;
          }
          if (result !== ABI.GhosttyResult.SUCCESS) throw new Error(`ghostty-vt: encoding a key failed (${result})`);
          return this.wasm.bytes().slice(buf, buf + len);
        } finally {
          this.wasm.free(buf, cap);
          this.wasm.free(written, 8);
        }
      }
      throw new Error("ghostty-vt: encoding a key failed (out of space)");
    } finally {
      // The event holds no pointer into the utf8 buffer past encode.
      this.wasm.free(utf8Ptr, utf8Len);
      fn.ghostty_key_event_free(ev);
    }
  }

  dispose(): void {
    if (this.encoder) {
      this.wasm.fn.ghostty_key_encoder_free(this.encoder);
      this.encoder = 0;
    }
  }
}
