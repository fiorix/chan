import { describe, expect, test } from "vitest";
import {
  DEFAULT_NEW_FILENAME_STEM,
  appendDefaultMd,
  backslashReason,
  preserveExtension,
  proposeDefaultFilename,
  splitPath,
  validatePath,
} from "./pathValidate";

const REFUSED = "\\ cannot be added to a name";

describe("backslashReason", () => {
  const exists = (path: string) => ["x\\y", "deep", "deep/p\\q", "a\\b.md"].includes(path);

  test.each([
    ["a path that holds none", "notes/a.md", {}],
    ["a rename that keeps the one its name holds", "a\\c.md", { source: "a\\b.md" }],
    ["a rename that moves the one its name holds", "ab\\.md", { source: "a\\b.md" }],
    ["a rename that drops it", "ab.md", { source: "a\\b.md" }],
    ["a move that keeps the name", "notes/a\\b.md", { source: "a\\b.md" }],
    ["a move into a listed directory that holds one", "x\\y/a.md", { source: "a.md", exists }],
    ["a move into a listed directory under another", "deep/p\\q/a.md", { source: "a.md", exists }],
    ["a rename beside the source, under a directory nothing lists", "far/p\\q/b.md", { source: "far/p\\q/a.md" }],
    ["a rename of a directory that holds one", "x\\z", { source: "x\\y" }],
    ["a directory typed with a trailing slash", "x\\z/", { source: "x\\y" }],
    ["an entry that exists, with no source", "a\\b.md", { exists }],
    ["a move onto an entry that holds one, which makes no name", "a\\b.md", { source: "notes.md", exists }],
    ["a new file in a listed directory that holds one", "x\\y/new.md", { exists }],
  ] as const)("%s passes", (_name, path, held) => {
    expect(backslashReason(path, held)).toBeNull();
  });

  test.each([
    ["a name that gains one", "a\\b.md", { source: "ab.md" }],
    ["a name that holds one more", "a\\b\\c.md", { source: "a\\b.md" }],
    ["a new name with no source", "p\\q.md", { exists }],
    ["a new directory on the way", "p\\q/a.md", { source: "a.md", exists }],
    ["a new directory under the source's own", "far/p\\q/n\\w/b.md", { source: "far/p\\q/a.md" }],
    ["a directory at another place than the source's", "p\\q/b.md", { source: "far/p\\q/a.md" }],
    ["an absolute path, which the tree does not list", "/var/x\\y/a.md", { exists }],
    ["a path with nothing to hold it against", "x\\y/a.md", {}],
  ] as const)("%s is refused", (_name, path, held) => {
    expect(backslashReason(path, held)).toBe(REFUSED);
  });
});

describe("validatePath", () => {
  test("a backslash is refused when the caller names nothing that holds one", () => {
    for (const path of ["a\\b.md", "dir/a\\b.md", "a\\b/c.md", "x\\y/"]) {
      expect(validatePath(path, { allowTrailingSlash: true })).toEqual({ ok: false, reason: REFUSED });
    }
  });
  test("a backslash a name holds passes with the rest of the path still checked", () => {
    const held = { source: "a\\b.md", exists: (path: string) => path === "x\\y" };
    expect(validatePath("x\\y/a\\b.md", held)).toEqual({ ok: true });
    expect(validatePath("x\\y/", { ...held, allowTrailingSlash: true })).toEqual({ ok: true });
    expect(validatePath("x\\y/a\\b?.md", held).ok, "a character Windows refuses").toBe(false);
  });
  test("empty input is rejected", () => {
    expect(validatePath("")).toEqual({ ok: false, reason: "path is empty" });
  });
  test("trailing slash is rejected with a name-prompt hint", () => {
    const r = validatePath("Recipes/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/type a name/);
  });
  test("trailing slash is accepted when allowTrailingSlash (directory)", () => {
    expect(validatePath("Recipes/", { allowTrailingSlash: true })).toEqual({
      ok: true,
    });
    expect(
      validatePath("a/b/c/", { allowTrailingSlash: true }),
    ).toEqual({ ok: true });
  });
  test("allowTrailingSlash still rejects a bare slash (nothing to name)", () => {
    // allowAbsolute so the bare "/" reaches the trailing-slash branch
    // (otherwise the absolute-path guard rejects it first).
    const r = validatePath("/", {
      allowTrailingSlash: true,
      allowAbsolute: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/type a name/);
  });
  test("allowTrailingSlash still validates the stripped segments", () => {
    // A `.` segment is illegal whether or not the path ends in `/`.
    expect(
      validatePath("a/./", { allowTrailingSlash: true }).ok,
    ).toBe(false);
  });
  test("absolute path is rejected", () => {
    const r = validatePath("/etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/absolute/);
  });
  test("absolute path can be allowed by the caller", () => {
    expect(validatePath("/tmp/events", { allowAbsolute: true })).toEqual({ ok: true });
  });
  test("dot segments are rejected", () => {
    expect(validatePath("a/./b").ok).toBe(false);
    expect(validatePath("a/../b").ok).toBe(false);
  });
  test("ordinary nested path is accepted", () => {
    expect(validatePath("Recipes/2024/pasta.md")).toEqual({ ok: true });
  });
});

describe("splitPath", () => {
  test("top-level basename has empty parent", () => {
    expect(splitPath("note.md")).toEqual({ parent: "", base: "note.md" });
  });
  test("nested path splits on the last slash", () => {
    expect(splitPath("a/b/c.md")).toEqual({ parent: "a/b", base: "c.md" });
  });
});

describe("appendDefaultMd", () => {
  test("bare name → .md added", () => {
    expect(appendDefaultMd("note")).toBe("note.md");
  });
  test("existing extension is preserved", () => {
    expect(appendDefaultMd("note.txt")).toBe("note.txt");
  });
  test("hidden-style basename gets .md tacked on", () => {
    // The .gitignore-shaped name has its `.` at position 0, which
    // appendDefaultMd treats as "no real extension". Important for
    // a notes app: the user typed a name, not a Unix dotfile.
    expect(appendDefaultMd(".gitignore")).toBe(".gitignore.md");
  });
  test("trailing dot is stripped before appending", () => {
    expect(appendDefaultMd("note.")).toBe("note.md");
  });
});

describe("preserveExtension", () => {
  test("rename without extension regains the original", () => {
    expect(preserveExtension("note.md", "humus")).toBe("humus.md");
  });
  test("user-chosen extension wins", () => {
    expect(preserveExtension("note.md", "humus.txt")).toBe("humus.txt");
  });
  test("extensionless source returns the new path verbatim", () => {
    expect(preserveExtension("README", "NOTES")).toBe("NOTES");
  });
});

describe("proposeDefaultFilename", () => {
  test("empty parent → top-level untitled.md", () => {
    expect(proposeDefaultFilename("")).toBe("untitled.md");
  });
  test("directory with trailing slash → joined without doubling", () => {
    expect(proposeDefaultFilename("Recipes/")).toBe("Recipes/untitled.md");
  });
  test("directory without trailing slash → slash added", () => {
    // The path prompt always feeds us a `<dir>/` value after a
    // directory completion, but we tolerate the missing slash so a
    // caller that already trimmed it doesn't have to re-add it.
    expect(proposeDefaultFilename("Recipes")).toBe("Recipes/untitled.md");
  });
  test("deeply nested parent", () => {
    expect(proposeDefaultFilename("a/b/c/")).toBe("a/b/c/untitled.md");
  });
  test("uses DEFAULT_NEW_FILENAME_STEM as the stem", () => {
    expect(proposeDefaultFilename("x/")).toBe(`x/${DEFAULT_NEW_FILENAME_STEM}.md`);
  });
});
