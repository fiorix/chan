// @vitest-environment jsdom
//
// Two pages can share a window id: a duplicated tab copies sessionStorage, and
// a `?w=` URL opened twice names the same window. Each page's transfer counter
// starts at 1, so the ids the two pages mint are told apart by each page's
// client nonce. Each page is a fresh load of the modules.

import { afterEach, describe, expect, test, vi } from "vitest";

async function loadPage(): Promise<{
  client: typeof import("../api/client");
  transfers: typeof import("./transfers.svelte");
}> {
  vi.resetModules();
  const client = await import("../api/client");
  const transfers = await import("./transfers.svelte");
  return { client, transfers };
}

afterEach(() => {
  window.sessionStorage.clear();
  vi.resetModules();
});

describe("transfer ids across pages", () => {
  test("two pages with the same window id mint distinct ids", async () => {
    const first = await loadPage();
    const second = await loadPage();
    expect(second.client.sessionWindowId()).toBe(first.client.sessionWindowId());

    const a = first.transfers.beginTransfer({ kind: "upload", filename: "a.bin", cancel: null });
    const b = second.transfers.beginTransfer({ kind: "upload", filename: "b.bin", cancel: null });
    expect(a).not.toBe(b);
  });
});
