// Both themes must name the same tokens, and a token's colour must have one
// spelling. A token defined only on `:root` is drawn in its dark value on the
// light surface, where a colour picked against a dark card can land at a
// contrast nobody can read; a literal copy of that value is reached by no theme
// block at all. Neither the build nor a component test can see either one,
// because `var()` resolves to whatever is defined.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// `?raw` returns an empty string for a `.css` import under the jsdom vitest
// setup (the CSS plugin chain consumes it), so read the stylesheet from disk,
// relative to the vitest cwd (= packages/launcher).
const styles = readFileSync("src/styles.css", "utf8");

// Every shipped source, so a colour the stylesheet names as a token cannot be
// respelled as a literal in a component style, where a theme switch that
// redefines the token does not reach it.
const sources = (
  // @ts-expect-error import.meta.glob is a Vite-only static helper.
  import.meta.glob(["./**/*.svelte", "./**/*.ts"], {
    query: "?raw",
    import: "default",
    eager: true,
  })
) as Record<string, string>;

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

  it("spells a themed colour only where its token is defined", () => {
    const values = [...styles.matchAll(/^\s*--[\w-]+:\s*(#[0-9a-fA-F]{3,8});/gm)].map((m) =>
      m[1]!.toLowerCase(),
    );
    expect(values.length).toBeGreaterThan(0);
    const offences: string[] = [];
    for (const [rel, text] of Object.entries(sources)) {
      if (/\.test\.ts$/.test(rel)) continue;
      const lower = text.toLowerCase();
      for (const value of values) {
        if (lower.includes(value)) offences.push(`${rel}: ${value}`);
      }
    }
    expect(offences, "draw the token, so both themes reach the rule").toEqual([]);
  });
});
