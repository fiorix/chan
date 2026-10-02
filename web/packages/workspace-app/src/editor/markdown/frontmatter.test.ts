// Guards the frontmatter block parser against the unclosed-opener
// corruption: a `---` on line 1 with no closing fence below must not
// consume lines before it knows the block closes. BlockContext never
// rewinds consumed lines, so a parser that read to EOF and then returned
// false would leave the whole document as one empty Paragraph (no
// headings, no lists, no HRs anywhere).
//
// We parse through the PROJECT grammar (chanMarkdown), not the stock
// @lezer/markdown parser, because the corruption is induced by the
// Frontmatter extension and only reproduces with it installed.

import { describe, expect, test } from "vitest";
import { chanMarkdown } from "./grammar";

const parser = chanMarkdown().language.parser;

/// Collect the set of node names appearing anywhere in the parse tree.
function nodeNames(input: string): Set<string> {
  const names = new Set<string>();
  parser.parse(input).iterate({
    enter(node) {
      names.add(node.name);
      return undefined;
    },
  });
  return names;
}

describe("frontmatter parser", () => {
  test("a `---`-headed doc with no closer still parses blocks below", () => {
    const names = nodeNames("---\n# Heading\n- bullet\n1. ordered\n");
    // The opener falls back to a horizontal rule and everything below it
    // parses normally instead of collapsing into one Paragraph.
    expect(names.has("HorizontalRule")).toBe(true);
    expect(names.has("ATXHeading1")).toBe(true);
    expect(names.has("BulletList")).toBe(true);
    expect(names.has("OrderedList")).toBe(true);
    expect(names.has("Frontmatter")).toBe(false);
  });

  test("all bullet markers survive below an unclosed opener", () => {
    const names = nodeNames("---\n- dash\n* star\n+ plus\n- [ ] task\n");
    expect(names.has("BulletList")).toBe(true);
    expect(names.has("TaskMarker")).toBe(true);
    expect(names.has("Frontmatter")).toBe(false);
  });

  test("valid frontmatter still emits a Frontmatter node", () => {
    const names = nodeNames("---\ntitle: hello\n---\n\n- bullet\n");
    // A closed block is dimmed as frontmatter, and content
    // below the closer still parses.
    expect(names.has("Frontmatter")).toBe(true);
    expect(names.has("FrontmatterMark")).toBe(true);
    expect(names.has("BulletList")).toBe(true);
  });

  test("a closer beyond MAX_LINES is treated as absent, not a swallow", () => {
    // With the closing `---` past the 10_000-line scan cap, the opener is
    // treated as having no closer: it falls back to a horizontal rule and
    // the content between the two markers is NOT swallowed as frontmatter.
    const filler = "x\n".repeat(10_003);
    const names = nodeNames(`---\n- bullet\n${filler}---\n`);
    expect(names.has("BulletList")).toBe(true);
    expect(names.has("Frontmatter")).toBe(false);
  });

  test("a closer within MAX_LINES still forms frontmatter", () => {
    const filler = "x\n".repeat(50);
    const names = nodeNames(`---\n${filler}---\n\n- bullet\n`);
    expect(names.has("Frontmatter")).toBe(true);
    expect(names.has("BulletList")).toBe(true);
  });
});
