import { describe, expect, test } from "vitest";
import {
  DEFAULT_NEW_FILENAME_STEM,
  appendDefaultMd,
  backslashClimbReason,
  backslashReason,
  backslashRuleSubject,
  backslashSeparates,
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

describe("backslashSeparates", () => {
  const dirs = ["docs", "docs/watch", "x", "x\\y"];
  const isDir = (path: string) => dirs.includes(path);
  const exists = (path: string) => [...dirs, "notes.md"].includes(path);

  test.each([
    ["a new name after a listed directory", "docs\\new.md", { exists }],
    ["a new name after a listed directory inside another", "docs/watch\\new.md", { exists }],
    ["a path of two, the first after a listed directory", "docs\\watch\\new.md", { exists }],
    ["a path that stops at the backslash", "docs\\", { exists }],
    ["a new directory's name after a listed directory, on the way to a file", "docs\\sub/new.md", { exists }],
    ["a move's last name after a listed directory", "docs\\notes.md", { source: "notes.md", exists }],
  ] as const)("%s reads as a separator", (_name, path, held) => {
    expect(backslashSeparates(path, held, isDir)).toBe(true);
  });

  test.each([
    ["a path that holds none", "docs/new.md", { exists }],
    ["a path the rule passes", "x\\y/new.md", { exists }],
    ["a name whose text before it names nothing", "p\\q.md", { exists }],
    ["a name whose text before it names a file", "notes.md\\x", { exists }],
    ["a refused name after a directory that holds one after a listed directory's name", "x\\y/p\\q.md", { exists }],
  ] as const)("%s does not", (_name, path, held) => {
    expect(backslashSeparates(path, held, isDir)).toBe(false);
  });

  test.each([
    ["under a directory", "docs/\\new.md"],
    ["at the top", "\\new.md"],
  ])("a backslash that opens a name %s follows no directory, whatever the caller calls one", (_where, path) => {
    expect(backslashSeparates(path, {}, () => true)).toBe(false);
  });
});

describe("backslashRuleSubject", () => {
  test.each([
    ["a relative path", "x\\y/new.md", "/abs/root", "x\\y/new.md"],
    ["a relative path with no root known", "x\\y/new.md", null, "x\\y/new.md"],
    ["a relative path under a root that is a bare name", "x\\y/new.md", "demo", "x\\y/new.md"],
    ["an absolute path under the root", "/abs/root/x\\y/new.md", "/abs/root", "x\\y/new.md"],
    ["an absolute path under a root spelled with a trailing /", "/abs/root/a\\b.md", "/abs/root/", "a\\b.md"],
    ["an absolute path under the machine's root", "/home/u/a\\b.md", "/", "home/u/a\\b.md"],
    ["a path that opens with ./", "./a\\b.md", "/abs/root", "a\\b.md"],
    ["a path with an empty name", "deep//a\\b.md", "/abs/root", "deep/a\\b.md"],
    ["a directory typed with its trailing /", "p\\q/", "/abs/root", "p\\q"],
  ])("%s is judged as a workspace path", (_name, target, root, judged) => {
    expect(backslashRuleSubject(target, root)).toBe(judged);
  });

  test.each([
    ["a path that holds no backslash", "notes/a.md", "/abs/root"],
    ["a path on a server whose root opens with a drive", "notes\\a.md", "C:\\ws"],
    ["a path on a server whose root opens with a drive and is spelled with /", "notes\\a.md", "c:/ws"],
    ["a path on a server whose root is a share", "notes\\a.md", "\\\\host\\share\\ws"],
    ["an absolute path outside the root", "/elsewhere/a\\b.md", "/abs/root"],
    ["an absolute path beside the root", "/abs/rootless/a\\b.md", "/abs/root"],
    ["an absolute path with no root known", "/abs/root/a\\b.md", null],
    ["a path that climbs with ..", "notes/../a\\b.md", "/abs/root"],
  ])("%s is not the rule's to judge", (_name, target, root) => {
    expect(backslashRuleSubject(target, root)).toBeNull();
  });
});

describe("backslashClimbReason", () => {
  test.each([
    ["a relative path", "notes/../a\\b.md", "/abs/root"],
    ["a relative path with no root known", "notes/../a\\b.md", null],
    ["a relative path under a root that is a bare name", "notes/../a\\b.md", "demo"],
    ["an absolute path under the root", "/abs/root/notes/../a\\b.md", "/abs/root"],
    ["an absolute path that leaves the root in its text", "/abs/root/../elsewhere/a\\b.md", "/abs/root"],
    ["an absolute path outside the root", "/elsewhere/../a\\b.md", "/abs/root"],
    ["an absolute path with no root known", "/abs/root/../a\\b.md", null],
    ["a path that opens with ..", "../a\\b.md", "/abs/root"],
    ["a path that ends with ..", "a\\b/..", "/abs/root"],
    ["a backslash in a directory before the ..", "x\\y/../a.md", "/abs/root"],
  ])("%s that holds a backslash and a .. name is refused", (_name, target, root) => {
    expect(backslashClimbReason(target, root)).toBe(".. cannot be used in a path that holds \\");
  });

  test.each([
    ["a path with a .. and no backslash", "notes/../a.md", "/abs/root"],
    ["a path with a backslash and no ..", "notes/a\\b.md", "/abs/root"],
    ["a name that only contains two dots", "a..b\\c.md", "/abs/root"],
    ["a .. between backslashes, which is one name", "notes\\..\\a.md", "/abs/root"],
    ["a name that opens with .. and a backslash", "..\\a.md", "/abs/root"],
    ["a name of three dots", "notes/.../a\\b.md", "/abs/root"],
    ["a path in the spelling of a server whose root opens with a drive", "notes\\..\\a.md", "C:\\ws"],
    ["a path with / on a server whose root opens with a drive", "notes/../a\\b.md", "c:/ws"],
    ["a path on a server whose root is a share", "notes/../a\\b.md", "\\\\host\\share\\ws"],
  ])("%s is not refused", (_name, target, root) => {
    expect(backslashClimbReason(target, root)).toBeNull();
  });
});

describe("validatePath", () => {
  test("on a server whose root is a Windows path a backslash passes", () => {
    expect(validatePath("notes\\new.md", { root: "C:\\ws" })).toEqual({ ok: true });
  });

  test("an absolute path under the root is held to the rule as its relative path", () => {
    const exists = (path: string) => path === "a\\b.md";
    const opts = { allowAbsolute: true, root: "/abs/root", exists };
    expect(validatePath("/abs/root/a\\b.md", opts)).toEqual({ ok: true });
    expect(validatePath("/abs/root/p\\q.md", opts)).toEqual({ ok: false, reason: "\\ cannot be added to a name" });
  });

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
