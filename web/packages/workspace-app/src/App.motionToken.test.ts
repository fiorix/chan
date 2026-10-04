// The pop easing has one definition: the --ease-pop token in App.svelte's
// root token block. Every pop animation and transition reads the token, and
// no stylesheet spells the curve beside it.

import { describe, expect, test } from "vitest";

// Build-time contract: the pop curve is spelled once, as App.svelte's --ease-pop token on the root; jsdom applies no stylesheet, so no mounted test resolves a var() or sees a pasted curve.
const sheets = import.meta.glob(["./**/*.svelte", "./**/*.css"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const APP = "./App.svelte";
const DECLARATION = "--ease-pop: cubic-bezier(0.34, 1.56, 0.64, 1);";
const CURVE = /cubic-bezier\(\s*0?\.34\s*,\s*1\.56\s*,\s*0?\.64\s*,\s*1\s*\)/g;

const shipped = Object.entries(sheets).filter(([path]) => !path.includes("/__tests__/"));

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

describe("the pop easing token", () => {
  test("the scan reads the app's stylesheets", () => {
    expect(shipped.length).toBeGreaterThan(50);
    expect(sheets[APP]).toBeDefined();
  });

  test("is declared once, in the root token block", () => {
    const declared = shipped.filter(([, text]) => count(text, /--ease-pop\s*:/g) > 0);
    expect(declared.map(([path]) => path)).toEqual([APP]);
    expect(count(sheets[APP], /--ease-pop\s*:/g)).toBe(1);

    const root = sheets[APP].indexOf(":global(:root),");
    const light = sheets[APP].indexOf(':global([data-theme="light"]) {');
    expect(root).toBeGreaterThan(-1);
    expect(light).toBeGreaterThan(root);
    expect(sheets[APP].slice(root, light)).toContain(DECLARATION);
  });

  test("no stylesheet spells the curve beside the declaration", () => {
    const spelled = shipped
      .map(([path, text]) => [path, count(text, CURVE)] as const)
      .filter(([, hits]) => hits > 0);
    expect(spelled).toEqual([[APP, 1]]);
  });

  test("every easing token a stylesheet reads is the declared one", () => {
    const read = new Set(shipped.flatMap(([, text]) => text.match(/var\(\s*--ease-[\w-]*/g) ?? []));
    expect([...read]).toEqual(["var(--ease-pop"]);
  });
});
