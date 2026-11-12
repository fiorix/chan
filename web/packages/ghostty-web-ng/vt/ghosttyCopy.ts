/// The characters a copy from a ghostty terminal leaves out because the
/// screen does not draw them: the C0 controls but the line feed, DEL and
/// the C1 controls, and the invisible format characters (zero-width space,
/// the bidi marks, embeddings, overrides and isolates, word joiner and the
/// invisible operators, BOM). Pasted into a shell, DEL is a backspace and a
/// bidi override reorders what an editor shows. The core keeps DEL as a cell
/// and drops the rest before they reach one; the strip covers every read,
/// ghostty-web's own included. The joiners, variation selectors and
/// combining marks stay, since they are parts of clusters the screen draws,
/// and so do private-use characters, which a Nerd Font draws as glyphs.
const UNDRAWN = /[\x00-\x09\x0b-\x1f\x7f-\x9f​‎‏‪-‮⁠-⁤⁦-⁩﻿]/gu;

/// `text`, read from a ghostty terminal for a copy, without what the
/// screen does not draw.
export function copiedText(text: string): string {
  return text.replace(UNDRAWN, "");
}
