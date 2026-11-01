import { beforeAll, describe, expect, test } from "vitest";
import {
  createXtermKeydownState,
  evaluateKeyboardEvent,
  xtermKeydown,
  type XtermKeyInput,
  type XtermKeyResultType,
} from "./xtermKeyboard";

type Reference = (
  ev: XtermKeyInput,
  applicationCursorMode: boolean,
  isMac: boolean,
  macOptionIsMeta: boolean,
) => { type: number; cancel: boolean; key: string | undefined };

// xterm.js's own evaluator, from the TypeScript source its package ships
// (vite.config.ts aliases its `common/...` imports). The specifier is a
// variable so svelte-check does not try to type xterm.js's source.
const XTERM_KEYBOARD = "common/input/Keyboard";
let reference: Reference;

beforeAll(async () => {
  reference = ((await import(/* @vite-ignore */ XTERM_KEYBOARD)) as { evaluateKeyboardEvent: Reference })
    .evaluateKeyboardEvent;
});

// xterm.js's KeyboardResultType, in its order.
const RESULT_TYPES: XtermKeyResultType[] = ["send", "select-all", "page-up", "page-down"];

// Values of `key` and `code` that reach every branch of the evaluator: the
// iOS arrow names, dead keys, the Ctrl+_ and Ctrl+@ symbols, composed and
// multi-character keys.
const KEYS = [
  "a",
  "A",
  "1",
  "_",
  "@",
  "/",
  " ",
  "é",
  "∫",
  "Dead",
  "Unidentified",
  "UIKeyInputUpArrow",
  "UIKeyInputDownArrow",
  "UIKeyInputLeftArrow",
  "UIKeyInputRightArrow",
];
const CODES = ["KeyN", "Quote"];

function* inputs(): Generator<XtermKeyInput> {
  for (let keyCode = 0; keyCode < 256; keyCode++) {
    for (let mods = 0; mods < 16; mods++) {
      for (const key of KEYS) {
        for (const code of CODES) {
          yield {
            keyCode,
            key,
            code,
            shiftKey: (mods & 1) !== 0,
            altKey: (mods & 2) !== 0,
            ctrlKey: (mods & 4) !== 0,
            metaKey: (mods & 8) !== 0,
          };
        }
      }
    }
  }
}

describe("the evaluator matches xterm.js's", () => {
  test.each([
    [false, false, true],
    [false, true, true],
    [true, false, true],
    [true, true, true],
    [true, false, false],
    [true, true, false],
  ])("isMac %s, application cursor keys %s, macOptionIsMeta %s", (isMac, appCursor, optionIsMeta) => {
    let compared = 0;
    const mismatches: string[] = [];
    for (const ev of inputs()) {
      const want = reference(ev, appCursor, isMac, optionIsMeta);
      const got = evaluateKeyboardEvent(ev, appCursor, isMac, optionIsMeta);
      compared++;
      if (
        RESULT_TYPES[want.type] !== got.type ||
        want.cancel !== got.cancel ||
        want.key !== got.key
      ) {
        if (mismatches.length < 10) mismatches.push(JSON.stringify({ ev, want, got }));
      }
    }
    expect(mismatches).toEqual([]);
    expect(compared).toBe(256 * 16 * KEYS.length * CODES.length);
  });
});

type Event = Partial<XtermKeyInput> & {
  isComposing?: boolean;
  altGraph?: boolean;
};

function keydown(init: Event) {
  return {
    keyCode: 0,
    key: "",
    code: "",
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
    isComposing: false,
    ...init,
    getModifierState: (name: string) => name === "AltGraph" && !!init.altGraph,
  };
}

const LINUX = { isMac: false, isWindows: false };
const MAC = { isMac: true, isWindows: false };
const WINDOWS = { isMac: false, isWindows: true };

function decide(init: Event, platform = LINUX, state = createXtermKeydownState()) {
  return xtermKeydown(keydown(init), { applicationCursorMode: false, platform, rows: 24 }, state);
}

describe("the keydown decisions around the evaluator", () => {
  test("an encoded key is sent", () => {
    expect(decide({ keyCode: 37, key: "ArrowLeft", altKey: true })).toEqual({ kind: "send", data: "\x1b[1;3D" });
  });

  test("Shift+PageUp and Shift+PageDown scroll a page less one row", () => {
    expect(decide({ keyCode: 33, key: "PageUp", shiftKey: true })).toEqual({ kind: "scroll", lines: -23 });
    expect(decide({ keyCode: 34, key: "PageDown", shiftKey: true })).toEqual({ kind: "scroll", lines: 23 });
  });

  test("Cmd+A selects all on macOS only", () => {
    expect(decide({ keyCode: 65, key: "a", metaKey: true }, MAC)).toEqual({ kind: "select-all" });
    expect(decide({ keyCode: 65, key: "a", metaKey: true }, LINUX)).toEqual({ kind: "pass", deadKey: false });
  });

  test("an IME's key is left to the composition", () => {
    expect(decide({ keyCode: 229, key: "Process" })).toEqual({ kind: "composing" });
    expect(decide({ keyCode: 65, key: "a", isComposing: true })).toEqual({ kind: "composing" });
  });

  test("macOS Option is Meta even while the browser composes", () => {
    expect(decide({ keyCode: 66, key: "∫", code: "KeyB", altKey: true, isComposing: true }, MAC))
      .toEqual({ kind: "send", data: "\x1bb" });
  });

  test("a key with no encoding is left to the browser", () => {
    expect(decide({ keyCode: 45, key: "Insert", shiftKey: true })).toEqual({ kind: "pass", deadKey: false });
    expect(decide({ keyCode: 16, key: "Shift", shiftKey: true })).toEqual({ kind: "pass", deadKey: false });
  });

  test("unmodified capitals are left to the browser, which types them", () => {
    expect(decide({ keyCode: 65, key: "A", shiftKey: true })).toEqual({ kind: "pass", deadKey: false });
    expect(decide({ keyCode: 65, key: "a" })).toEqual({ kind: "send", data: "a" });
  });

  test("a dead key and the key after it are left to the browser, which composes them", () => {
    const state = createXtermKeydownState();
    expect(decide({ keyCode: 222, key: "Dead", code: "Quote" }, LINUX, state)).toEqual({ kind: "pass", deadKey: true });
    expect(decide({ keyCode: 69, key: "e", code: "KeyE" }, LINUX, state)).toEqual({ kind: "pass", deadKey: true });
    expect(decide({ keyCode: 69, key: "e", code: "KeyE" }, LINUX, state)).toEqual({ kind: "send", data: "e" });
  });

  test("AltGraph arms the same pending composition", () => {
    const state = createXtermKeydownState();
    expect(decide({ keyCode: 225, key: "AltGraph" }, LINUX, state)).toEqual({ kind: "pass", deadKey: true });
    expect(state.deadKey).toBe(true);
  });

  test("a Windows AltGr (Ctrl+Alt) character is left to the browser", () => {
    const altGr = { keyCode: 81, key: "@", code: "KeyQ", ctrlKey: true, altKey: true };
    expect(decide(altGr, WINDOWS)).toEqual({ kind: "pass", deadKey: false });
    expect(decide({ keyCode: 81, key: "@", code: "KeyQ", altGraph: true }, WINDOWS)).toEqual({ kind: "pass", deadKey: false });
    expect(decide(altGr, LINUX)).toEqual({ kind: "send", data: "\x1b\x11" });
    // Not for the keys below 48: arrows keep their Ctrl+Alt encoding.
    expect(decide({ keyCode: 37, key: "ArrowLeft", ctrlKey: true, altKey: true }, WINDOWS))
      .toEqual({ kind: "send", data: "\x1b[1;7D" });
  });

  test.each([false, true])("Windows Ctrl+Alt plus a bare letter sends the control-Meta chord (AltGraph=%s)", (altGraph) => {
    expect(decide({ keyCode: 66, key: "b", code: "KeyB", ctrlKey: true, altKey: true, altGraph }, WINDOWS))
      .toEqual({ kind: "send", data: "\x1b\x02" });
    expect(decide({ keyCode: 66, key: "B", code: "KeyB", ctrlKey: true, altKey: true, shiftKey: true, altGraph }, WINDOWS))
      .toEqual({ kind: "send", data: "\x1b\x02" });
  });

  test.each([
    ["\u0131", "KeyI", 73],
    ["\u017f", "KeyS", 83],
  ] as const)("an AltGr layout character %s is not its ASCII uppercase equivalent", (key, code, keyCode) => {
    expect(decide({ keyCode, key, code, ctrlKey: true, altKey: true }, WINDOWS))
      .toEqual({ kind: "pass", deadKey: false });
  });
});
