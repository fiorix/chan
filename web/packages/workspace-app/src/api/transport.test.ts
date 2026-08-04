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

    await chanFetch("/api/session?w=w-test", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    const headers = seen?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-chan-csrf"]).toBe("csrf-token");
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
