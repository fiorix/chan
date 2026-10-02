// Lezer-markdown extension for YAML frontmatter at doc start.
//
// CommonMark + GFM does not parse frontmatter; without isolation, a `# `
// inside the YAML body would be promoted to a heading and `---` separators
// would render as horizontal rules. We define two block node types:
//
//   Frontmatter        the whole `---\n...\n---\n` block at doc start
//   FrontmatterMark    the opening `---` and closing `---` lines
//
// Style: muted (`tags.meta`) so theme rules can dim it. The body is left
// unstyled: there is no YAML highlighting.
//
// Constraints:
//   - Block must start at document position 0 (no leading blank lines).
//   - The opening line must be exactly `---` (CommonMark allows trailing
//     whitespace on HRs, but for frontmatter we want a strict `^---$` to
//     avoid eating real horizontal rules at line 1).
//   - The closing fence is the next line that is exactly `---` (or `...`,
//     a YAML stream-end marker; we accept both for parity with Pandoc).
//   - With no closing fence anywhere below, we emit no Frontmatter node
//     AND consume no lines, so the opener falls back to a normal
//     horizontal rule and every block below it still parses. Detecting
//     the missing fence has to happen without cx.nextLine(): that
//     advances the shared line cursor and BlockContext never rewinds it,
//     so scanning by consuming and then giving up would collapse the
//     rest of the document into one empty Paragraph.

import type { BlockContext, MarkdownConfig } from "@lezer/markdown";
import type { Input } from "@lezer/common";
import { tags } from "@lezer/highlight";

// Longest frontmatter block we scan for a closing fence. A closer beyond
// this many lines is treated as absent, capping both the pre-scan below
// and the consume loop.
const MAX_LINES = 10_000;

// True when a line that is exactly `---` or `...` exists below the opener,
// within MAX_LINES lines. Reads the raw input rather than walking with
// cx.nextLine() (which BlockContext does not rewind) or peekLine() (one
// line of lookahead only). `input` is not on BlockContext's published
// type but is present at runtime, where it backs readLine().
function hasFrontmatterCloser(cx: BlockContext, openEnd: number): boolean {
  const { input } = cx as unknown as { input: Input };
  const tail = input.read(openEnd, input.length);
  // `tail` starts at the opener's line break, so its first split entry is
  // the opener line's empty remainder; document line N is parts[N - 1].
  const parts = tail.split("\n");
  const limit = Math.min(parts.length - 1, MAX_LINES);
  for (let i = 1; i <= limit; i++) {
    const text = parts[i].endsWith("\r") ? parts[i].slice(0, -1) : parts[i];
    if (text === "---" || text === "...") return true;
  }
  return false;
}

export const Frontmatter: MarkdownConfig = {
  defineNodes: [
    {
      name: "Frontmatter",
      block: true,
      style: tags.meta,
    },
    {
      name: "FrontmatterMark",
      style: tags.processingInstruction,
    },
  ],
  parseBlock: [
    {
      name: "Frontmatter",
      parse(cx, line) {
        if (cx.lineStart !== 0) return false;
        if (line.text !== "---") return false;
        // The `line` parameter is the same Line object that gets
        // re-populated by cx.nextLine(), matching the pattern used by
        // lezer-markdown's own FencedCode / IndentedCode parsers.
        const openStart = cx.lineStart;
        const openEnd = openStart + line.text.length;
        // Bail before consuming anything when no closing fence exists;
        // otherwise the consumed lines never rewind and the whole
        // document parses as one empty Paragraph (see the header note).
        if (!hasFrontmatterCloser(cx, openEnd)) return false;
        let consumed = 0;
        // Move past the opener row.
        if (!cx.nextLine()) return false;
        while (consumed < MAX_LINES) {
          const text = line.text;
          if (text === "---" || text === "...") {
            const closeStart = cx.lineStart;
            const closeEnd = closeStart + text.length;
            cx.nextLine();
            cx.addElement(
              cx.elt("Frontmatter", openStart, closeEnd, [
                cx.elt("FrontmatterMark", openStart, openEnd),
                cx.elt("FrontmatterMark", closeStart, closeEnd),
              ]),
            );
            return true;
          }
          if (!cx.nextLine()) {
            // Defensive: hasFrontmatterCloser already proved a closer
            // exists within MAX_LINES, so this EOF path is unreachable
            // for well-formed input.
            return false;
          }
          consumed++;
        }
        return false;
      },
      // Must run before the HR parser; otherwise the opening `---`
      // line gets eaten as a horizontal rule and we never see it.
      before: "HorizontalRule",
    },
  ],
};
