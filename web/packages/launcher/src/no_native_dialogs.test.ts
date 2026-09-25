// Build-time guard against native browser dialogs.
//
// window.alert / window.confirm / window.prompt fail silently in chan's
// WKWebView and block the SPA elsewhere, so the launcher routes every prompt
// through the in-SPA Modal instead. This scans every shipped source via
// Vite's import.meta.glob (zero node-types footprint) and fails if a
// forbidden call appears.

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

const FORBIDDEN = /\bwindow\.(?:alert|confirm|prompt)\s*\(/g;

function isShipped(rel: string): boolean {
  return !/\.test\.[mc]?[tj]sx?$/.test(rel);
}

describe("no native browser dialogs in shipped sources", () => {
  // Source-text contract: no shipped module calls a native dialog, which fails silently in the desktop WebView.
  test("window.alert / window.confirm / window.prompt are not invoked", () => {
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
    expect(offences, `Native dialogs are forbidden; use the in-SPA Modal.`).toEqual([]);
  });
});
