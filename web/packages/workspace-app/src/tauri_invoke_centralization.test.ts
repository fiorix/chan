// Build-time guard keeping the Tauri IPC vocabulary auditable.
//
// chan-desktop's origin-aware ACL parity test (desktop/src-tauri/src/
// serve.rs) recomputes every window class's effective grants from the
// capability files and pins the SPA's invoke vocabulary as a subset.
// It reads that vocabulary from exactly two modules via include_str!:
// api/desktop.ts (the tauriInvoke call sites) and
// editor/external_links.ts (its thin plugin-opener invoke). An invoke
// added anywhere else would escape the walk and surface only as a
// runtime ACL denial in the shipped app, so this test scans every
// shipped source (import.meta.glob, mirroring no_native_dialogs) and
// pins the call sites to the audited modules.

import { describe, expect, test } from "vitest";

// Vite resolves `import.meta.glob` statically: it MUST be referenced
// by its full property path on a literal `import.meta` so the Vite
// transform can rewrite it to a static set of imports. The prop's
// type comes from vite/client (referenced in src/vite-env.d.ts).
const sources = (
  import.meta.glob(
    ["./**/*.ts", "./**/*.tsx", "./**/*.js", "./**/*.jsx", "./**/*.svelte"],
    { query: "?raw", import: "default", eager: true },
  )
) as Record<string, string>;

// The single tauriInvoke dispatch module: every app-command IPC the
// SPA fires is a named helper here.
const INVOKE_MODULE = "./api/desktop.ts";

// Modules allowed to touch the window.__TAURI__* globals at all.
// desktop.ts and external_links.ts are the two the desktop parity
// test audits; shortcuts.ts only DETECTS the native shell (a
// dedicated assertion below keeps it invoke-free).
const TAURI_GLOBAL_ALLOWED = new Set<string>([
  INVOKE_MODULE,
  "./editor/external_links.ts",
  "./state/shortcuts.ts",
]);

function isShipped(rel: string): boolean {
  // Test files spy on the invoke bridge to assert dispatch behavior.
  if (/\.test\.[mc]?[tj]sx?$/.test(rel)) return false;
  if (rel.includes("/__tests__/")) return false;
  return true;
}

describe("tauri invoke centralization", () => {
  test("tauriInvoke call sites live only in api/desktop.ts", () => {
    const offences: string[] = [];
    const CALL = /\btauriInvoke\s*[<(]/g;
    for (const [rel, text] of Object.entries(sources)) {
      if (!isShipped(rel) || rel === INVOKE_MODULE) continue;
      CALL.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = CALL.exec(text)) !== null) {
        const line = text.slice(0, match.index).split("\n").length;
        offences.push(`${rel}:${line}`);
      }
    }
    expect(
      offences,
      `tauriInvoke must be called only inside api/desktop.ts (wrap a new IPC in ` +
        `a named helper there): the desktop ACL parity test reads its invoke ` +
        `vocabulary from that file, and a call site elsewhere escapes the walk. ` +
        `Offending sites:\n  ${offences.join("\n  ")}`,
    ).toEqual([]);
  });

  test("window.__TAURI__* globals stay inside the audited modules", () => {
    const offences: string[] = [];
    for (const [rel, text] of Object.entries(sources)) {
      if (!isShipped(rel) || TAURI_GLOBAL_ALLOWED.has(rel)) continue;
      if (/__TAURI(?:_INTERNALS)?__/.test(text)) offences.push(rel);
    }
    expect(
      offences,
      `Only the audited modules may reach the Tauri globals; anything else ` +
        `could fire IPC the desktop ACL parity walk never sees. ` +
        `Offending files:\n  ${offences.join("\n  ")}`,
    ).toEqual([]);
  });

  test("shortcuts.ts stays detection-only (no invoke through the globals)", () => {
    const text = sources["./state/shortcuts.ts"];
    expect(
      text,
      "state/shortcuts.ts moved or was renamed; update TAURI_GLOBAL_ALLOWED",
    ).toBeDefined();
    expect(
      text,
      "shortcuts.ts is allowlisted for shell DETECTION only; route any IPC " +
        "through api/desktop.ts",
    ).not.toMatch(/\binvoke\b/i);
  });
});
