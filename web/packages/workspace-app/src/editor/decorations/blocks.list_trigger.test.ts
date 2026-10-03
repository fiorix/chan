// Locks in the list-mode trigger semantics.
//
// CommonMark explicitly allows a "blank list item" -- a marker
// followed by space and nothing else -- and lezer-markdown emits the
// `BulletList` / `OrderedList` node on the trailing whitespace.
//
// The trigger path must not require content past the marker. We
// exercise the parser directly (no DOM) so the test runs fast in
// the standard Vitest pool.

import { describe, expect, test } from "vitest";
import { chanMarkdown } from "../markdown/grammar";

// Exercise the CONFIGURED parser (Frontmatter + GFM + wikilink), not the
// stock @lezer/markdown one: an extension can corrupt list recognition,
// and only the project grammar surfaces that.
const parser = chanMarkdown().language.parser;

/// Walk the parse tree and check whether `nodeName` appears at
/// the document level (depth 0 means a top-level block).
function hasNode(input: string, nodeName: string): boolean {
  const tree = parser.parse(input);
  let found = false;
  tree.iterate({
    enter(node) {
      if (node.name === nodeName) {
        found = true;
        return false;
      }
      return undefined;
    },
  });
  return found;
}

describe("list-mode trigger", () => {
  test("`- ` alone yields a BulletList on the first space", () => {
    expect(hasNode("- ", "BulletList")).toBe(true);
    expect(hasNode("- ", "ListItem")).toBe(true);
    expect(hasNode("- ", "ListMark")).toBe(true);
  });

  test("`* ` alone yields a BulletList", () => {
    expect(hasNode("* ", "BulletList")).toBe(true);
  });

  test("`+ ` alone yields a BulletList", () => {
    expect(hasNode("+ ", "BulletList")).toBe(true);
  });

  test("`1. ` alone yields an OrderedList on the first space", () => {
    expect(hasNode("1. ", "OrderedList")).toBe(true);
    expect(hasNode("1. ", "ListItem")).toBe(true);
  });

  test("`1) ` (alternate ordered separator) yields an OrderedList", () => {
    expect(hasNode("1) ", "OrderedList")).toBe(true);
  });

  test("a leading dash mid-line does NOT spuriously start a list", () => {
    // Bare hyphen mid-paragraph isn't a valid list marker; lezer
    // emits a single Paragraph and no BulletList.
    expect(hasNode("foo - bar", "BulletList")).toBe(false);
  });

  test("ordered marker without separator does NOT start a list", () => {
    // `1 ` (no `.` or `)`) is plain text, not a list. Guards the
    // regex from over-matching when the user types a number
    // followed by a space.
    expect(hasNode("1 something", "OrderedList")).toBe(false);
  });
});
