// Build-time guard against native browser dialogs.
//
// alert / confirm / prompt fail silently in chan's WKWebView and block the
// SPA elsewhere, so every prompt goes through the in-SPA modal instead.
// This scans every shipped source via Vite's import.meta.glob (zero
// node-types footprint) and fails if a forbidden call appears, whether it
// is written bare or on `window`.

import { describe, expect, test } from "vitest";

// import.meta.glob must be referenced by its full property path on a literal
// import.meta so Vite can rewrite it statically; the type isn't part of the
// standard ImportMeta declarations, so suppress the missing-prop check here.
const sources = (
  // @ts-expect-error import.meta.glob is a Vite-only static helper.
  import.meta.glob(["./**/*.ts", "./**/*.svelte"], {
    query: "?raw",
    import: "default",
    eager: true,
  })
) as Record<string, string>;

/// Bare or `window.`-qualified. A leading dot or word character means it is
/// somebody else's method (`modal.confirm(`, `this.alert(`), not the global.
const FORBIDDEN = /(?<![.\w])(?:window\s*\.\s*)?(?:alert|confirm|prompt)\s*\(/g;

function isShipped(rel: string): boolean {
  return !/\.test\.[mc]?[tj]sx?$/.test(rel);
}

describe("no native browser dialogs in shipped sources", () => {
  test("alert / confirm / prompt are not invoked", () => {
    const offences: string[] = [];
    for (const [rel, text] of Object.entries(sources)) {
      if (!isShipped(rel)) continue;
      FORBIDDEN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = FORBIDDEN.exec(text)) !== null) {
        const line = text.slice(0, match.index).split("\n").length;
        offences.push(`${rel}:${line}`);
      }
    }
    expect(offences, `Native dialogs are forbidden; use the in-SPA modal.`).toEqual([]);
  });
});
