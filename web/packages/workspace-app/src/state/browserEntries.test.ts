import { describe, expect, test } from "vitest";
import { browserDirectoryInput, directoryEntries } from "./browserEntries";
import type { TreeEntry } from "../api/types";

const entries: TreeEntry[] = [
  { path: "src/file10.ts", is_dir: false, size: 10, mtime: 10, kind: "text" },
  { path: "src/file2.ts", is_dir: false, size: 20, mtime: 20, kind: "text" },
  { path: "src/.config", is_dir: false, size: 5, mtime: null, kind: "text" },
  { path: "src/nested", is_dir: true, size: 0, mtime: null },
  { path: "src/nested/other.ts", is_dir: false, size: 1, mtime: 1, kind: "text" },
  { path: "other/file.ts", is_dir: false, size: 1, mtime: 1, kind: "text" },
];

describe("directory entries", () => {
  test("lists immediate children once, folders first, with natural names", () => {
    expect(directoryEntries([...entries, entries[0]], "src", "", "name", false, false).map(e => e.path))
      .toEqual(["src/nested", "src/file2.ts", "src/file10.ts"]);
  });
  test("filters names case-insensitively without matching hidden descendants", () => {
    expect(directoryEntries(entries, "src", "FILE", "size", true, true).map(e => e.path))
      .toEqual(["src/file2.ts", "src/file10.ts"]);
    expect(directoryEntries(entries, "src", "other", "name", false, true)).toEqual([]);
  });
  test("keeps folders first for descending metadata order", () => {
    expect(directoryEntries(entries, "src", "", "modified", true, true).map(e => e.path))
      .toEqual(["src/nested", "src/file2.ts", "src/file10.ts", "src/.config"]);
  });
  test("normalizes rooted and relative path entry without escaping the root", () => {
    expect(browserDirectoryInput("/work/chan/src/../web/", "/work/chan")).toBe("web");
    expect(browserDirectoryInput("../../etc", "/work/chan")).toBe("etc");
    expect(browserDirectoryInput("/home/user", "/")).toBe("home/user");
  });
});
