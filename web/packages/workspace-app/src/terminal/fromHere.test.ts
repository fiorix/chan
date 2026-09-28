import { describe, expect, test } from "vitest";
import { shellQuotePath, terminalFromHereTarget } from "./fromHere";

describe("terminalFromHereTarget", () => {
  test("opens directories as cwd without prompt seed", () => {
    expect(terminalFromHereTarget("notes/work", true)).toEqual({ cwd: "notes/work" });
  });

  test("opens files at parent cwd and seeds the basename", () => {
    expect(terminalFromHereTarget("notes/work/today.md", false)).toEqual({
      cwd: "notes/work",
      seedInput: "today.md",
    });
  });

  test("opens a file whose name holds a backslash beside it, named whole", () => {
    expect(terminalFromHereTarget("a\\b.md", false)).toEqual({ cwd: "", seedInput: "'a\\b.md'" });
    expect(terminalFromHereTarget("dir/a\\b.md", false)).toEqual({
      cwd: "dir",
      seedInput: "'a\\b.md'",
    });
  });

  test("quotes file seed paths that need shell quoting", () => {
    expect(terminalFromHereTarget("notes/work/today's plan.md", false)).toEqual({
      cwd: "notes/work",
      seedInput: "'today'\\''s plan.md'",
    });
  });
});

describe("shellQuotePath", () => {
  test("leaves safe paths raw", () => {
    expect(shellQuotePath("notes/work/today.md")).toBe("notes/work/today.md");
  });

  test("quotes spaces and embedded single quotes", () => {
    expect(shellQuotePath("a b's.md")).toBe("'a b'\\''s.md'");
  });
});
