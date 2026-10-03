// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { relistTreeDir, tree } from "./store.svelte";

afterEach(() => {
  vi.restoreAllMocks();
  tree.entries = [];
  tree.loadedDirs = {};
  tree.loadingDirs = {};
  tree.dirErrors = {};
});

test("an unloaded directory reset contains the listing rejection and keeps its row error", async () => {
  tree.entries = [];
  tree.loadedDirs = {};
  tree.loadingDirs = {};
  tree.dirErrors = {};
  const list = vi.spyOn(api, "list").mockRejectedValue(new Error("cannot list private"));

  await expect(relistTreeDir("private")).resolves.toBeUndefined();

  expect(list).toHaveBeenCalledExactlyOnceWith("private");
  expect(tree.dirErrors.private).toContain("cannot list private");
  expect(tree.loadedDirs.private).toBeFalsy();
  expect(tree.loadingDirs.private).toBeFalsy();
});
