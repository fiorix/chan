// The window-level chords of chan-desktop's macOS menubar, which a
// full-window cover leaves to the menubar. The list names chan's own items
// by their accelerators in the desktop's menu code, so a rebound item cannot
// leave the cover passing a chord the menubar no longer has.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { isMenubarWindowChord, MAC_MENUBAR_WINDOW_CHORDS, type MenubarChordEvent } from "./menubarChords";

const MAIN_RS = readFileSync("../../../desktop/src-tauri/src/main.rs", "utf8");

function key(init: Partial<MenubarChordEvent>): MenubarChordEvent {
  return { key: "", code: "", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init };
}

const CMD_P = key({ key: "p", code: "KeyP", metaKey: true });

describe("isMenubarWindowChord", () => {
  test.each<[string, Partial<MenubarChordEvent>]>([
    ["Toggle Launcher", { key: "p", code: "KeyP" }],
    ["New Window", { key: "N", code: "KeyN", shiftKey: true }],
    ["Quit Chan", { key: "q", code: "KeyQ" }],
    ["Hide", { key: "h", code: "KeyH" }],
    ["Hide Others", { key: "\u02d9", code: "KeyH", altKey: true }],
    ["Minimize", { key: "m", code: "KeyM" }],
  ])("names %s on the macOS desktop", (item, init) => {
    expect(MAC_MENUBAR_WINDOW_CHORDS.map((c) => c.item)).toContain(item);
    expect(isMenubarWindowChord(key({ metaKey: true, ...init }), true)).toBe(true);
  });

  test("follows the layout's letter, not the key's position", () => {
    // Dvorak types P on the QWERTY R key; QWERTY's own R is not a menubar chord.
    expect(isMenubarWindowChord(key({ key: "p", code: "KeyR", metaKey: true }), true)).toBe(true);
    expect(isMenubarWindowChord(key({ key: "r", code: "KeyR", metaKey: true }), true)).toBe(false);
  });

  test("is empty off the macOS desktop", () => {
    expect(isMenubarWindowChord(CMD_P, false)).toBe(false);
  });

  test.each<[string, Partial<MenubarChordEvent>]>([
    ["Cmd+K, the command deck", { key: "k", code: "KeyK", metaKey: true }],
    ["Cmd+Shift+P, the Rich Prompt", { key: "P", code: "KeyP", metaKey: true, shiftKey: true }],
    ["Cmd+Option+P", { key: "\u03c0", code: "KeyP", metaKey: true, altKey: true }],
    ["Cmd+Ctrl+P", { key: "p", code: "KeyP", metaKey: true, ctrlKey: true }],
    ["Cmd+N, a new draft", { key: "n", code: "KeyN", metaKey: true }],
    ["Cmd+Shift+Q", { key: "Q", code: "KeyQ", metaKey: true, shiftKey: true }],
    ["Cmd+T, New Terminal (a command in the page)", { key: "t", code: "KeyT", metaKey: true }],
    ["Cmd+W, Close Window (a command in the page)", { key: "w", code: "KeyW", metaKey: true }],
    ["Cmd+V, Paste (acts on the page)", { key: "v", code: "KeyV", metaKey: true }],
    ["Ctrl+P", { key: "p", code: "KeyP", ctrlKey: true }],
    ["Ctrl+Shift+P", { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }],
    ["P", { key: "p", code: "KeyP" }],
  ])("does not name %s", (_name, init) => {
    expect(isMenubarWindowChord(key(init), true)).toBe(false);
  });
});

describe("the desktop's menubar", () => {
  test.each([
    ["view-toggle-launcher", "Toggle Launcher", "CmdOrCtrl+P"],
    ["app-new-window", "New Window", "CmdOrCtrl+Shift+N"],
    ["chan-quit", "Quit Chan", "CmdOrCtrl+Q"],
  ])("binds %s to the listed chord", (id, item, accelerator) => {
    const builder = new RegExp(
      `MenuItemBuilder::with_id\\("${id}", "${item}"\\)\\s*\\.accelerator\\("${accelerator.replace(/\+/g, "\\+")}"\\)`,
    );
    expect(MAIN_RS).toMatch(builder);
    const [letter] = accelerator.split("+").slice(-1);
    const shift = accelerator.includes("Shift+");
    expect(MAC_MENUBAR_WINDOW_CHORDS).toContainEqual({ item, letter, shift, option: false });
  });
});
