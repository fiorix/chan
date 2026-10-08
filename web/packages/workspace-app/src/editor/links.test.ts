import { describe, expect, it, test } from "vitest";

import { draftClientPath, draftDirOf, isDraftClientPath } from "../api/fileIdentity";
import { isInternalHref, normalizeHref, relativizePath } from "./links";

test.each([
  ["https://x", false],
  ["mailto:a@b", false],
  ["#section", false],
  ["", false],
  ["x.md", true],
  ["./x.md", true],
  ["/x.md", true],
  ["../x.md", true],
])("classifies %j as an internal href: %j", (href, expected) => {
  expect(isInternalHref(href)).toBe(expected);
});

describe("references across a draft's boundary", () => {
  const doc = draftClientPath({ path: "untitled/draft.md", draft_id: "id-1" });
  const image = draftClientPath({ path: "untitled/image.png", draft_id: "id-1" });
  const other = draftClientPath({ path: "untitled-2/image.png", draft_id: "id-2" });
  const dir = draftDirOf(doc)!;

  it("resolves inside the draft's directory", () => {
    expect(normalizeHref("./image.png", dir), "a sibling").toBe(image);
    expect(normalizeHref("sub/../image.png", dir), "down and back up").toBe(image);
    expect(normalizeHref("../image.png", `${dir}/sub`), "up from a subdirectory").toBe(image);
  });

  it("resolves nothing that climbs out of the draft's directory", () => {
    expect(normalizeHref("../x.md", dir), "one step out").toBeNull();
    expect(normalizeHref("../../x.md", dir), "two steps out").toBeNull();
    expect(normalizeHref("sub/../../x.md", dir), "out through a subdirectory").toBeNull();
    expect(normalizeHref("../../x.md", `${dir}/sub`), "out from a subdirectory").toBeNull();
  });

  it("reaches the workspace from a draft by the root-anchored form", () => {
    expect(normalizeHref("/notes/a.md", dir), "from the draft").toBe("notes/a.md");
    expect(normalizeHref("/notes/a.md", "other/place"), "from any workspace folder").toBe(
      "notes/a.md",
    );
  });

  it("yields no marked path from a workspace document", () => {
    for (const href of ["../x.md", "./x.md", "/x.md", "a/../../x.md"]) {
      const out = normalizeHref(href, "notes");
      expect(out !== null && isDraftClientPath(out), JSON.stringify(href)).toBe(false);
    }
    expect(normalizeHref(image, "notes"), "a reference holding the mark").toBeNull();
  });

  it("writes a workspace target from a draft in the root-anchored form", () => {
    expect(relativizePath("notes/a.md", doc), "a note").toBe("/notes/a.md");
    expect(relativizePath("a.md", doc), "a file at the root").toBe("/a.md");
  });

  it("writes a file of the same draft relatively", () => {
    expect(relativizePath(image, doc), "a sibling image").toBe("./image.png");
  });

  it("has no written form for a draft's file from any other document", () => {
    expect(relativizePath(image, "notes/b.md"), "from a workspace document").toBe("");
    expect(relativizePath(other, doc), "from another draft").toBe("");
  });
});
