import { describe, expect, test } from "vitest";

import { resolveImageSrc } from "./image";
import { decodePercent, encodeRelPath } from "../links";

// The image bubble / drop handler now percent-encodes the path it
// writes (so `My Photo.png` lands on disk as `My%20Photo.png` and
// pulldown-cmark produces a graph edge instead of truncating at the
// space). resolveImageSrc must decode that on read before re-encoding
// for `/api/fs`, or a spaced name double-encodes to `%2520` and
// 404s. These tests lock the encode (write) / decode (read) contract,
// mirroring the `[[` wiki-link round-trip in wikilinkParse.test.ts.
describe("image src encode/decode round-trip", () => {
  test("a percent-encoded spaced src resolves to a singly-encoded /api/fs URL", () => {
    const url = resolveImageSrc(
      "./Brazilian%20Rice.png#w=250",
      "Recipes/Pasta.md",
    );
    expect(url).toContain("/api/fs/Recipes/Brazilian%20Rice.png");
    // The decode-then-encode must not double-encode the space.
    expect(url).not.toContain("%2520");
  });

  test("a legacy literal-space src still resolves (no display regression)", () => {
    // Images written before the encode fix carry a literal space on
    // disk. resolveImageSrc already encoded for the URL, and decodePercent
    // is a no-op on a string with no `%`, so they keep resolving.
    const url = resolveImageSrc("./Brazilian Rice.png#w=250", "Recipes/Pasta.md");
    expect(url).toContain("/api/fs/Recipes/Brazilian%20Rice.png");
  });

  test("encodeRelPath / decodePercent invert each other per segment", () => {
    const path = "Recipes/Brazilian Rice.png";
    const enc = encodeRelPath(path);
    expect(enc).toBe("Recipes/Brazilian%20Rice.png");
    expect(decodePercent(enc)).toBe(path);
    // Segment separators survive encoding.
    expect(enc.split("/")).toHaveLength(2);
  });

  test("a stray percent in a name is left intact on decode", () => {
    // decodeURIComponent throws on a lone `%`; decodePercent must fall
    // back to the raw string so the path is not corrupted.
    expect(decodePercent("100%.png")).toBe("100%.png");
  });
});
