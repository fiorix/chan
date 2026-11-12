import { readFileSync } from "node:fs";
import { InputHandler } from "@chan/ghostty-web-ng";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { ghosttyKeydownAction, ghosttyTypesKey, installGhosttyKeyParity } from "./ghosttyKeys";
import { GhosttyVt } from "@chan/ghostty-web-ng/vt";
import { isTerminalPasteChord } from "./clipboardChord";
import { createTerminalKeyboardProtocolState, terminalMetaKeyBytes } from "./keymap";
import { createXtermKeydownState, xtermKeydown, type XtermPlatform } from "./xtermKeyboard";

const LINUX: XtermPlatform = { isMac: false, isWindows: false };
const MAC: XtermPlatform = { isMac: true, isWindows: false };
const WINDOWS: XtermPlatform = { isMac: false, isWindows: true };

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
  // pending dead key there; ghostty-web types them from keydown.
  const ALTGR_LINUX: Init = { key: "AltGraph", code: "AltRight", keyCode: 225 };
  const AT_LINUX: Init = { key: "@", code: "KeyQ", keyCode: 81 };
  const CTRL_WIN: Init = { key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: true };
  const ALTGR_WIN: Init = { key: "AltGraph", code: "AltRight", keyCode: 18, ctrlKey: true, altKey: true };
  const AT_WIN: Init = { key: "@", code: "KeyQ", keyCode: 81, ctrlKey: true, altKey: true };

  test("Windows AltGraph alone does not make the next plain key a dead-key continuation", () => {
    expect(sequence(WINDOWS, [ALTGR_WIN, { key: "h", code: "KeyH", keyCode: 72 }])).toEqual([
      { kind: "browser" }, { kind: "ghostty" },
    ]);
  });

  test("a Windows dead-key continuation consumes only the pending key", () => {
    expect(sequence(WINDOWS, [
      { key: "Dead", code: "Quote", keyCode: 222 },
      { key: "Shift", code: "ShiftLeft", keyCode: 16 },
      { key: "E", code: "KeyE", keyCode: 69, shiftKey: true },
      { key: "h", code: "KeyH", keyCode: 72 },
    ])).toEqual([{ kind: "browser" }, { kind: "browser" }, { kind: "browser" }, { kind: "ghostty" }]);
  });

  test.each([
    ["Enter", 13, "\r"],
    ["Tab", 9, "\t"],
  ] as const)("a dead key followed by %s sends the non-text key", (key, keyCode, data) => {
    expect(sequence(LINUX, [
      { key: "Dead", code: "Quote", keyCode: 222 },
      { key, code: key, keyCode },
    ])).toEqual([{ kind: "browser" }, { kind: "send", data }]);
  });

  test("Windows: Tab after a dead key is sent; a plain Enter waits for the browser's text", () => {
    const dead: Init = { key: "Dead", code: "Quote", keyCode: 222 };
    expect(sequence(WINDOWS, [dead, { key: "Tab", code: "Tab", keyCode: 9 }])).toEqual([
      { kind: "browser" }, { kind: "send", data: "\t" },
    ]);
    expect(sequence(WINDOWS, [dead, { key: "Enter", code: "Enter", keyCode: 13 }, { key: "Enter", code: "Enter", keyCode: 13 }]))
      .toEqual([{ kind: "browser" }, { kind: "line-break", data: "\r" }, { kind: "send", data: "\r" }]);
    expect(sequence(WINDOWS, [dead, { key: "Enter", code: "NumpadEnter", keyCode: 13 }]).at(-1))
      .toEqual({ kind: "line-break", data: "\r" });
    expect(sequence(WINDOWS, [dead, { key: "Enter", code: "Enter", keyCode: 13, altKey: true }]).at(-1))
      .toEqual({ kind: "send", data: "\x1b\r" });
    for (const mod of ["shiftKey", "ctrlKey", "metaKey"] as const) {
      expect(sequence(WINDOWS, [dead, { key: "Enter", code: "Enter", keyCode: 13, [mod]: true }]).at(-1)?.kind, mod)
        .not.toBe("line-break");
    }
  });

  test("Windows: numpad digits typed with Alt held are an Alt code, not keys", () => {
    // Recorded on Windows 11 Chrome and Edge 156: Num Lock off reads the
    // digits as arrows, which chan's own bytes would send as word motions.
    expect(action({ key: "ArrowLeft", code: "Numpad4", keyCode: 37, altKey: true }, WINDOWS, "\x1bb")).toEqual({ kind: "cancel" });
    expect(action({ key: "ArrowRight", code: "Numpad6", keyCode: 39, altKey: true }, WINDOWS, "\x1bf")).toEqual({ kind: "cancel" });
    expect(action({ key: "4", code: "Numpad4", keyCode: 100, altKey: true }, WINDOWS)).toEqual({ kind: "cancel" });
    expect(action({ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, altKey: true }, WINDOWS, "\x1bb")).toEqual({ kind: "send", data: "\x1bb" });
    expect(action({ key: "ArrowLeft", code: "Numpad4", keyCode: 37, altKey: true }, LINUX, "\x1bb")).toEqual({ kind: "send", data: "\x1bb" });
    for (const mod of ["ctrlKey", "metaKey", "shiftKey"] as const) {
      expect(action({ key: "4", code: "Numpad4", keyCode: 100, altKey: true, [mod]: true }, WINDOWS), mod).not.toEqual({ kind: "cancel" });
    }
    expect(action({ key: "4", code: "Numpad4", keyCode: 100 }, WINDOWS)).not.toEqual({ kind: "cancel" });
    expect(action({ key: "Enter", code: "NumpadEnter", keyCode: 13, altKey: true }, WINDOWS)).not.toEqual({ kind: "cancel" });
  });

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

const WASM = "../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";
let vt: GhosttyVt;
const hosts: HTMLElement[] = [];

beforeAll(async () => {
  vt = new GhosttyVt(await WebAssembly.instantiate(await WebAssembly.compile(readFileSync(WASM)), {}));
});

afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

/// Exercise the host listener together with ghostty-web's real input path.
function inputTerminal(
  cancelHost = false,
  platform = LINUX,
  chanBytes: (e: KeyboardEvent) => string | null = () => null,
) {
  const host = document.createElement("div");
  const textarea = document.createElement("textarea");
  host.append(textarea);
  document.body.append(host);
  hosts.push(host);
  const data: string[] = [];
  const handler = new InputHandler(vt, host, (text) => data.push(text), () => {}, undefined,
    () => false, () => false, undefined, textarea);
  const cancelled = { reached: false };
  if (cancelHost) host.addEventListener("beforeinput", (event) => { cancelled.reached = true; event.preventDefault(); });
  const remove = installGhosttyKeyParity(host, {
    terminal: { rows: 24, getMode: () => false, scrollLines() {}, selectAll() {}, clearSelection() {} },
    platform: () => platform,
    claimed: (event) => isTerminalPasteChord(event, platform.isMac ? "mac" : "windows"),
    chanBytes,
    send: (text) => data.push(text),
  });
  const beforeinput = (text: string | null, init: InputEventInit = {}, target: HTMLElement = host) => {
    const event = new InputEvent("beforeinput", {
      bubbles: true, cancelable: true, inputType: "insertText", data: text, ...init,
    });
    target.dispatchEvent(event);
    return event;
  };
  return { host, textarea, data, beforeinput, cancelled, dispose() { remove(); handler.dispose(); } };
}

describe("browser text on the ghostty host", () => {
  test.each([
    ["e", "KeyE", 69, "\u00e9"],
    ["\u00e9", "KeyE", 69, "\u00e9"],
    ["t", "KeyT", 84, "'t"],
    [" ", "Space", 32, "'"],
    ["'", "Space", 32, "'"],
    ["E", "KeyE", 69, "\u00c9"],
    ["\u00e9", "KeyE", 0, "\u00e9"],
  ] as const)("Windows Dead then %s (%s, keyCode %i) takes browser text %s once", (key, code, keyCode, text) => {
    const term = inputTerminal(true, WINDOWS);
    term.host.dispatchEvent(keydown({ key: "Dead", code: "Quote", keyCode: 222 }));
    const event = keydown({ key, code, keyCode });
    term.host.dispatchEvent(event);
    expect(term.data, "keydown must not guess the composed text").toEqual([]);
    expect(event.defaultPrevented, "the browser must be allowed to compose").toBe(false);
    term.beforeinput(text);
    expect(term.data).toEqual([text]);
    term.host.dispatchEvent(keydown({ key: "h", code: "KeyH", keyCode: 72 }));
    expect(term.data).toEqual([text, "h"]);
    term.dispose();
  });

  test.each([
    ["b", "KeyB", 66, "\x1b\x02"],
    ["@", "KeyQ", 81, "@"],
    ["@", "KeyV", 86, "@"],
  ] as const)("Windows Ctrl+Alt key=%s code=%s delivers its chord or character", (key, code, keyCode, data) => {
    const term = inputTerminal(true, WINDOWS);
    term.host.dispatchEvent(keydown({ key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: true }));
    term.host.dispatchEvent(keydown({ key: "AltGraph", code: "AltRight", keyCode: 18, ctrlKey: true, altKey: true }));
    let reachedGhostty = false;
    term.host.addEventListener("keydown", () => { reachedGhostty = true; });
    const event = keydown({ key, code, keyCode, ctrlKey: true, altKey: true });
    term.host.dispatchEvent(event);
    expect(term.data).toEqual([data]);
    expect(event.defaultPrevented).toBe(true);
    if (code === "KeyV") expect(reachedGhostty, "AltGr must not reach the KeyV paste early return").toBe(false);
    term.beforeinput(key);
    expect(term.data, "matching text after a handled key is not duplicated").toEqual([data]);
    term.host.dispatchEvent(keydown({ key: "Enter", code: "Enter", keyCode: 13 }));
    expect(term.data).toEqual([data, "\r"]);
    term.dispose();
  });

  test("Windows AltGr+V as Chromium reports it types its character once", () => {
    // Recorded on Windows 11 Chrome and Edge 156 (Czech, Slovak, Hungarian): a
    // synthetic Control keydown, then AltGraph and the character with ctrlKey
    // and altKey false and only the AltGraph modifier state set.
    const term = inputTerminal(true, WINDOWS);
    term.host.dispatchEvent(keydown({ key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: true }));
    term.host.dispatchEvent(keydown({ key: "AltGraph", code: "AltRight", keyCode: 18, modifierAltGraph: true }));
    term.host.dispatchEvent(keydown({ key: "@", code: "KeyV", keyCode: 86, modifierAltGraph: true }));
    term.beforeinput("@");
    expect(term.data).toEqual(["@"]);
    term.dispose();
  });

  describe("Windows Enter after a dead key", () => {
    // Recorded on Windows 11 Chrome and Edge 156 (US-International): the
    // pending apostrophe arrives as insertText only after Enter's keydown,
    // then Enter's own line break; a cancelled Enter keydown drops it.
    const DEAD: Init = { key: "Dead", code: "Quote", keyCode: 222 };
    const ENTER: Init = { key: "Enter", code: "Enter", keyCode: 13 };
    const enterUp = () => new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" });

    test.each([
      ["the focused host", "insertParagraph", false],
      ["ghostty-web's textarea", "insertLineBreak", true],
    ] as const)("on %s the apostrophe comes before CR, each once", (_where, inputType, onTextarea) => {
      const term = inputTerminal(true, WINDOWS);
      const target = onTextarea ? term.textarea : term.host;
      target.dispatchEvent(keydown(DEAD));
      const enter = keydown(ENTER);
      target.dispatchEvent(enter);
      expect(enter.defaultPrevented, "the browser must still type the pending apostrophe").toBe(false);
      expect(term.data, "CR must wait for the apostrophe").toEqual([]);
      term.beforeinput("'", {}, target);
      expect(term.data).toEqual(["'"]);
      expect(term.beforeinput(null, { inputType }, target).defaultPrevented).toBe(true);
      expect(term.data, "CR goes with Enter's own input").toEqual(["'", "\r"]);
      target.dispatchEvent(enterUp());
      expect(term.data).toEqual(["'", "\r"]);
      term.dispose();
    });

    test("an already cancelled line break leaves CR to Enter's keyup", () => {
      const term = inputTerminal(false, WINDOWS);
      term.host.dispatchEvent(keydown(DEAD));
      term.host.dispatchEvent(keydown(ENTER));
      const cancelled = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertParagraph" });
      cancelled.preventDefault();
      term.host.dispatchEvent(cancelled);
      expect(term.data).toEqual([]);
      term.host.dispatchEvent(enterUp());
      expect(term.data).toEqual(["\r"]);
      term.dispose();
    });

    test("with no line-break input, Enter's keyup sends CR", () => {
      const term = inputTerminal(true, WINDOWS);
      term.host.dispatchEvent(keydown(DEAD));
      term.host.dispatchEvent(keydown(ENTER));
      term.host.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Shift", code: "ShiftLeft" }));
      expect(term.data).toEqual([]);
      term.host.dispatchEvent(enterUp());
      term.host.dispatchEvent(enterUp());
      expect(term.data).toEqual(["\r"]);
      term.dispose();
    });

    test.each(["keydown", "focusout"])("a %s before Enter's input sends its CR first", (type) => {
      const term = inputTerminal(true, WINDOWS);
      term.host.dispatchEvent(keydown(DEAD));
      term.host.dispatchEvent(keydown(ENTER));
      if (type === "keydown") term.host.dispatchEvent(keydown({ key: "h", code: "KeyH", keyCode: 72 }));
      else term.host.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      expect(term.data).toEqual(type === "keydown" ? ["\r", "h"] : ["\r"]);
      term.beforeinput(null, { inputType: "insertParagraph" });
      term.host.dispatchEvent(enterUp());
      expect(term.data, "CR is sent once").toEqual(type === "keydown" ? ["\r", "h"] : ["\r"]);
      term.dispose();
    });

    test("a line break with no pending Enter is left alone", () => {
      const term = inputTerminal(false, WINDOWS);
      expect(term.beforeinput(null, { inputType: "insertParagraph" }).defaultPrevented).toBe(false);
      expect(term.data).toEqual([]);
      term.dispose();
    });
  });

  test.each([
    ["Num Lock off", [["ArrowRight", "Numpad6", 39], ["ArrowLeft", "Numpad4", 37]]],
    ["Num Lock on", [["6", "Numpad6", 102], ["4", "Numpad4", 100]]],
  ] as const)("Windows Alt+Numpad 6 4 types only its character (%s)", (_name, digits) => {
    // Recorded on Windows 11 Chrome and Edge 156: Windows types the Alt code's
    // character when Alt is released, as insertText after a keyup whose key is
    // that character; the digit keydowns type nothing.
    const term = inputTerminal(true, WINDOWS, (e) => terminalMetaKeyBytes(e, createTerminalKeyboardProtocolState()));
    term.host.dispatchEvent(keydown({ key: "Alt", code: "AltLeft", keyCode: 18, altKey: true }));
    for (const [key, code, keyCode] of digits) {
      const down = keydown({ key, code, keyCode, altKey: true });
      term.host.dispatchEvent(down);
      expect(down.defaultPrevented, `${code} must not reach the browser, where Alt+ArrowLeft is Back`).toBe(true);
      term.host.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key, code, altKey: true }));
    }
    term.host.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "@", code: "AltLeft" }));
    expect(term.data).toEqual([]);
    term.beforeinput("@");
    expect(term.data).toEqual(["@"]);
    term.dispose();
  });

  test("Windows Ctrl+V is input and Ctrl+Shift+V retains native paste", () => {
    const term = inputTerminal(true, WINDOWS);
    const ctrlV = keydown({ key: "v", code: "KeyV", keyCode: 86, ctrlKey: true });
    term.host.dispatchEvent(ctrlV);
    expect(ctrlV.defaultPrevented).toBe(true);
    expect(term.data).toEqual(["\x16"]);
    const pasteKey = keydown({ key: "V", code: "KeyV", keyCode: 86, ctrlKey: true, shiftKey: true });
    term.host.dispatchEvent(pasteKey);
    expect(pasteKey.defaultPrevented).toBe(false);
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => "clipboard text" } });
    term.host.dispatchEvent(paste);
    expect(term.data).toEqual(["\x16", "clipboard text"]);
    term.dispose();
  });

  test("insertText without keydown sends once, ahead of the host's cancel", () => {
    const term = inputTerminal(true);
    expect(term.beforeinput("\u{1f600}").defaultPrevented).toBe(true);
    expect(term.data).toEqual(["\u{1f600}"]);
    expect(term.cancelled.reached).toBe(false);
    term.dispose();
  });

  test("textarea input stays with ghostty-web and sends once", () => {
    const term = inputTerminal();
    let reachedTextarea = false;
    term.textarea.addEventListener("beforeinput", () => { reachedTextarea = true; });
    term.beforeinput("\u{1f600}", {}, term.textarea);
    expect(reachedTextarea).toBe(true);
    expect(term.data).toEqual(["\u{1f600}"]);
    term.dispose();
  });

  test("composing text stays with ghostty-web, including the commit's follow-up input", () => {
    const term = inputTerminal();
    expect(term.beforeinput("draft", { isComposing: true }).defaultPrevented).toBe(false);
    term.host.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(term.beforeinput("draft").defaultPrevented).toBe(false);
    term.host.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "\u00e9" }));
    term.beforeinput("\u00e9");
    expect(term.data).toEqual(["\u00e9"]);
    term.dispose();
  });

  test("a keydown's text is not sent again, and the next independent insertion is delivered", () => {
    const term = inputTerminal();
    term.host.dispatchEvent(keydown({ key: "a", code: "KeyA", keyCode: 65 }));
    term.beforeinput("a");
    expect(term.data).toEqual(["a"]);
    term.beforeinput("a");
    expect(term.data).toEqual(["a", "a"]);
    term.host.dispatchEvent(keydown({ key: "b", code: "KeyB", keyCode: 66 }));
    term.host.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "b" }));
    term.beforeinput("b");
    expect(term.data).toEqual(["a", "a", "b", "b"]);
    term.dispose();
  });

  test("a different insertion after a handled key is not lost", () => {
    const term = inputTerminal();
    term.host.dispatchEvent(keydown({ key: "a", code: "KeyA", keyCode: 65 }));
    term.beforeinput("\u{1f600}");
    expect(term.data).toEqual(["a", "\u{1f600}"]);
    term.dispose();
  });

  test.each(["keyup", "focusout", "keydown"])("%s clears a key's duplicate guard", (type) => {
    const term = inputTerminal();
    term.host.dispatchEvent(keydown({ key: "a", code: "KeyA", keyCode: 65 }));
    if (type === "keydown") term.host.dispatchEvent(keydown({ key: "Dead", code: "Quote", keyCode: 222 }));
    else term.host.dispatchEvent(new Event(type, { bubbles: true }));
    term.beforeinput("a");
    expect(term.data).toEqual(["a", "a"]);
    term.dispose();
  });

  test.each([
    { isComposing: true, keyCode: 65 },
    { isComposing: false, keyCode: 229 },
  ])("an IME key does not suppress its text commit: %j", (marks) => {
    const term = inputTerminal();
    term.host.dispatchEvent(keydown({ key: "a", code: "KeyA", ...marks }));
    term.beforeinput("a");
    expect(term.data).toEqual(["a"]);
    term.dispose();
  });

  test.each([["Enter", 13, "\r"], ["Tab", 9, "\t"]] as const)(
    "the browser's dead-key character precedes %s without being reconstructed from its key code",
    (key, keyCode, data) => {
      const term = inputTerminal();
      term.host.dispatchEvent(keydown({ key: "Dead", code: "Quote", keyCode: 222 }));
      term.beforeinput("\u00b4");
      term.host.dispatchEvent(keydown({ key, code: key, keyCode }));
      expect(term.data).toEqual(["\u00b4", data]);
      term.dispose();
    },
  );

  test("a composing letter after Dead stays with the browser and ghostty-web", () => {
    const term = inputTerminal();
    term.host.dispatchEvent(keydown({ key: "Dead", code: "Quote", keyCode: 222 }));
    term.host.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    term.host.dispatchEvent(keydown({ key: "e", code: "KeyE", keyCode: 229, isComposing: true }));
    term.beforeinput("\u00e9", { isComposing: true });
    expect(term.data).toEqual([]);
    term.host.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "\u00e9" }));
    expect(term.data).toEqual(["\u00e9"]);
    term.dispose();
  });

  test("non-text input, empty data, and already cancelled input are left alone", () => {
    const term = inputTerminal();
    for (const text of [null, ""]) expect(term.beforeinput(text).defaultPrevented).toBe(false);
    expect(term.beforeinput("paste", { inputType: "insertFromPaste" }).defaultPrevented).toBe(false);
    const cancelled = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "x" });
    cancelled.preventDefault();
    term.host.dispatchEvent(cancelled);
    expect(term.data).toEqual([]);
    term.dispose();
  });

  test("removal detaches the text listener", () => {
    const term = inputTerminal();
    term.dispose();
    expect(term.beforeinput("text").defaultPrevented).toBe(false);
    expect(term.data).toEqual([]);
  });
});

// WebKit can flag a delete key keyCode 229, as taken by its text input, with
// no composition under way. chan and ghostty-web both leave such a keydown to
// the browser, whose delete input then carries the key.
describe("delete input on the ghostty host", () => {
  const deleteInput = (
    term: ReturnType<typeof inputTerminal>,
    inputType: string,
    target: HTMLElement,
    init: InputEventInit = {},
  ) => term.beforeinput(null, { inputType, ...init }, target);

  test.each([
    ["the host", LINUX],
    ["the textarea", LINUX],
    ["the host", MAC],
    ["the textarea", MAC],
  ] as const)("a Backspace the text input took sends DEL once, aimed at %s (%j)", (where, platform) => {
    const term = inputTerminal(false, platform);
    const target = where === "the host" ? term.host : term.textarea;
    const key = keydown({ key: "Backspace", code: "Backspace", keyCode: 229 });
    target.dispatchEvent(key);
    expect(term.data, "the keydown is the text input's").toEqual([]);
    expect(key.defaultPrevented).toBe(false);
    expect(deleteInput(term, "deleteContentBackward", target).defaultPrevented).toBe(true);
    expect(term.data).toEqual(["\x7f"]);
    term.dispose();
  });

  test.each([
    ["deleteContentBackward", { key: "Backspace", code: "Backspace", keyCode: 8 }, LINUX],
    ["deleteContentForward", { key: "Delete", code: "Delete", keyCode: 46 }, LINUX],
    ["deleteWordBackward", { key: "Backspace", code: "Backspace", keyCode: 8, ctrlKey: true }, LINUX],
    ["deleteWordForward", { key: "Delete", code: "Delete", keyCode: 46, ctrlKey: true }, LINUX],
    ["deleteContentBackward", { key: "Backspace", code: "Backspace", keyCode: 8 }, MAC],
    ["deleteContentForward", { key: "Delete", code: "Delete", keyCode: 46 }, MAC],
    ["deleteWordBackward", { key: "Backspace", code: "Backspace", keyCode: 8, altKey: true }, MAC],
    ["deleteWordForward", { key: "Delete", code: "Delete", keyCode: 46, altKey: true }, MAC],
  ] as const)("%s sends what its key sends (%j, %j)", (inputType, init, platform) => {
    const want = xterm(init, platform).data;
    expect(want).not.toBe("");
    const term = inputTerminal(false, platform, (e) => terminalMetaKeyBytes(e, createTerminalKeyboardProtocolState()));
    term.textarea.dispatchEvent(keydown({ ...init, keyCode: 229 }));
    deleteInput(term, inputType, term.textarea);
    expect(term.data).toEqual([want]);
    term.dispose();
  });

  test.each([
    ["Backspace", 8, "deleteContentBackward", "\x7f"],
    ["Delete", 46, "deleteContentForward", "\x1b[3~"],
  ] as const)("a %s the keydown sent is not sent again by its delete input", (key, keyCode, inputType, bytes) => {
    const term = inputTerminal();
    const down = keydown({ key, code: key, keyCode });
    term.textarea.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    deleteInput(term, inputType, term.textarea);
    expect(term.data).toEqual([bytes]);
    term.textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key }));
    deleteInput(term, inputType, term.textarea);
    expect(term.data, "a later delete input is its own").toEqual([bytes, bytes]);
    term.dispose();
  });

  test("a composition's own deletes stay with it", () => {
    const term = inputTerminal();
    term.host.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    term.textarea.dispatchEvent(keydown({ key: "Backspace", code: "Backspace", keyCode: 229, isComposing: true }));
    expect(deleteInput(term, "deleteContentBackward", term.textarea).defaultPrevented).toBe(false);
    expect(deleteInput(term, "deleteContentBackward", term.textarea, { isComposing: true }).defaultPrevented).toBe(false);
    expect(deleteInput(term, "deleteCompositionText", term.textarea, { isComposing: true }).defaultPrevented).toBe(false);
    term.host.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
    expect(term.data).toEqual([]);
    term.dispose();
  });

  test("a delete input already cancelled, or aimed elsewhere, is left alone", () => {
    const term = inputTerminal();
    const cancelled = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentBackward" });
    cancelled.preventDefault();
    term.host.dispatchEvent(cancelled);
    const field = document.createElement("input");
    term.host.append(field);
    expect(deleteInput(term, "deleteContentBackward", field).defaultPrevented).toBe(false);
    expect(term.data).toEqual([]);
    term.dispose();
  });
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
    vt,
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
