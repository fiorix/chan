// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/?w=search-details-test");
});
afterEach(() => vi.restoreAllMocks());

test("Search defaults to Details open", async () => {
  const { searchPanel } = await import("./store.svelte");
  expect(searchPanel.inspectorOpen).toBe(true);
});

test.each([false, true])("Search retains Details=%s across reload while Search is closed", async (open) => {
  const first = await import("./store.svelte");
  first.searchPanel.open = false;
  first.searchPanel.inspectorOpen = open;
  first.persistStateToHash();
  expect(new URLSearchParams(location.hash.slice(1)).has("search")).toBe(false);
  vi.resetModules();
  const restored = await import("./store.svelte");
  expect(restored.searchPanel.inspectorOpen).toBe(open);
});

test("an explicit Search URL overrides the remembered Details choice", async () => {
  const first = await import("./store.svelte");
  first.searchPanel.inspectorOpen = false;
  first.persistStateToHash();
  vi.resetModules();
  window.history.replaceState({}, "", "/?w=search-details-test#search=1:query");
  const restored = await import("./store.svelte");
  restored.__testApplyOverlaysFromHash();
  expect(restored.searchPanel).toMatchObject({ open: true, inspectorOpen: true, query: "query" });
});

test("another window starts with its own Details choice", async () => {
  const first = await import("./store.svelte");
  first.searchPanel.inspectorOpen = false;
  first.persistStateToHash();
  vi.resetModules();
  window.history.replaceState({}, "", "/?w=other-window");
  const restored = await import("./store.svelte");
  expect(restored.searchPanel.inspectorOpen).toBe(true);
});

test("unavailable storage keeps the default and the open overlay's URL state", async () => {
  const getItem = Storage.prototype.getItem;
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
    if (key.startsWith("chan.search-details:")) throw new Error("unavailable");
    return getItem.call(this, key);
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (key.startsWith("chan.search-details:")) throw new Error("unavailable");
    setItem.call(this, key, value);
  });
  const store = await import("./store.svelte");
  expect(store.searchPanel.inspectorOpen).toBe(true);
  store.searchPanel.open = true;
  store.searchPanel.inspectorOpen = false;
  store.persistStateToHash();
  expect(new URLSearchParams(location.hash.slice(1)).get("search")).toBe("0:");
});
