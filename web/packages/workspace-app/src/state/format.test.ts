import { describe, expect, test } from "vitest";

import { basename, parentDir } from "./format";

describe("parentDir", () => {
  test.each([
    ["", ""],
    ["/", ""],
    ["/foo", ""],
    ["a", ""],
    ["file.md", ""],
    ["a/b", "a"],
    ["notes/today.md", "notes"],
    ["notes/2024", "notes"],
    ["a/b/c/d/e.md", "a/b/c/d"],
    ["/a/b", "/a"],
    ["a\\b", ""],
    ["a/b/", "a/b"],
  ])("parentDir(%j) is %j", (path, parent) => {
    expect(parentDir(path)).toBe(parent);
  });
});

describe("basename", () => {
  test.each([
    ["", ""],
    ["/", ""],
    ["/foo", "foo"],
    ["a", "a"],
    ["a/b", "b"],
    ["/a/b", "b"],
    ["a\\b", "b"],
    ["a/b/", ""],
  ])("basename(%j) is %j", (path, base) => {
    expect(basename(path)).toBe(base);
  });
});
