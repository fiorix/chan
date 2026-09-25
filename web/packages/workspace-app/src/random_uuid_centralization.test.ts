// Build-time guard keeping one id mint in the app.
//
// `crypto.randomUUID` is restricted to secure contexts, and a devserver
// reached over plain http at a LAN address is not one. A call site that names
// it directly therefore throws there, in whatever handler it sits in, and the
// user is told nothing. state/ids.ts is the one module allowed to name it,
// because it is the one module that has an answer when it is missing;
// everything else calls `newUuid()`.

import { describe, expect, test } from "vitest";

// Vite resolves `import.meta.glob` statically: it MUST be referenced by its
// full property path on a literal `import.meta` so the Vite transform can
// rewrite it to a static set of imports. The prop's type comes from
// vite/client (referenced in src/vite-env.d.ts).
const sources = import.meta.glob(
  ["./**/*.ts", "./**/*.tsx", "./**/*.js", "./**/*.jsx", "./**/*.svelte"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const ID_MODULE = "./state/ids.ts";

// Modules that still mint an id with a fallback of their own. Each is folded
// onto `newUuid` by the lane that owns it, and this set is exact: a fold that
// leaves its module listed here fails too, so the list cannot go stale.
const OWN_MINT = [
  "./api/client.ts",
  "./api/desktop.ts",
  "./state/docSync.svelte.ts",
  "./state/editorBuffer.ts",
  "./state/extensions.svelte.ts",
];

function isShipped(rel: string): boolean {
  // Tests name the global to stub it away, which is how the insecure context
  // is reproduced at all.
  if (/\.test\.[mc]?[tj]sx?$/.test(rel)) return false;
  if (rel.includes("/__tests__/")) return false;
  return true;
}

function modulesNamingRandomUuid(): string[] {
  const named: string[] = [];
  for (const [rel, text] of Object.entries(sources)) {
    if (!isShipped(rel) || rel === ID_MODULE) continue;
    if (/\brandomUUID\b/.test(text)) named.push(rel);
  }
  return named.sort();
}

describe("randomUUID centralization", () => {
  // Source-text contract: the one module the scan below exempts is in the scanned set (what newUuid mints is in state/ids.test.ts).
  test("state/ids.ts, the one exempt module, is in the scanned set", () => {
    expect(
      sources[ID_MODULE],
      `${ID_MODULE} moved or was renamed; this guard has nothing to point at`,
    ).toBeDefined();
  });

  // Source-text contract: no shipped module but state/ids.ts names crypto.randomUUID, which throws outside a secure context.
  test("no module outside it reaches for crypto.randomUUID", () => {
    expect(
      modulesNamingRandomUuid(),
      `crypto.randomUUID throws on a devserver served over plain http, so a ` +
        `new call site is a feature that breaks on a LAN address. Import ` +
        `{ newUuid } from "${ID_MODULE}" instead. The modules listed in ` +
        `OWN_MINT still carry a fallback of their own and are being folded ` +
        `onto it; when you fold one, drop it from that list in the same ` +
        `change.`,
    ).toEqual(OWN_MINT);
  });
});
