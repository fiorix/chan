import { readFileSync } from "node:fs";
import { Ghostty, Key, type GhosttyCell, type GhosttyTerminal } from "ghostty-web";
import { beforeAll, describe, expect, test } from "vitest";
import { ABI, CELL_BITS, GhosttyVt, KEY_SHIFT_FROM, LAYOUT, SCRATCH, upstreamKey } from "./ghosttyVt";

/// Ghostty's release wasm, vendored beside the package (vitest runs in
/// the package directory).
const VENDORED = "vendor/ghostty-vt/ghostty-vt.wasm";
/// ghostty-web's own build, the behavior this binding has to keep.
const GHOSTTY_WEB = "../../node_modules/ghostty-web/ghostty-vt.wasm";

let vendored: WebAssembly.Module;
let legacy: WebAssembly.Module;

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
  legacy = await WebAssembly.compile(readFileSync(GHOSTTY_WEB));
});

async function upstream(): Promise<GhosttyVt> {
  return new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
}

async function ghosttyWeb(): Promise<Ghostty> {
  return new Ghostty(await WebAssembly.instantiate(legacy, { env: { log: () => {} } }));
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

/// Byte streams a shell and its programs send, each read back through
/// both bindings.
const CORPUS: Record<string, string> = {
  "plain lines": "hello\r\nworld\r\n$ ",
  "SGR palette, bright, 256 and truecolor":
    "\x1b[31mred\x1b[0m \x1b[1;92mbold green\x1b[0m \x1b[38;5;208morange\x1b[0m \x1b[38;2;10;20;30mrgb\x1b[0m",
  "background colors and erase with a background":
    "\x1b[44mblue bg\x1b[0m \x1b[48;2;200;100;50mrgb bg\x1b[0m\r\n\x1b[41m\x1b[K\x1b[0m",
  "attributes": "\x1b[1mb\x1b[22;3mi\x1b[23;4mu\x1b[24;9ms\x1b[29;7mr\x1b[27;8mh\x1b[28;5mk\x1b[25;2mf\x1b[0m",
  "cursor movement and erase": "abcdef\x1b[3D\x1b[K\r\n\x1b[5;10Hx\x1b[2;2Hy\x1b[1J",
  "wide characters": "日本語 ｗｉｄｅ\r\n한국어",
  "line wrapping": "x".repeat(130),
  "scroll region and insert/delete lines": "1\r\n2\r\n3\r\n4\r\n5\x1b[2;4r\x1b[2;1H\x1b[L\x1b[3M\x1b[r",
  "alternate screen with content": "main\x1b[?1049h\x1b[2J\x1b[Halt screen\x1b[3;3Htext",
  "back from the alternate screen": "main\x1b[?1049halt\x1b[?1049l",
  "tabs and backspace": "a\tb\tc\x08\x08X",
  "a screen and a half of output": Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\r\n"),
};

describe("differential: the same bytes through ghostty-web's build and upstream's", () => {
  test.each(Object.entries(CORPUS))("%s", async (_name, input) => {
    const a = (await ghosttyWeb()).createTerminal(80, 24, { scrollbackLimit: 10_000 });
    const b = (await upstream()).createTerminal(80, 24, { scrollbackLimit: 10_000 });
    a.write(input);
    b.write(input);
    expect(b.update()).not.toBe(0);
    for (let y = 0; y < 24; y++) {
      expect(b.getLine(y), `row ${y}`).toEqual(a.getLine(y));
    }
    // ghostty-web's build hands `visible` over as the wasm's integer;
    // its callers only test it for truth.
    const cursor = (t: GhosttyTerminal) => {
      const c = t.getCursor();
      return { x: c.x, y: c.y, visible: Boolean(c.visible) };
    };
    expect(cursor(b)).toEqual(cursor(a));
    expect(b.isAlternateScreen()).toBe(a.isAlternateScreen());
    expect(b.getScrollbackLength()).toBe(a.getScrollbackLength());
    for (let i = 0; i < a.getScrollbackLength(); i++) {
      expect(b.getScrollbackLine(i), `history ${i}`).toEqual(a.getScrollbackLine(i));
    }
    for (let y = 0; y < 24; y++) expect(b.isRowWrapped(y), `wrap ${y}`).toBe(a.isRowWrapped(y));
  });

  test("modes read the same after a program sets them", async () => {
    const a = (await ghosttyWeb()).createTerminal(80, 24);
    const b = (await upstream()).createTerminal(80, 24);
    for (const t of [a, b]) {
      expect(t.hasBracketedPaste()).toBe(false);
      t.write("\x1b[?2004h\x1b[?1004h\x1b[?1002h\x1b[?1h\x1b[4h");
    }
    for (const t of [a, b]) {
      expect(t.hasBracketedPaste()).toBe(true);
      expect(t.hasFocusEvents()).toBe(true);
      expect(t.hasMouseTracking()).toBe(true);
      expect(t.getMode(1)).toBe(true);
      expect(t.getMode(4, true)).toBe(true);
      expect(t.getMode(25)).toBe(true);
    }
  });

  test("replies to status and attribute queries are ghostty-web's", async () => {
    const a = (await ghosttyWeb()).createTerminal(80, 24);
    const b = (await upstream()).createTerminal(80, 24);
    for (const query of ["\x1b[3;7H\x1b[6n", "\x1b[5n", "\x1b[c", "\x1b[>c"]) {
      a.write(query);
      b.write(query);
      expect(b.readResponse(), JSON.stringify(query)).toBe(a.readResponse());
    }
    expect(b.readResponse()).toBeNull();
    // ghostty-web's build leaves the tertiary query unanswered; upstream
    // answers it from the same callback, with a zero unit id.
    b.write("\x1b[=c");
    expect(b.readResponse()).toBe("\x1bP!|00000000\x1b\\");
  });

  test("color queries get no reply, as from ghostty-web's build", async () => {
    const a = (await ghosttyWeb()).createTerminal(80, 24);
    const b = (await upstream()).createTerminal(80, 24, { fgColor: 0x24292f, bgColor: 0xffffff });
    for (const query of [
      "\x1b]10;?\x07",
      "\x1b]11;?\x07",
      "\x1b]11;?\x1b\\",
      "\x1b]12;?\x07",
      "\x1b]4;1;?\x07",
      "\x1b]4;1;?;2;?\x07",
      "\x1b]11;#ffffff\x07\x1b]11;?\x07",
      "\x1b]21;foreground=?\x1b\\",
      "\x1b]21;background=?;cursor=?\x07",
    ]) {
      a.write(query);
      b.write(query);
      expect(a.readResponse(), `ghostty-web: ${JSON.stringify(query)}`).toBeNull();
      expect(b.readResponse(), `upstream: ${JSON.stringify(query)}`).toBeNull();
    }
    // A status query in the same write as a color query still answers.
    b.write("\x1b]11;?\x07\x1b[2;3H\x1b[6n\x1b]10;?\x07");
    expect(b.readResponse()).toBe("\x1b[2;3R");
  });

  test("keys encode the same, including keys past upstream's renumbering", async () => {
    const a = (await ghosttyWeb()).createKeyEncoder();
    const b = (await upstream()).createKeyEncoder();
    const events = [
      { key: Key.ENTER },
      { key: Key.A, utf8: "a" },
      { key: Key.C, mods: 2 },
      { key: Key.UP },
      { key: Key.F5 },
      { key: Key.DELETE },
      { key: Key.KP_5, utf8: "5" },
      { key: Key.PRINT_SCREEN },
      { key: Key.PAUSE },
    ];
    for (const e of events) {
      const event = { action: 1, key: e.key, mods: e.mods ?? 0, utf8: e.utf8 };
      expect([...b.encode(event)], Key[e.key]).toEqual([...a.encode(event)]);
    }
    for (const enc of [a, b]) enc.setOption(0, true);
    expect([...b.encode({ action: 1, key: Key.UP, mods: 0 })]).toEqual([...a.encode({ action: 1, key: Key.UP, mods: 0 })]);
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
    expect(t.update()).toBe(2);
    t.markClean();
    t.write("\x1b[4;1Hx");
    expect(t.update()).toBe(1);
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
    const t = (await upstream()).createTerminal(80, 24) as unknown as GhosttyTerminal & {
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

  test("scrollback keeps the configured number of lines, not bytes", async () => {
    const t = (await upstream()).createTerminal(80, 24, { scrollbackLimit: 5_000 });
    t.write(Array.from({ length: 3_000 }, (_, i) => `line ${i}`).join("\r\n"));
    expect(t.getScrollbackLength()).toBe(3_000 - 24);
    expect(text(t.getScrollbackLine(0))).toBe("line 0");
  });

  test.each([
    ["OSC 11, the background", "\x1b]11;rgb:40/00/00\x07", "bg", [64, 0, 0]],
    ["OSC 10, the foreground", "\x1b]10;rgb:00/80/00\x07", "fg", [0, 128, 0]],
  ] as const)("a default color change by %s redraws the rows drawn before it", async (_name, set, which, rgb) => {
    const t = (await upstream()).createTerminal(20, 4, { fgColor: 0xcccccc, bgColor: 0x101010 });
    t.write("first\r\nsecond");
    t.update();
    t.markClean();
    t.write(set);
    t.update();
    expect(t.needsFullRedraw()).toBe(true);
    for (const y of [0, 1]) {
      const cell = t.getLine(y)![0];
      const got = which === "bg" ? [cell.bg_r, cell.bg_g, cell.bg_b] : [cell.fg_r, cell.fg_g, cell.fg_b];
      expect(got, `row ${y} ${which}`).toEqual([...rgb]);
    }
  });

  test.each([33, 40, 65])("a cluster of %i codepoints is read into a buffer of its own", async (n) => {
    type Wasm = { bytes(): Uint8Array; alloc(len: number): number; free(ptr: number, len: number): void };
    const t = (await upstream()).createTerminal(20, 3) as unknown as GhosttyTerminal & { scratch: number; wasm: Wasm };
    const end = t.scratch + SCRATCH.size;
    const before = t.wasm.bytes().slice(end, end + 512);
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
    t.update();
    expect([...t.wasm.bytes().slice(end, end + 512)], "nothing past the scratch").toEqual([...before]);
    const own = allocs.filter(([, len]) => len === n * 4);
    expect(own, "one buffer of four bytes a codepoint").toHaveLength(1);
    expect(frees, "freed with its length").toContainEqual(own[0]);
    const cell = [...t.getGraphemeString(0, 0)];
    expect(cell[0]).toBe("e");
    expect(cell.length).toBe(n);
  });

  test("a resize reflows and redraws everything", async () => {
    const t = (await upstream()).createTerminal(10, 4);
    t.write("abcdefghijklmno");
    t.markClean();
    t.resize(20, 4);
    expect(t.needsFullRedraw()).toBe(true);
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
