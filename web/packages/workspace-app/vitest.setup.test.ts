// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

// A test that spies on `Storage.prototype` is watching the page's stores
// only while they are instances of the global `Storage`.
test.each(["localStorage", "sessionStorage"] as const)(
  "%s is the page's own Storage, so a spy on Storage.prototype sees its writes",
  (name) => {
    const storage = window[name];
    expect(Object.getPrototypeOf(storage), `${name} prototype`).toBe(
      Storage.prototype,
    );

    const write = vi.spyOn(Storage.prototype, "setItem");
    storage.setItem("probe", "1");

    expect(write, `${name} writes seen by the spy`).toHaveBeenCalledTimes(1);
    expect(storage.getItem("probe"), `${name} read back`).toBe("1");
  },
);
