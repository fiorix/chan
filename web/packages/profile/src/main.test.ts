// The mounted entry-point test proves installed listener wiring and a rendered notice. Source inspection establishes listener installation before mount.

import { flushSync } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

const load = vi.fn();

vi.mock("./state/me.svelte", () => ({
  meStore: {
    status: "anon",
    me: null,
    providers: [],
    error: null,
    load,
  },
}));

function reject(reason: unknown): void {
  // A settled promise keeps the event from raising a second, real rejection that Vitest would report against this file.
  window.dispatchEvent(
    new PromiseRejectionEvent("unhandledrejection", {
      promise: Promise.resolve() as Promise<unknown>,
      reason,
    }),
  );
  flushSync();
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("profile entry-point rejection boundary", () => {
  test("renders a rejected promise nobody handled as a visible notice", async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await import("./main");

    reject(new Error("profile refresh failed"));

    const notice = document.querySelector<HTMLElement>('#app [role="alert"]');
    expect(notice, "a visible error notice").not.toBeNull();
    expect(notice?.textContent).toContain("Unhandled error: profile refresh failed");
  });
});
