// Component test: the marketing demo shell. The empty variant stamps first-run
// hint flags on the frame as data attributes (the embedding page positions its
// callout bubbles off them, outside the mock window), tracking live library
// state; the populated variant stamps nothing.

import { describe, it, expect, afterEach, vi } from "vitest";
import demoSource from "./LauncherDemo.svelte?raw";
import { mount, unmount, flushSync, tick } from "svelte";
import LauncherDemo from "./LauncherDemo.svelte";
import { library } from "./state/library.svelte";
import { closeDialog } from "./state/dialog.svelte";
import { resetDeck } from "./state/deck.svelte";
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
  resetDeck();
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
    expect(frame().querySelector(".plasma-background")).toBeNull();
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

function activeSlot(): HTMLElement | null {
  return target!.querySelector<HTMLElement>(".slot.active");
}

it("opens the Devserver demo on the Add devserver card turned over, without taking focus", async () => {
  const origin = document.createElement("button");
  document.body.append(origin);
  try {
    origin.focus();
    mountDemo({ variant: "devserver" });
    await vi.waitFor(() => expect(target!.querySelector(".add-deck-card .devserver-form")).not.toBeNull());
    expect(activeSlot()?.dataset.key).toBe("add-devserver");
    expect(activeSlot()!.querySelector(".devserver-form")).not.toBeNull();
    expect(target!.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(origin);

    // Cancel turns the card back to its button, and the button turns it over again.
    const cancel = [...activeSlot()!.querySelectorAll<HTMLButtonElement>(".devserver-form button")]
      .find((b) => b.textContent?.trim() === "Cancel")!;
    cancel.click();
    flushSync();
    await tick();
    expect(target!.querySelector(".devserver-form")).toBeNull();
    const add = activeSlot()!.querySelector<HTMLButtonElement>(".add-devserver")!;
    expect(add).not.toBeNull();
    add.click();
    flushSync();
    await tick();
    expect(activeSlot()!.querySelector(".devserver-form")).not.toBeNull();
  } finally {
    origin.remove();
  }
});

it("brings the added devserver's card to the front of the Devserver demo", async () => {
  mountDemo({ variant: "devserver" });
  await vi.waitFor(() => expect(target!.querySelector(".add-deck-card .devserver-form")).not.toBeNull());
  const [name, address] = activeSlot()!.querySelectorAll<HTMLInputElement>(".devserver-form input[type=text]");
  name.value = "demo-box";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  address.value = "127.0.0.1:9911";
  address.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  const submit = [...activeSlot()!.querySelectorAll<HTMLButtonElement>(".devserver-form button")]
    .find((b) => b.textContent?.trim() === "Add devserver")!;
  submit.click();
  await vi.waitFor(() => expect(activeSlot()?.dataset.key).not.toBe("add-devserver"));
  expect(activeSlot()!.getAttribute("aria-label")).toMatch(/^demo-box,/);
  expect(target!.querySelector(".devserver-form")).toBeNull();
});

it("keeps launcher controls inert while a dialog is open over the Devserver demo", async () => {
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
    await vi.waitFor(() => expect(target!.querySelector(".add-deck-card .devserver-form")).not.toBeNull());
    const surface = target!.querySelector<HTMLElement>(".launcher-surface")!;
    expect(surface.hasAttribute("inert")).toBe(false);

    target!.querySelector<HTMLButtonElement>('.dot[title="This machine"]')!.click();
    flushSync();
    await tick();
    const opener = target!.querySelector<HTMLButtonElement>('[aria-label="New local workspace"]')!;
    opener.focus();
    opener.click();
    flushSync();
    expect(target!.querySelector('[role="dialog"]')).not.toBeNull();

    const selectors = [
      '[aria-label="Show gateways"]',
      '[aria-label="Open command launcher"]',
      '[aria-label="Select"]',
      '[aria-label="New local terminal"]',
      '[aria-label="New local workspace"]',
    ];
    for (const selector of selectors) {
      const control = target!.querySelector(selector);
      expect(control, selector).not.toBeNull();
      expect(control!.closest("[inert]"), selector).not.toBeNull();
      expect(control!.closest(".launcher-surface"), selector).toBe(surface);
    }
    // The Add devserver card, turned to the side still showing its form, sits
    // inside the dialog's inert surface too.
    const addCard = target!.querySelector(".add-deck-card .devserver-form")!;
    expect(addCard.closest(".launcher-surface")).toBe(surface);
    expect(surface.hasAttribute("inert")).toBe(true);
    expect(target!.querySelector(".modal-close")!.closest("[inert]")).toBeNull();

    pushLocalError("A notice while the dialog is open");
    flushSync();
    const notice = target!.querySelector('[role="alert"]')!;
    expect(notice.closest("[inert]")).toBeNull();

    target!.querySelector<HTMLButtonElement>(".modal-close")!.click();
    flushSync();
    await tick();
    await tick();
    expect(surface.hasAttribute("inert")).toBe(false);
    for (const selector of selectors) expect(target!.querySelector(selector)).not.toBeNull();
    expect(document.activeElement).toBe(opener);
  } finally {
    closeDialog();
    HTMLElement.prototype.focus = nativeFocus;
    if (inertDescriptor) Object.defineProperty(HTMLElement.prototype, "inert", inertDescriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, "inert");
  }
});

// jsdom lays out nothing, so the mock's deck sizing is read from the stylesheet:
// the frame is a size container and the deck's height reads it, not the page
// viewport the desktop formula uses, and an in-frame dialog is capped by it.
describe("the mock's deck height", () => {
  const style = demoSource.slice(demoSource.indexOf("<style>"));
  function rule(selector: string): string {
    const at = style.indexOf(`${selector} {`);
    expect(at, `${selector} has a rule`).toBeGreaterThanOrEqual(0);
    return style.slice(at, style.indexOf("}", at));
  }

  it("follows the frame instead of the reader's window", () => {
    expect(style).toMatch(/\n {2}\.launcher-demo-frame \{\s*container-type:\s*size;\s*\}/);
    const deck = rule(":global(.launcher-demo-frame .content .carousel)");
    expect(deck).toMatch(/--deck-height:[^;]*100cqh/);
    expect(deck).not.toMatch(/vh\b/);
  });

  it("caps an in-frame dialog by the frame", () => {
    expect(rule(":global(.launcher-demo-frame .overlay .modal)")).toMatch(/max-height:[^;]*100cqh/);
  });
});
