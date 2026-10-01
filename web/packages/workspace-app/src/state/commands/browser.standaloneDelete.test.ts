// @vitest-environment jsdom
//
// Delete on a multi-selection in a window with no workspace, where there is
// no trash behind it and the route deletes only a file or an empty directory:
// the one confirm names the count of the selected paths and says the delete is
// permanent, and every selected path is deleted, deepest first, so a folder
// selected with all its contents empties and then goes. The window's
// capabilities are read once at module load, so each test plants the `?kind=`
// marker and the Files capability meta before it imports the state modules
// (the state/standaloneBootstrap.test.ts discipline).

import { expect, test, vi } from "vitest";
import { serveMeta } from "../../__tests__/standalone";
import type { TreeEntry } from "../../api/types";

/// What the double answers for one path instead of deleting it.
type Refusal = { status: number; error: string; code?: string };

/// A window with no workspace over a disk that deletes the way the
/// no-workspace route does: a file or an empty directory, never recursively.
/// A path named in `refusals` is refused with that answer.
async function standaloneWindow(
  dirs: string[],
  files: string[],
  refusals: Record<string, Refusal> = {},
) {
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
  const { ApiError } = await import("../../api/errors");
  await import("./browser");

  const disk = new Map<string, boolean>([
    ...dirs.map((path) => [path, true] as const),
    ...files.map((path) => [path, false] as const),
  ]);
  const listing = (): TreeEntry[] =>
    [...disk].map(([path, is_dir]) => ({ path, is_dir, mtime: null, size: 0 }));
  // A refusal as the transport delivers it: the body's sentence as the
  // message, and the parsed body beside it.
  const refusal = (path: string, { status, error, code }: Refusal) =>
    new ApiError(status, error, code === undefined ? { error } : { error, code, path });
  const remove = vi.spyOn(api, "remove").mockImplementation(async (path: string) => {
    if (!disk.has(path)) throw new ApiError(404, "not_found");
    const planted = refusals[path];
    if (planted) throw refusal(path, planted);
    if ([...disk.keys()].some((p) => p.startsWith(`${path}/`))) {
      throw refusal(path, {
        status: 409,
        error: `directory is not empty: ${path}`,
        code: "directory_not_empty",
      });
    }
    disk.delete(path);
  });
  vi.spyOn(api, "list").mockImplementation(async () => listing());
  store.tree.entries = listing();
  tabs.openBrowserInActivePane();

  /// Run the Delete command on `paths` and return the confirm it raises.
  async function deleteSelection(paths: string[]): Promise<{ title: string; message: string }> {
    store.fbSelectSet(paths, paths[paths.length - 1]);
    const command = allCommands().find((c) => c.id === "app.browser.deleteSelection")!;
    expect(command.available(commandContext())).toBe(true);
    command.run();
    await vi.waitFor(() => expect(confirmState.open).toBe(true));
    return { title: confirmState.title, message: confirmState.message };
  }

  return { store, remove, disk, deleteSelection, confirmState, resolveConfirm };
}

test("a multi-selection's confirm names the count and says the delete is permanent", async () => {
  const { remove, deleteSelection, confirmState, resolveConfirm } = await standaloneWindow(
    ["home", "home/u"],
    ["home/u/a.md", "home/u/b.md"],
  );

  const shown = await deleteSelection(["home/u/a.md", "home/u/b.md"]);
  expect(shown.title).toBe("Permanently delete");
  expect(shown.message).toBe("Permanently delete 2 files? This cannot be undone.");
  resolveConfirm(false);
  await vi.waitFor(() => expect(confirmState.open).toBe(false));
  expect(remove).not.toHaveBeenCalled();
});

test("a folder selected with its files and a loose file all go, children before the folder", async () => {
  const { store, remove, disk, deleteSelection, resolveConfirm } = await standaloneWindow(
    ["build"],
    ["build/a.o", "build/b.o", "notes.txt"],
  );

  const shown = await deleteSelection(["build", "build/a.o", "build/b.o", "notes.txt"]);
  expect(shown.message).toBe(
    "Permanently delete 4 items, including 1 directory? This cannot be undone.",
  );
  resolveConfirm(true);

  await vi.waitFor(() => expect([...disk.keys()]).toEqual([]));
  const order = remove.mock.calls.map(([path]) => path);
  expect(order.indexOf("build")).toBeGreaterThan(order.indexOf("build/a.o"));
  expect(order.indexOf("build")).toBeGreaterThan(order.indexOf("build/b.o"));
  expect(store.ui.status).toBeNull();
  expect(store.browserSelection.paths).toEqual([]);
});

test("a folder selected with all its contents and nothing else empties and then goes", async () => {
  const { disk, deleteSelection, resolveConfirm } = await standaloneWindow(
    ["build"],
    ["build/a.o", "build/b.o", "notes.txt"],
  );

  const shown = await deleteSelection(["build", "build/a.o", "build/b.o"]);
  expect(shown.message).toBe(
    "Permanently delete 3 items, including 1 directory? This cannot be undone.",
  );
  resolveConfirm(true);

  await vi.waitFor(() => expect([...disk.keys()]).toEqual(["notes.txt"]));
});

test("a folder that still holds unselected files is refused and reported", async () => {
  const { store, disk, deleteSelection, resolveConfirm } = await standaloneWindow(
    ["build"],
    ["build/a.o", "build/b.o", "notes.txt"],
  );

  const shown = await deleteSelection(["build", "build/a.o", "notes.txt"]);
  expect(shown.message).toBe(
    "Permanently delete 3 items, including 1 directory? This cannot be undone.",
  );
  resolveConfirm(true);

  await vi.waitFor(() =>
    expect(store.ui.status).toBe("deleted 2 of 3; directory is not empty: build"),
  );
  expect([...disk.keys()]).toEqual(["build", "build/b.o"]);
  expect(store.browserSelection.paths).toEqual(["build"]);
});

test("a protected path in a multi-selection is reported by the server's sentence", async () => {
  const { store, disk, deleteSelection, resolveConfirm } = await standaloneWindow(
    ["home", "home/user"],
    ["notes.txt"],
    { "home/user": { status: 409, error: "path is protected: home/user", code: "protected_path" } },
  );

  await deleteSelection(["home/user", "notes.txt"]);
  resolveConfirm(true);

  await vi.waitFor(() =>
    expect(store.ui.status).toBe("deleted 1 of 2; path is protected: home/user"),
  );
  expect([...disk.keys()]).toEqual(["home", "home/user"]);
  expect(store.browserSelection.paths).toEqual(["home/user"]);
});

test.each<[string, Refusal]>([
  ["has no code", { status: 409, error: "directory_not_empty" }],
  ["has another code", { status: 409, error: "file is in use", code: "other" }],
  [
    "has another status",
    { status: 500, error: "directory is not empty: notes.txt", code: "directory_not_empty" },
  ],
])("a refusal in a multi-selection that %s is reported under its path", async (_reason, planted) => {
  const { store, deleteSelection, resolveConfirm } = await standaloneWindow(
    [],
    ["a.md", "notes.txt"],
    { "notes.txt": planted },
  );

  await deleteSelection(["a.md", "notes.txt"]);
  resolveConfirm(true);

  await vi.waitFor(() =>
    expect(store.ui.status).toBe(`deleted 1 of 2; notes.txt: ${planted.error}`),
  );
});

test("a single folder that still holds files is refused by the server's sentence", async () => {
  const { store, disk, deleteSelection, resolveConfirm } = await standaloneWindow(
    ["build"],
    ["build/a.o"],
  );

  const shown = await deleteSelection(["build"]);
  expect(shown.message).toBe('Permanently delete "build"? This cannot be undone.');
  resolveConfirm(true);

  await vi.waitFor(() =>
    expect(store.ui.status).toBe("delete failed: directory is not empty: build"),
  );
  expect([...disk.keys()]).toEqual(["build", "build/a.o"]);
});
