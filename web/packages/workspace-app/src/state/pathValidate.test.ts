import { describe, expect, test } from "vitest";
import {
  DEFAULT_NEW_FILENAME_STEM,
  appendDefaultMd,
  preserveExtension,
  proposeDefaultFilename,
  splitPath,
  validatePath,
} from "./pathValidate";

describe("validatePath", () => {
  test("a backslash is refused as a character a name cannot hold", () => {
    for (const path of ["a\\b.md", "dir/a\\b.md"]) {
      expect(validatePath(path)).toEqual({ ok: false, reason: "\\ is not allowed in a name" });
    }
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
