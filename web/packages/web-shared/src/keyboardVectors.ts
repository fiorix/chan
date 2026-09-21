// Keydowns taken from published keyboard layouts, shared by every test of a
// shortcut matcher: the TypeScript helper here and the injected JavaScript
// bridges that cannot import it. One table holds each implementation to the
// same layout facts.
//
// Layouts: Colemak, US Dvorak, French AZERTY (PC), German QWERTZ (PC), and US
// QWERTY including macOS Option glyphs. `key` is what the browser reports,
// `code` the physical position.

export type KeyVectorEvent = {
  key: string;
  code: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  /// `getModifierState("AltGraph")`: AltGr on Windows and Linux, and what an
  /// engine may also report for macOS Option.
  altGraph?: boolean;
  isComposing?: boolean;
};

export type KeyVector = {
  name: string;
  event: KeyVectorEvent;
  /// Resolve as macOS, where Option is Alt and never AltGr.
  mac?: boolean;
  /// The key token the matcher names, or null for a keydown no shortcut may
  /// claim.
  key: string | null;
  /// The token names Shift+key by itself (a US shifted glyph such as `?`).
  shifted?: boolean;
  /// Shift typed a base punctuation symbol, so the unshifted chord is a
  /// fallback candidate.
  consumable?: boolean;
};

export const KEY_VECTORS: readonly KeyVector[] = [
  // Colemak: letters move off their QWERTY positions.
  { name: "Colemak T on KeyF", event: { key: "t", code: "KeyF" }, key: "T" },
  { name: "Colemak F on KeyE", event: { key: "f", code: "KeyE" }, key: "F" },
  { name: "Colemak G on KeyT", event: { key: "g", code: "KeyT" }, key: "G" },
  { name: "Colemak O on Semicolon", event: { key: "o", code: "Semicolon" }, key: "O" },
  { name: "Colemak ; on KeyP", event: { key: ";", code: "KeyP" }, key: ";", consumable: true },
  { name: "Caps Lock T on KeyF", event: { key: "T", code: "KeyF" }, key: "T" },

  // US Dvorak: punctuation and letters trade places.
  { name: "Dvorak , on KeyW", event: { key: ",", code: "KeyW" }, key: ",", consumable: true },
  { name: "Dvorak . on KeyE", event: { key: ".", code: "KeyE" }, key: ".", consumable: true },
  {
    name: "Dvorak / on BracketLeft",
    event: { key: "/", code: "BracketLeft" },
    key: "/",
    consumable: true,
  },
  {
    name: "Dvorak = on BracketRight",
    event: { key: "=", code: "BracketRight" },
    key: "=",
    consumable: true,
  },
  { name: "Dvorak [ on Minus", event: { key: "[", code: "Minus" }, key: "[", consumable: true },
  { name: "Dvorak ] on Equal", event: { key: "]", code: "Equal" }, key: "]", consumable: true },
  { name: "Dvorak - on Quote", event: { key: "-", code: "Quote" }, key: "-", consumable: true },
  { name: "Dvorak W on Comma", event: { key: "w", code: "Comma" }, key: "W" },
  { name: "Dvorak V on Period", event: { key: "v", code: "Period" }, key: "V" },
  { name: "Dvorak Z on Slash", event: { key: "z", code: "Slash" }, key: "Z" },
  { name: "Dvorak E on KeyD", event: { key: "e", code: "KeyD" }, key: "E" },
  { name: "Dvorak D on KeyH", event: { key: "d", code: "KeyH" }, key: "D" },
  {
    name: "Dvorak { on Shift+Minus",
    event: { key: "{", code: "Minus", shiftKey: true },
    key: "[",
    shifted: true,
  },
  {
    name: "Dvorak ? on Shift+BracketLeft",
    event: { key: "?", code: "BracketLeft", shiftKey: true },
    key: "/",
    shifted: true,
  },

  // French AZERTY: the digit row types symbols unshifted, and `.` and `/`
  // need Shift.
  { name: "AZERTY A on KeyQ", event: { key: "a", code: "KeyQ" }, key: "A" },
  { name: "AZERTY Q on KeyA", event: { key: "q", code: "KeyA" }, key: "Q" },
  { name: "AZERTY M on Semicolon", event: { key: "m", code: "Semicolon" }, key: "M" },
  { name: "AZERTY & on Digit1 is digit 1", event: { key: "&", code: "Digit1" }, key: "1" },
  { name: "AZERTY - on Digit6 is digit 6", event: { key: "-", code: "Digit6" }, key: "6" },
  {
    name: "AZERTY Shift+Digit1 is digit 1",
    event: { key: "1", code: "Digit1", shiftKey: true },
    key: "1",
  },
  { name: "AZERTY , on KeyM", event: { key: ",", code: "KeyM" }, key: ",", consumable: true },
  { name: "AZERTY ; on Comma", event: { key: ";", code: "Comma" }, key: ";", consumable: true },
  {
    name: "AZERTY . on Shift+Comma",
    event: { key: ".", code: "Comma", shiftKey: true },
    key: ".",
    consumable: true,
  },
  {
    name: "AZERTY / on Shift+Period",
    event: { key: "/", code: "Period", shiftKey: true },
    key: "/",
    consumable: true,
  },
  {
    name: "AZERTY ? on Shift+KeyM",
    event: { key: "?", code: "KeyM", shiftKey: true },
    key: "/",
    shifted: true,
  },
  { name: "AZERTY ) on Minus", event: { key: ")", code: "Minus" }, key: ")" },
  { name: "AZERTY dead ^ on BracketLeft", event: { key: "Dead", code: "BracketLeft" }, key: null },

  // German QWERTZ: Y and Z swap, `-` sits on Slash, and brackets need AltGr.
  { name: "QWERTZ Z on KeyY", event: { key: "z", code: "KeyY" }, key: "Z" },
  { name: "QWERTZ Y on KeyZ", event: { key: "y", code: "KeyZ" }, key: "Y" },
  { name: "QWERTZ - on Slash", event: { key: "-", code: "Slash" }, key: "-", consumable: true },
  {
    name: "QWERTZ + on BracketRight",
    event: { key: "+", code: "BracketRight" },
    key: "=",
    shifted: true,
  },
  {
    name: "QWERTZ / on Shift+Digit7 is digit 7",
    event: { key: "/", code: "Digit7", shiftKey: true },
    key: "7",
  },
  {
    name: "QWERTZ ? on Shift+Minus",
    event: { key: "?", code: "Minus", shiftKey: true },
    key: "/",
    shifted: true,
  },
  {
    name: "QWERTZ ; on Shift+Comma",
    event: { key: ";", code: "Comma", shiftKey: true },
    key: ";",
    consumable: true,
  },
  { name: "QWERTZ dead ^ on Backquote", event: { key: "Dead", code: "Backquote" }, key: null },
  {
    name: "QWERTZ AltGr [ on Digit8 (Windows reports Ctrl+Alt)",
    event: { key: "[", code: "Digit8", ctrlKey: true, altKey: true, altGraph: true },
    key: null,
  },
  {
    name: "QWERTZ AltGr @ on KeyQ (Linux)",
    event: { key: "@", code: "KeyQ", altGraph: true },
    key: null,
  },

  // US QWERTY: shifted glyphs name Shift plus their base symbol.
  {
    name: "US ? on Shift+Slash",
    event: { key: "?", code: "Slash", shiftKey: true },
    key: "/",
    shifted: true,
  },
  {
    name: "US { on Shift+BracketLeft",
    event: { key: "{", code: "BracketLeft", shiftKey: true },
    key: "[",
    shifted: true,
  },
  {
    name: "US } on Shift+BracketRight",
    event: { key: "}", code: "BracketRight", shiftKey: true },
    key: "]",
    shifted: true,
  },
  {
    name: "US > on Shift+Period",
    event: { key: ">", code: "Period", shiftKey: true },
    key: ".",
    shifted: true,
  },
  {
    name: "US + on Shift+Equal",
    event: { key: "+", code: "Equal", shiftKey: true },
    key: "=",
    shifted: true,
  },
  { name: "US ` on Backquote", event: { key: "`", code: "Backquote" }, key: "`", consumable: true },
  {
    name: "US Alt+[ off macOS",
    event: { key: "[", code: "BracketLeft", altKey: true },
    key: "[",
    consumable: true,
  },
  { name: "numpad + is Shift+=", event: { key: "+", code: "NumpadAdd" }, key: "=", shifted: true },
  { name: "numpad 1", event: { key: "1", code: "Numpad1" }, key: "1" },
  { name: "Enter keeps its name", event: { key: "Enter", code: "Enter" }, key: "Enter" },
  {
    name: "ArrowLeft keeps its name",
    event: { key: "ArrowLeft", code: "ArrowLeft" },
    key: "ArrowLeft",
  },

  // macOS Option replaces the key with a glyph or a dead key; the position
  // decides only then.
  {
    name: "Option [ glyph",
    mac: true,
    event: { key: "“", code: "BracketLeft", altKey: true },
    key: "[",
  },
  {
    name: "Option Shift+[ glyph",
    mac: true,
    event: { key: "”", code: "BracketLeft", altKey: true, shiftKey: true },
    key: "[",
  },
  { name: "Option / glyph", mac: true, event: { key: "÷", code: "Slash", altKey: true }, key: "/" },
  { name: "Option G glyph", mac: true, event: { key: "©", code: "KeyG", altKey: true }, key: "G" },
  {
    name: "Option E dead key",
    mac: true,
    event: { key: "Dead", code: "KeyE", altKey: true },
    key: "E",
  },
  {
    name: "Option ` dead key",
    mac: true,
    event: { key: "Dead", code: "Backquote", altKey: true },
    key: "`",
  },
  {
    name: "Option glyph on Minus falls back to the US position",
    mac: true,
    event: { key: "–", code: "Minus", altKey: true },
    key: "-",
  },
  {
    name: "Option reported as AltGraph on macOS is still Option",
    mac: true,
    event: { key: "“", code: "BracketLeft", altKey: true, altGraph: true },
    key: "[",
  },
  {
    name: "Ctrl+Option reported as AltGraph on macOS is still a chord",
    mac: true,
    event: { key: "k", code: "KeyK", ctrlKey: true, altKey: true, altGraph: true },
    key: "K",
  },

  // Keydowns no shortcut may claim.
  { name: "IME composition", event: { key: "a", code: "KeyA", isComposing: true }, key: null },
  { name: "IME Process key", event: { key: "Process", code: "KeyA" }, key: null },
  { name: "lone Shift", event: { key: "Shift", code: "ShiftLeft", shiftKey: true }, key: null },
  { name: "lone AltGr", event: { key: "AltGraph", code: "AltRight", altGraph: true }, key: null },
];

/// Build the DOM event a vector describes, with extra modifiers on top.
export function keyVectorEvent(
  vector: KeyVector,
  extra: KeyboardEventInit = {},
): KeyboardEvent {
  const { altGraph, ...init } = vector.event;
  return new KeyboardEvent("keydown", {
    ...init,
    ...extra,
    modifierAltGraph: altGraph ?? false,
    bubbles: true,
    cancelable: true,
  });
}
