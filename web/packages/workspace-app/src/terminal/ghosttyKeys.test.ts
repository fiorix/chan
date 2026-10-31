import { readFileSync } from "node:fs";
import { InputHandler } from "ghostty-web";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { ghosttyKeydownAction, ghosttyTypesKey, installGhosttyKeyParity } from "./ghosttyKeys";
import { GhosttyVt } from "./ghosttyVt";
import { createTerminalKeyboardProtocolState, terminalMetaKeyBytes } from "./keymap";
import { createXtermKeydownState, xtermKeydown, type XtermPlatform } from "./xtermKeyboard";

const LINUX: XtermPlatform = { isMac: false, isWindows: false };
const MAC: XtermPlatform = { isMac: true, isWindows: false };

type Init = KeyboardEventInit & { keyCode?: number };

/// A keydown as a browser makes it, with the legacy key code xterm.js reads.
function keydown(init: Init): KeyboardEvent {
  const { keyCode = 0, ...rest } = init;
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...rest });
  Object.defineProperty(ev, "keyCode", { value: keyCode });
  return ev;
}

function action(init: Init, platform = LINUX, chanBytes: string | null = null) {
  return ghosttyKeydownAction(
    keydown(init),
    { platform, applicationCursorMode: false, rows: 24, chanBytes },
    createXtermKeydownState(),
  );
}

describe("ghosttyKeydownAction", () => {
  test("chan's own bytes come first", () => {
    expect(action({ key: "ArrowLeft", keyCode: 37, altKey: true }, LINUX, "\x1bb")).toEqual({ kind: "send", data: "\x1bb" });
  });

  test("a key xterm.js encodes is sent", () => {
    expect(action({ key: "b", code: "KeyB", keyCode: 66, altKey: true })).toEqual({ kind: "send", data: "\x1bb" });
    expect(action({ key: "∫", code: "KeyB", keyCode: 66, altKey: true }, MAC)).toEqual({ kind: "send", data: "\x1bb" });
  });

  test("plain typing stays with ghostty-web, which types the same text", () => {
    expect(action({ key: "a", code: "KeyA", keyCode: 65 })).toEqual({ kind: "ghostty" });
    expect(action({ key: "A", code: "KeyA", keyCode: 65, shiftKey: true })).toEqual({ kind: "ghostty" });
    expect(action({ key: " ", code: "Space", keyCode: 32, shiftKey: true })).toEqual({ kind: "ghostty" });
  });

  test("a key xterm.js leaves to the browser skips ghostty-web", () => {
    expect(action({ key: "Insert", code: "Insert", keyCode: 45, shiftKey: true })).toEqual({ kind: "browser" });
    expect(action({ key: "w", code: "KeyW", keyCode: 87, metaKey: true }, MAC)).toEqual({ kind: "browser" });
    expect(action({ key: "Dead", code: "Quote", keyCode: 222 })).toEqual({ kind: "browser" });
  });

  test("macOS Command chords xterm.js does not encode reach the host", () => {
    expect(action({ key: "`", code: "Backquote", keyCode: 192, metaKey: true }, MAC)).toEqual({ kind: "browser" });
    expect(action({ key: "N", code: "KeyN", keyCode: 78, metaKey: true, shiftKey: true }, MAC)).toEqual({ kind: "browser" });
    expect(action({ key: "n", code: "KeyN", keyCode: 78, metaKey: true, ctrlKey: true }, MAC)).toEqual({ kind: "browser" });
  });

  test("macOS Command chords xterm.js encodes are sent", () => {
    expect(action({ key: "Enter", code: "Enter", keyCode: 13, metaKey: true }, MAC)).toEqual({ kind: "send", data: "\r" });
    expect(action({ key: "Backspace", code: "Backspace", keyCode: 8, metaKey: true }, MAC)).toEqual({ kind: "send", data: "\x7f" });
  });

  test("a layout's printable ASCII Option character types itself on macOS", () => {
    // German: Option+L @, Option+5 [, Option+7 |, Option+8 {, Option+Shift+7 \.
    expect(action({ key: "@", code: "KeyL", keyCode: 76, altKey: true }, MAC)).toEqual({ kind: "send", data: "@" });
    expect(action({ key: "[", code: "Digit5", keyCode: 53, altKey: true }, MAC)).toEqual({ kind: "send", data: "[" });
    expect(action({ key: "|", code: "Digit7", keyCode: 55, altKey: true }, MAC)).toEqual({ kind: "send", data: "|" });
    expect(action({ key: "{", code: "Digit8", keyCode: 56, altKey: true }, MAC)).toEqual({ kind: "send", data: "{" });
    expect(action({ key: "\\", code: "Digit7", keyCode: 55, altKey: true, shiftKey: true }, MAC)).toEqual({
      kind: "send",
      data: "\\",
    });
  });

  test("Option stays Meta for a character outside ASCII, a space, and off macOS", () => {
    expect(action({ key: "∫", code: "KeyB", keyCode: 66, altKey: true }, MAC)).toEqual({ kind: "send", data: "\x1bb" });
    expect(action({ key: " ", code: "Space", keyCode: 32, altKey: true }, MAC)).toEqual({ kind: "send", data: "\x1b " });
    expect(action({ key: "b", code: "KeyB", keyCode: 66, altKey: true }, LINUX)).toEqual({ kind: "send", data: "\x1bb" });
    expect(action({ key: "@", code: "KeyL", keyCode: 76, altKey: true, ctrlKey: true }, MAC)).not.toEqual({
      kind: "send",
      data: "@",
    });
  });

  test("a Ctrl chord off macOS is the control character", () => {
    expect(action({ key: "n", code: "KeyN", keyCode: 78, ctrlKey: true })).toEqual({ kind: "send", data: "\x0e" });
  });

  test("Shift+PageUp scrolls, Cmd+A selects all", () => {
    expect(action({ key: "PageUp", code: "PageUp", keyCode: 33, shiftKey: true })).toEqual({ kind: "scroll", lines: -23 });
    expect(action({ key: "a", code: "KeyA", keyCode: 65, metaKey: true }, MAC)).toEqual({ kind: "select-all" });
  });

  test("an IME's key and a keyup stay with ghostty-web", () => {
    expect(action({ key: "Process", keyCode: 229 })).toEqual({ kind: "ghostty" });
    expect(
      ghosttyKeydownAction(
        new KeyboardEvent("keyup", { key: "ArrowLeft" }),
        { platform: LINUX, applicationCursorMode: false, rows: 24, chanBytes: null },
        createXtermKeydownState(),
      ),
    ).toEqual({ kind: "ghostty" });
  });

  test("ghosttyTypesKey is ghostty-web's printable test", () => {
    expect(ghosttyTypesKey({ key: "a", ctrlKey: false, altKey: false, metaKey: false })).toBe(true);
    expect(ghosttyTypesKey({ key: "@", ctrlKey: true, altKey: true, metaKey: false })).toBe(true);
    expect(ghosttyTypesKey({ key: "b", ctrlKey: false, altKey: true, metaKey: false })).toBe(false);
    expect(ghosttyTypesKey({ key: "Enter", ctrlKey: false, altKey: false, metaKey: false })).toBe(false);
  });
});

/// One state across a key sequence, as the listener keeps it.
function sequence(platform: XtermPlatform, inits: Init[]) {
  const state = createXtermKeydownState();
  return inits.map((init) =>
    ghosttyKeydownAction(keydown(init), { platform, applicationCursorMode: false, rows: 24, chanBytes: null }, state),
  );
}

describe("after AltGr or a dead key", () => {
  // xterm.js types these from its keypress or input handler and clears its
  // pending dead key there; ghostty-web types them from keydown, and the
  // browser's own text does not reach it while its host holds the focus.
  const ALTGR_LINUX: Init = { key: "AltGraph", code: "AltRight", keyCode: 225 };
  const AT_LINUX: Init = { key: "@", code: "KeyQ", keyCode: 81 };
  const CTRL_WIN: Init = { key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: true };
  const ALTGR_WIN: Init = { key: "AltGraph", code: "AltRight", keyCode: 18, ctrlKey: true, altKey: true };
  const AT_WIN: Init = { key: "@", code: "KeyQ", keyCode: 81, ctrlKey: true, altKey: true };

  test("Linux: the AltGr character is ghostty-web's to type, and so is the key after it", () => {
    expect(sequence(LINUX, [ALTGR_LINUX, AT_LINUX, { key: "h", code: "KeyH", keyCode: 72 }])).toEqual([
      { kind: "browser" },
      { kind: "ghostty" },
      { kind: "ghostty" },
    ]);
  });

  test("Linux: a dead key's composed character is ghostty-web's to type", () => {
    const dead: Init = { key: "Dead", code: "Quote", keyCode: 222 };
    expect(sequence(LINUX, [dead, { key: "é", code: "KeyE", keyCode: 69 }]).at(-1)).toEqual({ kind: "ghostty" });
    expect(sequence(LINUX, [dead, { key: "é", code: "KeyE", keyCode: 0 }]).at(-1)).toEqual({ kind: "ghostty" });
  });

  test("macOS: a dead key composed by the input source, then an ASCII Option character, ends it", () => {
    const dead: Init = { key: "Dead", code: "Equal", keyCode: 187 };
    const composing: Init = { key: "Process", code: "KeyE", keyCode: 229 };
    const at: Init = { key: "@", code: "KeyL", keyCode: 76, altKey: true };
    const enter: Init = { key: "Enter", code: "Enter", keyCode: 13 };
    expect(sequence(MAC, [dead, composing, at, enter])).toEqual([
      { kind: "browser" },
      { kind: "ghostty" },
      { kind: "send", data: "@" },
      { kind: "send", data: "\r" },
    ]);
  });

  test.each([
    ["h", { key: "h", code: "KeyH", keyCode: 72 }, { kind: "ghostty" }],
    ["Enter", { key: "Enter", code: "Enter", keyCode: 13 }, { kind: "send", data: "\r" }],
    ["ArrowLeft", { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }, { kind: "send", data: "\x1b[D" }],
    ["Ctrl+C", { key: "c", code: "KeyC", keyCode: 67, ctrlKey: true }, { kind: "send", data: "\x03" }],
    ["Tab", { key: "Tab", code: "Tab", keyCode: 9 }, { kind: "send", data: "\t" }],
  ] as const)("Windows: after an AltGr character, %s is the terminal's", (_name, next, want) => {
    const actions = sequence({ isMac: false, isWindows: true }, [CTRL_WIN, ALTGR_WIN, AT_WIN, next]);
    expect(actions[2], "ghostty-web types the AltGr character").toEqual({ kind: "ghostty" });
    expect(actions[3]).toEqual(want);
  });
});

// The full path: chan's listener in front of ghostty-web's own InputHandler
// on Ghostty's wasm key encoder, against what chan's xterm.js path sends.

const WASM = "vendor/ghostty-vt/ghostty-vt.wasm";
let vt: GhosttyVt;
const hosts: HTMLElement[] = [];

beforeAll(async () => {
  vt = new GhosttyVt(await WebAssembly.instantiate(await WebAssembly.compile(readFileSync(WASM)), {}));
});

afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

type Outcome = { data: string; scrolled: number; prevented: boolean };

/// What a ghostty terminal does with a keydown under chan's listener.
function ghostty(init: Init, platform: XtermPlatform, applicationCursorMode = false): Outcome {
  const host = document.createElement("div");
  const textarea = document.createElement("textarea");
  host.append(textarea);
  document.body.append(host);
  hosts.push(host);
  const out: Outcome = { data: "", scrolled: 0, prevented: false };
  const protocol = createTerminalKeyboardProtocolState();
  const handler = new InputHandler(
    vt as never,
    host,
    (d) => (out.data += d),
    () => {},
    undefined,
    () => false,
    (mode) => (mode === 1 ? applicationCursorMode : false),
  );
  const remove = installGhosttyKeyParity(host, {
    terminal: {
      rows: 24,
      getMode: (mode) => (mode === 1 ? applicationCursorMode : false),
      scrollLines: (n) => (out.scrolled += n),
      selectAll: () => {},
      clearSelection: () => {},
    },
    platform: () => platform,
    claimed: () => false,
    chanBytes: (e) => terminalMetaKeyBytes(e, protocol),
    send: (d) => (out.data += d),
  });
  const ev = keydown(init);
  textarea.dispatchEvent(ev);
  out.prevented = ev.defaultPrevented;
  remove();
  handler.dispose();
  return out;
}

/// What chan's xterm.js terminal sends for the same keydown: chan's key
/// handler, then xterm.js, with the browser typing the key it passes on.
function xterm(init: Init, platform: XtermPlatform, applicationCursorMode = false): Omit<Outcome, "prevented"> {
  const ev = keydown(init);
  const chan = terminalMetaKeyBytes(ev, createTerminalKeyboardProtocolState());
  if (chan !== null) return { data: chan, scrolled: 0 };
  const decision = xtermKeydown(ev, { applicationCursorMode, platform, rows: 24 }, createXtermKeydownState());
  switch (decision.kind) {
    case "send":
      return { data: decision.data, scrolled: 0 };
    case "scroll":
      return { data: "", scrolled: decision.lines };
    case "pass":
      return { data: ghosttyTypesKey(ev) && !decision.deadKey ? ev.key : "", scrolled: 0 };
    default:
      return { data: "", scrolled: 0 };
  }
}

type Key = { code: string; key: string; keyCode: number; shifted?: string; option?: string; optionShifted?: string };

const letter = (c: string, option: string, optionShifted: string): Key => ({
  code: `Key${c.toUpperCase()}`,
  key: c,
  keyCode: c.toUpperCase().charCodeAt(0),
  shifted: c.toUpperCase(),
  option,
  optionShifted,
});

// US layout; `option` is what macOS Option types.
const KEYS: Key[] = [
  { code: "ArrowLeft", key: "ArrowLeft", keyCode: 37 },
  { code: "ArrowRight", key: "ArrowRight", keyCode: 39 },
  { code: "ArrowUp", key: "ArrowUp", keyCode: 38 },
  { code: "ArrowDown", key: "ArrowDown", keyCode: 40 },
  { code: "Home", key: "Home", keyCode: 36 },
  { code: "End", key: "End", keyCode: 35 },
  { code: "PageUp", key: "PageUp", keyCode: 33 },
  { code: "PageDown", key: "PageDown", keyCode: 34 },
  { code: "Insert", key: "Insert", keyCode: 45 },
  { code: "Delete", key: "Delete", keyCode: 46 },
  { code: "Backspace", key: "Backspace", keyCode: 8 },
  { code: "Enter", key: "Enter", keyCode: 13 },
  { code: "Tab", key: "Tab", keyCode: 9 },
  { code: "Escape", key: "Escape", keyCode: 27 },
  { code: "Space", key: " ", keyCode: 32, shifted: " ", option: " ", optionShifted: " " },
  { code: "F1", key: "F1", keyCode: 112 },
  { code: "F5", key: "F5", keyCode: 116 },
  { code: "F12", key: "F12", keyCode: 123 },
  letter("a", "å", "Å"),
  letter("b", "∫", "ı"),
  letter("c", "ç", "Ç"),
  letter("d", "∂", "Î"),
  letter("f", "ƒ", "Ï"),
  letter("u", "Dead", "¨"),
  { code: "Slash", key: "/", keyCode: 191, shifted: "?", option: "÷", optionShifted: "¿" },
  { code: "Period", key: ".", keyCode: 190, shifted: ">", option: "≥", optionShifted: "˘" },
  { code: "Comma", key: ",", keyCode: 188, shifted: "<", option: "≤", optionShifted: "¯" },
  { code: "BracketLeft", key: "[", keyCode: 219, shifted: "{", option: "“", optionShifted: "”" },
  { code: "BracketRight", key: "]", keyCode: 221, shifted: "}", option: "‘", optionShifted: "’" },
  { code: "Backslash", key: "\\", keyCode: 220, shifted: "|", option: "«", optionShifted: "»" },
  { code: "Minus", key: "-", keyCode: 189, shifted: "_", option: "–", optionShifted: "—" },
  { code: "Digit1", key: "1", keyCode: 49, shifted: "!", option: "¡", optionShifted: "⁄" },
  { code: "Digit2", key: "2", keyCode: 50, shifted: "@", option: "™", optionShifted: "€" },
  { code: "Digit6", key: "6", keyCode: 54, shifted: "^", option: "§", optionShifted: "ﬂ" },
];

function event(k: Key, mods: number, platform: XtermPlatform): Init {
  const shiftKey = (mods & 1) !== 0;
  const altKey = (mods & 2) !== 0;
  const ctrlKey = (mods & 4) !== 0;
  const metaKey = (mods & 8) !== 0;
  let key = shiftKey && k.shifted ? k.shifted : k.key;
  if (platform.isMac && altKey && !ctrlKey && !metaKey) {
    key = (shiftKey ? k.optionShifted : k.option) ?? key;
  }
  return { key, code: k.code, keyCode: k.keyCode, shiftKey, altKey, ctrlKey, metaKey };
}

function label(init: Init, platform: XtermPlatform): string {
  const mods = [init.ctrlKey && "Ctrl", init.altKey && "Alt", init.shiftKey && "Shift", init.metaKey && "Meta"];
  return `${platform.isMac ? "mac" : "linux"} ${[...mods.filter(Boolean), init.code].join("+")}`;
}

describe("a ghostty terminal sends what chan's xterm.js terminal sends", () => {
  test.each([
    ["linux", LINUX],
    ["mac", MAC],
  ] as const)("every modifier combination on %s", (_name, platform) => {
    const mismatches: string[] = [];
    let compared = 0;
    for (const k of KEYS) {
      for (let mods = 0; mods < 16; mods++) {
        const init = event(k, mods, platform);
        for (const appCursor of [false, true]) {
          const want = xterm(init, platform, appCursor);
          const got = ghostty(init, platform, appCursor);
          compared++;
          if (got.data !== want.data || got.scrolled !== want.scrolled) {
            mismatches.push(`${label(init, platform)}${appCursor ? " DECCKM" : ""}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(compared).toBe(KEYS.length * 16 * 2);
  });

  test.each([
    ["Alt+Left", { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, altKey: true }, LINUX, "\x1bb"],
    ["Alt+Right", { key: "ArrowRight", code: "ArrowRight", keyCode: 39, altKey: true }, MAC, "\x1bf"],
    ["Alt+B", { key: "b", code: "KeyB", keyCode: 66, altKey: true }, LINUX, "\x1bb"],
    ["Option+F", { key: "ƒ", code: "KeyF", keyCode: 70, altKey: true }, MAC, "\x1bf"],
    ["Alt+Delete", { key: "Delete", code: "Delete", keyCode: 46, altKey: true }, LINUX, "\x1bd"],
    ["Ctrl+[", { key: "[", code: "BracketLeft", keyCode: 219, ctrlKey: true }, LINUX, "\x1b"],
    ["Shift+Home", { key: "Home", code: "Home", keyCode: 36, shiftKey: true }, LINUX, "\x1b[1;2H"],
    ["Cmd+Enter", { key: "Enter", code: "Enter", keyCode: 13, metaKey: true }, MAC, "\r"],
  ] as const)("%s", (_name, init, platform, bytes) => {
    const out = ghostty(init, platform);
    expect(out.data).toBe(bytes);
    expect(out.prevented).toBe(true);
  });

  test("Shift+Insert keeps its default, the browser's paste", () => {
    expect(ghostty({ key: "Insert", code: "Insert", keyCode: 45, shiftKey: true }, LINUX)).toEqual({
      data: "",
      scrolled: 0,
      prevented: false,
    });
  });

  test("a dead key keeps its default, the browser's composition", () => {
    expect(ghostty({ key: "Dead", code: "Quote", keyCode: 222 }, LINUX)).toEqual({
      data: "",
      scrolled: 0,
      prevented: false,
    });
  });

  test("an unclaimed macOS Command chord keeps its default for the native menu", () => {
    expect(ghostty({ key: "w", code: "KeyW", keyCode: 87, metaKey: true }, MAC).prevented).toBe(false);
  });
});
