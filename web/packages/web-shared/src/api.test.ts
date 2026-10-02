// Profile views render errors by message truthiness, so blank bodies and
// empty service messages need a status-code fallback. HTTP/2 supplies the
// status code even when the reason phrase is empty.

import { afterEach, describe, expect, test, vi } from "vitest";

import { HttpError, request } from "./api";

function respondWith(
  status: number,
  body: string,
  contentType: string | null,
  statusText = "",
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(body, {
          status,
          statusText,
          headers: contentType ? { "content-type": contentType } : {},
        }),
    ),
  );
}

async function failureFrom(call: Promise<unknown>): Promise<HttpError> {
  try {
    await call;
  } catch (err) {
    return err as HttpError;
  }
  throw new Error("expected the request to fail");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a failed request", () => {
  test("names the status when the error body is empty", async () => {
    // A bare 502 from a proxy: no body, and no reason phrase over h2.
    respondWith(502, "", null);

    const err = await failureFrom(request("/api/thing"));

    expect(err.status).toBe(502);
    expect(err.message).toBe("HTTP 502");
  });

  test("names the status when the service sends an empty error string", async () => {
    respondWith(500, JSON.stringify({ error: "" }), "application/json");

    const err = await failureFrom(request("/api/thing"));

    expect(err.status).toBe(500);
    expect(err.message).toBe("HTTP 500");
  });

  test("names the status when the body is only whitespace", async () => {
    respondWith(503, "   \n", "text/plain");

    const err = await failureFrom(request("/api/thing"));

    expect(err.message).toBe("HTTP 503");
  });

  test("keeps the service's own message when there is one", async () => {
    respondWith(
      403,
      JSON.stringify({ error: "no such credential" }),
      "application/json",
    );

    const err = await failureFrom(request("/api/thing"));

    expect(err.status).toBe(403);
    expect(err.message).toBe("no such credential");
  });

  test("keeps a plain-text error body", async () => {
    respondWith(400, "bad request shape", "text/plain");

    const err = await failureFrom(request("/api/thing"));

    expect(err.message).toBe("bad request shape");
  });

  test("never falls back to statusText, which h2 leaves empty", async () => {
  // The status code gives the same fallback on HTTP/1 and HTTP/2.
    respondWith(418, "", null, "I'm a teapot");

    const err = await failureFrom(request("/api/thing"));

    expect(err.message).toBe("HTTP 418");
  });
});
