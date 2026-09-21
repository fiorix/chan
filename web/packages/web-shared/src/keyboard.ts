// The keyboard identity every shortcut matcher reads from a keydown, so the
// workspace handlers, the terminal escape registry, shortcut capture and the
// launcher agree on what a key names under the active layout.

/// The punctuation symbols a shortcut can name. A key that types one of these
/// names it, wherever the layout puts it.
const BASE_PUNCTUATION = new Set(["`", "[", "]", ",", "=", "-", ".", ";", "/"]);

/// US shifted forms of the base symbols. The chord grammar spells `?` as
/// Shift+/, and every glyph here follows the same rule, so Cmd+Shift+[ keeps
/// naming Shift+[ when the browser reports the `{` it typed.
const SHIFTED_PUNCTUATION: ReadonlyMap<string, string> = new Map([
  ["~", "`"],
  ["{", "["],
  ["}", "]"],
  ["<", ","],
  ["+", "="],
  ["_", "-"],
  [">", "."],
  [":", ";"],
  ["?", "/"],
]);

/// The US symbol at each punctuation position, for the Option fallback only.
const PHYSICAL_PUNCTUATION: ReadonlyMap<string, string> = new Map([
  ["Backquote", "`"],
  ["BracketLeft", "["],
  ["BracketRight", "]"],
  ["Comma", ","],
  ["Equal", "="],
  ["Minus", "-"],
  ["Period", "."],
  ["Semicolon", ";"],
  ["Slash", "/"],
]);

const MODIFIER_KEYS = new Set(["Shift", "Alt", "Control", "Meta", "AltGraph"]);

export type ShortcutKeyEvent = Pick<KeyboardEvent, "key" | "code" | "altKey"> &
  Partial<Pick<KeyboardEvent, "isComposing" | "getModifierState">>;

export type ShortcutKey = {
  /// The registry's key token: `A`..`Z`, a top-row digit, a base
  /// punctuation symbol, a named key such as `Enter`, or any other character
  /// the layout typed.
  key: string;
  /// The layout typed a shifted glyph, so the chord names Shift+`key`.
  shifted: boolean;
  /// `key` is a base punctuation symbol the layout typed. A Shift held to
  /// type it may be consumed when the unshifted chord is the one claimed.
  consumable: boolean;
};

/// Resolve a keydown to the key it names for shortcuts, or null when no
/// shortcut may claim it: a lone modifier, an IME composition, a dead key
/// outside Option, or AltGr character entry. Top-row digits keep their
/// position, so AZERTY's unshifted digit row still selects tabs. Letters and
/// punctuation follow the layout, including Caps Lock. Option can replace
/// the key with a glyph or a dead key; only then, where the event carries no
/// supported symbol, does the physical position decide.
///
/// AltGr is refused off macOS only. There Option is Alt, and an engine may
/// report it as AltGraph as well, which must not disable every Option chord.
export function shortcutKey(
  e: ShortcutKeyEvent,
  mac: boolean = macUserAgent(),
): ShortcutKey | null {
  const k = e.key;
  if (!k || MODIFIER_KEYS.has(k) || k === "Unidentified") return null;
  if (e.isComposing || k === "Process") return null;
  if (!mac && e.getModifierState?.("AltGraph")) return null;
  const digit = e.code.match(/^Digit([0-9])$/)?.[1];
  if (digit) return named(digit);
  if (/^[a-z]$/i.test(k)) return named(k.toUpperCase());
  if (BASE_PUNCTUATION.has(k)) return { key: k, shifted: false, consumable: true };
  const base = SHIFTED_PUNCTUATION.get(k);
  if (base) return { key: base, shifted: true, consumable: false };
  if (e.altKey) {
    const letter = e.code.match(/^Key([A-Z])$/)?.[1];
    if (letter) return named(letter);
    const punctuation = PHYSICAL_PUNCTUATION.get(e.code);
    if (punctuation) return named(punctuation);
  }
  if (k === "Dead") return null;
  // Named keys keep the browser's `KeyboardEvent.key` spelling (`Enter`,
  // `Tab`, `ArrowLeft`), which is the registry's.
  return named(k.length === 1 ? k.toUpperCase() : k);
}

/// The base symbol a US shifted glyph names with Shift (`?` is Shift+/), or
/// undefined. Chord comparison folds stored chords with the same table the
/// keydown side uses, so both spell a shifted symbol one way.
export function shiftedPunctuationBase(symbol: string): string | undefined {
  return SHIFTED_PUNCTUATION.get(symbol);
}

/// Resolve letter shortcuts through the active layout, including Caps Lock.
/// Option can replace a letter with a glyph or dead key; retain the physical
/// fallback only for those events, where the browser exposes no base letter.
export function shortcutLetter(e: ShortcutKeyEvent): string | null {
  const key = shortcutKey(e)?.key;
  return key && /^[A-Z]$/.test(key) ? key : null;
}

function named(key: string): ShortcutKey {
  return { key, shifted: false, consumable: false };
}

function macUserAgent(): boolean {
  return typeof navigator !== "undefined" && /Mac OS X|Macintosh/.test(navigator.userAgent);
}
