// Build-time guard against re-introducing native browser dialogs.
//
// `window.alert`, `window.confirm`, and `window.prompt` fail silently
// in Chan.app's WKWebView and block the SPA in other browsers, so
// the codebase routes user prompts through the in-house ConfirmModal
// / PromptModal / uiPrompt / uiConfirm pair instead. This test scans
// every shipped source file under web/src (via Vite's import.meta.glob,
// so the gate has zero node-types footprint) and fails if a forbidden
// call sneaks back in.

import { describe, expect, test } from "vitest";

// Vite resolves `import.meta.glob` statically: it MUST be referenced
// by its full property path on a literal `import.meta` so the Vite
// transform can rewrite it to a static set of imports. Indirection
// through a local variable breaks that. The prop's type comes from
// vite/client (referenced in src/vite-env.d.ts).
const sources = (
  import.meta.glob(
    ["./**/*.ts", "./**/*.tsx", "./**/*.js", "./**/*.jsx", "./**/*.svelte"],
    { query: "?raw", import: "default", eager: true },
  )
) as Record<string, string>;

const EXCLUDE = new Set<string>([
  // The in-house replacement modules - references are explanatory,
  // not invocations.
  "./state/store.svelte.ts",
  "./state/confirm.svelte.ts",
  "./components/ConfirmModal.svelte",
  "./components/PromptModal.svelte",
  // The guard itself.
  "./no_native_dialogs.test.ts",
]);

const FORBIDDEN = /\bwindow\.(?:alert|confirm|prompt)\s*\(/g;

function isShipped(rel: string): boolean {
  if (EXCLUDE.has(rel)) return false;
  // Drop test files: vitest sometimes spies on window dialogs to
  // assert no caller invoked them. Both `.test.ts` and `__tests__`
  // suffix conventions covered.
  if (/\.test\.[mc]?[tj]sx?$/.test(rel)) return false;
  if (rel.includes("/__tests__/")) return false;
  return true;
}

describe("no native browser dialogs in shipped sources", () => {
  test("window.alert / window.confirm / window.prompt are not invoked", () => {
    const offences: string[] = [];
    for (const [rel, text] of Object.entries(sources)) {
      if (!isShipped(rel)) continue;
      FORBIDDEN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = FORBIDDEN.exec(text)) !== null) {
        const callee = match[0].replace(/\s*\($/, "");
        const line = text.slice(0, match.index).split("\n").length;
        offences.push(`${rel}:${line} -> ${callee}`);
      }
    }
    expect(
      offences,
      `Native browser dialogs are forbidden in shipped sources. ` +
        `Use uiPrompt / uiConfirm (PromptModal / ConfirmModal) instead. ` +
        `Offending sites:\n  ${offences.join("\n  ")}`,
    ).toEqual([]);
  });
});
