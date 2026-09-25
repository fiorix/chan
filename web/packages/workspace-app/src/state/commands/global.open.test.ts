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
import { ui } from "../store.svelte";
import "./global";

afterEach(() => {
  vi.restoreAllMocks();
  ui.status = null;
  ui.statusKind = null;
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
});
