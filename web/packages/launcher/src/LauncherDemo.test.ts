// Component test: the marketing demo shell. The empty variant stamps first-run
// hint flags on the frame as data attributes (the embedding page positions its
// callout bubbles off them, outside the mock window), tracking live library
// state; the populated variant stamps nothing.

import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, unmount, flushSync, tick } from "svelte";
import LauncherDemo from "./LauncherDemo.svelte";
import { library } from "./state/library.svelte";
import { closeDialog } from "./state/dialog.svelte";
import { clearNotices, pushLocalError } from "./state/notices.svelte";
import type { WindowRecord, WorkspaceEntry } from "./api/library";

let target: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;

function mountDemo(props: Record<string, unknown>): void {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(LauncherDemo, { target, props });
}

function frame(): HTMLElement {
  return target!.querySelector(".launcher-demo-frame") as HTMLElement;
}

function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  if (app) unmount(app);
  clearNotices();
  target?.remove();
  target = null;
  app = null;
});

const termWindow: WindowRecord = {
  window_id: "w-hint-term",
  library_id: "local",
  kind: "terminal",
  title: "🏠 Terminal Window 1",
  ordinal: 1,
  workspace_path: null,
  prefix: "t/hint-1",
  token: "tok_hint",
  persisted: true,
  connected: true,
  active_transfer: false,
  control: false,
};

const localWorkspace: WorkspaceEntry = {
  workspace_id: "ws-hint",
  path: "/Users/you/dev/your-project",
  label: "",
  on: true,
  status: "running",
  library_id: "local",
  devserver_id: null,
  prefix: "ws-hint",
};

describe("LauncherDemo hint attributes", () => {
  it("stamps both hints on the empty variant and clears each with live state", async () => {
    mountDemo({ variant: "empty", hints: true });
    await settle();
    expect(frame().getAttribute("data-hint-terminal")).toBe("true");
    expect(frame().getAttribute("data-hint-workspace")).toBe("true");

    library.windows = [...library.windows, termWindow];
    flushSync();
    expect(frame().getAttribute("data-hint-terminal")).toBeNull();
    expect(frame().getAttribute("data-hint-workspace")).toBe("true");

    library.workspaces = [...library.workspaces, localWorkspace];
    flushSync();
    expect(frame().getAttribute("data-hint-workspace")).toBeNull();

    // Discarding everything brings both back.
    library.windows = library.windows.filter((w) => w.window_id !== termWindow.window_id);
    library.workspaces = library.workspaces.filter(
      (w) => w.workspace_id !== localWorkspace.workspace_id,
    );
    flushSync();
    expect(frame().getAttribute("data-hint-terminal")).toBe("true");
    expect(frame().getAttribute("data-hint-workspace")).toBe("true");
  });

  it("stamps nothing without the hints prop (the home hero)", async () => {
    mountDemo({});
    await settle();
    expect(frame().getAttribute("data-hint-terminal")).toBeNull();
    expect(frame().getAttribute("data-hint-workspace")).toBeNull();
  });
});

it("opens the Devserver demo without taking focus from the reader", async () => {
  const origin = document.createElement("button");
  document.body.append(origin);
  try {
    origin.focus();
    mountDemo({ variant: "devserver" });
    await vi.waitFor(() => expect(target!.querySelector('[role="dialog"]')).not.toBeNull());
    expect(document.activeElement).toBe(origin);
    target!.querySelector<HTMLButtonElement>(".modal-close")!.click();
    flushSync();
    const reopen = target!.querySelector<HTMLButtonElement>(".add-devserver")!;
    expect(reopen).not.toBeNull();
    reopen.click();
    flushSync();
    expect(document.activeElement).toBe(target!.querySelector('[role="dialog"]'));
  } finally {
    closeDialog();
    origin.remove();
  }
});

it("keeps launcher controls inert while the Devserver dialog is open", async () => {
  // jsdom has no inert semantics; reflect it and block focus into the inert surface for this boundary test.
  const inertDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "inert");
  const nativeFocus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (options?: FocusOptions) {
    if (!this.closest("[inert]")) nativeFocus.call(this, options);
  };
  Object.defineProperty(HTMLElement.prototype, "inert", {
    configurable: true,
    get(this: HTMLElement) { return this.hasAttribute("inert"); },
    set(this: HTMLElement, value: boolean) {
      this.toggleAttribute("inert", Boolean(value));
      if (value && this.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    },
  });
  try {
    mountDemo({ variant: "devserver" });
    await vi.waitFor(() => expect(target!.querySelector('[role="dialog"]')).not.toBeNull());

    const selectors = [
      '[aria-label="Show gateways"]',
      '[aria-label="Open command launcher"]',
      '[aria-label="Select"]',
      '[aria-label="Collapse windows of This machine"]',
      '[aria-label="New local terminal"]',
      '[aria-label="New local workspace"]',
      '.add-devserver',
    ];
    const surface = target!.querySelector<HTMLElement>(".launcher-surface")!;
    for (const selector of selectors) {
      const control = target!.querySelector(selector);
      expect(control, selector).not.toBeNull();
      expect(control!.closest("[inert]"), selector).toBe(surface);
    }
    expect(surface.hasAttribute("inert")).toBe(true);
    expect(target!.querySelector(".modal-close")!.closest("[inert]")).toBeNull();

    pushLocalError("A notice while the dialog is open");
    flushSync();
    const notice = target!.querySelector('[role="alert"]')!;
    expect(notice.closest("[inert]")).toBeNull();

    target!.querySelector<HTMLButtonElement>(".modal-close")!.click();
    flushSync();
    expect(surface.hasAttribute("inert")).toBe(false);
    for (const selector of selectors) expect(target!.querySelector(selector)).not.toBeNull();

    const opener = target!.querySelector<HTMLButtonElement>(".add-devserver")!;
    opener.focus();
    opener.click();
    flushSync();
    expect(surface.hasAttribute("inert")).toBe(true);
    expect(target!.querySelector('[role="dialog"]')).not.toBeNull();
    target!.querySelector<HTMLButtonElement>(".modal-close")!.click();
    flushSync();
    await tick();
    await tick();
    expect(document.activeElement).toBe(opener);
  } finally {
    closeDialog();
    HTMLElement.prototype.focus = nativeFocus;
    if (inertDescriptor) Object.defineProperty(HTMLElement.prototype, "inert", inertDescriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, "inert");
  }
});
