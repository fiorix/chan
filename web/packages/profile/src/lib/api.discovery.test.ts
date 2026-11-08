import { afterEach, expect, test, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

test("discovery reads the gateway's same-origin public endpoint", async () => {
  const body = { tunnel_url: "https://proxy.example.test/v1/tunnel" };
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetch);
  expect(api.discovery).toBeTypeOf("function");
  await expect(api.discovery()).resolves.toEqual(body);
  expect(fetch).toHaveBeenCalledExactlyOnceWith("/.well-known/chan-gateway", { credentials: "include" });
});
