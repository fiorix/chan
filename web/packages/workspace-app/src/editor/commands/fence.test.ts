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

  test("an unclosed fence holds every later line as code", () => {
    expect(classify(["```", "a", "", "# b"])).toEqual(["fence", "code", "code", "code"]);
  });

  test("each tracker starts a fresh document", () => {
    const first = fenceLineTracker();
    first("```");
    expect(fenceLineTracker()("# heading")).toBe("text");
    expect(first("# heading")).toBe("code");
  });
});
