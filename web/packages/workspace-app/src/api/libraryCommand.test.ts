// @vitest-environment jsdom

import type { WindowPageCheck } from "@chan/web-shared/window-page";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "./errors";

const transport = vi.hoisted(() => ({ requestRoot: vi.fn() }));

vi.mock("./transport", async (importOriginal) => ({
  ...await importOriginal<typeof import("./transport")>(),
  requestRoot: transport.requestRoot,
}));
vi.mock("./client", () => ({ sessionWindowId: () => "window-live-1" }));

import * as libraryCommand from "./libraryCommand";
import { setFetchImpl } from "./transport";

import {
  loadScopedLibrarySnapshot,
  loadScopedWindowLiveTerminals,
  resetScopedLibraryCapability,
  runScopedLibraryAction,
} from "./libraryCommand";

const snapshot = {
  library_id: "lib-test",
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
      .mockResolvedValueOnce({ token: "cap-secret", expires_in_seconds: 300 })
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

  test("reads a window's live terminal count under the same capability", async () => {
    transport.requestRoot
      .mockResolvedValueOnce({ token: "cap-secret", expires_in_seconds: 300 })
      .mockResolvedValueOnce({ count: 2 });

    // The window id rides a path segment, so it is encoded rather than
    // interpolated raw.
    await expect(loadScopedWindowLiveTerminals("w one")).resolves.toBe(2);
    expect(transport.requestRoot).toHaveBeenNthCalledWith(
      2,
      "GET",
      "/api/library/command-capabilities/cap-secret/windows/w%20one/live-terminals",
    );
  });

  test("remints once after the server revokes a stale capability", async () => {
    transport.requestRoot
      .mockResolvedValueOnce({ token: "cap-old", expires_in_seconds: 300 })
      .mockRejectedValueOnce(new ApiError(410, "source window is gone"))
      .mockResolvedValueOnce({ token: "cap-new", expires_in_seconds: 300 })
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
      .mockResolvedValueOnce({ token: "cap-action", expires_in_seconds: 300 })
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

afterEach(() => {
  setFetchImpl(null);
  vi.restoreAllMocks();
});

function pageCheck(): WindowPageCheck {
  const check = Reflect.get(libraryCommand, "checkScopedWindowPage");
  expect(check).toBeTypeOf("function");
  return check as WindowPageCheck;
}

const launchPath = "/api/library/command-capabilities/cap/windows/w-other/launch";

describe("capability page check", () => {
  test("follows the launch redirect with one uncached abortable GET", async () => {
    const response = new Response("<html>window</html>");
    const fetch = vi.fn(async () => response);
    setFetchImpl(fetch);
    const controller = new AbortController();

    const result = await pageCheck()(launchPath, controller.signal);

    expect(fetch).toHaveBeenCalledExactlyOnceWith(launchPath, {
      method: "GET", cache: "no-store", redirect: "follow", signal: controller.signal,
    });
    expect(result.response).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(transport.requestRoot).not.toHaveBeenCalled();
  });

  test.each([
    [401, "invalid or expired library command capability"],
    [410, "the invoking window is no longer live"],
    [409, "window tenant is not running"],
    [404, "window not found"],
  ] as const)("reads the %i envelope once without minting again", async (status, message) => {
    const body = JSON.stringify({ error: message });
    const response = new Response(body, { status });
    const read = vi.spyOn(response, "text");
    const parse = vi.spyOn(JSON, "parse");
    const fetch = vi.fn(async () => response);
    setFetchImpl(fetch);

    const result = await pageCheck()(launchPath, new AbortController().signal);
    expect(read).not.toHaveBeenCalled();
    expect(await result.readRefusal()).toMatchObject({ status, message, data: { error: message } });
    expect(read).toHaveBeenCalledTimes(1);
    expect(parse.mock.calls.filter(([text]) => text === body)).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(transport.requestRoot).not.toHaveBeenCalled();
  });

  test("retains the redirected gate's Retry-After and sentence", async () => {
    const response = new Response('{"error":"devserver is restoring terminal sessions"}', {
      status: 503, headers: { "Retry-After": "3" },
    });
    setFetchImpl(async () => response);

    const result = await pageCheck()(launchPath, new AbortController().signal);

    expect(result.response.status).toBe(503);
    expect(result.response.headers.get("Retry-After")).toBe("3");
    expect(await result.readRefusal()).toMatchObject({
      status: 503, message: "devserver is restoring terminal sessions",
    });
  });
});
