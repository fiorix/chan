// The desktop surface's Computers deck: the machine cards as a carousel, This
// machine first, the devservers by name, Add devserver last. Arrows turn it and
// move focus onto the card in front, every other card is inert, a click brings
// a side card forward, and the Add devserver card turns over to the devserver
// form and back. jsdom has no layout and no inert semantics, so these read the
// deck's state off the DOM it renders: which slot is current, which bodies are
// inert, where focus sits.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import Library from "./Library.svelte";
import {
  library,
  loadLibrary,
  removeDevserver,
  saveDevserver,
  stopWatching,
} from "../state/library.svelte";
import { decks, resetDeck } from "../state/deck.svelte";

vi.mock("../api/backend", async () => {
  const { mockApi } = await import("../api/mock");
  return { backend: mockApi };
});

let target: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;
const added: string[] = [];

function mountDeck(): void {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(Library, { target });
  flushSync();
}

function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

async function settleAll(): Promise<void> {
  for (let i = 0; i < 4; i++) await settle();
  flushSync();
  await tick();
}

function slots(): HTMLElement[] {
  return [...(target?.querySelectorAll<HTMLElement>(".slot") ?? [])];
}

function labels(): string[] {
  return slots().map((s) => s.getAttribute("aria-label") ?? "");
}

function front(): string {
  return target?.querySelector(".slot[aria-current='true']")?.getAttribute("aria-label") ?? "";
}

function press(key: string, on: EventTarget = document.body): void {
  on.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  flushSync();
}

async function addDevserver(label: string, port: number): Promise<void> {
  added.push(await saveDevserver({ host: "127.0.0.1", port, label }));
}

beforeEach(async () => {
  resetDeck();
  library.error = null;
  await loadLibrary();
});

afterEach(async () => {
  if (app) unmount(app);
  stopWatching();
  target?.remove();
  target = null;
  app = null;
  for (const id of added.splice(0)) await removeDevserver(id);
});

describe("the Computers deck", () => {
  it("deals This machine first, the devservers by name, and Add devserver last", async () => {
    await addDevserver("zeta", 9101);
    await addDevserver("alpha", 9102);
    mountDeck();
    expect(labels()).toEqual([
      "This machine, 1 of 5",
      "alpha, 2 of 5",
      "prod, 3 of 5",
      "zeta, 4 of 5",
      "Add devserver, 5 of 5",
    ]);
    expect(front()).toBe("This machine, 1 of 5");
  });

  it("turns with the arrows, wraps at the ends, and focuses the card in front", async () => {
    mountDeck();
    expect(labels()).toEqual(["This machine, 1 of 3", "prod, 2 of 3", "Add devserver, 3 of 3"]);

    press("ArrowRight");
    await tick();
    expect(front()).toBe("prod, 2 of 3");
    expect(document.activeElement).toBe(target!.querySelector(".slot[aria-current='true']"));

    press("ArrowLeft");
    press("ArrowLeft");
    await tick();
    expect(front()).toBe("Add devserver, 3 of 3");

    press("ArrowRight");
    expect(front()).toBe("This machine, 1 of 3");
  });

  it("holds keyboard focus to the card in front", () => {
    mountDeck();
    const bodies = slots().map((s) => s.querySelector<HTMLElement>(".slot-body")!);
    expect(bodies.map((b) => b.inert)).toEqual([false, true, true]);
    press("ArrowRight");
    expect(bodies.map((b) => b.inert)).toEqual([true, false, true]);
  });

  it("leaves arrows with a modifier, or typed into a field, alone", async () => {
    mountDeck();
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true }),
    );
    flushSync();
    expect(front()).toBe("This machine, 1 of 3");

    // Bring the Add devserver card forward and type into its form.
    press("ArrowLeft");
    target!.querySelector<HTMLButtonElement>("button.add-devserver")!.click();
    flushSync();
    await tick();
    const name = target!.querySelector<HTMLInputElement>(".devserver-form input[type=text]")!;
    press("ArrowLeft", name);
    expect(front()).toBe("Add devserver, 3 of 3");
  });

  it("brings a side card forward on a click", async () => {
    mountDeck();
    slots()[1].click();
    flushSync();
    await tick();
    expect(front()).toBe("prod, 2 of 3");
    expect(document.activeElement).toBe(slots()[1]);
  });

  it("keeps the card in front across a remount", () => {
    mountDeck();
    press("ArrowRight");
    unmount(app!);
    target!.remove();
    mountDeck();
    expect(front()).toBe("prod, 2 of 3");
    expect(decks.computers.activeKey).toBe("ds-1");
  });
});

describe("the Add devserver card", () => {
  // The click comes after the arrow that brought the card forward has moved
  // focus onto it, as a person's would.
  async function openForm(): Promise<void> {
    await tick();
    target!.querySelector<HTMLButtonElement>("button.add-devserver")!.click();
    flushSync();
  }

  function form(): HTMLElement | null {
    return target!.querySelector(".add-deck-card .devserver-form");
  }

  it("turns over to the devserver form, and Escape turns it back", async () => {
    mountDeck();
    press("ArrowLeft");
    await openForm();
    await tick();
    expect(form()).not.toBeNull();
    expect(document.activeElement).toBe(form()!.querySelector("input[type=text]"));

    press("Escape", form()!.querySelector("input[type=text]")!);
    await settleAll();
    expect(form()).toBeNull();
    expect(document.activeElement).toBe(target!.querySelector("button.add-devserver"));
  });

  it("Cancel turns it back without adding a devserver", async () => {
    mountDeck();
    press("ArrowLeft");
    await openForm();
    const before = library.devservers.length;
    [...form()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cancel")!.click();
    flushSync();
    await tick();
    expect(form()).toBeNull();
    expect(library.devservers.length).toBe(before);
  });

  it("adds the devserver, deals its card by name, and brings it to the front", async () => {
    mountDeck();
    press("ArrowLeft");
    await openForm();
    const [name, address] = form()!.querySelectorAll<HTMLInputElement>("input[type=text]");
    name.value = "beta";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    address.value = "127.0.0.1:9200";
    address.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    [...form()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add devserver")!.click();
    await settleAll();

    const beta = library.devservers.find((d) => d.label === "beta");
    expect(beta).toBeDefined();
    added.push(beta!.id);
    expect(labels()).toEqual([
      "This machine, 1 of 4",
      "beta, 2 of 4",
      "prod, 3 of 4",
      "Add devserver, 4 of 4",
    ]);
    expect(front()).toBe("beta, 2 of 4");
    expect(document.activeElement).toBe(target!.querySelector(".slot[aria-current='true']"));
    // The Add devserver card is back on its front face, ready for the next one.
    expect(form()).toBeNull();
  });

  it("keeps the form up with the error when the address does not parse", async () => {
    mountDeck();
    press("ArrowLeft");
    await openForm();
    [...form()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add devserver")!.click();
    await settleAll();
    expect(form()?.querySelector('[role="alert"]')?.textContent).toContain("Enter an address");
    expect(front()).toBe("Add devserver, 3 of 3");
  });
});
