// A rejected promise nobody handled must reach the notice ring and render.
// The bubble is mounted for real: a notice the user cannot see is the bug
// this handler exists to close.

import { describe, it, expect, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import NoticeBubbles from "../components/NoticeBubbles.svelte";
import { clearNotices, notices } from "./notices.svelte";
import { installUnhandledRejectionNotice } from "./unhandledRejection.svelte";

let target: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;
let uninstall: (() => void) | null = null;

function mountBubbles(): void {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(NoticeBubbles, { target });
}

function reject(reason: unknown): void {
  // A settled promise keeps the event from raising a second, real rejection
  // that vitest would report against this file.
  window.dispatchEvent(
    new PromiseRejectionEvent("unhandledrejection", {
      promise: Promise.resolve() as unknown as Promise<unknown>,
      reason,
    }),
  );
  flushSync();
}

afterEach(() => {
  uninstall?.();
  uninstall = null;
  if (app) unmount(app);
  target?.remove();
  target = null;
  app = null;
  clearNotices();
});

describe("launcher unhandled rejection", () => {
  it("renders a rejected promise nobody handled as a visible notice", () => {
    uninstall = installUnhandledRejectionNotice();
    mountBubbles();

    reject(new Error("token refresh failed"));

    expect(notices.items).toHaveLength(1);
    expect(notices.items[0]!.kind).toBe("error");
    expect(notices.items[0]!.message).toBe("Unhandled error: token refresh failed");
    expect(document.body.textContent).toContain("token refresh failed");
  });

  it("stringifies a reason that is not an Error rather than dropping it", () => {
    uninstall = installUnhandledRejectionNotice();
    mountBubbles();

    reject("gateway said no");

    expect(notices.items[0]!.message).toBe("Unhandled error: gateway said no");
    expect(document.body.textContent).toContain("gateway said no");
  });

  it("stops surfacing once uninstalled", () => {
    const stop = installUnhandledRejectionNotice();
    mountBubbles();
    stop();

    reject(new Error("after uninstall"));

    expect(notices.items, "the listener is gone, so nothing is raised").toHaveLength(0);
  });
});
