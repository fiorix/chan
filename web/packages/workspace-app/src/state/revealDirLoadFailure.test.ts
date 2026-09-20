// @vitest-environment jsdom
//
// Entering a directory from a window command starts a listing nothing awaits.
// `loadTreeDir` records the failure in `tree.dirErrors`, which the directory's
// own row renders, and then rethrows for the callers that do await it, so the
// unawaited call has to swallow its rejection: an unhandled one raises a
// second report of a failure the tree is already showing.
//
// The two halves are enforced differently, which is worth knowing before
// trusting a green run of this file. The assertion below covers the reporting
// half only. The no-unhandled-rejection half is enforced by the runner: vitest
// fails a file whose run leaves an unhandled rejection, with the test itself
// still passing and the failure in an "Unhandled Errors" section. A jsdom
// `window` listener does NOT see it, because the rejection is Node's and never
// reaches the jsdom event target.

import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "../api/client";
import { revealAndEnterDirectory, tree } from "./store.svelte";

afterEach(() => {
  vi.restoreAllMocks();
  tree.dirErrors = {};
  tree.loadedDirs = {};
  tree.loadingDirs = {};
});

/// An unhandled rejection is reported a turn after the microtasks settle, so
/// the test has to still be running then for the runner to attribute it here.
async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("entering a directory whose listing fails", () => {
  test("reports through dirErrors, and leaves the runner nothing to catch", async () => {
    const list = vi.spyOn(api, "list").mockRejectedValue(new Error("permission denied"));

    revealAndEnterDirectory("locked/inner");
    await settle();

    expect(list).toHaveBeenCalledWith("locked/inner");
    expect(tree.dirErrors["locked/inner"]).toBe("permission denied");
  });
});
