// @vitest-environment jsdom
//
// What a file move leaves in the status pill. A success that rewrote links
// says so and clears itself, like every other action confirmation; a success
// with nothing to report leaves no status, not even the "Moving..." a slow
// move shows; a failure stays until the user dismisses it.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import type { MoveResponse } from "../api/types";
import { fileOps, ui } from "./store.svelte";

function moved(overrides: Partial<MoveResponse> = {}): MoveResponse {
  return { renamed: [["a.md", "b.md"]], rewritten: [], conflicts: [], ...overrides };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(api, "list").mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  ui.status = null;
  ui.statusKind = null;
});

describe("the status a move leaves", () => {
  test("a move that updated links says so, then clears itself", async () => {
    vi.spyOn(api, "move").mockResolvedValue(moved({ rewritten: ["index.md"] }));
    await fileOps.moveTo("a.md", "b.md");

    expect(ui.status).toBe("Moved 'b.md' (1 link updated)");
    expect(ui.statusKind).toBe("transient");
    await vi.advanceTimersByTimeAsync(3000);
    expect(ui.status).toBeNull();
  });

  test("a slow move with nothing to report shows Moving..., then nothing", async () => {
    let finish: (response: MoveResponse) => void = () => {};
    vi.spyOn(api, "move").mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const move = fileOps.moveTo("a.md", "b.md");
    await vi.advanceTimersByTimeAsync(200);
    expect(ui.status).toBe("Moving...");

    finish(moved());
    await move;
    expect(ui.status).toBeNull();
  });

  test("a failed move stays until it is dismissed", async () => {
    vi.spyOn(api, "move").mockRejectedValue(new Error("permission denied"));
    await fileOps.moveTo("a.md", "b.md");

    expect(ui.status).toBe("rename failed: permission denied");
    expect(ui.statusKind).not.toBe("transient");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ui.status).toBe("rename failed: permission denied");
  });
});
