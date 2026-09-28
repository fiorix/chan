// @vitest-environment jsdom
//
// A sign-out the gateway refuses leaves the page signed in, so the page says
// the sign-out failed and why, rather than looking like a click that did
// nothing or naming an unhandled error.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";

const logout = vi.fn();

vi.mock("./state/me.svelte", () => ({
  meStore: {
    status: "loaded",
    me: { user: { username: "alex", email: "alex@example.com", avatar_url: null }, flags: {} },
    providers: [],
    error: null,
    load: vi.fn(async () => {}),
    logout: () => logout(),
  },
}));
vi.mock("./views/Profile.svelte", () => ({ default: () => {} }));

import App from "./App.svelte";

let view: Record<string, unknown> | null = null;

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

test("a refused sign-out says it failed", async () => {
  const refusal = Promise.reject(new Error("gateway unreachable"));
  // Handled here too, so a page that drops the rejection fails at the
  // assertion below and not as an unhandled rejection of the run.
  refusal.catch(() => {});
  logout.mockReturnValue(refusal);
  const target = document.body.appendChild(document.createElement("div"));
  view = mount(App, { target });
  flushSync();

  [...target.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Sign out")!.click();

  await vi.waitFor(() =>
    expect(target.querySelector('[role="alert"]')?.textContent ?? "").toContain("Sign out failed: gateway unreachable"),
  );
});
