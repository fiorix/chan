// @vitest-environment jsdom

import { expect, test } from "vitest";

// Global storage must be the page's store so Storage.prototype spies see its calls.
test.each(["localStorage", "sessionStorage"] as const)(
  "%s is the page's own Storage",
  (name) => {
    const page = (globalThis as { jsdom?: { window: Window } }).jsdom?.window;
    if (!page) throw new Error("vitest did not expose the jsdom page");

    expect(globalThis[name] === page[name], `${name} is the jsdom page store`).toBe(true);
    expect(globalThis[name] instanceof Storage, `${name} is an instance of the global Storage`).toBe(true);
  },
);
