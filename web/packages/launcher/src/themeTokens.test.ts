// Both themes must name the same tokens. A token defined only on `:root` is
// drawn in its dark value on the light surface, where a colour picked against
// a dark card can land at a contrast nobody can read, and neither the build
// nor a component test can see it: `var()` resolves to whatever is defined.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// `?raw` returns an empty string for a `.css` import under the jsdom vitest
// setup (the CSS plugin chain consumes it), so read the stylesheet from disk,
// relative to the vitest cwd (= packages/launcher).
const styles = readFileSync("src/styles.css", "utf8");

// Declarations of a token block, comments stripped so prose naming a token
// cannot be read as a declaration.
function tokensOf(selector: string): string[] {
  const opener = `${selector} {`;
  const start = styles.indexOf(opener);
  expect(start, `${selector} block`).toBeGreaterThanOrEqual(0);
  const end = styles.indexOf("\n}", start);
  const block = styles.slice(start + opener.length, end).replace(/\/\*[\s\S]*?\*\//g, "");
  return [...block.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]!).sort();
}

describe("theme tokens", () => {
  it("gives every root token a light-theme value", () => {
    const dark = tokensOf(":root");
    expect(dark.length).toBeGreaterThan(0);
    expect(tokensOf(':root[data-theme="light"]')).toEqual(dark);
  });
});
