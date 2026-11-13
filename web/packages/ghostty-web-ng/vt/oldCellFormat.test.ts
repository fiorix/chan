// Nothing chan builds from this package names ghostty-web's own binding of
// its own wasm or that binding's cell format, both gone once the binding's
// differential tests were held to a recorded oracle: `lib/ghostty.ts` and
// its `Ghostty`, `Ghostty.load`, `getGhostty`, the `asGhostty` casts, the
// wasm at the package root and its export, the `GhosttyCell` interface and
// its fields, `CellFlags`, the renderer's `IRenderable` and scrollback
// provider, and the binding's readers of that format.
//
// Scanned: the widget's sources in `lib/` that chan builds (upstream's
// `bun:test` files and `test-helpers.ts`, which nothing in chan runs, still
// name them), the binding and its tests in `vt/`, and the package manifest.
// The app scans its own sources (src/terminal/ghosttyOldFormat.test.ts).

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const FORBIDDEN: [string, RegExp][] = [
  ["ghostty-web's binding module", /lib\/ghostty["'`]|from\s+["']\.{1,2}\/ghostty["']/],
  ["its loader", /\bGhostty\.load\b|\bgetGhostty\b|\basGhostty\b/],
  // Its bare name as a path, how the deleted tests and the recorder read it
  // from the package directory; the vendored core's path has a directory
  // before the name, so it does not match.
  ["the wasm at the package root", /["'`]ghostty-vt\.wasm["'`]|["'](?:\.{1,2}\/)+ghostty-vt\.wasm["']|@chan\/ghostty-web-ng\/ghostty-vt\.wasm/],
  ["ghostty-web's GhosttyCell", /import[^;]*\bGhosttyCell\b[^;]*from\s+["'](?:@chan\/ghostty-web-ng|[^"']*\/types)["']|\binterface\s+GhosttyCell\b/],
  // As code, read or written: upstream's comments speak of a hyperlink id.
  ["its fields", /\.(?:(?:fg|bg)_[rgb]|hyperlink_id|grapheme_len)\b|\b(?:(?:fg|bg)_[rgb]|hyperlink_id|grapheme_len)\s*:/],
  ["its flags", /\bCellFlags\b/],
  ["the renderer's old inputs", /\bIRenderable\b|\bIScrollbackProvider\b/],
  ["the binding's readers of that format", /\.(?:getScrollbackLine|getGraphemeString|getScrollbackGraphemeString|getColors)\(|\blegacy(?:Cells|Flags)\b/],
];

/// The files the scan reads, relative to the package directory vitest runs in.
function sources(): string[] {
  const lib = readdirSync("lib", { recursive: true })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "test-helpers.ts")
    .map((f) => `lib/${f}`);
  const vt = readdirSync("vt", { recursive: true })
    .filter((f) => f.endsWith(".ts") && f !== "oldCellFormat.test.ts")
    .map((f) => `vt/${f}`);
  return [...lib, ...vt, "package.json"];
}

describe("ghostty-web's binding and cell format stay gone", () => {
  test("the scan reads the widget, the binding and the manifest", () => {
    const files = sources();
    expect(files).toEqual(expect.arrayContaining(["lib/index.ts", "lib/renderer.ts", "vt/ghosttyVt.ts", "vt/ghosttyVt.test.ts", "package.json"]));
    expect(files.filter((f) => f.endsWith(".test.ts") && f.startsWith("lib/"))).toEqual([]);
  });

  test.each(FORBIDDEN)("no source names %s", (_what, pattern) => {
    const hits = sources().flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) => (pattern.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(hits).toEqual([]);
  });
});
