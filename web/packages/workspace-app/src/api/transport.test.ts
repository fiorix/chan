// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  chanFetch,
  gatewayCsrfHeaderPairs,
  setFetchImpl,
  setGatewayCsrfTokenReader,
} from "./transport";

afterEach(() => {
  setFetchImpl(null);
  setGatewayCsrfTokenReader(null);
  // `Secure` is required: the `__Host-` prefix mandates it, and jsdom's cookie
  // jar rejects a `__Host-` cookie set without it, so the read would see nothing.
  document.cookie = "__Host-devserver_csrf=; Max-Age=0; path=/; Secure";
});

describe("gateway CSRF", () => {
  test("prefers the desktop token over the readable cookie", async () => {
    document.cookie = "__Host-devserver_csrf=cookie-token; path=/; Secure";
    setGatewayCsrfTokenReader(async () => "desktop-token");
    let seen: RequestInit | undefined;
    setFetchImpl(async (_input, init) => {
      seen = init;
      return new Response("", { status: 200 });
    });

    await chanFetch("/api/session?w=w-test", { method: "PUT" });

    expect((seen?.headers as Record<string, string>)["x-chan-csrf"]).toBe(
      "desktop-token",
    );
  });

  test("hydrates once on registration and dispatches steady-state fetch synchronously", async () => {
    const readToken = vi.fn(async () => "desktop-token");
    setGatewayCsrfTokenReader(readToken);
    expect(readToken).toHaveBeenCalledTimes(1);
    await expect(gatewayCsrfHeaderPairs("POST")).resolves.toEqual([
      ["x-chan-csrf", "desktop-token"],
    ]);

    let seen: RequestInit | undefined;
    const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
      seen = init;
      return new Response("", { status: 200 });
    });
    setFetchImpl(fetch);

    const request = chanFetch("/api/session?w=w-test", { method: "PUT" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((seen?.headers as Record<string, string>)["x-chan-csrf"]).toBe(
      "desktop-token",
    );
    await request;
    expect(readToken).toHaveBeenCalledTimes(1);
  });

  test("defers only a cold request that races eager desktop hydration", async () => {
    let resolveToken!: (csrf: string | null) => void;
    setGatewayCsrfTokenReader(
      vi.fn(
        () =>
          new Promise<string | null>((resolve) => {
            resolveToken = resolve;
          }),
      ),
    );
    const fetch = vi.fn(async () => new Response("", { status: 200 }));
    setFetchImpl(fetch);

    const request = chanFetch("/api/session?w=w-test", { method: "PUT" });
    expect(fetch).not.toHaveBeenCalled();
    resolveToken("desktop-token");
    await request;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("falls back from an unavailable desktop token to the readable cookie", async () => {
    document.cookie = "__Host-devserver_csrf=cookie-token; path=/; Secure";
    setGatewayCsrfTokenReader(async () => null);

    await expect(gatewayCsrfHeaderPairs("POST")).resolves.toEqual([
      ["x-chan-csrf", "cookie-token"],
    ]);

    setGatewayCsrfTokenReader(async () => {
      throw new Error("invoke denied");
    });
    await expect(gatewayCsrfHeaderPairs("POST")).resolves.toEqual([
      ["x-chan-csrf", "cookie-token"],
    ]);
  });

  test("re-reads the desktop token and retries one 403 exactly once", async () => {
    const readToken = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce("csrf-old")
      .mockResolvedValue("csrf-fresh");
    setGatewayCsrfTokenReader(readToken);
    const seen: string[] = [];
    setFetchImpl(async (_input, init) => {
      seen.push((init?.headers as Record<string, string>)["x-chan-csrf"]);
      return new Response("forbidden", { status: 403 });
    });

    const response = await chanFetch("/api/session?w=w-test", { method: "PUT" });

    expect(response.status).toBe(403);
    expect(readToken).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["csrf-old", "csrf-fresh"]);
  });

  test("stores the refreshed token for the next synchronous request", async () => {
    const readToken = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce("csrf-old")
      .mockResolvedValue("csrf-fresh");
    setGatewayCsrfTokenReader(readToken);
    const seen: string[] = [];
    let attempts = 0;
    const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string>)["x-chan-csrf"]);
      attempts += 1;
      return new Response("", { status: attempts === 1 ? 403 : 200 });
    });
    setFetchImpl(fetch);

    await chanFetch("/api/session?w=w-test", { method: "PUT" });
    expect(readToken).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["csrf-old", "csrf-fresh"]);

    const next = chanFetch("/api/session?w=w-test", { method: "PUT" });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(seen).toEqual(["csrf-old", "csrf-fresh", "csrf-fresh"]);
    await next;
    expect(readToken).toHaveBeenCalledTimes(2);
  });

  test("does not retry a browser cookie 403", async () => {
    document.cookie = "__Host-devserver_csrf=cookie-token; path=/; Secure";
    const fetch = vi.fn(async () => new Response("forbidden", { status: 403 }));
    setFetchImpl(fetch);

    const response = await chanFetch("/api/session?w=w-test", { method: "PUT" });

    expect(response.status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("chanFetch mirrors the readable gateway csrf cookie on unsafe requests", async () => {
    document.cookie = "__Host-devserver_csrf=csrf-token; path=/; Secure";
    let seen: RequestInit | undefined;
    setFetchImpl(async (_input, init) => {
      seen = init;
      return new Response("", { status: 200 });
    });

    const request = chanFetch("/api/session?w=w-test", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    const headers = seen?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-chan-csrf"]).toBe("csrf-token");
    await request;
  });

  test("chanFetch leaves safe requests without the csrf mirror", async () => {
    document.cookie = "__Host-devserver_csrf=csrf-token; path=/; Secure";
    let seen: RequestInit | undefined;
    setFetchImpl(async (_input, init) => {
      seen = init;
      return new Response("", { status: 200 });
    });

    await chanFetch("/api/session?w=w-test", {
      method: "GET",
      headers: { authorization: "Bearer tok" },
    });

    const headers = seen?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
    expect(headers["x-chan-csrf"]).toBeUndefined();
  });
});

describe("gatewayCsrfHeaderPairs", () => {
  test("carries the cookie mirror for unsafe methods only", async () => {
    document.cookie = "__Host-devserver_csrf=csrf-token; path=/; Secure";

    await expect(gatewayCsrfHeaderPairs("POST")).resolves.toEqual([
      ["x-chan-csrf", "csrf-token"],
    ]);
    await expect(gatewayCsrfHeaderPairs("delete")).resolves.toEqual([
      ["x-chan-csrf", "csrf-token"],
    ]);
    await expect(gatewayCsrfHeaderPairs("GET")).resolves.toEqual([]);
  });

  test("is empty without a desktop token or cookie (loopback)", async () => {
    await expect(gatewayCsrfHeaderPairs("POST")).resolves.toEqual([]);
  });
});
