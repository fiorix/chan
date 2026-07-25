import { describe, expect, test } from "vitest";
import wysiwyg from "./Wysiwyg.svelte?raw";

// The WYSIWYG negative-z paint order is a shared stacking context
// (neither .cm-content nor .cm-line forms one), so the ordering is an
// invariant, not per-layer taste: the OPAQUE page fill must be the
// bottom layer, the code-block slab above it, and both strictly below
// CM6's .cm-selectionLayer at -1 so selections stay visible. Getting
// this wrong is invisible to every build check: moving one layer to
// fix the selection silently buries another behind the page fill.
// jsdom cannot paint, so this pins the declared values' ORDER rather
// than pixels; the shade itself is owner-verified in a browser.

function zIndexAfter(anchor: RegExp): number {
  const at = wysiwyg.match(anchor);
  if (!at || at.index === undefined) {
    throw new Error(`anchor not found in Wysiwyg.svelte: ${anchor}`);
  }
  const block = wysiwyg.slice(at.index + at[0].length);
  const z = block.match(/z-index:\s*(-?\d+)/);
  if (!z) {
    throw new Error(`no z-index after anchor: ${anchor}`);
  }
  return Number(z[1]);
}

describe("wysiwyg layer order", () => {
  test("page fill < code slab < selection layer (-1)", () => {
    const pageFill = zIndexAfter(
      /\.chan-page-capped \.md-wysiwyg-cm6 \.cm-content\)::before \{/,
    );
    const codeSlab = zIndexAfter(/\.cm-line\.cm-md-code-block::before\) \{/);

    expect(
      pageFill,
      "the opaque page fill must paint strictly below the code slab",
    ).toBeLessThan(codeSlab);
    expect(
      codeSlab,
      "the code slab must paint strictly below CM6's selection layer",
    ).toBeLessThan(-1);
    expect(
      pageFill,
      "the page fill must paint strictly below CM6's selection layer",
    ).toBeLessThan(-1);
  });
});
