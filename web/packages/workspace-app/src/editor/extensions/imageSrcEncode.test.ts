import { describe, expect, test } from "vitest";

import { resolveImageSrc } from "./image";
import { draftClientPath } from "../../api/fileIdentity";
import { decodePercent, encodeRelPath } from "../links";

// The image bubble / drop handler now percent-encodes the path it
// writes (so `My Photo.png` lands on disk as `My%20Photo.png` and
// pulldown-cmark produces a graph edge instead of truncating at the
// space). resolveImageSrc must decode that on read before re-encoding
// for `/api/fs`, or a spaced name double-encodes to `%2520` and
// 404s. These tests lock the encode (write) / decode (read) contract,
// mirroring the `[[` wiki-link round-trip in wikilinkParse.test.ts.
describe("an image of a workspace's draft", () => {
  const from = draftClientPath({ path: "untitled/draft.md", draft_id: "life-1" });

  test("is fetched by the draft's own path with its root and lifetime id, never by the client's form", () => {
    const url = resolveImageSrc("./My%20Shot.png#w=250", from);

    expect.soft(url).toContain("/api/fs/untitled/My%20Shot.png");
    expect.soft(url).toContain("root=draft");
    expect.soft(url).toContain("draft_id=life-1");
    expect.soft(url.includes("%00") || url.includes(String.fromCharCode(0)), "the mark").toBe(false);
  });

  test("a draft's link into the workspace is fetched as the workspace's file", () => {
    const url = resolveImageSrc("/notes/pic.png", from);

    expect(url).toContain("/api/fs/notes/pic.png");
    expect(url).not.toContain("root=draft");
  });
});

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
