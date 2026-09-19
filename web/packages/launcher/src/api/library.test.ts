import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, liveApi, liveTerminalsCount } from "./library";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("liveApi.liveTerminalCount", () => {
  it("gets the encoded window count route and reads its count field", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ count: 2 }),
    });
    vi.stubGlobal("fetch", fetch);

    await expect(liveApi.liveTerminalCount("w/one")).resolves.toBe(2);
    expect(fetch).toHaveBeenCalledWith("/api/library/windows/w%2Fone/live-terminals", {
      method: "GET",
      headers: {},
      body: undefined,
    });
  });

  it("reports a missing count route as a 404 ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => "missing window",
      }),
    );

    await expect(liveApi.liveTerminalCount("missing")).rejects.toEqual(
      new ApiError(404, "missing window"),
    );
  });
});

describe("liveApi.setWorkspaceOn", () => {
  it("accepts the row the on route answers with", async () => {
    // `on` answers 200 carrying the workspace's row. The launcher re-lists
    // rather than reading it, so all this call owes the caller is to resolve.
    const row = {
      workspace_id: "ws-1",
      path: "/home/me/proj",
      label: "",
      on: true,
      status: "unavailable",
      error: "workspace root does not exist: /home/me/proj",
      library_id: "local",
      devserver_id: null,
      prefix: "ws-1",
    };
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => row });
    vi.stubGlobal("fetch", fetch);

    // Resolving IS the assertion: a body the caller does not read must not
    // become a parse failure on the way back.
    await liveApi.setWorkspaceOn("ws-1", true);
    expect(fetch).toHaveBeenCalledWith("/api/library/workspaces/ws-1/on", {
      method: "POST",
      headers: {},
      body: undefined,
    });
  });

  it("carries a plain-text refusal through as the error a person reads", async () => {
    // The workspace another Chan process holds: a plain-text 409, so the body
    // is already the sentence the banner shows.
    const locked = "workspace is open in another Chan process";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        statusText: "Conflict",
        text: async () => locked,
      }),
    );

    await expect(liveApi.setWorkspaceOn("ws-1", true)).rejects.toEqual(new ApiError(409, locked));
    await expect(liveApi.setWorkspaceOn("ws-1", true)).rejects.toThrow(locked);
  });
});

describe("ApiError", () => {
  it("reads an enveloped refusal as its message and keeps the raw body", () => {
    // Refusals mapped from a chan-workspace error arrive as
    // `{"error": "<reason>"}` (fd pressure on the on route is one); the reason
    // is what a person reads in the error bubble, the envelope is not.
    const reason = "workspace is under file-descriptor pressure";
    const e = new ApiError(503, JSON.stringify({ error: reason }));

    expect(e.message).toBe(reason);
    expect(e.body).toBe(JSON.stringify({ error: reason }));
  });

  it("leaves a plain-text body alone", () => {
    expect(new ApiError(409, "NO_DESKTOP").message).toBe("NO_DESKTOP");
    expect(new ApiError(500, "").message).toBe("HTTP 500");
  });

  it("still reads the live-terminals refusal off the raw body", () => {
    // The envelope reader must not cost the confirm-and-retry flow its shape:
    // that refusal carries a count beside its `error` tag.
    const live = new ApiError(
      409,
      JSON.stringify({ error: "live_terminals", active_terminals: 3 }),
    );
    expect(liveTerminalsCount(live)).toBe(3);
    expect(
      liveTerminalsCount(new ApiError(409, JSON.stringify({ error: "some other reason" }))),
    ).toBeNull();
    expect(liveTerminalsCount(new ApiError(409, "NO_DESKTOP"))).toBeNull();
  });
});
