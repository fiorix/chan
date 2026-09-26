import { describe, expect, test } from "vitest";

import { parseBlocks } from "./wikiBlocks";

function blockTexts(text: string): string[] {
  return parseBlocks(text).map((b) => b.text);
}

describe("parseBlocks", () => {
  test("paragraphs separated by blank lines are blocks, a fence's lines are not", () => {
    expect(blockTexts("first\n\n```\ncode\n```\n\nsecond\n")).toEqual(["first", "second"]);
  });

  test("a backtick run inside a tilde fence does not close it", () => {
    expect(blockTexts("~~~\n```\nnot a block\n~~~\n\npara\n")).toEqual(["para"]);
  });

  test("a shorter run inside a longer fence does not close it", () => {
    expect(blockTexts("````\n```\ninner\n```\n````\n\npara\n")).toEqual(["para"]);
  });
});
