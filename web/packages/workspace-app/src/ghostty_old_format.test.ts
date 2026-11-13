// No source of the app, shipped or test, names ghostty-web's own binding of
// its own wasm or that binding's cell format. Both left the widget package
// once the binding's differential tests were held to a recorded oracle; the
// app reads cells through the binding's frame reader (`readRow`,
// `readHistoryRow`, `VtCells`) and runs the vendored libghostty-vt alone.
// The widget package scans its own sources the same way
// (ghostty-web-ng/vt/oldCellFormat.test.ts).

import { describe, expect, test } from "vitest";

// Resolved statically by Vite, as in no_native_dialogs.test.ts.
const sources = (
  import.meta.glob(["./**/*.ts", "./**/*.svelte"], { query: "?raw", import: "default", eager: true })
) as Record<string, string>;

const SELF = "./ghostty_old_format.test.ts";

const FORBIDDEN: [string, RegExp][] = [
  ["ghostty-web's binding module", /ghostty-web-ng\/lib\/ghostty["'`]/],
  ["its loader", /\bGhostty\.load\b|\bgetGhostty\b|\basGhostty\b/],
  ["the wasm at the package root", /@chan\/ghostty-web-ng\/ghostty-vt\.wasm|ghostty-web-ng\/ghostty-vt\.wasm/],
  ["ghostty-web's GhosttyCell", /import[^;]*\bGhosttyCell\b[^;]*from\s+["']@chan\/ghostty-web-ng["']/],
  ["its fields, as code", /\.(?:(?:fg|bg)_[rgb]|hyperlink_id|grapheme_len)\b|\b(?:(?:fg|bg)_[rgb]|hyperlink_id|grapheme_len)\s*:/],
  ["its flags", /\bCellFlags\b/],
  ["the renderer's old inputs", /\bIRenderable\b|\bIScrollbackProvider\b/],
  ["the binding's readers of that format", /\.(?:getScrollbackLine|getGraphemeString|getScrollbackGraphemeString|getColors)\(/],
];

describe("ghostty-web's binding and cell format stay out of the app", () => {
  test("the scan reads the app's terminal sources", () => {
    expect(Object.keys(sources)).toEqual(
      expect.arrayContaining(["./terminal/backend.ts", "./terminal/ghosttyCompat.ts", "./components/TerminalTab.svelte"]),
    );
  });

  test.each(FORBIDDEN)("no source names %s", (_what, pattern) => {
    const hits: string[] = [];
    for (const [rel, text] of Object.entries(sources)) {
      if (rel === SELF) continue;
      text.split("\n").forEach((line, i) => {
        if (pattern.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
