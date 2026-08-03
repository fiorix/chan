// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "./errors";

const transport = vi.hoisted(() => ({ requestRoot: vi.fn() }));

vi.mock("./transport", () => ({ requestRoot: transport.requestRoot }));
vi.mock("./client", () => ({ sessionWindowId: () => "window-live-1" }));

import {
  loadScopedLibrarySnapshot,
  resetScopedLibraryCapability,
  runScopedLibraryAction,
} from "./libraryCommand";

const snapshot = {
  library_id: "lib-test",
  role: "owner",
  window_mode: "browser",
  windows: [],
  workspaces: [],
};

beforeEach(() => {
  document.head.innerHTML = '<meta name="chan-prefix" content="/project-a">';
  sessionStorage.clear();
  resetScopedLibraryCapability();
  transport.requestRoot.mockReset();
});

describe("scoped library command client", () => {
  test("mints from this tenant/window and keeps the capability out of storage", async () => {
    transport.requestRoot
      .mockResolvedValueOnce({ token: "cap-secret", role: "owner", expires_in_seconds: 300 })
      .mockResolvedValueOnce(snapshot);

    await expect(loadScopedLibrarySnapshot()).resolves.toEqual(snapshot);
    expect(transport.requestRoot).toHaveBeenNthCalledWith(
      1,
      "POST",
      "/api/library/command-capabilities",
      { window_id: "window-live-1", tenant_prefix: "/project-a" },
    );
    expect(transport.requestRoot).toHaveBeenNthCalledWith(
      2,
      "GET",
      "/api/library/command-capabilities/cap-secret",
    );
    expect(sessionStorage.length).toBe(0);
  });

  test("remints once after the server revokes a stale capability", async () => {
    transport.requestRoot
      .mockResolvedValueOnce({ token: "cap-old", role: "owner", expires_in_seconds: 300 })
      .mockRejectedValueOnce(new ApiError(410, "source window is gone"))
      .mockResolvedValueOnce({ token: "cap-new", role: "owner", expires_in_seconds: 300 })
      .mockResolvedValueOnce(snapshot);

    await expect(loadScopedLibrarySnapshot()).resolves.toEqual(snapshot);
    expect(transport.requestRoot).toHaveBeenNthCalledWith(
      4,
      "GET",
      "/api/library/command-capabilities/cap-new",
    );
  });

  test("executes only through the capability action route", async () => {
    transport.requestRoot
      .mockResolvedValueOnce({ token: "cap-action", role: "owner", expires_in_seconds: 300 })
      .mockResolvedValueOnce(undefined);

    await runScopedLibraryAction({
      action: "set_window_visibility",
      window_id: "window-2",
      hidden: true,
    });
    expect(transport.requestRoot).toHaveBeenNthCalledWith(
      2,
      "POST",
      "/api/library/command-capabilities/cap-action/actions",
      { action: "set_window_visibility", window_id: "window-2", hidden: true },
    );
  });
});
