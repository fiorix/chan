import { describe, expect, test } from "vitest";
import { copiedText } from "./ghosttyCopy";

const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("a copy from a ghostty terminal", () => {
  test("keeps the line feed and leaves out every other C0 control, DEL and the C1 controls", () => {
    expect(copiedText("one\ntwo")).toBe("one\ntwo");
    for (const cp of [...range(0x00, 0x09), ...range(0x0b, 0x1f), 0x7f, ...range(0x80, 0x9f)]) {
      expect(copiedText(`a${String.fromCodePoint(cp)}b`), hex(cp)).toBe("ab");
    }
  });

  test("leaves out the invisible format characters", () => {
    const invisible = [0x200b, 0x200e, 0x200f, ...range(0x202a, 0x202e), ...range(0x2060, 0x2064), ...range(0x2066, 0x2069), 0xfeff];
    for (const cp of invisible) {
      expect(copiedText(`a${String.fromCodePoint(cp)}b`), hex(cp)).toBe("ab");
    }
    // A bidi override a program printed reads in its logical order.
    expect(copiedText("ls ‮exe.txt‬")).toBe("ls exe.txt");
  });

  test("keeps every character a cluster the screen draws is made of, and private-use glyphs", () => {
    const drawn = [
      "a\u{1F468}‍\u{1F469}‍\u{1F467}b", // ZWJ family
      "\u{1F44D}\u{1F3FD}", // skin tone
      "❤️", // variation selector
      "é", // combining acute
      "\u{1F1EF}\u{1F1F5}", // flag
      "क्‌ष", // ZWNJ in a Devanagari conjunct
      "  \u{F0000}", // powerline, Nerd Font, plane 15
      "no-break  ideographic　", // whitespace a program printed
      "日本語 한국어 €",
    ];
    for (const text of drawn) expect(copiedText(text), text).toBe(text);
  });
});
