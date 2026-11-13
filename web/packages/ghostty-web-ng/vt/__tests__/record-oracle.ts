// Records the oracle of the binding's differential tests into
// differential-oracle.json: the corpus, modes, replies and key encodings
// read through ghostty-web's own binding (`lib/ghostty.ts`'s `Ghostty`)
// over its own build (`ghostty-vt.wasm` at the package root), the patched
// pre-1.0 snapshot chan does not ship. It runs once, from a clean tree, and
// goes with that wasm; the fixture's header names the commit and command.
//
//   cd web/packages/ghostty-web-ng && npx vitest run --config vt/__tests__/record-oracle.config.ts

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { Ghostty, type GhosttyTerminal } from "../../lib/ghostty";
import { CellFlags, Key, KeyEncoderOption, Mods, type GhosttyCell } from "../../lib/types";
import {
  ORACLE_FIXTURE,
  fixtureRow,
  keyText,
  type Attr,
  type FixtureCell,
  type FixtureKeyEvent,
  type FixtureScreen,
  type OracleFixture,
} from "./oracleFixture";

const WASM = "ghostty-vt.wasm";
const COMMAND = "cd web/packages/ghostty-web-ng && npx vitest run --config vt/__tests__/record-oracle.config.ts";

/// Byte streams a shell and its programs send.
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

const FLAG_ATTRS: [CellFlags, Attr][] = [
  [CellFlags.BOLD, "bold"],
  [CellFlags.ITALIC, "italic"],
  [CellFlags.FAINT, "faint"],
  [CellFlags.BLINK, "blink"],
  [CellFlags.INVERSE, "inverse"],
  [CellFlags.INVISIBLE, "invisible"],
  [CellFlags.STRIKETHROUGH, "strikethrough"],
  [CellFlags.UNDERLINE, "underline"],
];

function fixtureCells(cells: GhosttyCell[], grapheme: (x: number) => string): FixtureCell[] {
  return cells.map((c, x) => ({
    codepoint: c.codepoint,
    width: c.width,
    fg: (c.fg_r << 16) | (c.fg_g << 8) | c.fg_b,
    bg: (c.bg_r << 16) | (c.bg_g << 8) | c.bg_b,
    attrs: FLAG_ATTRS.flatMap(([flag, name]) => (c.flags & flag ? [name] : [])),
    link: c.hyperlink_id,
    grapheme: c.grapheme_len > 0 ? grapheme(x) : null,
  }));
}

function screen(ghostty: Ghostty, input: string): FixtureScreen {
  const [cols, rows, scrollbackLimit] = [80, 24, 10_000];
  const t = ghostty.createTerminal(cols, rows, { scrollbackLimit });
  t.write(input);
  const c = t.getCursor();
  const out: FixtureScreen = {
    input,
    size: [cols, rows],
    scrollbackLimit,
    cursor: { x: c.x, y: c.y, visible: Boolean(c.visible) },
    alternateScreen: t.isAlternateScreen(),
    rows: [],
    history: [],
  };
  for (let y = 0; y < rows; y++) {
    const cells = t.getLine(y);
    expect(cells, `row ${y}`).not.toBeNull();
    out.rows.push(fixtureRow(fixtureCells(cells!, (x) => t.getGraphemeString(y, x)), t.isRowWrapped(y)));
  }
  for (let i = 0; i < t.getScrollbackLength(); i++) {
    const cells = t.getScrollbackLine(i);
    expect(cells, `history ${i}`).not.toBeNull();
    out.history.push(fixtureRow(fixtureCells(cells!, (x) => t.getScrollbackGraphemeString(i, x))));
  }
  t.free();
  return out;
}

function event(e: { key: Key; mods?: number; utf8?: string }): FixtureKeyEvent {
  return { key: Key[e.key], ...(e.mods ? { mods: e.mods } : {}), ...(e.utf8 !== undefined ? { utf8: e.utf8 } : {}) };
}

function modes(t: GhosttyTerminal): Record<string, boolean> {
  return {
    bracketedPaste: t.hasBracketedPaste(),
    focusEvents: t.hasFocusEvents(),
    mouseTracking: t.hasMouseTracking(),
    "DEC 1": t.getMode(1),
    "ANSI 4": t.getMode(4, true),
    "DEC 25": t.getMode(25),
  };
}

/// A pretty JSON form: every row and every small value on one line.
function pretty(value: unknown, indent = ""): string {
  const inline = JSON.stringify(value);
  const isRow = typeof value === "object" && value !== null && "text" in value && "styles" in value;
  if (typeof value !== "object" || value === null || isRow || inline.length <= 100) return inline;
  const next = indent + "  ";
  if (Array.isArray(value)) return `[\n${value.map((v) => next + pretty(v, next)).join(",\n")}\n${indent}]`;
  const entries = Object.entries(value).map(([k, v]) => `${next}${JSON.stringify(k)}: ${pretty(v, next)}`);
  return `{\n${entries.join(",\n")}\n${indent}}`;
}

test("record ghostty-web's oracle", async () => {
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
  expect(git("status", "--porcelain"), "the recorder runs from a clean tree").toBe("");
  const commit = git("rev-parse", "HEAD");
  const bytes = readFileSync(WASM);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const wasmSha256 = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  const module = await WebAssembly.compile(bytes);
  const ghostty = async () => new Ghostty(await WebAssembly.instantiate(module, { env: { log: () => {} } }));

  const screens: Record<string, FixtureScreen> = {};
  for (const [name, input] of Object.entries(CORPUS)) screens[name] = screen(await ghostty(), input);

  const set = "\x1b[?2004h\x1b[?1004h\x1b[?1002h\x1b[?1h\x1b[4h";
  const m = (await ghostty()).createTerminal(80, 24);
  const before = modes(m);
  m.write(set);
  const after = modes(m);

  const r = (await ghostty()).createTerminal(80, 24);
  const replies = ["\x1b[3;7H\x1b[6n", "\x1b[5n", "\x1b[c", "\x1b[>c", "\x1b[=c"].map((query) => {
    r.write(query);
    return { query, reply: r.readResponse() };
  });
  const q = (await ghostty()).createTerminal(80, 24);
  const colorQueries = [
    "\x1b]10;?\x07",
    "\x1b]11;?\x07",
    "\x1b]11;?\x1b\\",
    "\x1b]12;?\x07",
    "\x1b]4;1;?\x07",
    "\x1b]4;1;?;2;?\x07",
    "\x1b]11;#ffffff\x07\x1b]11;?\x07",
    "\x1b]21;foreground=?\x1b\\",
    "\x1b]21;background=?;cursor=?\x07",
  ].map((query) => {
    q.write(query);
    return { query, reply: q.readResponse() };
  });

  const encoder = (await ghostty()).createKeyEncoder();
  const encode = (e: { key: Key; mods?: number; utf8?: string }) =>
    keyText(encoder.encode({ action: 1, key: e.key, mods: e.mods ?? 0, utf8: e.utf8 }));
  const keys = [
    { key: Key.ENTER },
    { key: Key.A, utf8: "a" },
    { key: Key.C, mods: 2 },
    { key: Key.UP },
    { key: Key.F5 },
    { key: Key.DELETE },
    { key: Key.KP_5, utf8: "5" },
    { key: Key.PRINT_SCREEN },
    { key: Key.PAUSE },
  ].map((e) => ({ event: event(e), bytes: encode(e) }));
  encoder.setOption(0, true);
  const cursorKeyApplication = { event: event({ key: Key.UP }), bytes: encode({ key: Key.UP }) };

  /// A key each option changes the encoding of; `given` is an option the
  /// probe needs on first.
  const probes: Record<string, { key: Key; mods?: number; utf8?: string; given?: KeyEncoderOption }> = {
    CURSOR_KEY_APPLICATION: { key: Key.UP },
    KEYPAD_KEY_APPLICATION: { key: Key.KP_5, utf8: "5" },
    IGNORE_KEYPAD_WITH_NUMLOCK: { key: Key.KP_5, mods: Mods.NUMLOCK, utf8: "5", given: KeyEncoderOption.KEYPAD_KEY_APPLICATION },
    ALT_ESC_PREFIX: { key: Key.A, mods: Mods.ALT, utf8: "a" },
    MODIFY_OTHER_KEYS_STATE_2: { key: Key.TAB, mods: Mods.SHIFT },
    KITTY_KEYBOARD_FLAGS: { key: Key.ESCAPE },
  };
  const keyOptions: OracleFixture["keyOptions"] = {};
  for (const [name, probe] of Object.entries(probes)) {
    const enc = (await ghostty()).createKeyEncoder();
    const bytes = () => keyText(enc.encode({ action: 1, key: probe.key, mods: probe.mods ?? 0, utf8: probe.utf8 }));
    if (probe.given !== undefined) enc.setOption(probe.given, true);
    const beforeBytes = bytes();
    if (name === "KITTY_KEYBOARD_FLAGS") enc.setKittyFlags(1);
    else enc.setOption(KeyEncoderOption[name as keyof typeof KeyEncoderOption], true);
    keyOptions[name] = {
      event: event(probe),
      ...(probe.given !== undefined ? { given: KeyEncoderOption[probe.given] } : {}),
      before: beforeBytes,
      after: bytes(),
    };
  }

  const fixture: OracleFixture = {
    recorded: {
      commit,
      command: COMMAND,
      oracle: "ghostty-web's own binding (lib/ghostty.ts, Ghostty) at upstream 1858a5947",
      wasm: `${WASM} at the package root`,
      wasmSha256,
    },
    format: "vt/__tests__/oracleFixture.ts describes a row; replies and key bytes are the text they spell",
    screens,
    modes: { set, before, after },
    replies,
    colorQueries,
    keys,
    cursorKeyApplication,
    keyOptions,
  };
  writeFileSync(ORACLE_FIXTURE, pretty(fixture) + "\n");
});
