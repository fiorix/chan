// xterm.js's keyboard encoding, ported so a terminal on another engine sends
// the bytes an xterm.js terminal sends for the same keydown. The evaluator is
// xterm.js 6.0.0's src/common/input/Keyboard.ts; `xtermKeydown` is the part
// of CoreBrowserTerminal._keyDown that decides what happens to its result.
// xtermKeyboard.test.ts compares the evaluator with xterm.js's own over every
// key code and modifier combination.
//
// Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
// Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
// Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

const NUL = "\x00";
const HT = "\t";
const CR = "\r";
const ESC = "\x1b";
const FS = "\x1c";
const GS = "\x1d";
const US = "\x1f";
const DEL = "\x7f";

const KEYCODE_KEY_MAPPINGS: Record<number, [string, string]> = {
  48: ["0", ")"],
  49: ["1", "!"],
  50: ["2", "@"],
  51: ["3", "#"],
  52: ["4", "$"],
  53: ["5", "%"],
  54: ["6", "^"],
  55: ["7", "&"],
  56: ["8", "*"],
  57: ["9", "("],
  186: [";", ":"],
  187: ["=", "+"],
  188: [",", "<"],
  189: ["-", "_"],
  190: [".", ">"],
  191: ["/", "?"],
  192: ["`", "~"],
  219: ["[", "{"],
  220: ["\\", "|"],
  221: ["]", "}"],
  222: ["'", '"'],
};

/// The fields of a keydown the evaluator reads.
export type XtermKeyInput = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "shiftKey" | "metaKey" | "keyCode" | "key" | "code"
>;

/// xterm.js's KeyboardResultType, by name.
export type XtermKeyResultType = "send" | "select-all" | "page-up" | "page-down";

export type XtermKeyResult = {
  type: XtermKeyResultType;
  cancel: boolean;
  key: string | undefined;
};

/// Cursor keys (arrows, Home, End) with xterm's modifier form and DECCKM.
function cursorKey(final: string, modifiers: number, applicationCursorMode: boolean): string {
  if (modifiers) return `${ESC}[1;${modifiers + 1}${final}`;
  return applicationCursorMode ? `${ESC}O${final}` : `${ESC}[${final}`;
}

/// F1-F4: SS3 alone, CSI 1;m with a modifier.
function pfKey(final: string, modifiers: number): string {
  return modifiers ? `${ESC}[1;${modifiers + 1}${final}` : `${ESC}O${final}`;
}

/// F5-F12 and Delete: CSI n ~, with the modifier as a second param.
function tildeKey(code: number, modifiers: number): string {
  return modifiers ? `${ESC}[${code};${modifiers + 1}~` : `${ESC}[${code}~`;
}

const F5_TO_F12: Record<number, number> = {
  116: 15,
  117: 17,
  118: 18,
  119: 19,
  120: 20,
  121: 21,
  122: 23,
  123: 24,
};

export function evaluateKeyboardEvent(
  ev: XtermKeyInput,
  applicationCursorMode: boolean,
  isMac: boolean,
  macOptionIsMeta: boolean,
): XtermKeyResult {
  const result: XtermKeyResult = { type: "send", cancel: false, key: undefined };
  const modifiers =
    (ev.shiftKey ? 1 : 0) | (ev.altKey ? 2 : 0) | (ev.ctrlKey ? 4 : 0) | (ev.metaKey ? 8 : 0);
  switch (ev.keyCode) {
    case 0: {
      // iOS hardware keyboards report arrows by name, with no key code.
      const finals: Record<string, string> = {
        UIKeyInputUpArrow: "A",
        UIKeyInputLeftArrow: "D",
        UIKeyInputRightArrow: "C",
        UIKeyInputDownArrow: "B",
      };
      const final = finals[ev.key];
      if (final) result.key = cursorKey(final, 0, applicationCursorMode);
      break;
    }
    case 8:
      result.key = ev.ctrlKey ? "\b" : DEL;
      if (ev.altKey) result.key = ESC + result.key;
      break;
    case 9:
      if (ev.shiftKey) {
        result.key = `${ESC}[Z`;
        break;
      }
      result.key = HT;
      result.cancel = true;
      break;
    case 13:
      result.key = ev.altKey ? ESC + CR : CR;
      result.cancel = true;
      break;
    case 27:
      result.key = ev.altKey ? ESC + ESC : ESC;
      result.cancel = true;
      break;
    case 37:
    case 39:
    case 38:
    case 40:
      if (ev.metaKey) break;
      result.key = cursorKey({ 37: "D", 39: "C", 38: "A", 40: "B" }[ev.keyCode]!, modifiers, applicationCursorMode);
      break;
    case 45:
      if (!ev.shiftKey && !ev.ctrlKey) result.key = `${ESC}[2~`;
      break;
    case 46:
      result.key = tildeKey(3, modifiers);
      break;
    case 36:
      result.key = cursorKey("H", modifiers, applicationCursorMode);
      break;
    case 35:
      result.key = cursorKey("F", modifiers, applicationCursorMode);
      break;
    case 33:
    case 34: {
      const up = ev.keyCode === 33;
      if (ev.shiftKey) {
        result.type = up ? "page-up" : "page-down";
      } else if (ev.ctrlKey) {
        result.key = `${ESC}[${up ? 5 : 6};${modifiers + 1}~`;
      } else {
        result.key = `${ESC}[${up ? 5 : 6}~`;
      }
      break;
    }
    case 112:
    case 113:
    case 114:
    case 115:
      result.key = pfKey({ 112: "P", 113: "Q", 114: "R", 115: "S" }[ev.keyCode]!, modifiers);
      break;
    case 116:
    case 117:
    case 118:
    case 119:
    case 120:
    case 121:
    case 122:
    case 123:
      result.key = tildeKey(F5_TO_F12[ev.keyCode]!, modifiers);
      break;
    default:
      if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey) {
        if (ev.keyCode >= 65 && ev.keyCode <= 90) {
          result.key = String.fromCharCode(ev.keyCode - 64);
        } else if (ev.keyCode === 32) {
          result.key = NUL;
        } else if (ev.keyCode >= 51 && ev.keyCode <= 55) {
          // Ctrl+3..7: ESC, FS, GS, RS, US.
          result.key = String.fromCharCode(ev.keyCode - 51 + 27);
        } else if (ev.keyCode === 56) {
          result.key = DEL;
        } else if (ev.keyCode === 219) {
          result.key = ESC;
        } else if (ev.keyCode === 220) {
          result.key = FS;
        } else if (ev.keyCode === 221) {
          result.key = GS;
        }
      } else if ((!isMac || macOptionIsMeta) && ev.altKey && !ev.metaKey) {
        // Alt as Meta: ESC and the key's US-layout character, read from the
        // key code so macOS Option's composed character does not leak in.
        const key = KEYCODE_KEY_MAPPINGS[ev.keyCode]?.[ev.shiftKey ? 1 : 0];
        if (key) {
          result.key = ESC + key;
        } else if (ev.keyCode >= 65 && ev.keyCode <= 90) {
          const code = ev.ctrlKey ? ev.keyCode - 64 : ev.keyCode + 32;
          let keyString = String.fromCharCode(code);
          if (ev.shiftKey) keyString = keyString.toUpperCase();
          result.key = ESC + keyString;
        } else if (ev.keyCode === 32) {
          result.key = ESC + (ev.ctrlKey ? NUL : " ");
        } else if (ev.key === "Dead" && ev.code.startsWith("Key")) {
          // macOS Option makes some US letters (E, I, N, U) dead keys.
          let keyString = ev.code.slice(3, 4);
          if (!ev.shiftKey) keyString = keyString.toLowerCase();
          result.key = ESC + keyString;
          result.cancel = true;
        }
      } else if (isMac && !ev.altKey && !ev.ctrlKey && !ev.shiftKey && ev.metaKey) {
        if (ev.keyCode === 65) result.type = "select-all";
      } else if (
        ev.key &&
        !ev.ctrlKey &&
        !ev.altKey &&
        !ev.metaKey &&
        ev.keyCode >= 48 &&
        ev.key.length === 1
      ) {
        result.key = ev.key;
      } else if (ev.key && ev.ctrlKey) {
        if (ev.key === "_") result.key = US;
        if (ev.key === "@") result.key = NUL;
      }
      break;
  }
  return result;
}

export type XtermPlatform = { isMac: boolean; isWindows: boolean };

/// What xterm.js does with a keydown that its custom key handler declined.
/// - `send`: it sends `data` as user input and cancels the event.
/// - `scroll`: it scrolls its viewport by `lines` and cancels the event.
/// - `select-all`: it selects everything, then leaves the event to the browser.
/// - `pass`: it leaves the event to the browser, which may type text through
///   the input or composition events. `deadKey` marks a pass for a pending
///   dead key, whose text the browser composes.
/// - `composing`: an IME owns the key.
export type XtermKeydown =
  | { kind: "send"; data: string }
  | { kind: "scroll"; lines: number }
  | { kind: "select-all" }
  | { kind: "pass"; deadKey: boolean }
  | { kind: "composing" };

/// State xterm.js carries from one keydown to the next.
export type XtermKeydownState = {
  /// A dead key (or AltGraph) was pressed and its text is still to come.
  deadKey: boolean;
};

export function createXtermKeydownState(): XtermKeydownState {
  return { deadKey: false };
}

export type XtermKeydownInput = XtermKeyInput &
  Pick<KeyboardEvent, "isComposing" | "getModifierState">;

/// The decisions CoreBrowserTerminal._keyDown makes around the evaluator, for
/// xterm.js with `macOptionIsMeta` on and screen reader mode off, as chan
/// runs it. The composition helper's test is reduced to the event's own
/// composing marks.
export function xtermKeydown(
  ev: XtermKeydownInput,
  opts: { applicationCursorMode: boolean; platform: XtermPlatform; rows: number },
  state: XtermKeydownState,
): XtermKeydown {
  const { isMac, isWindows } = opts.platform;
  const macOptionIsMeta = true;
  const ignoreComposition = isMac && macOptionIsMeta && ev.altKey;
  if (!ignoreComposition && (ev.isComposing || ev.keyCode === 229)) {
    return { kind: "composing" };
  }
  if (!ignoreComposition && (ev.key === "Dead" || ev.key === "AltGraph")) {
    state.deadKey = true;
  }
  const result = evaluateKeyboardEvent(ev, opts.applicationCursorMode, isMac, macOptionIsMeta);
  if (result.type === "page-up" || result.type === "page-down") {
    const lines = opts.rows - 1;
    return { kind: "scroll", lines: result.type === "page-up" ? -lines : lines };
  }
  if (result.type === "select-all") return { kind: "select-all" };
  // A Windows AltGr (Ctrl+Alt) on a character key types the character.
  const thirdLevelShift =
    ((isWindows && ev.altKey && ev.ctrlKey && !ev.metaKey) ||
      (isWindows && ev.getModifierState("AltGraph"))) &&
    (!ev.keyCode || ev.keyCode > 47);
  if (thirdLevelShift) return { kind: "pass", deadKey: false };
  if (!result.key) return { kind: "pass", deadKey: state.deadKey };
  // Unmodified capitals go through keypress so macOS IMEs see Caps Lock.
  if (ev.key && !ev.ctrlKey && !ev.altKey && !ev.metaKey && ev.key.length === 1) {
    const code = ev.key.charCodeAt(0);
    if (code >= 65 && code <= 90) return { kind: "pass", deadKey: false };
  }
  if (state.deadKey) {
    state.deadKey = false;
    return { kind: "pass", deadKey: true };
  }
  return { kind: "send", data: result.key };
}
