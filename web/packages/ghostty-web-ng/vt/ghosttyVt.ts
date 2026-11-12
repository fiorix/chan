/// Ghostty's VT core from Ghostty's own release build, bound as the core
/// the widget's `Terminal` takes as its `ghostty` option. The widget's
/// sources in `lib/` are typed against the classes here.
///
/// WHY: ghostty-web ships a wasm it compiles from a patched Ghostty
/// snapshot with its own C entry points: render-state getters, a polled
/// reply buffer, and a stream handler that dispatches a hand-picked
/// subset of Ghostty's actions. Ghostty's release wasm exposes the
/// libghostty-vt C API instead, with Ghostty's full stream handler. The
/// widget keeps ghostty-web's renderer, input handler and selection; this
/// module gives them the terminal and key encoder they call over upstream's
/// parser and terminal state, and the renderer, the buffer API and the
/// selection read the core's render state through its frame reader
/// (`VtTerminal`, `VtCells`).
///
/// The ABI numbers and struct offsets below are read off the pinned
/// build's `ghostty_type_json()`; `ghosttyVt.test.ts` checks each one
/// against that JSON, so a re-pin that moves one fails there and not in
/// a user's terminal.

import type { GhosttyCell } from "@chan/ghostty-web-ng";
import { copiedText } from "./ghosttyCopy";

/// Enum values of the pinned build, by upstream C type.
export const ABI = {
  GhosttyResult: { SUCCESS: 0, OUT_OF_SPACE: -3, NO_VALUE: -4 },
  GhosttyTerminalOption: {
    WRITE_PTY: 2,
    DEVICE_ATTRIBUTES: 9,
    COLOR_FOREGROUND: 12,
    COLOR_BACKGROUND: 13,
    COLOR_CURSOR: 14,
    COLOR_PALETTE: 15,
    SCROLLBACK_MAX_BYTES: 28,
    SCROLLBACK_MAX_LINES: 29,
    MODE_DEFAULT: 34,
    MODE: 35,
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
  GhosttyPointTag: { ACTIVE: 0, VIEWPORT: 1, SCREEN: 2, HISTORY: 3 },
  GhosttyRenderStateData: { DIRTY: 3, ROW_ITERATOR: 4, CURSOR_VISIBLE: 11, COLORS: 19 },
  GhosttyRenderStateDirty: { FALSE: 0, PARTIAL: 1, FULL: 2 },
  GhosttyRenderStateRowData: { CELLS: 3, CELLS_RAW: 5 },
  GhosttyRenderStateRowCellsData: { RAW: 1, STYLE: 2, GRAPHEMES_BUF: 4, BG_COLOR: 5, FG_COLOR: 6 },
  GhosttyRowData: { WRAP_CONTINUATION: 2 },
  GhosttyStyleColorTag: { NONE: 0, PALETTE: 1, RGB: 2 },
  GhosttyCellContentTag: {
    CODEPOINT: 0,
    CODEPOINT_GRAPHEME: 1,
    BG_COLOR_PALETTE: 2,
    BG_COLOR_RGB: 3,
  },
  GhosttyCellWide: { NARROW: 0, WIDE: 1, SPACER_TAIL: 2, SPACER_HEAD: 3 },
  GhosttyFormatterOption: { UNWRAP: 2, TRIM: 3, SELECTION: 4 },
  GhosttyKeyEncoderOption: {
    CURSOR_KEY_APPLICATION: 1,
    KEYPAD_KEY_APPLICATION: 2,
    IGNORE_KEYPAD_WITH_NUMLOCK: 3,
    ALT_ESC_PREFIX: 4,
    MODIFY_OTHER_KEYS_STATE_2: 5,
    KITTY_FLAGS: 6,
  },
  GhosttyBuildInfo: { VERSION_MAJOR: 6, FEATURE_SEARCH: 14 },
  GhosttySearchOption: { NEEDLE: 1, SELECT_SCROLL: 4 },
  GhosttySearchData: {
    STATUS: 1,
    NEEDLE: 2,
    TOTAL_MATCHES: 3,
    SELECTED_INDEX: 4,
    SELECTED_MATCH: 5,
    MATCHES: 6,
    VIEWPORT_MATCHES: 7,
    SELECT_SCROLL: 8,
  },
  GhosttySearchStatus: { RUNNING: 0, FEED_REQUIRED: 1, COMPLETE: 2 },
  GhosttySearchScroll: { IF_NEEDED: 0, NONE: 1 },
} as const;

/// Struct sizes and field offsets of the pinned build, by upstream C type.
export const LAYOUT = {
  GhosttyStyle: {
    size: 16,
    fields: { fg_color: 0, bg_color: 4, underline_color: 8, flags: 12 },
  },
  GhosttyStyleColor: { size: 4, fields: { tag: 0, value: 1 } },
  GhosttyRenderStateColors: {
    size: 784,
    fields: { size: 0, background: 4, foreground: 7, palette: 14 },
  },
  GhosttyPoint: { size: 24, fields: { tag: 0, value: 8 } },
  GhosttyPointCoordinate: { size: 8, fields: { x: 0, y: 4 } },
  GhosttyGridRef: { size: 8, fields: { node: 0, x: 4, y: 6 } },
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
  GhosttySelection: { size: 20, fields: { start: 0, end: 8, rectangle: 16 } },
  GhosttyString: { size: 8, fields: { ptr: 0, len: 4 } },
  GhosttyCellsView: { size: 8, fields: { ptr: 0, len: 4 } },
  GhosttySelectionBuffer: { size: 12, fields: { ptr: 0, cap: 4, len: 8 } },
  GhosttyCodepointBuffer: { size: 12, fields: { ptr: 0, cap: 4, len: 8 } },
} as const;

/// Bit ranges `[lsb, width]` of the packed 64-bit `GhosttyCell`.
export const CELL_BITS = {
  content_tag: [0, 2],
  content: [2, 24],
  style_id: [26, 16],
  wide: [42, 2],
  hyperlink: [45, 1],
} as const;

/// Bit ranges `[lsb, width]` of the packed 16-bit `GhosttyStyleFlags`;
/// `underline` holds a `GhosttySgrUnderline`, zero for none.
export const STYLE_FLAG_BITS = {
  bold: [0, 1],
  italic: [1, 1],
  faint: [2, 1],
  blink: [3, 1],
  inverse: [4, 1],
  invisible: [5, 1],
  strikethrough: [6, 1],
  overline: [7, 1],
  underline: [8, 3],
} as const;

const mask = ([lsb, width]: readonly [number, number]) => ((1 << width) - 1) << lsb;

/// The bits of a `VtCell`'s `flags`, the core's own `GhosttyStyleFlags`:
/// each attribute's mask, `UNDERLINE` covering every underline style.
export const VtFlag = {
  BOLD: mask(STYLE_FLAG_BITS.bold),
  ITALIC: mask(STYLE_FLAG_BITS.italic),
  FAINT: mask(STYLE_FLAG_BITS.faint),
  BLINK: mask(STYLE_FLAG_BITS.blink),
  INVERSE: mask(STYLE_FLAG_BITS.inverse),
  INVISIBLE: mask(STYLE_FLAG_BITS.invisible),
  STRIKETHROUGH: mask(STYLE_FLAG_BITS.strikethrough),
  OVERLINE: mask(STYLE_FLAG_BITS.overline),
  UNDERLINE: mask(STYLE_FLAG_BITS.underline),
} as const;

/// One cell of a row as the reader decodes it from the core.
export type VtCell = {
  /// The base codepoint; 0 for a cell nothing was written to, or one that
  /// holds only a background colour.
  codepoint: number;
  /// The whole grapheme cluster when the cell holds more than one
  /// codepoint, else null.
  cluster: string | null;
  /// The columns the cell takes: 1, 2 for a wide character, and 0 for a
  /// spacer: the column after a wide character, or the last column of a row
  /// a wide character did not fit at the end of.
  width: number;
  /// The cell's style flags (`VtFlag`); 0 when the cell has no style.
  flags: number;
  /// The foreground and the background as 0xRRGGBB, resolved against the
  /// palette and the terminal's default colours.
  fg: number;
  bg: number;
  /// 1 when the cell carries an OSC 8 hyperlink, else 0. The core does not
  /// number links, so every link reads 1.
  hyperlink: number;
};

/// A row of cells read from a terminal (`VtTerminal.readRow`,
/// `readHistoryRow`) into cell objects the view keeps and fills again on its
/// next read, so reading a row allocates nothing beyond a cluster's string.
/// A view holds one row at a time: a reader that needs two rows at once keeps
/// a view for each.
export class VtCells {
  private readonly cells: VtCell[] = [];
  /// The cells of the row read last; `at` answers for `0` to `length - 1`.
  length = 0;
  /// Where the row was read from: history row `row`, 0 the oldest, or screen
  /// row `row`. `row` is -1 before the first read.
  history = false;
  row = -1;
  /// The terminal and the state of its screen the row was read at, so a
  /// read of the same row in the same state reads nothing.
  private source: object | null = null;
  private generation = -1;

  /// The cell at column `x`, or undefined outside the row.
  at(x: number): VtCell | undefined {
    return x >= 0 && x < this.length ? this.cells[x] : undefined;
  }

  /// Whether the view holds the row a reader is asked for, read from `source`
  /// at `generation`. For `VtTerminal`'s readers.
  holds(source: object, history: boolean, row: number, generation: number): boolean {
    return this.source === source && this.generation === generation && this.history === history && this.row === row;
  }

  /// Takes the view for a row of `length` cells and returns its cells, whose
  /// first `length` a reader fills, every one. For `VtTerminal`'s readers.
  fill(source: object, history: boolean, row: number, generation: number, length: number): VtCell[] {
    while (this.cells.length < length) {
      this.cells.push({ codepoint: 0, cluster: null, width: 1, flags: 0, fg: 0, bg: 0, hyperlink: 0 });
    }
    this.source = source;
    this.history = history;
    this.row = row;
    this.generation = generation;
    this.length = length;
    return this.cells;
  }

  /// Forgets the row, as when a read fails partway.
  drop(): void {
    this.source = null;
    this.length = 0;
    this.row = -1;
  }
}

/// First ghostty-web `Key` value that upstream numbers one higher.
/// Upstream inserted `FN` at this value; every key before it keeps its
/// number (some under new names, such as `BACKQUOTE` for `GRAVE`).
export const KEY_SHIFT_FROM = 146;

export function upstreamKey(key: number): number {
  return key >= KEY_SHIFT_FROM ? key + 1 : key;
}

/// ghostty-web's `KeyEncoderOption` values, which its input handler passes
/// to `setOption`, each with the name of the upstream option it means.
/// Upstream numbers these from 1 (0 is `INVALID`) and calls the kitty flags
/// `KITTY_FLAGS`, so an option is translated by name; `ghosttyVt.test.ts`
/// checks the web side against the library's enum and the upstream side
/// against the build's values.
export const KEY_ENCODER_OPTIONS = {
  CURSOR_KEY_APPLICATION: { web: 0, upstream: "CURSOR_KEY_APPLICATION" },
  KEYPAD_KEY_APPLICATION: { web: 1, upstream: "KEYPAD_KEY_APPLICATION" },
  IGNORE_KEYPAD_WITH_NUMLOCK: { web: 2, upstream: "IGNORE_KEYPAD_WITH_NUMLOCK" },
  ALT_ESC_PREFIX: { web: 3, upstream: "ALT_ESC_PREFIX" },
  MODIFY_OTHER_KEYS_STATE_2: { web: 4, upstream: "MODIFY_OTHER_KEYS_STATE_2" },
  KITTY_KEYBOARD_FLAGS: { web: 5, upstream: "KITTY_FLAGS" },
} as const satisfies Record<string, { web: number; upstream: keyof typeof ABI.GhosttyKeyEncoderOption }>;

const UPSTREAM_KEY_ENCODER_OPTION = new Map<number, number>(
  Object.values(KEY_ENCODER_OPTIONS).map((o) => [o.web, ABI.GhosttyKeyEncoderOption[o.upstream]]),
);

/// Upstream's number for a ghostty-web key encoder option; undefined for a
/// number ghostty-web does not define.
export function upstreamKeyEncoderOption(option: number): number | undefined {
  return UPSTREAM_KEY_ENCODER_OPTION.get(option);
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

/// Whether a reply is upstream's answer to an OSC 4, 10, 11 or 12 color
/// query, or to an OSC 21 query of kitty's color protocol. chan answers none, on either backend (ghostty-web's build never
/// did, and xtermReports.ts suppresses xterm.js's): a program that exits
/// before reading the reply leaves the PTY to echo it into the next prompt.
/// Upstream writes each query's answer as one reply that starts with the
/// query's own OSC number.
function isColorReport(reply: Uint8Array): boolean {
  if (reply.length < 5 || reply[0] !== 0x1b || reply[1] !== 0x5d) return false;
  const semi = reply.indexOf(0x3b, 2);
  if (semi < 0 || semi > 4) return false;
  const ident = String.fromCharCode(...reply.subarray(2, semi));
  return ident === "4" || ident === "10" || ident === "11" || ident === "12" || ident === "21";
}

/// chan's xterm.js path leaves XTVERSION unanswered too.
function isVersionReport(reply: Uint8Array): boolean {
  return reply[0] === 0x1b && reply[1] === 0x50 && reply[2] === 0x3e && reply[3] === 0x7c;
}

/// The keyboard observer answers from the flags chan's encoder uses.
function isKittyKeyboardReport(reply: Uint8Array): boolean {
  if (reply.length < 5 || reply[0] !== 0x1b || reply[1] !== 0x5b || reply[2] !== 0x3f || reply.at(-1) !== 0x75) return false;
  return reply.subarray(3, -1).every((byte) => byte >= 0x30 && byte <= 0x39);
}

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
  "ghostty_terminal_point_from_grid_ref",
  "ghostty_terminal_grid_ref_track",
  "ghostty_tracked_grid_ref_point",
  "ghostty_tracked_grid_ref_set",
  "ghostty_tracked_grid_ref_free",
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
  "ghostty_render_state_row_iterator_next_dirty",
  "ghostty_render_state_row_get_multi",
  "ghostty_render_state_row_cells_new",
  "ghostty_render_state_row_cells_free",
  "ghostty_render_state_row_cells_select",
  "ghostty_render_state_row_cells_get",
  "ghostty_render_state_row_cells_get_multi",
  "ghostty_key_encoder_new",
  "ghostty_key_encoder_free",
  "ghostty_formatter_terminal_new",
  "ghostty_formatter_set",
  "ghostty_formatter_format_alloc",
  "ghostty_formatter_free",
  "ghostty_free",
  "ghostty_key_encoder_set",
  "ghostty_key_encoder_encode",
  "ghostty_key_event_new",
  "ghostty_key_event_free",
  "ghostty_key_event_set_action",
  "ghostty_key_event_set_key",
  "ghostty_key_event_set_mods",
  "ghostty_key_event_set_utf8",
  "ghostty_build_info",
  "ghostty_search_new",
  "ghostty_search_free",
  "ghostty_search_tick",
  "ghostty_search_feed",
  "ghostty_search_set",
  "ghostty_search_get",
  "ghostty_search_select_next",
  "ghostty_search_select_prev",
  "ghostty_paste_encode",
] as const;

type Fns = Record<(typeof FUNCTIONS)[number], Fn> & {
  /// Takes the 64-bit row by value, which JS passes as a BigInt.
  ghostty_row_get: (row: bigint, data: number, out: number) => number;
};

/// The binding's refusal of a core it does not drive: one without an
/// export the binding calls, one that is not libghostty-vt 1.x, or one
/// without search. A refusal is the core's own and comes again from every
/// instance of the same module, where any other failure to instantiate (a
/// wasm memory RangeError on a page short of memory) may pass, so a loader
/// can keep this one and retry the rest.
export class GhosttyVtRefusal extends Error {}

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
      if (typeof f !== "function") throw new GhosttyVtRefusal(`ghostty-vt: missing export ${name}`);
      fn[name] = f;
    }
    this.fn = fn as Fns;
    this.memory = exports.memory as WebAssembly.Memory;
    this.table = exports.__indirect_function_table as WebAssembly.Table;
    this.checkBuild();
  }

  /// Refuses a core this binding does not drive. The tables and calls in
  /// this module are libghostty-vt's 1.x ABI, which a minor only adds to,
  /// and the ghostty backend needs the search feature Ghostty's wasm builds
  /// carry. Either mismatch would fail inside a user's terminal; failing
  /// here lets the loader fall back to xterm.js instead.
  private checkBuild(): void {
    const B = ABI.GhosttyBuildInfo;
    const out = this.alloc(8);
    try {
      this.view().setUint32(out, 0, true);
      this.view().setUint8(out + 4, 0);
      this.fn.ghostty_build_info(B.VERSION_MAJOR, out);
      this.fn.ghostty_build_info(B.FEATURE_SEARCH, out + 4);
      const major = this.view().getUint32(out, true);
      const search = this.view().getUint8(out + 4) !== 0;
      if (major !== 1) {
        throw new GhosttyVtRefusal(`ghostty-vt: libghostty-vt ${major}.x is not the 1.x ABI this binding drives`);
      }
      if (!search) throw new GhosttyVtRefusal("ghostty-vt: this libghostty-vt build has no search");
    } finally {
      this.free(out, 8);
    }
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

/// Renderer measurements and delivery for replies generated outside a write.
export type VtHost = {
  cellSize: () => { width: number; height: number } | undefined;
  onResizeReply: (data: string) => void;
};

/// The core ghostty-web's `Terminal` takes as its `ghostty` option.
export class GhosttyVt {
  private readonly wasm: VtWasm;
  private readonly terminals = new Map<number, VtTerminal>();
  readonly writePtyCallback: number;
  readonly deviceAttributesCallback: number;

  constructor(instance: WebAssembly.Instance, readonly host?: VtHost) {
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

  createKeyEncoder(): VtKeyEncoder {
    return new VtKeyEncoder(this.wasm);
  }

  createTerminal(cols = 80, rows = 24, config?: VtTerminalConfig): VtTerminal {
    return new VtTerminal(this.wasm, this, cols, rows, config);
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

/// Field `range` of a packed 64-bit `GhosttyCell` given as its low and high
/// 32 bits. No field the binding reads is wider than 24 bits.
function cellBits(lo: number, hi: number, [lsb, width]: readonly [number, number]): number {
  const m = (1 << width) - 1;
  if (lsb >= 32) return (hi >>> (lsb - 32)) & m;
  if (lsb + width <= 32) return (lo >>> lsb) & m;
  return ((lo >>> lsb) | (hi << (32 - lsb))) & m;
}

function cellWidth(wide: number): number {
  const W = ABI.GhosttyCellWide;
  return wide === W.WIDE ? 2 : wide === W.SPACER_TAIL || wide === W.SPACER_HEAD ? 0 : 1;
}

/// The 0xRRGGBB of a `GhosttyColorRgb` at `ptr`.
function readRgb(view: DataView, ptr: number): number {
  return (view.getUint8(ptr) << 16) | (view.getUint8(ptr + 1) << 8) | view.getUint8(ptr + 2);
}

function rgbOf(color: number): Rgb {
  return { r: (color >>> 16) & 0xff, g: (color >>> 8) & 0xff, b: color & 0xff };
}

/// ghostty-web's `CellFlags` for a cell's `VtFlag`s. Any underline style
/// underlines; overline has no ghostty-web flag.
function legacyFlags(flags: number): number {
  let out = 0;
  if (flags & VtFlag.BOLD) out |= FLAG.BOLD;
  if (flags & VtFlag.ITALIC) out |= FLAG.ITALIC;
  if (flags & VtFlag.UNDERLINE) out |= FLAG.UNDERLINE;
  if (flags & VtFlag.STRIKETHROUGH) out |= FLAG.STRIKETHROUGH;
  if (flags & VtFlag.INVERSE) out |= FLAG.INVERSE;
  if (flags & VtFlag.INVISIBLE) out |= FLAG.INVISIBLE;
  if (flags & VtFlag.BLINK) out |= FLAG.BLINK;
  if (flags & VtFlag.FAINT) out |= FLAG.FAINT;
  return out;
}

/// A row in ghostty-web's cell format.
function legacyCells(cells: VtCells): GhosttyCell[] {
  const out: GhosttyCell[] = [];
  for (let x = 0; x < cells.length; x++) {
    const cell = cells.at(x)!;
    const fg = rgbOf(cell.fg);
    const bg = rgbOf(cell.bg);
    out.push({
      codepoint: cell.codepoint,
      fg_r: fg.r,
      fg_g: fg.g,
      fg_b: fg.b,
      bg_r: bg.r,
      bg_g: bg.g,
      bg_b: bg.b,
      flags: legacyFlags(cell.flags),
      width: cell.width,
      hyperlink_id: cell.hyperlink,
      grapheme_len: cell.cluster ? [...cell.cluster].length - 1 : 0,
    });
  }
  return out;
}

/// The text a cell shows: its cluster, its codepoint, or a space.
function cellText(cell: VtCell | undefined): string {
  return cell?.cluster ?? (cell?.codepoint ? String.fromCodePoint(cell.codepoint) : " ");
}

/// Byte offsets of the scratch area each terminal keeps for out parameters
/// and the key and value arrays of its multi-get calls.
export const SCRATCH = {
  slot: 0, // u32 handle or size_t out value
  slot2: 8, // second u32 out value
  raw: 16, // GhosttyCell / GhosttyRow (u64)
  rgb: 24, // GhosttyColorRgb
  mode: 28, // GhosttyTerminalModeConfig
  point: 32, // GhosttyPoint (24 bytes, 8-aligned)
  gridRef: 56, // GhosttyGridRef (8 bytes)
  style: 64, // GhosttyStyle (16 bytes)
  codepoints: 80, // GhosttyCodepointBuffer (12 bytes)
  colors: 92, // GhosttyRenderStateColors (784 bytes)
  graphemes: 876, // u32[GRAPHEME_CAP]
  cellsView: 1004, // GhosttyCellsView (8 bytes)
  rowCells: 1012, // GhosttyRenderStateRowCells, the handle a row's cells are read into
  rowKeys: 1016, // GhosttyRenderStateRowData[2]: CELLS_RAW, CELLS
  rowValues: 1024, // void*[2]: cellsView, rowCells
  cellKeys: 1032, // GhosttyRenderStateRowCellsData[2]: STYLE, GRAPHEMES_BUF
  cellValues: 1040, // void*[2]: style, codepoints
  dirtyY: 1048, // u16, the row next_dirty moved to
  size: 1052,
} as const;
const GRAPHEME_CAP = 32;

/// Distinct styles a row's read keeps by style id. A style id names one style
/// in the page a row is on, and a row is on one page, so within a row the
/// first read of an id serves every cell that carries it.
const ROW_STYLES = 64;

/// A terminal of the core and the render state the widget paints it from.
/// The widget scrolls in JS (it reads history rows itself), so the core's
/// viewport never moves and its render state is the active screen.
///
/// A frame reads it in three parts: `beginFrame` brings the render state up
/// to date and says what changed since the last frame, the whole screen or
/// the rows `isRowDirty` names, which the core's own dirty iteration lists;
/// `readRow` and `readHistoryRow` read any row's cells into a `VtCells` view;
/// `endFrame` marks it all painted.
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

  /// What changed since the last `endFrame`: the render state's dirty
  /// state, and the rows the core listed dirty while it was partial.
  private dirty = 0;
  private rowDirty = new Uint8Array(0);
  /// Writes or a resize since the render state was last updated.
  private stale = true;
  /// Updates of the render state so far. A view holds a row read at one
  /// count, and the row iterator was filled at one.
  private generation = 0;
  private iteratorGeneration = -1;
  /// The row the iterator stands on, -1 before its first row.
  private iteratorRow = -1;
  /// The styles a row's read has met, by style id: flags, foreground and
  /// background.
  private readonly styleIds = new Int32Array(ROW_STYLES);
  private readonly styleFlags = new Uint16Array(ROW_STYLES);
  private readonly styleFg = new Int32Array(ROW_STYLES);
  private readonly styleBg = new Int32Array(ROW_STYLES);
  private styleCount = 0;
  /// The content tag and content of the raw cell `rawCell` read last.
  private rawTag = 0;
  private rawContent = 0;
  /// The history's length at an update, for the reads after it.
  private historyGeneration = -1;
  private historyRows = 0;
  /// A view for the binding's own one-cell reads.
  private readonly lookup = new VtCells();
  /// Writes and resizes taken so far. A search compares it with the count
  /// at its last feed to tell whether the matches it holds are current.
  private changes = 0;
  /// The default colours as 0xRRGGBB and the palette, as of the last update.
  private fg = 0xcccccc;
  private bg = 0x000000;
  private palette = new Uint8Array(768);
  private replies: Uint8Array[] = [];
  /// The cells tracked on this terminal and not freed yet; the terminal
  /// frees them with itself.
  private readonly trackedCells = new Set<VtTrackedCell>();
  private readonly cellOwner: TrackedCellOwner;
  private readonly resizeListeners = new Set<(from: { cols: number; rows: number }) => void>();

  constructor(wasm: VtWasm, owner: GhosttyVt, cols: number, rows: number, config?: VtTerminalConfig) {
    this.wasm = wasm;
    this.owner = owner;
    this._cols = cols;
    this._rows = rows;
    this.cellOwner = {
      handle: () => this.handle,
      point: (row, col) => this.writePoint(ABI.GhosttyPointTag.SCREEN, col, row),
      coordinate: () => this.scratch + SCRATCH.slot,
      release: (cell) => void this.trackedCells.delete(cell),
    };
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
    this.writeMultiArgs();
    this.rowDirty = new Uint8Array(rows);
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
      const cap = Math.max(bytes.length, 4096);
      const buf = this.wasm.alloc(cap);
      this.wasm.free(this.writeBuf, this.writeCap);
      this.writeCap = cap;
      this.writeBuf = buf;
    }
    this.wasm.bytes().set(bytes, this.writeBuf);
    this.stale = true;
    this.changes++;
    this.wasm.fn.ghostty_terminal_vt_write(this.handle, this.writeBuf, bytes.length);
  }

  resize(cols: number, rows: number): void {
    if (cols === this._cols && rows === this._rows) return;
    const from = { cols: this._cols, rows: this._rows };
    for (const listener of this.resizeListeners) listener(from);
    this._cols = cols;
    this._rows = rows;
    this.changes++;
    const cell = this.owner.host?.cellSize();
    this.wasm.fn.ghostty_terminal_resize(
      this.handle, cols, rows,
      Math.round(cell?.width ?? 0), Math.round(cell?.height ?? 0),
    );
    // The render state's next update redraws every row; until then, nothing
    // is dirty at the new size.
    this.rowDirty = new Uint8Array(rows);
    this.stale = true;
    // ghostty-web drains after writes only; a resize can produce its own
    // mode 2048 report while the program is otherwise silent.
    if (this.owner.host) {
      const reply = this.readResponse();
      if (reply !== null) this.owner.host.onResizeReply(reply);
    }
  }

  /// Calls `listener` at the start of each resize that changes the size,
  /// while the core still holds the old grid; `from` is the size it leaves.
  /// ghostty-web sets its own `cols` and `rows` before it hands the core the
  /// new size and fires its resize event after, so a reader that needs the
  /// grid as it was (find, to tell whether its match was on the screen)
  /// reads it here. Returns the call that stops it.
  beforeResize(listener: (from: { cols: number; rows: number }) => void): () => void {
    this.resizeListeners.add(listener);
    return () => {
      this.resizeListeners.delete(listener);
    };
  }

  free(): void {
    const fn = this.wasm.fn;
    for (const cell of [...this.trackedCells]) cell.free();
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
  // Frames
  // ------------------------------------------------------------------

  /// Begins a frame: brings the render state up to date with the writes and
  /// resizes since its last update and returns what changed since the last
  /// `endFrame`, a `GhosttyRenderStateDirty`: FALSE nothing, PARTIAL the rows
  /// `isRowDirty` names, FULL every row. Cheap to call again: without a write
  /// or a resize in between it reads nothing.
  beginFrame(): number {
    this.sync();
    return this.dirty;
  }

  /// Whether screen row `y` changed since the last `endFrame`, as of the
  /// last `beginFrame` or read.
  isRowDirty(y: number): boolean {
    return this.dirty === ABI.GhosttyRenderStateDirty.FULL || this.rowDirty[y] === 1;
  }

  /// Ends a frame: what changed so far counts as painted, in the core's
  /// render state too.
  endFrame(): void {
    if (this.dirty === ABI.GhosttyRenderStateDirty.FALSE || !this.handle) return;
    this.wasm.fn.ghostty_render_state_clean(this.renderState);
    this.dirty = ABI.GhosttyRenderStateDirty.FALSE;
    this.rowDirty.fill(0);
  }

  /// Reads screen row `y` into `into` from the render state, brought up to
  /// date first: the row's raw cells in one call, read where the core keeps
  /// them, and a style or a cluster for the cells that carry one. False
  /// outside the screen or once the terminal is freed. A view that holds the
  /// row already, read since the last update, is left as it is.
  readRow(y: number, into: VtCells): boolean {
    if (y < 0 || y >= this._rows || !this.handle) return false;
    this.sync();
    if (into.holds(this, false, y, this.generation)) return true;
    const fn = this.wasm.fn;
    const s = this.scratch;
    const ok = ABI.GhosttyResult.SUCCESS;
    const V = LAYOUT.GhosttyCellsView.fields;
    if (!this.seekRow(y) || fn.ghostty_render_state_row_get_multi(this.rowIterator, 2, s + SCRATCH.rowKeys, s + SCRATCH.rowValues, 0) !== ok) {
      into.drop();
      return false;
    }
    let view = this.wasm.view();
    const raw = view.getUint32(s + SCRATCH.cellsView + V.ptr, true);
    const len = view.getUint32(s + SCRATCH.cellsView + V.len, true);
    const cells = into.fill(this, false, y, this.generation, this._cols);
    const T = ABI.GhosttyCellContentTag;
    this.styleCount = 0;
    for (let x = 0; x < this._cols; x++) {
      const cell = cells[x];
      if (x >= len) {
        this.blank(cell);
        continue;
      }
      const styleId = this.rawCell(cell, view.getUint32(raw + x * 8, true), view.getUint32(raw + x * 8 + 4, true));
      let style = styleId === 0 ? -1 : this.knownStyle(styleId);
      const grapheme = this.rawTag === T.CODEPOINT_GRAPHEME;
      if ((styleId !== 0 && style < 0) || grapheme) {
        // One call for what the cell needs read: its style, its cluster or
        // both (the keys are STYLE then GRAPHEMES_BUF).
        const wantStyle = styleId !== 0 && style < 0;
        const first = wantStyle ? 0 : 1;
        const count = (wantStyle ? 1 : 0) + (grapheme ? 1 : 0);
        if (grapheme) this.clearCodepoints();
        const selected = fn.ghostty_render_state_row_cells_select(this.rowCells, x) === ok;
        const result = selected
          ? fn.ghostty_render_state_row_cells_get_multi(this.rowCells, count, s + SCRATCH.cellKeys + first * 4, s + SCRATCH.cellValues + first * 4, s + SCRATCH.slot)
          : ABI.GhosttyResult.NO_VALUE;
        view = this.wasm.view();
        const written = selected ? view.getUint32(s + SCRATCH.slot, true) : 0;
        if (wantStyle && written >= 1) style = this.rememberStyle(styleId, view, s + SCRATCH.style);
        if (grapheme && selected) {
          // A cluster longer than the scratch holds reads again into a
          // buffer of its own.
          const cps = result === ok ? this.scratchCodepoints() : this.rowCellCluster();
          view = this.wasm.view();
          if (cps && cps.length > 1) cell.cluster = String.fromCodePoint(...cps);
        }
      }
      if (style >= 0) this.applyStyle(cell, style);
      this.contentBackground(cell);
    }
    return true;
  }

  /// Reads history row `offset`, 0 the oldest, into `into` through the
  /// core's grid references: a reference and a raw cell for each cell, and a
  /// style or a cluster for the cells that carry one. False outside the
  /// history or once the terminal is freed. A view that holds the row
  /// already, read since the last update, is left as it is.
  readHistoryRow(offset: number, into: VtCells): boolean {
    if (offset < 0 || !this.handle) return false;
    this.sync();
    if (this.historyGeneration !== this.generation) {
      this.historyRows = this.getScrollbackLength();
      this.historyGeneration = this.generation;
    }
    if (offset >= this.historyRows) return false;
    if (into.holds(this, true, offset, this.generation)) return true;
    const fn = this.wasm.fn;
    const s = this.scratch;
    const ok = ABI.GhosttyResult.SUCCESS;
    const T = ABI.GhosttyCellContentTag;
    const cells = into.fill(this, true, offset, this.generation, this._cols);
    this.styleCount = 0;
    for (let x = 0; x < this._cols; x++) {
      const cell = cells[x];
      if (!this.gridRef(ABI.GhosttyPointTag.HISTORY, x, offset) || fn.ghostty_grid_ref_cell(s + SCRATCH.gridRef, s + SCRATCH.raw) !== ok) {
        this.blank(cell);
        continue;
      }
      let view = this.wasm.view();
      const styleId = this.rawCell(cell, view.getUint32(s + SCRATCH.raw, true), view.getUint32(s + SCRATCH.raw + 4, true));
      let style = styleId === 0 ? -1 : this.knownStyle(styleId);
      if (styleId !== 0 && style < 0 && fn.ghostty_grid_ref_style(s + SCRATCH.gridRef, s + SCRATCH.style) === ok) {
        view = this.wasm.view();
        style = this.rememberStyle(styleId, view, s + SCRATCH.style);
      }
      if (style >= 0) this.applyStyle(cell, style);
      this.contentBackground(cell);
      if (this.rawTag === T.CODEPOINT_GRAPHEME) {
        const text = this.gridGraphemes();
        if (text && [...text].length > 1) cell.cluster = text;
      }
    }
    return true;
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
    return { background: rgbOf(this.bg), foreground: rgbOf(this.fg), cursor: null };
  }

  /// Replaces the default colors, the cursor color and the 16-color
  /// palette with `config`'s, so the terminal resolves its cells as one
  /// created with `config` and fed the same output would. Colors the
  /// program set itself (OSC 4, 10, 11, 12) stay over the new defaults, as
  /// in Ghostty. The next update reads the new colors and reports a full
  /// redraw.
  setColors(config?: VtTerminalConfig): void {
    this.writeColors(config);
    this.stale = true;
  }

  // ------------------------------------------------------------------
  // ghostty-web's cell format, for the tests that hold the binding to
  // ghostty-web's own build and read cells in that shape
  // ------------------------------------------------------------------

  /// Screen row `y` in ghostty-web's cell format, cells of its own.
  getLine(y: number): GhosttyCell[] | null {
    const cells = new VtCells();
    return this.readRow(y, cells) ? legacyCells(cells) : null;
  }

  /// History row `offset`, 0 the oldest, in ghostty-web's cell format.
  getScrollbackLine(offset: number): GhosttyCell[] | null {
    const cells = new VtCells();
    return this.readHistoryRow(offset, cells) ? legacyCells(cells) : null;
  }

  /// The text of screen row `row`'s cell at `col`: its cluster, its
  /// codepoint, or a space.
  getGraphemeString(row: number, col: number): string {
    return this.readRow(row, this.lookup) ? cellText(this.lookup.at(col)) : " ";
  }

  /// The text of history row `offset`'s cell at `col`, read through the
  /// cell's own grid reference.
  getScrollbackGraphemeString(offset: number, col: number): string {
    if (!this.gridRef(ABI.GhosttyPointTag.HISTORY, col, offset)) return " ";
    return this.gridGraphemes() ?? " ";
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

  /// What a paste of `text` sends the program, by the core's own paste
  /// encoder, the one native Ghostty pastes with: NUL, BS, ENQ, EOT, ESC, DEL
  /// and the tty's control characters (Ctrl+C, Ctrl+\, Ctrl+U, Ctrl+Z,
  /// Ctrl+Q, Ctrl+S, Ctrl+W, Ctrl+V, Ctrl+R, Ctrl+O) each become a space, so a
  /// pasted ESC[201~ cannot end the bracket early and no pasted byte acts as a
  /// key; under bracketed paste (mode 2004) the text is framed in ESC[200~ and
  /// ESC[201~, and without it each line feed becomes a carriage return. An
  /// empty text without bracketed paste sends nothing.
  encodePaste(text: string): string {
    const data = new TextEncoder().encode(text);
    // The frame adds ESC[200~ and ESC[201~ at most.
    const cap = data.length + 12;
    const src = this.wasm.alloc(Math.max(data.length, 1));
    const buf = this.wasm.alloc(cap);
    const written = this.wasm.alloc(8);
    try {
      this.wasm.bytes().set(data, src);
      const bracketed = this.hasBracketedPaste() ? 1 : 0;
      const result = this.wasm.fn.ghostty_paste_encode(src, data.length, bracketed, buf, cap, written);
      if (result !== ABI.GhosttyResult.SUCCESS) throw new Error(`ghostty-vt: encoding a paste failed (${result})`);
      const len = this.wasm.view().getUint32(written, true);
      // The encoder replaces ASCII bytes with ASCII ones, so the UTF-8 it
      // returns decodes whole.
      return new TextDecoder().decode(this.wasm.bytes().slice(buf, buf + len));
    } finally {
      this.wasm.free(src, Math.max(data.length, 1));
      this.wasm.free(buf, cap);
      this.wasm.free(written, 8);
    }
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

  /// The text of the active screen in one core call, as a copy takes it:
  /// on the primary screen its history and then its rows, on the alternate
  /// screen its rows alone. It is the text the rows show: a blank cell is a
  /// space, a wide character appears once, a cluster whole; a row the
  /// program soft-wrapped joins the row it continues, as xterm.js copies,
  /// and a hard line break stays; each line's trailing spaces and the
  /// trailing blank rows go (other whitespace a program printed stays). A
  /// row-by-row read of the history costs a few wasm calls a cell; this is
  /// one formatter call for all of it. The text is built in the instance's
  /// memory, which keeps its high-water mark, so a long history's first copy
  /// grows the terminal's memory by about the text's size. With `range`, only
  /// those rows and columns; a range past the last row stops there. `null`
  /// when the core cannot format it.
  plainText(range?: TextRange): string | null {
    const fn = this.wasm.fn;
    const s = this.scratch;
    let selection = 0;
    let formatter = 0;
    try {
      if (range) {
        const last = this.getScrollbackLength() + this._rows - 1;
        if (Math.min(range.startRow, range.endRow) > last) return "";
        selection = this.selection(range, last);
        if (!selection) return null;
      }
      // A new formatter emits plain text of the whole screen. Its default
      // keeps a soft wrap as a line break, which pastes a wrapped command as
      // several, so unwrapping is set; trimming is its default and is set
      // too, since a copy's text depends on it. A range narrows it to the
      // selection, which the formatter copies.
      formatter = this.wasm.newHandle(
        (slot) => fn.ghostty_formatter_terminal_new(0, slot, this.handle),
        "formatter",
      );
      if (!this.setFormatterFlag(formatter, ABI.GhosttyFormatterOption.UNWRAP, true)) return null;
      if (!this.setFormatterFlag(formatter, ABI.GhosttyFormatterOption.TRIM, true)) return null;
      if (selection && fn.ghostty_formatter_set(formatter, ABI.GhosttyFormatterOption.SELECTION, selection) !== ABI.GhosttyResult.SUCCESS) {
        return null;
      }
      const result = fn.ghostty_formatter_format_alloc(formatter, 0, s + SCRATCH.slot, s + SCRATCH.slot2);
      if (result !== ABI.GhosttyResult.SUCCESS) return null;
      const ptr = this.wasm.view().getUint32(s + SCRATCH.slot, true);
      const len = this.wasm.view().getUint32(s + SCRATCH.slot2, true);
      // Empty output is a success with no buffer.
      if (!ptr) return "";
      try {
        return new TextDecoder().decode(this.wasm.bytes().subarray(ptr, ptr + len));
      } finally {
        fn.ghostty_free(0, ptr, len);
      }
    } catch {
      return null;
    } finally {
      if (formatter) fn.ghostty_formatter_free(formatter);
      this.wasm.free(selection, LAYOUT.GhosttySelection.size);
    }
  }

  /// Set the bool `option` of `formatter`; false when the core refuses it.
  private setFormatterFlag(formatter: number, option: number, on: boolean): boolean {
    const ptr = this.scratch + SCRATCH.slot;
    this.wasm.view().setUint8(ptr, on ? 1 : 0);
    return this.wasm.fn.ghostty_formatter_set(formatter, option, ptr) === ABI.GhosttyResult.SUCCESS;
  }

  /// A `GhosttySelection` over `range`, its rows clamped to `last`, in a
  /// block the caller frees; 0 when a corner is outside the screen.
  private selection(range: TextRange, last: number): number {
    const S = LAYOUT.GhosttySelection;
    const R = LAYOUT.GhosttyGridRef;
    const history = this.getScrollbackLength();
    const col = (x: number) => Math.max(0, Math.min(x, this._cols - 1));
    const corner = (x: number, row: number, at: number): boolean => {
      const y = Math.max(0, Math.min(row, last));
      const found =
        y < history
          ? this.gridRef(ABI.GhosttyPointTag.HISTORY, col(x), y)
          : this.gridRef(ABI.GhosttyPointTag.ACTIVE, col(x), y - history);
      if (found) {
        const from = this.scratch + SCRATCH.gridRef;
        this.wasm.bytes().copyWithin(at, from, from + R.size);
      }
      return found;
    };
    const sel = this.wasm.alloc(S.size);
    // Zeroed: not rectangular.
    this.wasm.bytes().fill(0, sel, sel + S.size);
    if (corner(range.startCol, range.startRow, sel + S.fields.start) && corner(range.endCol, range.endRow, sel + S.fields.end)) {
      return sel;
    }
    this.wasm.free(sel, S.size);
    return 0;
  }

  getScrollbackLength(): number {
    const ptr = this.scratch + SCRATCH.slot;
    this.wasm.fn.ghostty_terminal_get(this.handle, ABI.GhosttyTerminalData.SCROLLBACK_ROWS, ptr);
    return this.wasm.view().getUint32(ptr, true);
  }

  /// Whether row `row` continues the row above it, the meaning xterm's
  /// `isWrapped` has and ghostty-web's buffer API passes on.
  isRowWrapped(row: number): boolean {
    return this.continuesRowAbove(ABI.GhosttyPointTag.ACTIVE, row);
  }

  /// Whether history row `offset`, 0 the oldest, continues the row above
  /// it. ghostty-web's buffer reads every history row as unwrapped.
  isScrollbackRowWrapped(offset: number): boolean {
    return this.continuesRowAbove(ABI.GhosttyPointTag.HISTORY, offset);
  }

  private continuesRowAbove(tag: number, y: number): boolean {
    if (!this.gridRef(tag, 0, y)) return false;
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

  // ------------------------------------------------------------------
  // Search
  // ------------------------------------------------------------------

  /// A search of this terminal on the core's engine; see `VtSearch`.
  createSearch(): VtSearch {
    return new VtSearch(this.wasm, { handle: () => this.handle, changes: () => this.changes });
  }

  /// Tracks the cell at SCREEN row `row` and column `col` of the screen
  /// showing now (see `VtTrackedCell`); null when no such cell exists or the
  /// terminal was freed. The core bounds-checks the point, so a negative row
  /// or column, written unsigned, is outside the screen too.
  trackCell(row: number, col: number): VtTrackedCell | null {
    if (!this.handle) return null;
    const point = this.writePoint(ABI.GhosttyPointTag.SCREEN, col, row);
    const out = this.scratch + SCRATCH.slot;
    if (this.wasm.fn.ghostty_terminal_grid_ref_track(this.handle, point, out) !== ABI.GhosttyResult.SUCCESS) return null;
    const cell = new VtTrackedCell(this.wasm, this.cellOwner, this.wasm.view().getUint32(out, true));
    this.trackedCells.add(cell);
    return cell;
  }

  // ------------------------------------------------------------------
  // Replies to the program (DSR, DA, mode reports, ...)
  // ------------------------------------------------------------------

  queueReply(ptr: number, len: number): void {
    const reply = this.wasm.bytes().slice(ptr, ptr + len);
    if (isColorReport(reply) || isVersionReport(reply) || isKittyKeyboardReport(reply)) return;
    this.replies.push(reply);
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
    // Upstream also caps history in bytes, by default at one page (about a
    // thousand short lines at 80 columns), and the first cap reached wins.
    // SIZE_MAX, the wasm32 size_t's maximum, lifts the byte cap so the line
    // count the user's setting maps to holds; a null value would restore
    // the default.
    this.wasm.view().setUint32(s + SCRATCH.slot, 0xffff_ffff, true);
    fn.ghostty_terminal_set(this.handle, O.SCROLLBACK_MAX_BYTES, s + SCRATCH.slot);
    const lines = config?.scrollbackLimit ?? 10_000;
    if (lines > 0) {
      this.wasm.view().setUint32(s + SCRATCH.slot, lines, true);
      fn.ghostty_terminal_set(this.handle, O.SCROLLBACK_MAX_LINES, s + SCRATCH.slot);
    } else {
      fn.ghostty_terminal_set(this.handle, O.SCROLLBACK_MAX_LINES, 0);
    }
    this.writeColors(config);
  }

  /// Writes `config`'s colors as the core's defaults; zero keeps the
  /// built-in default, as in ghostty-web's binding.
  private writeColors(config?: VtTerminalConfig): void {
    const fn = this.wasm.fn;
    const s = this.scratch;
    const O = ABI.GhosttyTerminalOption;
    const setColor = (option: number, rgb: number) => {
      const view = this.wasm.view();
      view.setUint8(s + SCRATCH.rgb, (rgb >> 16) & 0xff);
      view.setUint8(s + SCRATCH.rgb + 1, (rgb >> 8) & 0xff);
      view.setUint8(s + SCRATCH.rgb + 2, rgb & 0xff);
      fn.ghostty_terminal_set(this.handle, option, s + SCRATCH.rgb);
    };
    setColor(O.COLOR_FOREGROUND, config?.fgColor || DEFAULT_FG);
    setColor(O.COLOR_BACKGROUND, config?.bgColor || DEFAULT_BG);
    // A null value clears the cursor color and puts the built-in palette
    // back, so on a live terminal a color the config leaves at zero takes
    // upstream's default rather than the one an earlier config wrote.
    if (config?.cursorColor) setColor(O.COLOR_CURSOR, config.cursorColor);
    else fn.ghostty_terminal_set(this.handle, O.COLOR_CURSOR, 0);
    fn.ghostty_terminal_set(this.handle, O.COLOR_PALETTE, 0);
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

  /// Writes the key and value arrays of the multi-get calls a row's read
  /// makes, which stay put: the row's raw cells and its cells handle, and a
  /// cell's style and cluster.
  private writeMultiArgs(): void {
    const view = this.wasm.view();
    const s = this.scratch;
    view.setInt32(s + SCRATCH.rowKeys, ABI.GhosttyRenderStateRowData.CELLS_RAW, true);
    view.setInt32(s + SCRATCH.rowKeys + 4, ABI.GhosttyRenderStateRowData.CELLS, true);
    view.setUint32(s + SCRATCH.rowValues, s + SCRATCH.cellsView, true);
    view.setUint32(s + SCRATCH.rowValues + 4, s + SCRATCH.rowCells, true);
    view.setUint32(s + SCRATCH.rowCells, this.rowCells, true);
    view.setInt32(s + SCRATCH.cellKeys, ABI.GhosttyRenderStateRowCellsData.STYLE, true);
    view.setInt32(s + SCRATCH.cellKeys + 4, ABI.GhosttyRenderStateRowCellsData.GRAPHEMES_BUF, true);
    view.setUint32(s + SCRATCH.cellValues, s + SCRATCH.style, true);
    view.setUint32(s + SCRATCH.cellValues + 4, s + SCRATCH.codepoints, true);
  }

  /// Updates the render state when a write, a resize or new colours changed
  /// the terminal since its last update, and adds what the update reports
  /// changed to what changed since the last `endFrame`. The core keeps its
  /// own dirty state across updates until `endFrame` cleans it, so its dirty
  /// iteration lists every row changed since then. It reports the whole
  /// screen changed after a resize, a switch of screens, new colours and
  /// output that scrolled.
  private sync(): void {
    if (!this.stale || !this.handle) return;
    this.stale = false;
    this.generation++;
    const fn = this.wasm.fn;
    const s = this.scratch;
    const D = ABI.GhosttyRenderStateDirty;
    fn.ghostty_render_state_update(this.renderState, this.handle);
    fn.ghostty_render_state_get(this.renderState, ABI.GhosttyRenderStateData.DIRTY, s + SCRATCH.slot);
    let dirty = this.wasm.view().getInt32(s + SCRATCH.slot, true);
    // Every cell's colours resolve against the defaults and the palette read
    // here, so a change to them repaints every row whatever the core says.
    if (this.readColors()) dirty = D.FULL;
    if (dirty === D.PARTIAL) this.readDirtyRows();
    if (dirty > this.dirty) this.dirty = dirty;
    // The update moved the rows the iterator was filled with.
    this.iteratorGeneration = -1;
  }

  /// Marks the rows the core's dirty iteration lists.
  private readDirtyRows(): void {
    const fn = this.wasm.fn;
    const s = this.scratch;
    this.wasm.view().setUint32(s + SCRATCH.slot, this.rowIterator, true);
    fn.ghostty_render_state_get(this.renderState, ABI.GhosttyRenderStateData.ROW_ITERATOR, s + SCRATCH.slot);
    while (fn.ghostty_render_state_row_iterator_next_dirty(this.rowIterator, s + SCRATCH.dirtyY)) {
      const y = this.wasm.view().getUint16(s + SCRATCH.dirtyY, true);
      if (y < this.rowDirty.length) this.rowDirty[y] = 1;
    }
  }

  /// Moves the row iterator to screen row `y`, filling it again when the
  /// render state was updated since or the row is above it; rows are read
  /// top to bottom in a frame, so a frame steps it down the screen once.
  private seekRow(y: number): boolean {
    const fn = this.wasm.fn;
    if (this.iteratorGeneration !== this.generation || y < this.iteratorRow) {
      const s = this.scratch;
      this.wasm.view().setUint32(s + SCRATCH.slot, this.rowIterator, true);
      fn.ghostty_render_state_get(this.renderState, ABI.GhosttyRenderStateData.ROW_ITERATOR, s + SCRATCH.slot);
      this.iteratorGeneration = this.generation;
      this.iteratorRow = -1;
    }
    while (this.iteratorRow < y) {
      if (!fn.ghostty_render_state_row_iterator_next(this.rowIterator)) {
        this.iteratorGeneration = -1;
        return false;
      }
      this.iteratorRow++;
    }
    return true;
  }

  /// A cell nothing was written to, in the default colours.
  private blank(cell: VtCell): void {
    cell.codepoint = 0;
    cell.cluster = null;
    cell.width = 1;
    cell.flags = 0;
    cell.fg = this.fg;
    cell.bg = this.bg;
    cell.hyperlink = 0;
  }

  /// A cell from its raw value, `lo` and `hi`, with no style yet: its text,
  /// its width, its link and the default colours. Keeps the value's content
  /// tag and content for the reader's next steps, decoding each field once,
  /// and returns its style id.
  private rawCell(cell: VtCell, lo: number, hi: number): number {
    const T = ABI.GhosttyCellContentTag;
    const tag = cellBits(lo, hi, CELL_BITS.content_tag);
    const content = cellBits(lo, hi, CELL_BITS.content);
    this.rawTag = tag;
    this.rawContent = content;
    cell.codepoint = tag === T.CODEPOINT || tag === T.CODEPOINT_GRAPHEME ? content & 0x1fffff : 0;
    cell.cluster = null;
    cell.width = cellWidth(cellBits(lo, hi, CELL_BITS.wide));
    cell.flags = 0;
    cell.fg = this.fg;
    cell.bg = this.bg;
    cell.hyperlink = cellBits(lo, hi, CELL_BITS.hyperlink);
    return cellBits(lo, hi, CELL_BITS.style_id);
  }

  /// The background a cell with no text carries in its raw value (the one
  /// `rawCell` read last), over its style's.
  private contentBackground(cell: VtCell): void {
    const T = ABI.GhosttyCellContentTag;
    if (this.rawTag === T.BG_COLOR_PALETTE) {
      cell.bg = this.paletteColor(this.rawContent & 0xff);
    } else if (this.rawTag === T.BG_COLOR_RGB) {
      const c = this.rawContent;
      cell.bg = ((c & 0xff) << 16) | (c & 0xff00) | ((c >>> 16) & 0xff);
    }
  }

  /// The slot of style `id` among the styles this row's read has met, or -1.
  private knownStyle(id: number): number {
    for (let i = 0; i < this.styleCount; i++) if (this.styleIds[i] === id) return i;
    return -1;
  }

  /// Keeps the `GhosttyStyle` at `ptr` as style `id`, resolved against the
  /// palette and the defaults, and returns its slot. Past ROW_STYLES styles
  /// in a row the last slot serves each new one in turn.
  private rememberStyle(id: number, view: DataView, ptr: number): number {
    const L = LAYOUT.GhosttyStyle.fields;
    const slot = this.styleCount < ROW_STYLES ? this.styleCount++ : ROW_STYLES - 1;
    this.styleIds[slot] = id;
    this.styleFlags[slot] = view.getUint16(ptr + L.flags, true);
    this.styleFg[slot] = this.styleColor(view, ptr + L.fg_color) ?? this.fg;
    this.styleBg[slot] = this.styleColor(view, ptr + L.bg_color) ?? this.bg;
    return slot;
  }

  private applyStyle(cell: VtCell, slot: number): void {
    cell.flags = this.styleFlags[slot];
    cell.fg = this.styleFg[slot];
    cell.bg = this.styleBg[slot];
  }

  /// Points the codepoint buffer of a cell's multi-get at the scratch room.
  private clearCodepoints(): void {
    const B = LAYOUT.GhosttyCodepointBuffer.fields;
    const view = this.wasm.view();
    const cb = this.scratch + SCRATCH.codepoints;
    view.setUint32(cb + B.ptr, this.scratch + SCRATCH.graphemes, true);
    view.setUint32(cb + B.cap, GRAPHEME_CAP, true);
    view.setUint32(cb + B.len, 0, true);
  }

  /// The codepoints a cell's multi-get wrote to the scratch room.
  private scratchCodepoints(): number[] {
    const B = LAYOUT.GhosttyCodepointBuffer.fields;
    const view = this.wasm.view();
    const len = Math.min(view.getUint32(this.scratch + SCRATCH.codepoints + B.len, true), GRAPHEME_CAP);
    const cps: number[] = [];
    for (let i = 0; i < len; i++) cps.push(view.getUint32(this.scratch + SCRATCH.graphemes + i * 4, true));
    return cps;
  }

  /// Reads the default colors and the palette; true when any of them
  /// differs from the last read.
  private readColors(): boolean {
    const s = this.scratch;
    const C = LAYOUT.GhosttyRenderStateColors;
    const ptr = s + SCRATCH.colors;
    this.wasm.view().setUint32(ptr + C.fields.size, C.size, true);
    this.wasm.fn.ghostty_render_state_get(this.renderState, ABI.GhosttyRenderStateData.COLORS, ptr);
    const view = this.wasm.view();
    const bg = readRgb(view, ptr + C.fields.background);
    const fg = readRgb(view, ptr + C.fields.foreground);
    const palette = this.wasm.bytes().subarray(ptr + C.fields.palette, ptr + C.fields.palette + 768);
    let changed = bg !== this.bg || fg !== this.fg;
    for (let i = 0; i < 768 && !changed; i++) changed = palette[i] !== this.palette[i];
    this.bg = bg;
    this.fg = fg;
    if (changed) this.palette.set(palette);
    return changed;
  }

  /// Points the scratch grid ref at a cell; false when the point is
  /// outside the screen.
  private gridRef(tag: number, x: number, y: number): boolean {
    const point = this.writePoint(tag, x, y);
    return this.wasm.fn.ghostty_terminal_grid_ref(this.handle, point, this.scratch + SCRATCH.gridRef) === ABI.GhosttyResult.SUCCESS;
  }

  /// Writes a `GhosttyPoint` to the scratch area and returns its address; a
  /// point is passed by value, which wasm32 does by address.
  private writePoint(tag: number, x: number, y: number): number {
    const view = this.wasm.view();
    const point = this.scratch + SCRATCH.point;
    const coord = point + LAYOUT.GhosttyPoint.fields.value;
    view.setInt32(point + LAYOUT.GhosttyPoint.fields.tag, tag, true);
    view.setUint16(coord + LAYOUT.GhosttyPointCoordinate.fields.x, x, true);
    view.setUint32(coord + LAYOUT.GhosttyPointCoordinate.fields.y, y, true);
    return point;
  }

  /// The 0xRRGGBB of the `GhosttyStyleColor` at `ptr`, or null when it
  /// names no colour.
  private styleColor(view: DataView, ptr: number): number | null {
    const C = LAYOUT.GhosttyStyleColor.fields;
    const tag = view.getUint8(ptr + C.tag);
    if (tag === ABI.GhosttyStyleColorTag.PALETTE) return this.paletteColor(view.getUint8(ptr + C.value));
    if (tag === ABI.GhosttyStyleColorTag.RGB) return readRgb(view, ptr + C.value);
    return null;
  }

  private paletteColor(index: number): number {
    const p = this.palette;
    return (p[index * 3] << 16) | (p[index * 3 + 1] << 8) | p[index * 3 + 2];
  }

  /// The codepoints of a cluster, base first, through `read`, which fills
  /// up to `cap` of them at `buf` and reports the result and the cluster's
  /// length. The scratch room serves a cluster that fits it; a longer one
  /// is read again into a buffer of its own.
  private cluster(read: (buf: number, cap: number) => [result: number, len: number]): number[] | null {
    let want = GRAPHEME_CAP;
    for (let attempt = 0; attempt < 2; attempt++) {
      const cap = want;
      const own = cap > GRAPHEME_CAP ? this.wasm.alloc(cap * 4) : 0;
      const buf = own || this.scratch + SCRATCH.graphemes;
      try {
        const [result, len] = read(buf, cap);
        if (result === ABI.GhosttyResult.OUT_OF_SPACE && len > cap) {
          want = len;
          continue;
        }
        if (result !== ABI.GhosttyResult.SUCCESS || len === 0) return null;
        const view = this.wasm.view();
        const cps: number[] = [];
        for (let i = 0; i < Math.min(len, cap); i++) cps.push(view.getUint32(buf + i * 4, true));
        return cps;
      } finally {
        this.wasm.free(own, cap * 4);
      }
    }
    return null;
  }

  /// The cluster of the row cells iterator's current cell.
  private rowCellCluster(): number[] | null {
    const B = LAYOUT.GhosttyCodepointBuffer.fields;
    const cb = this.scratch + SCRATCH.codepoints;
    return this.cluster((buf, cap) => {
      const view = this.wasm.view();
      view.setUint32(cb + B.ptr, buf, true);
      view.setUint32(cb + B.cap, cap, true);
      view.setUint32(cb + B.len, 0, true);
      const result = this.wasm.fn.ghostty_render_state_row_cells_get(
        this.rowCells, ABI.GhosttyRenderStateRowCellsData.GRAPHEMES_BUF, cb,
      );
      return [result, this.wasm.view().getUint32(cb + B.len, true)];
    });
  }

  /// The full cluster at the scratch grid ref, base codepoint first.
  private gridGraphemes(): string | null {
    const s = this.scratch;
    const cps = this.cluster((buf, cap) => {
      const result = this.wasm.fn.ghostty_grid_ref_graphemes(s + SCRATCH.gridRef, buf, cap, s + SCRATCH.slot);
      return [result, this.wasm.view().getUint32(s + SCRATCH.slot, true)];
    });
    return cps ? String.fromCodePoint(...cps) : null;
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

/// A match of a `VtSearch` as rows and columns, both ends included. Rows
/// are SCREEN rows: 0 is the oldest history row and the active rows follow,
/// the numbering of ghostty-web's `absoluteRow` and of `TextRange`; the
/// alternate screen has no history, so there they are its rows. A range is
/// a reading of one moment: a write, a resize or a reset moves rows, and
/// the search reads the current rows again after its next feed.
export type MatchRange = { startRow: number; startCol: number; endRow: number; endCol: number };

/// What a find bar shows of a search. `index` counts from the newest match,
/// 0 the newest, the order of `VtSearch.matchesBetween`, so the bar reads
/// `index + 1` of `total`; it and `active` are null while nothing is
/// selected. `complete` means the scan has caught up with the terminal as
/// of the last feed, which a later write undoes until the next one.
export type SearchState = { total: number; index: number | null; active: MatchRange | null; complete: boolean };

/// Byte offsets of the scratch area each search keeps for out parameters.
const SEARCH_SCRATCH = {
  slot: 0, // u32: a status, a count or an index
  scroll: 4, // GhosttySearchScroll
  coord: 8, // GhosttyPointCoordinate (8 bytes)
  selection: 16, // GhosttySelection (20 bytes)
  buffer: 36, // GhosttySelectionBuffer (12 bytes)
  size: 48,
} as const;

/// What a search reads of its terminal: the core's handle, 0 once the
/// terminal was freed, and the count of writes and resizes it has taken.
type SearchTerminal = { handle(): number; changes(): number };

/// A search of a `VtTerminal` for a string on the core's own engine, over
/// the rows and the history of the screen the program shows. The scan is
/// incremental (`step`), learns of writes through `feed`, and lists matches
/// newest first for a "k of n" count. Create one with
/// `VtTerminal.createSearch()` and `free` it when the find bar closes; the
/// terminal may be freed first, after which the search reports nothing.
export class VtSearch {
  private readonly wasm: VtWasm;
  private readonly terminal: SearchTerminal;
  private handle: number;
  private readonly scratch: number;
  /// The terminal's change count at the last feed. A match the core hands
  /// out is a snapshot into the terminal's pages as of that feed, which a
  /// later write may have moved or pruned, so a read after a change feeds
  /// first rather than resolve a stale snapshot.
  private fed: number;
  private needle = "";
  /// Milliseconds the unit of `step` that last completed a scan took, on
  /// the clock `step` was given; null until a scan completes in `step`. The
  /// core checks every match it holds against the terminal's pages as a
  /// scan completes, and again on each later feed and select while the scan
  /// stays complete, a cost that grows with the matches times the pages of
  /// history; this unit is its measure.
  completingUnitMs: number | null = null;

  constructor(wasm: VtWasm, terminal: SearchTerminal) {
    this.wasm = wasm;
    this.terminal = terminal;
    this.scratch = wasm.alloc(SEARCH_SCRATCH.size);
    try {
      this.handle = wasm.newHandle((slot) => wasm.fn.ghostty_search_new(0, slot, terminal.handle()), "search");
    } catch (error) {
      // A terminal outlives many searches, each find bar opening makes one,
      // so a search the core fails to make gives its block back.
      wasm.free(this.scratch, SEARCH_SCRATCH.size);
      throw error;
    }
    this.fed = terminal.changes();
    // ghostty-web scrolls in JS and upstream's viewport never moves, so the
    // render state this binding reads is the active screen (see
    // `VtTerminal`). The core's default policy, IF_NEEDED, scrolls that
    // viewport to a selected match in history, and the render state then
    // shows history rows as the active screen, where every later write
    // lands too. The find bar scrolls ghostty-web to the match instead.
    const scroll = this.scratch + SEARCH_SCRATCH.scroll;
    wasm.view().setInt32(scroll, ABI.GhosttySearchScroll.NONE, true);
    const result = wasm.fn.ghostty_search_set(this.handle, ABI.GhosttySearchOption.SELECT_SCROLL, scroll);
    if (result !== ABI.GhosttyResult.SUCCESS) {
      this.free();
      throw new Error(`ghostty-vt: setting the search's scroll policy failed (${result})`);
    }
  }

  /// Sets the text to look for. A new needle drops the results and leaves
  /// the search waiting for a feed, so `step` scans again from scratch; the
  /// same needle again keeps them, so a find bar can resubmit freely. The
  /// core compares bytes, with ASCII letters case-insensitively and nothing
  /// else folded: `error` matches `ERROR`, `élan` does not match `Élan`.
  /// An empty needle returns the search to idle: no matches, no selection,
  /// complete.
  setNeedle(needle: string): void {
    if (!this.live()) return;
    const S = LAYOUT.GhosttyString;
    const bytes = new TextEncoder().encode(needle);
    // One block: the `GhosttyString` header, then the bytes it points at,
    // which the core copies. A null string clears the needle.
    const len = bytes.length ? S.size + bytes.length : 0;
    const str = len ? this.wasm.alloc(len) : 0;
    try {
      if (str) {
        this.wasm.bytes().set(bytes, str + S.size);
        const view = this.wasm.view();
        view.setUint32(str + S.fields.ptr, str + S.size, true);
        view.setUint32(str + S.fields.len, bytes.length, true);
      }
      this.check("setting the needle", this.wasm.fn.ghostty_search_set(this.handle, ABI.GhosttySearchOption.NEEDLE, str));
      this.needle = needle;
    } finally {
      this.wasm.free(str, len);
    }
  }

  /// Drops the results and scans again from scratch for the same needle,
  /// as a new needle does: nothing is selected, and `step` scans from the
  /// newest output up in budgeted units. Cheap however many matches the
  /// search held.
  restart(): void {
    const needle = this.needle;
    if (!needle) return;
    this.setNeedle("");
    // Kept before the set, so a set that fails leaves the next restart
    // something to set again.
    this.needle = needle;
    this.setNeedle(needle);
  }

  /// Works toward a complete scan for about `budgetMs` milliseconds on
  /// `now` (`performance.now` unless given): a feed when the search needs
  /// the terminal, a tick while it has copied data to scan, at least one of
  /// either, until the scan is complete or the budget is spent. "running"
  /// asks for another call. "complete" means caught up with the terminal as
  /// of the last feed; a later write needs another feed.
  step(budgetMs: number, now: () => number = () => performance.now()): "running" | "complete" {
    if (!this.live()) return "complete";
    const S = ABI.GhosttySearchStatus;
    let unitStart = now();
    const deadline = unitStart + budgetMs;
    let status = this.status();
    while (status !== S.COMPLETE) {
      if (status === S.FEED_REQUIRED) this.feed();
      else this.check("scanning", this.wasm.fn.ghostty_search_tick(this.handle, 0));
      status = this.status();
      const unitEnd = now();
      if (status === S.COMPLETE) this.completingUnitMs = unitEnd - unitStart;
      if (unitEnd >= deadline) break;
      unitStart = unitEnd;
    }
    return status === S.COMPLETE ? "complete" : "running";
  }

  /// Reads the terminal's changes since the last feed into the search: new
  /// output, pruned history, a switch of screens. The only way the search
  /// learns of a write. Bounded work, which can leave the search running;
  /// `step` finishes it.
  feed(): void {
    if (!this.live()) return;
    this.fed = this.terminal.changes();
    this.check("feeding", this.wasm.fn.ghostty_search_feed(this.handle));
  }

  /// Selects the next match toward older output: the newest match first,
  /// then up through the history, wrapping from the oldest to the newest.
  /// Feeds the terminal's changes first and selects among the matches found
  /// so far: right after a needle change those are the newest ones, and the
  /// selection stays on its match while `step` completes the scan. False
  /// when there is no match.
  selectNext(): boolean {
    return this.select(true);
  }

  /// Selects the next match toward newer output, wrapping from the newest
  /// to the oldest; otherwise as `selectNext`.
  selectPrev(): boolean {
    return this.select(false);
  }

  /// Whether the scan had caught up with the terminal as of the last feed,
  /// read without feeding: a reader deciding how to bring the search up to
  /// date asks this first. After the terminal was freed: true.
  caughtUp(): boolean {
    if (!this.live()) return true;
    return this.status() === ABI.GhosttySearchStatus.COMPLETE;
  }

  /// The count, the selected match and whether the scan is complete. When
  /// the terminal changed since the last feed this feeds first, so the
  /// range is never read from a snapshot the change invalidated. After the
  /// terminal was freed: no matches, nothing selected, complete.
  state(): SearchState {
    if (!this.live()) return { total: 0, index: null, active: null, complete: true };
    this.catchUp();
    const D = ABI.GhosttySearchData;
    const selection = this.scratch + SEARCH_SCRATCH.selection;
    const selected = this.wasm.fn.ghostty_search_get(this.handle, D.SELECTED_MATCH, selection) === ABI.GhosttyResult.SUCCESS;
    return {
      total: this.count(D.TOTAL_MATCHES) ?? 0,
      index: this.count(D.SELECTED_INDEX),
      active: selected ? this.range(selection) : null,
      complete: this.status() === ABI.GhosttySearchStatus.COMPLETE,
    };
  }

  /// The matches whose rows touch `firstRow` to `lastRow`, newest first, at
  /// most `cap` of them. Feeds first when the terminal changed, as `state`
  /// does. The core lists every match of the screen newest first; this
  /// places each one until the rows fall above the window, so a window high
  /// in a long history costs a placement per match below it.
  matchesBetween(firstRow: number, lastRow: number, cap: number): MatchRange[] {
    const found: MatchRange[] = [];
    if (cap <= 0 || !this.live()) return found;
    const F = LAYOUT.GhosttySelection.fields;
    this.eachMatch((sel) => {
      const start = this.screenPoint(sel + F.start);
      // Newer than the window: the match starts below it.
      if (!start || start.y > lastRow) return true;
      const end = this.screenPoint(sel + F.end);
      if (!end) return true;
      // Older than the window, and every match after it is older still.
      if (end.y < firstRow) return false;
      found.push({ startRow: start.y, startCol: start.x, endRow: end.y, endCol: end.x });
      return found.length < cap;
    });
    return found;
  }

  /// The index of the match that starts at SCREEN row `row` and column
  /// `col`, counted as `SearchState.index` is (0 the newest) among the
  /// matches found so far; null when none starts there. Feeds first when the
  /// terminal changed, as `state` does. It places matches from the newest
  /// until it reaches the cell, so a match high in a long history costs a
  /// placement per match below it.
  indexOfMatchAt(row: number, col: number): number | null {
    if (!this.live()) return null;
    const F = LAYOUT.GhosttySelection.fields;
    let index: number | null = null;
    this.eachMatch((sel, i) => {
      const start = this.screenPoint(sel + F.start);
      // Newer than the cell: below its row, or right of it on the row,
      // since the core lists a row's matches right to left.
      if (!start || start.y > row || (start.y === row && start.x > col)) return true;
      if (start.y === row && start.x === col) index = i;
      return false;
    });
    return index;
  }

  /// Releases the search. Safe after the terminal was freed, and again
  /// after itself.
  free(): void {
    if (!this.handle) return;
    this.wasm.fn.ghostty_search_free(this.handle);
    this.wasm.free(this.scratch, SEARCH_SCRATCH.size);
    this.handle = 0;
  }

  /// Whether the search and its terminal are both still allocated. The
  /// core detaches a search when its terminal is freed: every call that
  /// reads the terminal then fails, and the match snapshots the search still
  /// holds point into freed pages.
  private live(): boolean {
    return this.handle !== 0 && this.terminal.handle() !== 0;
  }

  private check(what: string, result: number): void {
    if (result !== ABI.GhosttyResult.SUCCESS) throw new Error(`ghostty-vt: ${what} of a search failed (${result})`);
  }

  /// Feeds when the terminal changed since the last feed.
  private catchUp(): void {
    if (this.fed !== this.terminal.changes()) this.feed();
  }

  /// Calls `visit` with the address of each match's `GhosttySelection` and
  /// its index, newest first, until it returns false. The core copies the
  /// list into a block that lives for the call. Feeds first when the
  /// terminal changed.
  private eachMatch(visit: (sel: number, index: number) => boolean): void {
    this.catchUp();
    const S = LAYOUT.GhosttySelection;
    const B = LAYOUT.GhosttySelectionBuffer.fields;
    const buf = this.scratch + SEARCH_SCRATCH.buffer;
    const list = (ptr: number, capacity: number): number => {
      const view = this.wasm.view();
      view.setUint32(buf + B.ptr, ptr, true);
      view.setUint32(buf + B.cap, capacity, true);
      view.setUint32(buf + B.len, 0, true);
      return this.wasm.fn.ghostty_search_get(this.handle, ABI.GhosttySearchData.MATCHES, buf);
    };
    // A null buffer asks how many there are; none is a success.
    const asked = list(0, 0);
    if (asked === ABI.GhosttyResult.SUCCESS) return;
    if (asked !== ABI.GhosttyResult.OUT_OF_SPACE) this.check("counting the matches", asked);
    const count = this.wasm.view().getUint32(buf + B.len, true);
    const arr = this.wasm.alloc(count * S.size);
    try {
      this.check("listing the matches", list(arr, count));
      const len = this.wasm.view().getUint32(buf + B.len, true);
      for (let i = 0; i < len; i++) if (!visit(arr + i * S.size, i)) break;
    } finally {
      this.wasm.free(arr, count * S.size);
    }
  }

  private status(): number {
    const out = this.scratch + SEARCH_SCRATCH.slot;
    this.check("reading the status", this.wasm.fn.ghostty_search_get(this.handle, ABI.GhosttySearchData.STATUS, out));
    return this.wasm.view().getUint32(out, true);
  }

  /// A `size_t` field of the search, null when it has no value.
  private count(data: number): number | null {
    const out = this.scratch + SEARCH_SCRATCH.slot;
    const result = this.wasm.fn.ghostty_search_get(this.handle, data, out);
    if (result === ABI.GhosttyResult.NO_VALUE) return null;
    this.check("reading a count", result);
    return this.wasm.view().getUint32(out, true);
  }

  private select(older: boolean): boolean {
    if (!this.live()) return false;
    // The core brings the search up to date with the terminal first.
    this.fed = this.terminal.changes();
    const fn = this.wasm.fn;
    const result = older ? fn.ghostty_search_select_next(this.handle) : fn.ghostty_search_select_prev(this.handle);
    if (result === ABI.GhosttyResult.NO_VALUE) return false;
    this.check("selecting a match", result);
    return true;
  }

  /// The SCREEN rows and columns of the `GhosttySelection` at `sel`, null
  /// when the core cannot place an end on the screen.
  private range(sel: number): MatchRange | null {
    const F = LAYOUT.GhosttySelection.fields;
    const start = this.screenPoint(sel + F.start);
    const end = start && this.screenPoint(sel + F.end);
    return start && end ? { startRow: start.y, startCol: start.x, endRow: end.y, endCol: end.x } : null;
  }

  /// The SCREEN coordinate of the cell the grid reference at `ref` names,
  /// null when the core cannot place it there.
  private screenPoint(ref: number): { x: number; y: number } | null {
    const out = this.scratch + SEARCH_SCRATCH.coord;
    const result = this.wasm.fn.ghostty_terminal_point_from_grid_ref(
      this.terminal.handle(), ref, ABI.GhosttyPointTag.SCREEN, out,
    );
    if (result !== ABI.GhosttyResult.SUCCESS) return null;
    const view = this.wasm.view();
    const C = LAYOUT.GhosttyPointCoordinate.fields;
    return { x: view.getUint16(out + C.x, true), y: view.getUint32(out + C.y, true) };
  }
}

/// A cell's place as SCREEN row and column, the numbering of `MatchRange`.
export type CellPoint = { row: number; col: number };

/// What a tracked cell reads of its terminal: the core handle; a
/// `GhosttyPoint` for a SCREEN row and column, written to the terminal's
/// scratch area; an out slot for a coordinate there; and the call that
/// forgets a freed cell. The terminal frees its cells before itself, so a
/// cell that still has its reference has a live terminal.
type TrackedCellOwner = {
  handle(): number;
  point(row: number, col: number): number;
  coordinate(): number;
  release(cell: VtTrackedCell): void;
};

/// A cell of a terminal that the core keeps track of (libghostty-vt's tracked
/// grid reference). An untracked reference names a cell only until the next
/// change to the terminal; this one moves with its cell's text through new
/// output, pruned history and a resize's reflow, so `point` reads where that
/// text is now. A resize that crops rather than reflows (the alternate
/// screen's) leaves a cell past the new last column on the row's last
/// column. It belongs to the screen it was set on, primary or alternate.
/// Make one with `VtTerminal.trackCell` and `free` it; a terminal frees the
/// cells still tracked on it when it is freed.
export class VtTrackedCell {
  private readonly wasm: VtWasm;
  private readonly owner: TrackedCellOwner;
  private ref: number;

  constructor(wasm: VtWasm, owner: TrackedCellOwner, ref: number) {
    this.wasm = wasm;
    this.owner = owner;
    this.ref = ref;
  }

  /// Where the cell is now; null once its row was pruned from the history,
  /// or the cell or its terminal was freed.
  point(): CellPoint | null {
    if (!this.ref) return null;
    const out = this.owner.coordinate();
    const result = this.wasm.fn.ghostty_tracked_grid_ref_point(this.ref, ABI.GhosttyPointTag.SCREEN, out);
    if (result !== ABI.GhosttyResult.SUCCESS) return null;
    const view = this.wasm.view();
    const C = LAYOUT.GhosttyPointCoordinate.fields;
    return { row: view.getUint32(out + C.y, true), col: view.getUint16(out + C.x, true) };
  }

  /// Tracks the cell at SCREEN row `row` and column `col` of the screen
  /// showing now instead; false when no such cell exists, and then the cell
  /// tracked before stays.
  moveTo(row: number, col: number): boolean {
    if (!this.ref) return false;
    const point = this.owner.point(row, col);
    return this.wasm.fn.ghostty_tracked_grid_ref_set(this.ref, this.owner.handle(), point) === ABI.GhosttyResult.SUCCESS;
  }

  /// Stops tracking. Safe after the terminal was freed, and again after
  /// itself.
  free(): void {
    if (!this.ref) return;
    this.wasm.fn.ghostty_tracked_grid_ref_free(this.ref);
    this.ref = 0;
    this.owner.release(this);
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

  /// Takes ghostty-web's option numbering, as its input handler calls it.
  setOption(option: number, value: boolean | number): void {
    const upstream = upstreamKeyEncoderOption(option);
    if (upstream === undefined) throw new Error(`ghostty-vt: unknown key encoder option ${option}`);
    this.set(upstream, value);
  }

  setKittyFlags(flags: number): void {
    this.set(ABI.GhosttyKeyEncoderOption.KITTY_FLAGS, flags);
  }

  /// Every option set here is one byte: a `bool`, or the kitty flags'
  /// `GhosttyKittyKeyFlags`.
  private set(option: number, value: boolean | number): void {
    const ptr = this.wasm.alloc(1);
    try {
      this.wasm.bytes()[ptr] = typeof value === "boolean" ? (value ? 1 : 0) : value;
      const result = this.wasm.fn.ghostty_key_encoder_set(this.encoder, option, ptr);
      if (result !== ABI.GhosttyResult.SUCCESS) {
        throw new Error(`ghostty-vt: setting key encoder option ${option} failed (${result})`);
      }
    } finally {
      this.wasm.free(ptr, 1);
    }
  }

  encode(event: { action: number; key: number; mods: number; utf8?: string }): Uint8Array {
    const fn = this.wasm.fn;
    const ev = this.wasm.newHandle((slot) => fn.ghostty_key_event_new(0, slot), "key event");
    // One block: the `GhosttyString` header, then the bytes it points at.
    let text = 0;
    let textLen = 0;
    const set = (what: string, result: number) => {
      if (result !== ABI.GhosttyResult.SUCCESS) throw new Error(`ghostty-vt: setting a key event's ${what} failed (${result})`);
    };
    try {
      set("action", fn.ghostty_key_event_set_action(ev, event.action));
      set("key", fn.ghostty_key_event_set_key(ev, upstreamKey(event.key)));
      set("mods", fn.ghostty_key_event_set_mods(ev, event.mods));
      if (event.utf8) {
        const bytes = new TextEncoder().encode(event.utf8);
        const S = LAYOUT.GhosttyString;
        textLen = S.size + bytes.length;
        text = this.wasm.alloc(textLen);
        this.wasm.bytes().set(bytes, text + S.size);
        const view = this.wasm.view();
        view.setUint32(text + S.fields.ptr, text + S.size, true);
        view.setUint32(text + S.fields.len, bytes.length, true);
        // The string is passed by value, which wasm32 does by address.
        set("text", fn.ghostty_key_event_set_utf8(ev, text));
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
      // The event borrows the text until it is freed.
      fn.ghostty_key_event_free(ev);
      this.wasm.free(text, textLen);
    }
  }

  dispose(): void {
    if (this.encoder) {
      this.wasm.fn.ghostty_key_encoder_free(this.encoder);
      this.encoder = 0;
    }
  }
}

/// A span of a terminal's rows and columns between two corners, both
/// included, either one first. Rows count the history first, 0 its oldest
/// row, and then the screen's rows, the way ghostty-web's selection numbers
/// them.
export type TextRange = { startCol: number; startRow: number; endCol: number; endRow: number };

/// What Copy scrollback reads of a ghostty-web terminal.
export type ScrollbackSource = {
  readonly wasmTerm?: unknown;
  readonly buffer: {
    readonly active: {
      readonly length: number;
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
};

/// Copy scrollback's text of a ghostty terminal, without what the screen
/// does not draw (`copiedText`). The binding's terminal formats its history
/// and rows in one core call (`VtTerminal.plainText`), where reading them
/// through ghostty-web's buffer costs a few wasm calls a cell and blocks the
/// page for seconds over a long history. Any other terminal, or a format
/// that fails, is read row by row through the buffer.
export function ghosttyScrollbackText(term: ScrollbackSource): string {
  const text = term.wasmTerm instanceof VtTerminal ? term.wasmTerm.plainText() : null;
  if (text !== null) return copiedText(text);
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buf.length; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? "");
  return copiedText(lines.join("\n").trimEnd());
}
