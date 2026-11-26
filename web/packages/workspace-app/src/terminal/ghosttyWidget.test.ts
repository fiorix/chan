import { Terminal } from "@chan/ghostty-web-ng";
import type { GhosttyVt } from "@chan/ghostty-web-ng/vt";
import { describe, expect, test } from "vitest";

// The widget compiles from source with its own tsconfig.json, whose ES2020
// target leaves useDefineForClassFields off: class fields are assigned in the
// constructor, as ghostty-web's npm build assigns them. Under native class
// fields, every field declared without an initializer would exist from
// construction as an own undefined property. A `#private` field is never an
// own property, so the probe is a public field the widget assigns at open.
describe("the ghostty widget's class fields", () => {
  test("a field declared without an initializer is not an own property until it is assigned", () => {
    // The constructor only stores the core; nothing here calls into it.
    const term = new Terminal({ ghostty: {} as GhosttyVt, cols: 20, rows: 4 });
    expect(Object.hasOwn(term, "element"), "a field assigned at open").toBe(false);
    expect(Object.hasOwn(term, "cols"), "a field the constructor assigns").toBe(true);
    expect(term.cols).toBe(20);
  });
});
