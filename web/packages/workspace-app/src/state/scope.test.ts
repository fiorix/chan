import { describe, expect, test } from "vitest";
import { scopeKey } from "./scope.svelte";

describe("scopeKey", () => {
  test("sorts and joins with pipe", () => {
    expect(scopeKey(["b", "a"])).toBe("a|b");
  });

  test("empty input → empty string", () => {
    expect(scopeKey([])).toBe("");
  });

  test("single entry → that entry", () => {
    expect(scopeKey(["only"])).toBe("only");
  });
});
