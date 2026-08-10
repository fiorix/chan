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
      /\{:else if searchNotReady\}[\s\S]{1,200}rebuilding search index - content search is paused until it\s*finishes[\s\S]*?\{:else if searchPanel\.query\.trim\(\) && rows\.length === 0\}/,
    );
  });

  test("the stale-window copy names the consequence, not just the state", () => {
    // The contract line this pins: search behaviour during a stale window is
    // DEFINED rather than incidental -- it declines, and it says why. The old
    // copy ("workspace recovering") named a state and left the user to infer
    // what it cost them, which was survivable only while the boot overlay kept
    // them out of the workspace entirely. It no longer does.
    expect(search).toMatch(/rebuilding search index/);
    expect(search).toMatch(/paused until it\s*finishes/);
    expect(search).not.toMatch(/workspace recovering/);
  });
});
