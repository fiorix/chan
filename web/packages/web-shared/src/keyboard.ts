/// Resolve letter shortcuts through the active layout, including Caps Lock.
/// Option can replace a letter with a glyph or dead key; retain the physical
/// fallback only for those events, where the browser exposes no base letter.
export function shortcutLetter(e: Pick<KeyboardEvent, "key" | "code" | "altKey">): string | null {
  if (/^[a-z]$/i.test(e.key)) return e.key.toUpperCase();
  return e.altKey ? (e.code.match(/^Key([A-Z])$/)?.[1] ?? null) : null;
}
