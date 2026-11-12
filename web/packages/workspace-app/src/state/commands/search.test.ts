// The Rebuild index command's status line: it says the rebuild started, and
// says so when the server refuses it. Details (search) is the search
// overlay's Details pane as a toggle of the Workspace scope: it reports and
// flips the pane's state, open overlay or not.

import { afterEach, expect, test, vi } from "vitest";
import { api } from "../../api/client";
import { allCommands, commandById, commandContext, commandPlacement, commandState } from "../commands";
import { searchPanel, ui } from "../store.svelte";
import "./search";

afterEach(() => {
  vi.restoreAllMocks();
  ui.status = null;
  searchPanel.inspectorOpen = false;
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

test("Details (search) is a Workspace toggle over the search overlay's Details pane", () => {
  const details = commandById("app.search.details")!;
  expect(details).toMatchObject({ title: "Details (search)", kind: "toggle", requirement: "workspace" });
  expect(commandPlacement(details)).toEqual({ scope: "workspace", surfaces: [], group: "Workspace" });
  // The words it had as a menu row that flipped still find it.
  expect(details.keywords).toEqual(expect.arrayContaining(["Show Details", "Hide Details"]));

  searchPanel.open = false;
  searchPanel.inspectorOpen = false;
  expect(commandState("app.search.details")).toBe(false);

  details.run();
  expect(searchPanel.inspectorOpen, "the next search opens with Details").toBe(true);
  expect(commandState("app.search.details")).toBe(true);

  details.run();
  expect(searchPanel.inspectorOpen).toBe(false);
});

test("Details (search) is offered in a workspace window only", () => {
  const details = commandById("app.search.details")!;
  expect(details.available(commandContext())).toBe(true);
  expect(details.available({ ...commandContext(), terminalOnly: true })).toBe(false);
});
