import { describe, expect, test } from "vitest";
import search from "./SearchPanel.svelte?raw";

describe("search workspace readiness", () => {
  test("content results consume the nested readiness state", () => {
    expect(search).toMatch(
      /searchRecovering = workspaceIsRecovering\(res\.readiness\)/,
    );
  });

  test("recovery is rendered before hit counts or no-matches copy", () => {
    expect(search).toMatch(
      /\{:else if searchNotReady\}[\s\S]{1,180}workspace recovering - content search not ready[\s\S]*?\{:else if searchPanel\.query\.trim\(\) && rows\.length === 0\}/,
    );
  });
});
