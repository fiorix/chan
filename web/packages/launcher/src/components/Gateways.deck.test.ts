// The desktop surface's Gateways deck: the gateway badges as a carousel like
// the Computers deck, sorted by name, with the Add gateway card last. The Add
// gateway card turns over to the gateway form, and a save deals the new
// gateway's card by name and brings it to the front. The deck keeps its own
// position apart from the Computers deck's.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import Gateways from "./Gateways.svelte";
import { addGateway, library, loadLibrary, stopWatching } from "../state/library.svelte";
import { decks, resetDeck } from "../state/deck.svelte";

vi.mock("../api/backend", async () => {
  const { mockApi } = await import("../api/mock");
  return { backend: mockApi };
});

let target: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;

function mountDeck(): void {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(Gateways, { target });
  flushSync();
}

async function settleAll(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  flushSync();
  await tick();
}

function labels(): string[] {
  return [...(target?.querySelectorAll(".slot") ?? [])].map((s) => s.getAttribute("aria-label") ?? "");
}

function front(): string {
  return target?.querySelector(".slot[aria-current='true']")?.getAttribute("aria-label") ?? "";
}

function press(key: string, on: EventTarget = document.body): void {
  on.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  flushSync();
}

function form(): HTMLElement | null {
  return target!.querySelector(".add-deck-card .gateway-form");
}

async function openForm(): Promise<void> {
  await tick();
  target!.querySelector<HTMLButtonElement>("button.add-gateway")!.click();
  flushSync();
  await tick();
}

beforeEach(async () => {
  resetDeck();
  const { resetMockGateways } = await import("../api/mock");
  resetMockGateways();
  await loadLibrary();
});

afterEach(() => {
  if (app) unmount(app);
  stopWatching();
  target?.remove();
  target = null;
  app = null;
  library.gateways = [];
});

describe("the Gateways deck", () => {
  it("deals the gateways by name and the Add gateway card last", async () => {
    await addGateway({ url: "https://zeta.example.com" });
    await addGateway({ url: "https://gw.example.com", label: "alpha" });
    mountDeck();
    expect(labels()).toEqual([
      "alpha, 1 of 3",
      "zeta.example.com, 2 of 3",
      "Add gateway, 3 of 3",
    ]);
  });

  it("turns over to the gateway form, and Escape turns it back", async () => {
    mountDeck();
    expect(labels()).toEqual(["Add gateway, 1 of 1"]);
    await openForm();
    expect(form()).not.toBeNull();
    expect(document.activeElement).toBe(form()!.querySelector("input[type=text]"));
    press("Escape", form()!.querySelector("input[type=text]")!);
    await settleAll();
    expect(form()).toBeNull();
    expect(document.activeElement).toBe(target!.querySelector("button.add-gateway"));
  });

  it("adds the gateway, deals its card by name, and brings it to the front", async () => {
    await addGateway({ url: "https://zeta.example.com" });
    mountDeck();
    press("ArrowLeft");
    await openForm();
    const [url, name] = form()!.querySelectorAll<HTMLInputElement>("input[type=text]");
    url.value = "https://corp.example.com";
    url.dispatchEvent(new Event("input", { bubbles: true }));
    name.value = "corp";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    [...form()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add gateway")!.click();
    await settleAll();

    expect(labels()).toEqual(["corp, 1 of 3", "zeta.example.com, 2 of 3", "Add gateway, 3 of 3"]);
    expect(front()).toBe("corp, 1 of 3");
    expect(document.activeElement).toBe(target!.querySelector(".slot[aria-current='true']"));
    expect(form()).toBeNull();
  });

  it("refuses a URL that does not parse and keeps the form up", async () => {
    mountDeck();
    await openForm();
    [...form()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add gateway")!.click();
    await settleAll();
    expect(form()?.querySelector('[role="alert"]')?.textContent).toContain("Enter the gateway URL");
  });

  it("keeps its position apart from the Computers deck", async () => {
    await addGateway({ url: "https://zeta.example.com" });
    mountDeck();
    press("ArrowRight");
    expect(front()).toBe("Add gateway, 2 of 2");
    expect(decks.gateways.activeKey).toBe("add-gateway");
    expect(decks.computers.activeKey).toBeNull();
  });
});
