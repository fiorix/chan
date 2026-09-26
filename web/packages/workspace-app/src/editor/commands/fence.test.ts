import { parser } from "@lezer/markdown";
import { describe, expect, test } from "vitest";

import { fenceLineTracker } from "./fence";

function classify(lines: string[]): string[] {
  return lines.map(fenceLineTracker());
}

describe("fenceLineTracker", () => {
  test("a backtick fence opens and closes around its code", () => {
    expect(classify(["intro", "```js", "let a;", "```", "after"])).toEqual([
      "text",
      "fence",
      "code",
      "fence",
      "text",
    ]);
  });

  test("a tilde fence opens and closes around its code", () => {
    expect(classify(["~~~", "x", "~~~", "y"])).toEqual(["fence", "code", "fence", "text"]);
  });

  test("a run of the other character inside a block is code", () => {
    expect(classify(["~~~", "```", "# not a heading", "~~~"])).toEqual([
      "fence",
      "code",
      "code",
      "fence",
    ]);
  });

  test("a shorter run does not close a longer fence", () => {
    expect(classify(["````", "```", "inner", "```", "````", "out"])).toEqual([
      "fence",
      "code",
      "code",
      "code",
      "fence",
      "text",
    ]);
  });

  test("a longer run of the same character closes", () => {
    expect(classify(["```", "x", "`````", "y"])).toEqual(["fence", "code", "fence", "text"]);
  });

  test("two characters are not a fence", () => {
    expect(classify(["``", "~~", "x"])).toEqual(["text", "text", "text"]);
  });

  test("up to three spaces of indent open and close a fence, four do not", () => {
    expect(classify(["   ```", "x", "  ```", "    ```", "y"])).toEqual([
      "fence",
      "code",
      "fence",
      "text",
      "text",
    ]);
  });

  test("a tab or other non-space whitespace before a run is not fence indent", () => {
    expect(classify(["\t```", "x", "\u00a0```", "y"])).toEqual(["text", "text", "text", "text"]);
  });

  test("an unclosed fence holds every later line as code", () => {
    expect(classify(["```", "a", "", "# b"])).toEqual(["fence", "code", "code", "code"]);
  });

  test("a fence on a list item's marker line closes at the item's content column", () => {
    expect(classify(["- ```sh", "  make", "  ```", "after"])).toEqual(["fence", "code", "fence", "text"]);
    expect(classify(["1. ```sh", "   make", "   ```", "after"])).toEqual(["fence", "code", "fence", "text"]);
    expect(classify(["- a", "  - ```sh", "    make", "    ```", "after"])).toEqual([
      "text",
      "fence",
      "code",
      "fence",
      "text",
    ]);
  });

  test("a line indented less than the item's content ends its fence with the item", () => {
    expect(classify(["- ```sh", "  make", "", "  more", "# next"])).toEqual([
      "fence",
      "code",
      "code",
      "code",
      "text",
    ]);
    // The column-zero run ends the item, then opens a fence of its own.
    expect(classify(["- ```sh", "  make", "```", "# inside", "```", "# after"])).toEqual([
      "fence",
      "code",
      "fence",
      "code",
      "fence",
      "text",
    ]);
  });

  test("each tracker starts a fresh document", () => {
    const first = fenceLineTracker();
    first("```");
    expect(fenceLineTracker()("# heading")).toBe("text");
    expect(first("# heading")).toBe("code");
  });
});

// The editor's parser answers the same question from the syntax tree: a
// line is a fence line if a FencedCode node opens or closes on it, and code
// if it lies between.
function parsedFenceLines(doc: string): string[] {
  const starts = doc.split("\n").map((_, i, lines) => lines.slice(0, i).join("\n").length + (i ? 1 : 0));
  const lineAt = (pos: number): number => starts.filter((start) => start <= pos).length - 1;
  const kinds = starts.map(() => "text");
  parser.parse(doc).iterate({
    enter(node) {
      if (node.name !== "FencedCode") return;
      const first = lineAt(node.from);
      const last = lineAt(node.to);
      const marks = node.node.getChildren("CodeMark").length;
      for (let i = first; i <= last; i++) kinds[i] = "code";
      kinds[first] = "fence";
      if (marks === 2) kinds[last] = "fence";
    },
  });
  return kinds;
}

describe("fenceLineTracker against the editor's parser", () => {
  test.each([
    ["top-level fences", "# A\n```sh\n# c\n```\n~~~\n```\n~~~\n# B"],
    ["a tab-indented run", "# A\n\n\t```\n\n# B"],
    ["a list item's fence", "# Setup\n- ```sh\n  make\n  ```\n# Usage\n```sh\n# a comment\n```\n# Last"],
    ["an ordered item's fence", "# S\n1. ```sh\n   make\n   ```\n# U"],
    ["a nested item's fence", "# S\n- a\n  - ```sh\n    make\n    ```\n# U"],
    ["an item's fence left open", "# S\n- ```sh\n  make\n\n  more\n# U"],
    ["an item's fence ended by a column-zero run", "# S\n- ```sh\n  make\n```\n# X\n```\n# Y"],
  ])("agrees on %s", (_name, doc) => {
    expect(classify(doc.split("\n"))).toEqual(parsedFenceLines(doc));
  });
});
