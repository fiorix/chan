// The Rebuild index command's status line: it says the rebuild started, and
// says so when the server refuses it.

import { afterEach, expect, test, vi } from "vitest";
import { api } from "../../api/client";
import { allCommands } from "../commands";
import { ui } from "../store.svelte";
import "./search";

afterEach(() => {
  vi.restoreAllMocks();
  ui.status = null;
});

async function statusAfterRebuild(): Promise<string | null> {
  ui.status = null;
  allCommands()
    .find((command) => command.id === "app.index.rebuild")!
    .run();
  await vi.waitFor(() => expect(ui.status).not.toBeNull());
  return ui.status;
}

test("a rebuild the server accepts says it started", async () => {
  const rebuild = vi.spyOn(api, "indexRebuild").mockResolvedValue(undefined as never);
  expect(await statusAfterRebuild()).toBe("Rebuilding search index...");
  expect(rebuild).toHaveBeenCalledTimes(1);
});

test("a rebuild the server refuses says it failed", async () => {
  vi.spyOn(api, "indexRebuild").mockRejectedValue(new Error("workspace busy"));
  expect(await statusAfterRebuild()).toBe("Index rebuild failed");
});
