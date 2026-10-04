// @vitest-environment jsdom
//
// The launcher's Open sends its target to /api/open. A refusal (binary
// target, workspace escape, no connected window) lands in the status pill as
// a persistent status, the kind AppStatusBar gives a dismiss control: a
// status with no kind neither clears itself nor offers a way to clear it.

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../api/client";
import { ApiError } from "../../api/errors";
import { allCommands } from "../commands";
import { tree, ui } from "../store.svelte";
import { workspace } from "../workspace.svelte";
import "./global";

afterEach(() => {
  vi.restoreAllMocks();
  ui.status = null;
  ui.statusKind = null;
  tree.entries = [];
  tree.loadedDirs = {};
  workspace.info = null;
});

function runOpen(target: string): void {
  const open = allCommands().find((command) => command.id === "app.open.path");
  expect(open, "the Open command is registered").toBeDefined();
  open!.run(target);
}

describe("the launcher's Open", () => {
  test("a refused target lands as a persistent status", async () => {
    vi.spyOn(api, "open").mockRejectedValue(new ApiError(400, "binary file"));
    runOpen("image.png");

    await vi.waitFor(() => expect(ui.status).toBe("open failed: binary file"));
    expect(ui.statusKind).toBe("persistent");
  });

  test("an accepted target sets no status of its own", async () => {
    const open = vi.spyOn(api, "open").mockResolvedValue({ message: "queued" });
    runOpen("notes/a.md");

    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith({
        window_id: expect.any(String),
        target: "notes/a.md",
      }),
    );
    expect(ui.status).toBeNull();
    expect(ui.statusKind).toBeNull();
  });

  test("a target whose name would gain a backslash is refused and sends nothing", async () => {
    // /api/open creates a path that is missing, so the typed name would be made.
    const open = vi.spyOn(api, "open").mockResolvedValue({ message: "queued" });
    tree.loadedDirs = { "": true };
    runOpen("p\\q.md");

    await vi.waitFor(() => expect(ui.status).toBe("open failed: \\ cannot be added to a name"));
    expect(ui.statusKind).toBe("persistent");
    expect(open).not.toHaveBeenCalled();
  });

  test("a target that names an entry whose name holds a backslash is sent", async () => {
    const open = vi.spyOn(api, "open").mockResolvedValue({ message: "queued" });
    tree.entries = [{ path: "a\\b.md", is_dir: false, mtime: null, size: 1 }];
    tree.loadedDirs = { "": true };
    runOpen("a\\b.md");

    await vi.waitFor(() => expect(open).toHaveBeenCalledWith({ window_id: expect.any(String), target: "a\\b.md" }));
    expect(ui.status).toBeNull();
  });
});

describe("where the backslash rule speaks for the launcher's Open", () => {
  const REFUSED = "open failed: \\ cannot be added to a name";
  const CLIMB_REFUSED = "open failed: .. cannot be used in a path that holds \\";

  /// The workspace this window is served from, by the root its server reports.
  function servedFrom(root: string): void {
    workspace.info = { root } as typeof workspace.info;
  }

  /// Run Open, wait until it has sent its request or said why it sent none,
  /// and answer both.
  async function opened(target: string): Promise<{ sent: string[]; told: string | null }> {
    const open = vi.spyOn(api, "open").mockResolvedValue({ message: "queued" });
    runOpen(target);
    await vi.waitFor(() => expect(open.mock.calls.length > 0 || ui.status !== null).toBe(true));
    return { sent: open.mock.calls.map(([request]) => request.target), told: ui.status };
  }

  test.each([
    ["a relative path in the server's spelling", "notes\\a.md"],
    ["an absolute path in the server's spelling", "C:\\ws\\notes\\a.md"],
  ])("on a Windows server %s is sent as typed", async (_name, target) => {
    servedFrom("C:\\ws");
    tree.loadedDirs = { "": true };

    expect(await opened(target)).toEqual({ sent: [target], told: null });
  });

  test("on a server whose root is a share, a path in its spelling is sent as typed", async () => {
    servedFrom("\\\\host\\share\\ws");
    tree.loadedDirs = { "": true };

    expect(await opened("notes\\a.md")).toEqual({ sent: ["notes\\a.md"], told: null });
  });

  test.each([
    ["its absolute path", "/abs/root/a\\b.md"],
    ["a path that opens with ./", "./a\\b.md"],
  ])("on a Unix server an entry whose name holds a backslash is opened by %s", async (_name, target) => {
    servedFrom("/abs/root");
    tree.entries = [{ path: "a\\b.md", is_dir: false, mtime: null, size: 1 }];
    tree.loadedDirs = { "": true };

    expect(await opened(target)).toEqual({ sent: [target], told: null });
  });

  test("on a Unix server an absolute path through an unlisted directory is judged once its parent is listed", async () => {
    servedFrom("/abs/root");
    tree.entries = [{ path: "deep", is_dir: true, mtime: null, size: 0 }];
    tree.loadedDirs = { "": true };
    const list = vi
      .spyOn(api, "list")
      .mockResolvedValue([{ path: "deep/x\\y", is_dir: true, mtime: null, size: 0 }]);

    const target = "/abs/root/deep/x\\y/new.md";
    expect(await opened(target)).toEqual({ sent: [target], told: null });
    expect(list.mock.calls).toEqual([["deep"]]);
  });

  test("on a Unix server an absolute path under the root whose name would gain a backslash is refused", async () => {
    servedFrom("/abs/root");
    tree.loadedDirs = { "": true };

    expect(await opened("/abs/root/p\\q.md")).toEqual({ sent: [], told: REFUSED });
  });

  test.each([
    ["an absolute path outside the root", "/elsewhere/a\\b.md"],
    ["an absolute path beside the root, with the root's name as a prefix", "/abs/rootless/a\\b.md"],
  ])("on a Unix server %s is the server's to judge, and is sent", async (_name, target) => {
    servedFrom("/abs/root");
    tree.loadedDirs = { "": true };

    expect(await opened(target)).toEqual({ sent: [target], told: null });
  });

  // /api/open resolves a `..` and creates what is missing, and the tree
  // cannot say what a path through one names.
  test.each([
    ["a relative path", "notes/../a\\b.md"],
    ["an absolute path under the root", "/abs/root/notes/../a\\b.md"],
    ["an absolute path that leaves the root in its text and returns", "/abs/root/../root/a\\b.md"],
    ["an absolute path that leaves the root in its text", "/abs/root/../elsewhere/a\\b.md"],
    ["a path whose backslash is in a directory before the ..", "x\\y/../a.md"],
  ])("on a Unix server a path that holds a backslash and a .. is refused and sends nothing: %s", async (_name, target) => {
    servedFrom("/abs/root");
    tree.loadedDirs = { "": true };

    expect(await opened(target)).toEqual({ sent: [], told: CLIMB_REFUSED });
    expect(ui.statusKind).toBe("persistent");
  });

  test("on a Unix server a path with a .. to an entry whose name holds a backslash is refused as well", async () => {
    servedFrom("/abs/root");
    tree.entries = [{ path: "a\\b.md", is_dir: false, mtime: null, size: 1 }];
    tree.loadedDirs = { "": true };

    expect(await opened("notes/../a\\b.md")).toEqual({ sent: [], told: CLIMB_REFUSED });
    expect(ui.statusKind).toBe("persistent");
  });

  // Guards: what the refusal of a path with a backslash and a `..` leaves as
  // it is.
  test("on a Unix server a path with a .. and no backslash is sent", async () => {
    servedFrom("/abs/root");
    tree.loadedDirs = { "": true };

    expect(await opened("notes/../a.md")).toEqual({ sent: ["notes/../a.md"], told: null });
  });

  test("on a Windows server a path with a .. in the server's spelling is sent as typed", async () => {
    servedFrom("C:\\ws");
    tree.loadedDirs = { "": true };

    expect(await opened("notes\\..\\a.md")).toEqual({ sent: ["notes\\..\\a.md"], told: null });
  });

  test("a graph link that holds a backslash and a .. is sent", async () => {
    servedFrom("/abs/root");
    tree.loadedDirs = { "": true };

    const link = "chan://graph?focus=notes/../a\\b.md";
    expect(await opened(link)).toEqual({ sent: [link], told: null });
  });

  test.each([
    ["a name that only contains two dots", "a..b\\c.md"],
    ["a .. between backslashes, which is one name", "notes\\..\\a.md"],
  ])("on a Unix server %s is the backslash rule's own to refuse", async (_name, target) => {
    servedFrom("/abs/root");
    tree.loadedDirs = { "": true };

    expect(await opened(target)).toEqual({ sent: [], told: REFUSED });
  });
});
