// @vitest-environment jsdom
//
// A command that writes config reports its outcome through withStatus: a
// write that resolves shows the success text as a transient status, and one
// that rejects shows the failure text and never rejects its caller.

import { afterEach, describe, expect, test } from "vitest";
import { withStatus } from "../commands";
import { ui } from "../store.svelte";

afterEach(() => {
  ui.status = null;
  ui.statusKind = null;
});

describe("withStatus", () => {
  test("a write that resolves shows the success text", async () => {
    await withStatus(() => Promise.resolve(), "Saved", "Save failed");

    expect(ui.status).toBe("Saved");
    expect(ui.statusKind).toBe("transient");
  });

  test("a write that rejects shows the failure text and does not reject", async () => {
    const outcome = withStatus(() => Promise.reject(new Error("refused")), "Saved", "Save failed");

    await expect(outcome).resolves.toBeUndefined();
    expect(ui.status).toBe("Save failed");
    expect(ui.statusKind).toBe("transient");
  });
});
