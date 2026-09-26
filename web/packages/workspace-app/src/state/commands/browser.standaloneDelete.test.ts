// @vitest-environment jsdom
//
// Delete on a multi-selection in a window with no workspace, where there is
// no trash behind it: the one confirm names the count and says the delete is
// permanent. The window's capabilities are read once at module load, so the
// test plants the `?kind=` marker and the Files capability meta before it
// imports the state modules (the state/standaloneBootstrap.test.ts
// discipline).

import { expect, test, vi } from "vitest";
import { serveMeta } from "../../__tests__/standalone";

test("a multi-selection's confirm names the count and says the delete is permanent", async () => {
  vi.resetModules();
  window.history.replaceState({}, "", "/?kind=terminal&w=w-mini");
  serveMeta("chan-files", true);
  const { windowCaps } = await import("../windowCaps");
  expect(windowCaps.workspace).toBe(false);
  const tabs = await import("../tabs.svelte");
  const store = await import("../store.svelte");
  const { allCommands, commandContext } = await import("../commands");
  const { confirmState, resolveConfirm } = await import("../confirm.svelte");
  const { api } = await import("../../api/client");
  await import("./browser");
  const remove = vi.spyOn(api, "remove").mockResolvedValue(undefined);

  tabs.openBrowserInActivePane();
  store.fbSelectSet(["home/u/a.md", "home/u/b.md"], "home/u/b.md");
  const command = allCommands().find((c) => c.id === "app.browser.deleteSelection")!;
  expect(command.available(commandContext())).toBe(true);
  command.run();
  await vi.waitFor(() => expect(confirmState.open).toBe(true));

  expect(confirmState.title).toBe("Permanently delete");
  expect(confirmState.message).toBe("Permanently delete 2 files? This cannot be undone.");
  resolveConfirm(false);
  await vi.waitFor(() => expect(confirmState.open).toBe(false));
  expect(remove).not.toHaveBeenCalled();
});
