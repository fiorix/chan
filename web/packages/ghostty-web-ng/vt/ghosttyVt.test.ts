import { readFileSync } from "node:fs";
import { Key, KeyEncoderOption, type GhosttyCell } from "@chan/ghostty-web-ng";
import { beforeAll, describe, expect, test } from "vitest";
import {
  ORACLE_FIXTURE,
  fixtureRow,
  keyText,
  type Attr,
  type FixtureKeyEvent,
  type OracleFixture,
} from "./__tests__/oracleFixture";
import {
  ABI,
  CELL_BITS,
  GhosttyVt,
  KEY_ENCODER_OPTIONS,
  KEY_SHIFT_FROM,
  LAYOUT,
  SCRATCH,
  STYLE_FLAG_BITS,
  VtCells,
  VtFlag,
  upstreamKey,
  upstreamKeyEncoderOption,
  type VtTerminal,
} from "./ghosttyVt";

/// Ghostty's release wasm, vendored in this package (vitest runs in the
/// package directory).
const VENDORED = "vendor/ghostty-vt/ghostty-vt.wasm";

/// The behavior this binding has to keep: what ghostty-web's own binding
/// over its own build read back for the differential corpus, recorded once
/// (`__tests__/oracleFixture.ts` describes the form; its header names the
/// commit, the command and the wasm it was recorded from).
const oracle = JSON.parse(readFileSync(ORACLE_FIXTURE, "utf8")) as OracleFixture;

let vendored: WebAssembly.Module;

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

async function upstream(): Promise<GhosttyVt> {
  return new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
}

type TypeJson = {
  types: Record<
    string,
    {
      size: number;
      values?: Record<string, number>;
      fields?: Record<string, { offset: number }>;
      bits?: Record<string, { lsb: number; width: number }>;
    }
  >;
};

function typeJson(instance: WebAssembly.Instance): TypeJson {
  const exports = instance.exports as Record<string, unknown>;
  const ptr = (exports.ghostty_type_json as () => number)();
  const bytes = new Uint8Array((exports.memory as WebAssembly.Memory).buffer);
  let end = ptr;
  while (bytes[end] !== 0) end++;
  return JSON.parse(new TextDecoder().decode(bytes.subarray(ptr, end))) as TypeJson;
}

function text(cells: GhosttyCell[] | null): string {
  return (cells ?? [])
    .map((c) => (c.width === 0 ? "" : c.codepoint ? String.fromCodePoint(c.codepoint) : " "))
    .join("")
    .trimEnd();
}

type Fn = (...args: number[]) => number;

/// `instance` with its `ghostty_build_info` export answering the version
/// and search queries as given, every other query from the real export.
function reporting(instance: WebAssembly.Instance, major: number, search: boolean): WebAssembly.Instance {
  const exports = instance.exports as Record<string, unknown>;
  const memory = exports.memory as WebAssembly.Memory;
  const real = exports.ghostty_build_info as Fn;
  const ghostty_build_info: Fn = (data, out) => {
    const view = new DataView(memory.buffer);
    if (data === ABI.GhosttyBuildInfo.VERSION_MAJOR) view.setUint32(out, major, true);
    else if (data === ABI.GhosttyBuildInfo.FEATURE_SEARCH) view.setUint8(out, search ? 1 : 0);
    else return real(data, out);
    return ABI.GhosttyResult.SUCCESS;
  };
  return { exports: { ...exports, ghostty_build_info } } as unknown as WebAssembly.Instance;
}

describe("the binding's ABI tables", () => {
  let json: TypeJson;
  beforeAll(async () => {
    json = typeJson(await WebAssembly.instantiate(vendored, {}));
  });

  test("every enum value is the pinned build's", () => {
    for (const [type, values] of Object.entries(ABI)) {
      const upstreamValues = json.types[type]?.values;
      expect(upstreamValues, type).toBeDefined();
      for (const [name, value] of Object.entries(values)) {
        expect(upstreamValues?.[name], `${type}.${name}`).toBe(value);
      }
    }
  });

  test("every struct size and field offset is the pinned build's", () => {
    for (const [type, layout] of Object.entries(LAYOUT)) {
      const upstreamType = json.types[type];
      expect(upstreamType?.size, `${type} size`).toBe(layout.size);
      for (const [field, offset] of Object.entries(layout.fields)) {
        expect(upstreamType?.fields?.[field]?.offset, `${type}.${field}`).toBe(offset);
      }
    }
  });

  test("the packed cell bits are the pinned build's", () => {
    const bits = json.types.GhosttyCell?.bits ?? {};
    for (const [field, [lsb, width]] of Object.entries(CELL_BITS)) {
      expect(bits[field], field).toEqual(expect.objectContaining({ lsb, width }));
    }
  });

  test("the style flag bits are the pinned build's", () => {
    const bits = json.types.GhosttyStyleFlags?.bits ?? {};
    for (const [field, [lsb, width]] of Object.entries(STYLE_FLAG_BITS)) {
      expect(bits[field], field).toEqual(expect.objectContaining({ lsb, width }));
    }
  });

  test("every ghostty-web key encoder option lands on the upstream option it means", () => {
    const names = Object.keys(KeyEncoderOption).filter((k) => Number.isNaN(Number(k)));
    expect(names.sort(), "ghostty-web's options are all translated").toEqual(Object.keys(KEY_ENCODER_OPTIONS).sort());
    const values = json.types.GhosttyKeyEncoderOption?.values ?? {};
    for (const [name, { web, upstream }] of Object.entries(KEY_ENCODER_OPTIONS)) {
      expect(KeyEncoderOption[name as keyof typeof KeyEncoderOption], `ghostty-web ${name}`).toBe(web);
      expect(upstreamKeyEncoderOption(web), `upstream ${upstream}`).toBe(values[upstream]);
    }
    expect(upstreamKeyEncoderOption(Object.keys(KEY_ENCODER_OPTIONS).length)).toBeUndefined();
  });

  test("ghostty_key_event_set_utf8 takes its string struct as one argument", async () => {
    const exports = (await WebAssembly.instantiate(vendored, {})).exports;
    expect((exports.ghostty_key_event_set_utf8 as Fn).length).toBe(2);
  });

  test("every ghostty-web key lands on the upstream key of the same name", () => {
    // Names upstream changed while keeping the number.
    const renamed: Record<string, string> = {
      GRAVE: "BACKQUOTE",
      DOWN: "ARROW_DOWN",
      LEFT: "ARROW_LEFT",
      RIGHT: "ARROW_RIGHT",
      UP: "ARROW_UP",
      KP_PLUS: "NUMPAD_ADD",
      KP_PERIOD: "NUMPAD_DECIMAL",
      KP_MINUS: "NUMPAD_SUBTRACT",
    };
    const digits = ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE"];
    const upstreamName = (name: string) =>
      renamed[name] ??
      (digits.includes(name) ? `DIGIT_${digits.indexOf(name)}` : name.replace(/^KP_/, "NUMPAD_"));
    const keys = json.types.GhosttyKey?.values ?? {};
    const names = Object.keys(Key).filter((k) => Number.isNaN(Number(k)));
    expect(names.length).toBeGreaterThan(150);
    for (const name of names) {
      const web = Key[name as keyof typeof Key];
      expect(upstreamKey(web), `${name}=${web}`).toBe(keys[upstreamName(name)]);
    }
    expect(upstreamKey(KEY_SHIFT_FROM - 1)).toBe(KEY_SHIFT_FROM - 1);
  });
});

const VT_ATTRS: [number, Attr][] = [
  [VtFlag.BOLD, "bold"],
  [VtFlag.ITALIC, "italic"],
  [VtFlag.FAINT, "faint"],
  [VtFlag.BLINK, "blink"],
  [VtFlag.INVERSE, "inverse"],
  [VtFlag.INVISIBLE, "invisible"],
  [VtFlag.STRIKETHROUGH, "strikethrough"],
  [VtFlag.UNDERLINE, "underline"],
  [VtFlag.OVERLINE, "overline"],
];

/// The row a view holds, as the recorded oracle describes rows.
function bindingRow(cells: VtCells, wrapped?: boolean) {
  const out = Array.from({ length: cells.length }, (_, x) => {
    const c = cells.at(x)!;
    return {
      codepoint: c.codepoint,
      width: c.width,
      fg: c.fg,
      bg: c.bg,
      attrs: VT_ATTRS.flatMap(([flag, name]) => (c.flags & flag ? [name] : [])),
      link: c.hyperlink,
      grapheme: c.cluster,
    };
  });
  return fixtureRow(out, wrapped);
}

function keyEvent(e: FixtureKeyEvent) {
  return { action: 1, key: Key[e.key as keyof typeof Key], mods: e.mods ?? 0, utf8: e.utf8 };
}

function modes(t: VtTerminal): Record<string, boolean> {
  return {
    bracketedPaste: t.hasBracketedPaste(),
    focusEvents: t.hasFocusEvents(),
    mouseTracking: t.hasMouseTracking(),
    "DEC 1": t.getMode(1),
    "ANSI 4": t.getMode(4, true),
    "DEC 25": t.getMode(25),
  };
}

/// ghostty-web's build leaves the tertiary device attributes query
/// unanswered; upstream answers it from the same callback, with a zero unit
/// id.
const TERTIARY_DA = "\x1b[=c";

describe("differential: the binding against ghostty-web's recorded build", () => {
  test("the oracle was recorded from ghostty-web's own wasm, over the whole corpus", () => {
    expect(oracle.recorded.wasmSha256).toBe("794191ccd9f469ed0d49ebcb3e6b326d64279b91752b71ad80a3d89ff1f26416");
    expect(Object.keys(oracle.screens)).toHaveLength(12);
    expect(Object.keys(oracle.keyOptions).sort(), "a probe for every option ghostty-web numbers").toEqual(Object.keys(KEY_ENCODER_OPTIONS).sort());
  });

  test.each(Object.keys(oracle.screens))("%s", async (name) => {
    const want = oracle.screens[name];
    const [cols, rows] = want.size;
    const t = (await upstream()).createTerminal(cols, rows, { scrollbackLimit: want.scrollbackLimit });
    t.write(want.input);
    expect(t.beginFrame()).not.toBe(0);
    const cells = new VtCells();
    for (let y = 0; y < rows; y++) {
      expect(t.readRow(y, cells), `row ${y} reads`).toBe(true);
      expect(bindingRow(cells, t.isRowWrapped(y)), `row ${y}`).toEqual(want.rows[y]);
    }
    // ghostty-web's build hands `visible` over as the wasm's integer, which
    // its callers only test for truth and the oracle records as a boolean.
    const cursor = t.getCursor();
    expect({ x: cursor.x, y: cursor.y, visible: cursor.visible }).toEqual(want.cursor);
    expect(t.isAlternateScreen()).toBe(want.alternateScreen);
    expect(t.getScrollbackLength()).toBe(want.history.length);
    for (let i = 0; i < want.history.length; i++) {
      expect(t.readHistoryRow(i, cells), `history ${i} reads`).toBe(true);
      expect(bindingRow(cells), `history ${i}`).toEqual(want.history[i]);
    }
    t.free();
  });

  test("modes read as the oracle's before and after a program sets them", async () => {
    const t = (await upstream()).createTerminal(80, 24);
    expect(modes(t)).toEqual(oracle.modes.before);
    t.write(oracle.modes.set);
    expect(modes(t)).toEqual(oracle.modes.after);
  });

  test("replies to status and attribute queries are the oracle's, but for the tertiary attributes", async () => {
    const t = (await upstream()).createTerminal(80, 24);
    for (const { query, reply } of oracle.replies) {
      t.write(query);
      if (query === TERTIARY_DA) {
        expect(reply, "the oracle leaves the tertiary query unanswered").toBeNull();
        expect(t.readResponse(), "upstream answers it with a zero unit id").toBe("\x1bP!|00000000\x1b\\");
      } else {
        expect(t.readResponse(), JSON.stringify(query)).toBe(reply);
      }
    }
    expect(oracle.replies.map((r) => r.query)).toContain(TERTIARY_DA);
    expect(t.readResponse()).toBeNull();
  });

  test("XTVERSION gets no reply while device status and attributes still pass", async () => {
    const t = (await upstream()).createTerminal(80, 24);
    try {
      t.write("\x1b[>q");
      expect(t.readResponse()).toBeNull();
      t.write("\x1b[>0q\x1b[5n\x1b[c");
      expect(t.readResponse()).toBe("\x1b[0n\x1b[?62;22c");
    } finally {
      t.free();
    }
  });

  test("color queries get no reply, as from ghostty-web's build", async () => {
    const t = (await upstream()).createTerminal(80, 24, { fgColor: 0x24292f, bgColor: 0xffffff });
    for (const { query, reply } of oracle.colorQueries) {
      expect(reply, `ghostty-web: ${JSON.stringify(query)}`).toBeNull();
      t.write(query);
      expect(t.readResponse(), `upstream: ${JSON.stringify(query)}`).toBe(reply);
    }
    // A status query in the same write as a color query still answers.
    t.write("\x1b]11;?\x07\x1b[2;3H\x1b[6n\x1b]10;?\x07");
    expect(t.readResponse()).toBe("\x1b[2;3R");
  });

  test("keys encode as the oracle's, including keys past upstream's renumbering", async () => {
    const enc = (await upstream()).createKeyEncoder();
    for (const { event, bytes } of oracle.keys) {
      expect(keyText(enc.encode(keyEvent(event))), event.key).toBe(bytes);
    }
    enc.setOption(0, true);
    const { event, bytes } = oracle.cursorKeyApplication;
    expect(keyText(enc.encode(keyEvent(event)))).toBe(bytes);
  });

  test.each(Object.keys(oracle.keyOptions))("the %s option set through ghostty-web's numbering encodes as in its build", async (name) => {
    const probe = oracle.keyOptions[name];
    expect(probe.after, "the probe is sensitive to the option").not.toBe(probe.before);
    const enc = (await upstream()).createKeyEncoder();
    if (probe.given !== undefined) enc.setOption(KeyEncoderOption[probe.given as keyof typeof KeyEncoderOption], true);
    expect(keyText(enc.encode(keyEvent(probe.event))), "before").toBe(probe.before);
    if (name === "KITTY_KEYBOARD_FLAGS") enc.setKittyFlags(1);
    else enc.setOption(KeyEncoderOption[name as keyof typeof KeyEncoderOption], true);
    expect(keyText(enc.encode(keyEvent(probe.event))), "after").toBe(probe.after);
  });
});

describe("the core the binding accepts", () => {
  test("the vendored build is a 1.x with search", async () => {
    const instance = await WebAssembly.instantiate(vendored, {});
    const exports = instance.exports as Record<string, Fn>;
    const out = exports.ghostty_wasm_alloc(8);
    const view = () => new DataView((exports.memory as unknown as WebAssembly.Memory).buffer);
    expect(exports.ghostty_build_info(ABI.GhosttyBuildInfo.VERSION_MAJOR, out)).toBe(ABI.GhosttyResult.SUCCESS);
    expect(view().getUint32(out, true)).toBe(1);
    expect(exports.ghostty_build_info(ABI.GhosttyBuildInfo.FEATURE_SEARCH, out)).toBe(ABI.GhosttyResult.SUCCESS);
    expect(view().getUint8(out)).toBe(1);
    expect(() => new GhosttyVt(instance)).not.toThrow();
  });

  test.each([0, 2])("a core reporting major version %i is refused", async (major) => {
    const instance = await WebAssembly.instantiate(vendored, {});
    expect(() => new GhosttyVt(reporting(instance, major, true))).toThrow(`libghostty-vt ${major}.x`);
  });

  test("a core without search is refused", async () => {
    const instance = await WebAssembly.instantiate(vendored, {});
    expect(() => new GhosttyVt(reporting(instance, 1, false))).toThrow("no search");
  });
});

describe("upstream's terminal through ghostty-web's binding API", () => {
  test("a written row reads back with resolved colors and style flags", async () => {
    const t = (await upstream()).createTerminal(20, 5, { fgColor: 0xd0d0d0, bgColor: 0x101010 });
    t.write("\x1b[1;31mR\x1b[0m\x1b[48;2;1;2;3mB\x1b[0m");
    const [r, b] = t.getLine(0) ?? [];
    expect(String.fromCodePoint(r.codepoint)).toBe("R");
    expect(r.flags & 1).toBe(1);
    expect([b.bg_r, b.bg_g, b.bg_b]).toEqual([1, 2, 3]);
    expect([b.fg_r, b.fg_g, b.fg_b]).toEqual([0xd0, 0xd0, 0xd0]);
    expect(t.getColors().background).toEqual({ r: 0x10, g: 0x10, b: 0x10 });
  });

  test("only the rows a write touched are dirty after a clean", async () => {
    const t = (await upstream()).createTerminal(20, 6);
    t.write("a\r\nb\r\nc");
    expect(t.beginFrame()).toBe(2);
    t.endFrame();
    t.write("\x1b[4;1Hx");
    expect(t.beginFrame()).toBe(1);
    // Row 2 held the cursor before the move, so it redraws too.
    expect([0, 1, 2, 3, 4, 5].map((y) => t.isRowDirty(y))).toEqual([false, false, true, true, false, false]);
    expect(text(t.getLine(3))).toBe("x");
  });

  test("an OSC 8 link resolves on screen and in history", async () => {
    const t = (await upstream()).createTerminal(20, 3);
    t.write("\x1b]8;;https://example.com/a\x1b\\link\x1b]8;;\x1b\\");
    expect(t.getLine(0)?.[0].hyperlink_id).toBe(1);
    expect(t.getHyperlinkUri(0, 1)).toBe("https://example.com/a");
    expect(t.getHyperlinkUri(0, 6)).toBeNull();
    t.write("\r\n\r\n\r\n\r\n");
    expect(t.getScrollbackHyperlinkUri(0, 0)).toBe("https://example.com/a");
  });

  test("a failed write-buffer growth preserves the allocation for later writes", async () => {
    type Wasm = {
      fn: { ghostty_wasm_alloc(len: number): number };
      free(ptr: number, len: number): void;
    };
    const t = (await upstream()).createTerminal(80, 24) as unknown as Pick<VtTerminal, "write" | "free" | "getLine"> & {
      wasm: Wasm;
      writeBuf: number;
      writeCap: number;
    };
    t.write("first");
    const oldBuf = t.writeBuf;
    const oldCap = t.writeCap;
    const { ghostty_wasm_alloc: alloc } = t.wasm.fn;
    const { free } = t.wasm;
    const frees: [number, number][] = [];
    t.wasm.free = (ptr, len) => {
      frees.push([ptr, len]);
      free.call(t.wasm, ptr, len);
    };
    t.wasm.fn.ghostty_wasm_alloc = (len) => len > oldCap ? 0 : alloc(len);
    try {
      expect(() => t.write(new Uint8Array(oldCap + 1))).toThrow(/out of memory/);
    } finally {
      t.wasm.fn.ghostty_wasm_alloc = alloc;
    }
    expect(frees, "the live buffer must not be freed on allocation failure").not.toContainEqual([oldBuf, oldCap]);
    expect(t.writeBuf).toBe(oldBuf);
    expect(t.writeCap).toBe(oldCap);
    t.write(" second");
    expect(t.writeBuf, "a smaller write reuses the intact buffer").toBe(oldBuf);
    expect(text(t.getLine(0))).toBe("first second");
    t.write("x".repeat(oldCap + 1));
    expect(t.writeBuf).not.toBe(oldBuf);
    t.free();
    expect(frees.filter(([ptr]) => ptr === oldBuf), "the old buffer is freed exactly once").toEqual([[oldBuf, oldCap]]);
  });

  test("a grapheme cluster takes one cell and reads back whole", async () => {
    const t = (await upstream()).createTerminal(20, 3);
    const family = "👨‍👩‍👧";
    t.write(`${family}x`);
    const row = t.getLine(0) ?? [];
    expect(row[0].grapheme_len).toBeGreaterThan(0);
    expect(row[0].width).toBe(2);
    expect(t.getGraphemeString(0, 0)).toBe(family);
    expect(String.fromCodePoint(row[2].codepoint)).toBe("x");
    t.write("\r\n\r\n\r\n");
    expect(t.getScrollbackGraphemeString(0, 0)).toBe(family);
  });

  test.each(["screen", "history"])("a cluster beyond the scratch capacity reads whole from %s", async (surface) => {
    const t = (await upstream()).createTerminal(20, 3);
    const cluster = "e" + "\u0301".repeat(33);
    t.write(`${cluster}x`);
    if (surface === "history") t.write("\r\n\r\n\r\n");
    const row = surface === "history" ? t.getScrollbackLine(0) : t.getLine(0);
    const read = surface === "history" ? t.getScrollbackGraphemeString(0, 0) : t.getGraphemeString(0, 0);
    expect(read).toBe(cluster);
    expect(row?.[0].grapheme_len).toBe(33);
    expect(row?.[0].width).toBe(1);
    expect(row?.[1].codepoint).toBe("x".codePointAt(0));
    t.free();
  });

  test("a ranged read formats the selection alone, across history and screen", async () => {
    const t = (await upstream()).createTerminal(20, 3);
    t.write(Array.from({ length: 6 }, (_, i) => `row ${i} abcdefghij`).join("\r\n"));
    expect(t.getScrollbackLength()).toBe(3);
    expect(t.plainText({ startCol: 6, startRow: 2, endCol: 4, endRow: 3 })).toBe("abcdefghij\nrow 3");
    expect(t.plainText({ startCol: 0, startRow: 5, endCol: 19, endRow: 5 })).toBe("row 5 abcdefghij");
    expect(t.plainText()).toBe(Array.from({ length: 6 }, (_, i) => `row ${i} abcdefghij`).join("\n"));
  });

  test("scrollback keeps the configured number of lines, not bytes", async () => {
    const t = (await upstream()).createTerminal(80, 24, { scrollbackLimit: 5_000 });
    t.write(Array.from({ length: 3_000 }, (_, i) => `line ${i}`).join("\r\n"));
    expect(t.getScrollbackLength()).toBe(3_000 - 24);
    expect(text(t.getScrollbackLine(0))).toBe("line 0");
  });

  test("the line limit holds past the core's default byte cap", async () => {
    const t = (await upstream()).createTerminal(80, 24, { scrollbackLimit: 10_000 });
    for (let from = 0; from < 20_000; from += 1_000) {
      t.write(Array.from({ length: 1_000 }, (_, i) => `line ${from + i} ${"x".repeat(40)}`).join("\r\n") + "\r\n");
    }
    // The core prunes whole pages, so the count lands near the limit; the
    // default byte cap alone would keep one page, about a thousand rows.
    const rows = t.getScrollbackLength();
    expect(rows).toBeGreaterThanOrEqual(9_000);
    expect(rows).toBeLessThanOrEqual(11_000);
    // The last line's CRLF leaves the cursor on an empty row below it.
    expect(text(t.getScrollbackLine(rows - 1))).toBe(`line ${20_000 - 24} ${"x".repeat(40)}`);
  });

  test.each([
    ["OSC 11, the background", "\x1b]11;rgb:40/00/00\x07", "bg", [64, 0, 0]],
    ["OSC 10, the foreground", "\x1b]10;rgb:00/80/00\x07", "fg", [0, 128, 0]],
  ] as const)("a default color change by %s redraws the rows drawn before it", async (_name, set, which, rgb) => {
    const t = (await upstream()).createTerminal(20, 4, { fgColor: 0xcccccc, bgColor: 0x101010 });
    t.write("first\r\nsecond");
    t.beginFrame();
    t.endFrame();
    t.write(set);
    expect(t.beginFrame()).toBe(ABI.GhosttyRenderStateDirty.FULL);
    for (const y of [0, 1]) {
      const cell = t.getLine(y)![0];
      const got = which === "bg" ? [cell.bg_r, cell.bg_g, cell.bg_b] : [cell.fg_r, cell.fg_g, cell.fg_b];
      expect(got, `row ${y} ${which}`).toEqual([...rgb]);
    }
  });

  test.each([33, 40, 65])("a cluster of %i codepoints is read into a buffer of its own", async (n) => {
    type Wasm = { bytes(): Uint8Array; alloc(len: number): number; free(ptr: number, len: number): void };
    type Probe = Pick<VtTerminal, "write" | "beginFrame" | "getGraphemeString"> & { scratch: number; wasm: Wasm };
    const pastScratch = (term: Probe) => term.wasm.bytes().slice(term.scratch + SCRATCH.size, term.scratch + SCRATCH.size + 512);
    const moved = (a: Uint8Array, b: Uint8Array) => [...a].flatMap((v, i) => (v !== b[i] ? [i] : []));
    // The core keeps its own state (the cursor and the read position among
    // it) right past the scratch, so a two-codepoint cluster, which fits
    // the scratch, written and read on an identical terminal names the
    // bytes a write and a read move on their own.
    const control = (await upstream()).createTerminal(20, 3) as unknown as Probe;
    const controlBefore = pastScratch(control);
    control.write("e\u0301");
    control.beginFrame();
    control.getGraphemeString(0, 0);
    const ownState = moved(controlBefore, pastScratch(control));
    const t = (await upstream()).createTerminal(20, 3) as unknown as Probe;
    expect(t.scratch, "the control's layout is this terminal's").toBe(control.scratch);
    const before = pastScratch(t);
    const allocs: [number, number][] = [];
    const frees: [number, number][] = [];
    const { alloc, free } = t.wasm;
    t.wasm.alloc = (len) => {
      const ptr = alloc.call(t.wasm, len);
      allocs.push([ptr, len]);
      return ptr;
    };
    t.wasm.free = (ptr, len) => {
      frees.push([ptr, len]);
      free.call(t.wasm, ptr, len);
    };
    // One cluster: "e" and n - 1 combining acute accents.
    t.write("e" + "\u0301".repeat(n - 1));
    t.beginFrame();
    const cell = [...t.getGraphemeString(0, 0)];
    expect(ownState, "nothing past the scratch but the core's own state").toEqual(expect.arrayContaining(moved(before, pastScratch(t))));
    const own = allocs.filter(([, len]) => len === n * 4);
    expect(own, "one buffer of four bytes a codepoint").toHaveLength(1);
    expect(frees, "freed with its length").toContainEqual(own[0]);
    expect(cell[0]).toBe("e");
    expect(cell.length).toBe(n);
  });

  test("a resize reflows and redraws everything", async () => {
    const t = (await upstream()).createTerminal(10, 4);
    t.write("abcdefghijklmno");
    t.beginFrame();
    t.endFrame();
    t.resize(20, 4);
    expect(t.beginFrame()).toBe(ABI.GhosttyRenderStateDirty.FULL);
    expect(text(t.getLine(0))).toBe("abcdefghijklmno");
  });

  test("a full reset keeps grapheme clustering on", async () => {
    const t = (await upstream()).createTerminal(20, 3);
    expect(t.getMode(2027)).toBe(true);
    t.write("\x1bc");
    expect(t.getMode(2027)).toBe(true);
  });

  test("terminals on one instance answer their own queries", async () => {
    const vt = await upstream();
    const a = vt.createTerminal(20, 5);
    const b = vt.createTerminal(20, 5);
    a.write("\x1b[2;3H\x1b[6n");
    b.write("\x1b[4;5H\x1b[6n");
    expect(a.readResponse()).toBe("\x1b[2;3R");
    expect(b.readResponse()).toBe("\x1b[4;5R");
    a.free();
    b.write("\x1b[6n");
    expect(b.readResponse()).toBe("\x1b[4;5R");
  });
});

describe("in-band resize replies", () => {
  test("a resize delivers its report immediately with the current cell pixel size", async () => {
    const replies: string[] = [];
    let cell = { width: 9.6, height: 19.6 };
    const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}), {
      cellSize: () => cell,
      onResizeReply: (reply: string) => replies.push(reply),
    });
    const t = vt.createTerminal(80, 24);
    try {
      t.write("\x1b[?2048h");
      t.readResponse();
      t.resize(100, 30);
      expect(replies, "delivered without another write").toEqual(["\x1b[48;30;100;600;1000t"]);
      expect(t.readResponse(), "the delivered report is drained").toBeNull();
      cell = { width: 8, height: 16 };
      t.resize(90, 25);
      expect(replies.at(-1)).toBe("\x1b[48;25;90;400;720t");
      t.resize(90, 25);
      expect(replies).toHaveLength(2);
      t.write("\x1b[?2048l");
      t.resize(80, 24);
      expect(replies).toHaveLength(2);
    } finally {
      t.free();
    }
  });
});
