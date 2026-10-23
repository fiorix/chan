// @vitest-environment jsdom

import { beforeEach, expect, test, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  window.history.replaceState(null, "", "/?w=w-test&h=client-holder");
  document.cookie = "__Host-devserver_csrf=; Max-Age=0; path=/; Secure";
});

test("an already detached request does not prepare a holder or dispatch", async () => {
  const transport = await import("./transport");
  const session = await import("./clientSession");
  window.history.replaceState(null, "", "/?w=w-test");
  sessionStorage.clear();
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  transport.setFetchImpl(fetch);
  session.markClientDetached();

  await expect(transport.chanFetch("/api/session?w=w-test", { method: "PUT" })).rejects.toThrow("client session detached");
  expect(sessionStorage.getItem("chan-client-holder")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

test.each([false, true])("a cold CSRF read respects detached=%s", async (detach) => {
  const transport = await import("./transport");
  const session = await import("./clientSession");
  let release!: (token: string | null) => void;
  transport.setGatewayCsrfTokenReader(() => new Promise((resolve) => { release = resolve; }));
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  transport.setFetchImpl(fetch);

  const request = transport.chanFetch("/api/session?w=w-test", { method: "PUT" });
  expect(fetch).not.toHaveBeenCalled();
  if (detach) session.markClientDetached();
  release("fresh-csrf");

  if (detach) await expect(request).rejects.toThrow("client session detached");
  else await expect(request).resolves.toHaveProperty("status", 204);
  expect(fetch).toHaveBeenCalledTimes(detach ? 0 : 1);
});

test("resume still dispatches when detachment arrives during CSRF hydration", async () => {
  const transport = await import("./transport");
  const session = await import("./clientSession");
  let release!: (token: string | null) => void;
  transport.setGatewayCsrfTokenReader(() => new Promise((resolve) => { release = resolve; }));
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  transport.setFetchImpl(fetch);

  const request = transport.chanFetch("/api/session/resume", { method: "POST" });
  session.markClientDetached();
  release("fresh-csrf");

  await expect(request).resolves.toHaveProperty("status", 204);
  expect(fetch).toHaveBeenCalledOnce();
});

test.each([false, true])("a desktop 403 retry respects detached=%s", async (detach) => {
  const transport = await import("./transport");
  const session = await import("./clientSession");
  let release!: (token: string | null) => void;
  const readToken = vi.fn<() => Promise<string | null>>()
    .mockResolvedValueOnce("first-csrf")
    .mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  transport.setGatewayCsrfTokenReader(readToken);
  await transport.gatewayCsrfHeaderPairs("PUT");
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 403 }))
    .mockResolvedValue(new Response(null, { status: 204 }));
  transport.setFetchImpl(fetch);

  const request = transport.chanFetch("/api/session?w=w-test", { method: "PUT" });
  expect(fetch).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  expect(readToken).toHaveBeenCalledTimes(2);
  if (detach) session.markClientDetached();
  release("second-csrf");

  if (detach) await expect(request).rejects.toThrow("client session detached");
  else await expect(request).resolves.toHaveProperty("status", 204);
  expect(fetch).toHaveBeenCalledTimes(detach ? 1 : 2);
});
