import { describe, expect, test } from "vitest";

import { basename, fmtCost, fmtDevs, fmtMonths, parentDir } from "./format";

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
    ["a\\b.md", ""],
    ["dir/a\\b.md", "dir"],
    ["x\\y/a.md", "x\\y"],
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
    ["a\\b", "a\\b"],
    ["a\\b.md", "a\\b.md"],
    ["dir/a\\b.md", "a\\b.md"],
    ["x\\y/a.md", "a.md"],
    ["a/b/", ""],
  ])("basename(%j) is %j", (path, base) => {
    expect(basename(path)).toBe(base);
  });
});

describe("fmtMonths", () => {
  test.each([
    [12.4, "12 mo"],
    [10, "10 mo"],
    [3.14, "3.1 mo"],
    [NaN, " - "],
    [Infinity, " - "],
  ])("%d -> %j", (input, expected) => {
    expect(fmtMonths(input)).toBe(expected);
  });
});

describe("fmtDevs", () => {
  test.each([
    [12.6, "13"],
    [2.5, "2.5"],
    [NaN, " - "],
  ])("%d -> %j", (input, expected) => {
    expect(fmtDevs(input)).toBe(expected);
  });
});

describe("fmtCost", () => {
  test("rounds to whole dollars and groups the digits as the locale does", () => {
    expect(fmtCost(1234.6)).toBe(`$${(1235).toLocaleString()}`);
  });

  test("an estimate that is not a number reads as a dash", () => {
    expect(fmtCost(NaN)).toBe(" - ");
  });
});
