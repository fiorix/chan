// The machine and gateway badges draw one card chrome from the shared sheet.
// jsdom applies no stylesheet, so a mount shows the hooks the sheet keys off:
// a gateway badge and a devserver machine each wear the card, its header, its
// action cluster and its status line, a pending browser sign-in marks that
// line waiting, the gateway list's empty line wears the empty hint, and both
// screens' dashed add button wears the add entry.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";
import Gateways from "./components/Gateways.svelte";
import Library from "./components/Library.svelte";
import { library, loadLibrary, saveDevserver, stopWatching } from "./state/library.svelte";
import type { DevserverEntry, GatewayEntry } from "./api/library";

vi.mock("./api/backend", async () => {
  const { mockApi } = await import("./api/mock");
  return { backend: mockApi };
});

// The card's parts, outermost first.
const PARTS = ["card", "card-header", "card-actions", "card-prompt"];

let target: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;

function render(component: typeof Gateways | typeof Library): HTMLElement {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(component, { target });
  return target;
}

function partsOf(card: Element): string[] {
  return PARTS.filter((part) => card.matches(`.${part}`) || card.querySelector(`.${part}`) !== null);
}

function gateway(over: Partial<GatewayEntry> = {}): GatewayEntry {
  return {
    id: "gw-chrome01",
    url: "https://gw.chan.app",
    label: "",
    enabled: true,
    status: "disconnected",
    pending_signin: false,
    devserver_count: 0,
    last_error: null,
    ...over,
  };
}

function buttonNamed(root: HTMLElement, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  expect(button, `button ${text}`).toBeTruthy();
  return button!;
}

function machineNamed(root: HTMLElement, text: string): Element {
  const card = [...root.querySelectorAll("section.machine")].find((m) => m.textContent?.includes(text));
  expect(card, `machine card for ${text}`).toBeTruthy();
  return card!;
}

beforeEach(async () => {
  await loadLibrary();
});

afterEach(async () => {
  if (app) unmount(app);
  stopWatching();
  target?.remove();
  target = null;
  app = null;
  library.gateways = [];
  const { resetMockGateways } = await import("./api/mock");
  resetMockGateways();
});

describe("the card chrome", () => {
  it("draws a gateway badge from the card, its header, actions and status line", () => {
    library.gateways = [gateway()];
    const card = render(Gateways).querySelector("section.gateway-card")!;

    expect(partsOf(card)).toEqual(PARTS);
    expect(card.querySelector(".card-prompt")!.classList.contains("waiting")).toBe(false);
  });

  it("marks a gateway's status line waiting while a browser sign-in is pending", () => {
    library.gateways = [gateway({ pending_signin: true })];
    const card = render(Gateways).querySelector("section.gateway-card")!;

    expect(card.querySelector(".card-prompt.waiting")).not.toBeNull();
  });

  it("draws a devserver machine from the same parts, waiting included", async () => {
    await saveDevserver({ host: "chrome.example", port: 443, label: "chrome" });
    library.devservers = library.devservers.map(
      (d): DevserverEntry => (d.host === "chrome.example" ? { ...d, pending_signin: true } : d),
    );
    const card = machineNamed(render(Library), "chrome.example");

    expect(partsOf(card)).toEqual(PARTS);
    expect(card.querySelector(".card-prompt.waiting")).not.toBeNull();
  });

  it("gives the empty gateway list the empty hint and both screens the add entry", () => {
    library.gateways = [];
    const gateways = render(Gateways);
    const hint = [...gateways.querySelectorAll("p")].find((p) => p.textContent?.includes("No gateways yet"));
    expect(hint, "the empty gateway list's line").toBeTruthy();
    expect([...hint!.classList]).toContain("empty-hint");
    expect([...buttonNamed(gateways, "Add gateway").classList]).toContain("add-entry");
    unmount(app!);
    target!.remove();

    const machines = render(Library);
    expect([...buttonNamed(machines, "Add devserver").classList]).toContain("add-entry");
  });
});
