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

/// A comment is prose, and prose writes "closes the confirm (and the create
/// behind it)" freely. Scanning comments would point the guard at whatever
/// sentence somebody writes next instead of at a call. A `//` behind a colon
/// is a URL scheme, and blanking the rest of that line would hide a real call
/// sharing it.
const COMMENT = /\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|(?<!:)\/\/[^\n]*/g;

/// Replace every comment with spaces, keeping the newlines, so a reported
/// line number still counts to the line the call is on.
function withoutComments(text: string): string {
  return text.replace(COMMENT, (comment) => comment.replace(/[^\n]/g, " "));
}

function offences(rel: string, text: string): string[] {
  const found: string[] = [];
  const code = withoutComments(text);
  FORBIDDEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FORBIDDEN.exec(code)) !== null) {
    const line = code.slice(0, match.index).split("\n").length;
    found.push(`${rel}:${line}`);
  }
  return found;
}

function isShipped(rel: string): boolean {
  return !/\.test\.[mc]?[tj]sx?$/.test(rel);
}

describe("no native browser dialogs in shipped sources", () => {
  test("alert / confirm / prompt are not invoked", () => {
    const found: string[] = [];
    for (const [rel, text] of Object.entries(sources)) {
      if (!isShipped(rel)) continue;
      found.push(...offences(rel, text));
    }
    expect(found, `Native dialogs are forbidden; use the in-SPA modal.`).toEqual([]);
  });
});

describe("the scan", () => {
  test("names a call, however it is spelled", () => {
    for (const source of [
      `confirm("really?");`,
      `window.confirm("really?");`,
      `window . prompt("name");`,
      `if (alert ("gone")) return;`,
    ]) {
      expect(offences("./x.ts", source), source).toEqual(["./x.ts:1"]);
    }
  });

  test("ignores a call somebody else owns", () => {
    for (const source of [
      `modal.confirm("really?");`,
      `this.alert("gone");`,
      `let confirmRevoke = $state(null);`,
    ]) {
      expect(offences("./x.ts", source), source).toEqual([]);
    }
  });

  test("ignores prose in all three comment forms", () => {
    for (const source of [
      `// Escape closes the confirm (the create modal is behind it).`,
      `/* the prompt (Hide / Close / Cancel) */`,
      `<!-- the alert (a banner, not a dialog) -->`,
    ]) {
      expect(offences("./x.ts", source), source).toEqual([]);
    }
  });

  test("still reads the call on a line that carries a URL", () => {
    const source = `const docs = "https://chan.app/tokens"; confirm("really?");`;
    expect(offences("./x.ts", source)).toEqual(["./x.ts:1"]);
  });

  test("counts lines past a blanked comment", () => {
    const source = `// the confirm (a sentence about one)\nconfirm("really?");\n`;
    expect(offences("./x.ts", source)).toEqual(["./x.ts:2"]);
  });
});
