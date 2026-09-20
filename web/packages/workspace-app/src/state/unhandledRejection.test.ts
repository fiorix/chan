// A rejected promise nobody handled must reach the status bar and render.
// AppStatusBar is mounted for real: a notice the user cannot see is the bug
// this handler exists to close.
//
// Importing the store registers the notify() handler that maps the bus onto
// ui.status, which is the wiring the entry point relies on at boot.

import { describe, it, expect, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import AppStatusBar from "../components/AppStatusBar.svelte";
import { ui } from "./store.svelte";
import { installUnhandledRejectionNotice } from "./unhandledRejection.svelte";

let target: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;
let uninstall: (() => void) | null = null;

function mountStatusBar(): void {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(AppStatusBar, { target });
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
  ui.status = "";
});

describe("workspace-app unhandled rejection", () => {
  it("renders a rejected promise nobody handled as a visible notice", () => {
    uninstall = installUnhandledRejectionNotice();
    mountStatusBar();

    reject(new Error("workspace save failed"));

    expect(ui.status).toBe("Unhandled error: workspace save failed");
    expect(document.body.textContent).toContain("workspace save failed");
  });

  it("stringifies a reason that is not an Error rather than dropping it", () => {
    uninstall = installUnhandledRejectionNotice();
    mountStatusBar();

    reject("server said no");

    expect(ui.status).toBe("Unhandled error: server said no");
    expect(document.body.textContent).toContain("server said no");
  });

  it("stops surfacing once uninstalled", () => {
    const stop = installUnhandledRejectionNotice();
    mountStatusBar();
    stop();

    reject(new Error("after uninstall"));

    expect(ui.status, "the listener is gone, so nothing is raised").toBe("");
  });
});
