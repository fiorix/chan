// The Gateways screen: badges render from the store, the plug/unplug controls
// mirror the Library card idiom (spinner, sign-in narration, lost dot), select
// mode reveals gateway checkboxes feeding the global selection, and the dashed
// Add gateway opens the URL-only form.

import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Gateways from "./Gateways.svelte";
import { addGateway, library } from "../state/library.svelte";
import { dialog, closeDialog } from "../state/dialog.svelte";
import { isSelected, setSelectMode } from "../state/selection.svelte";
import type { GatewayEntry } from "../api/library";

vi.mock("../api/backend", async () => {
  const { mockApi } = await import("../api/mock");
  return { backend: mockApi };
});

let target: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;

function render(): HTMLElement {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(Gateways, { target });
  return target;
}

function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function gw(over: Partial<GatewayEntry> = {}): GatewayEntry {
  return {
    id: "gw-test0001",
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

afterEach(async () => {
  if (app) unmount(app);
  target?.remove();
  target = null;
  app = null;
  library.gateways = [];
  setSelectMode(false);
  closeDialog();
  const { resetMockGateways } = await import("../api/mock");
  resetMockGateways();
});

describe("Gateways screen", () => {
  it("renders the empty hint and the dashed Add gateway entry point", () => {
    library.gateways = [];
    const el = render();
    expect(el.textContent).toContain("No gateways yet");
    const add = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Add gateway"),
    );
    expect(add).toBeTruthy();
  });

  it("Add gateway opens the dialog on the gateway choice", () => {
    library.gateways = [];
    const el = render();
    const add = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Add gateway"),
    ) as HTMLButtonElement;
    add.click();
    flushSync();
    expect(dialog.open).toBe(true);
    expect(dialog.choice).toBe("gateway");
  });

  it("a disconnected badge shows the label over the URL with a Connect plug", () => {
    library.gateways = [gw({ label: "prod" })];
    const el = render();
    const card = el.querySelector("section.gateway-card")!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("prod");
    expect(card.textContent).toContain("https://gw.chan.app");
    expect(card.textContent).toContain("Not connected");
    expect(card.querySelector(".gw-glyph svg")).not.toBeNull();
    expect(card.querySelector('[aria-label="Connect gateway prod"]')).not.toBeNull();
    expect(card.querySelector(".status-dot")).toBeNull();
  });

  it("an unlabeled badge derives its name from the URL host", () => {
    library.gateways = [gw()];
    const el = render();
    expect(el.querySelector('[aria-label="Connect gateway gw.chan.app"]')).not.toBeNull();
  });

  it("a connected badge shows the live dot, the count chip, and Disconnect", () => {
    library.gateways = [gw({ label: "prod", status: "connected", devserver_count: 2 })];
    const el = render();
    const card = el.querySelector("section.gateway-card")!;
    expect(card.querySelector(".status-dot.live")).not.toBeNull();
    expect(card.textContent).toContain("2 devservers");
    expect(card.querySelector('[aria-label="Disconnect gateway prod"]')).not.toBeNull();
    expect(card.textContent).toContain("listed under Computers");
  });

  it("a pending sign-in narrates the browser wait and keeps the re-open affordance", () => {
    library.gateways = [gw({ label: "prod", pending_signin: true })];
    const el = render();
    const card = el.querySelector("section.gateway-card")!;
    expect(card.textContent).toContain("Waiting for sign-in in your browser");
    expect(
      card.querySelector('[aria-label="Re-open sign-in in your browser for prod"]'),
    ).not.toBeNull();
  });

  it("an unreachable badge shows the lost dot, keeps Disconnect, and carries last_error", () => {
    library.gateways = [
      gw({ label: "prod", status: "unreachable", last_error: "roster poll failed" }),
    ];
    const el = render();
    const card = el.querySelector("section.gateway-card")!;
    expect(card.querySelector(".status-dot.lost")).not.toBeNull();
    expect(card.querySelector('[aria-label="Disconnect gateway prod"]')).not.toBeNull();
    expect(card.textContent).toContain("roster poll failed");
    expect(card.textContent).toContain("last-known");
  });

  it("a connecting badge spins and disables its control", () => {
    library.gateways = [gw({ label: "prod", status: "connecting" })];
    const el = render();
    const working = el.querySelector('[aria-label="Working on prod"]') as HTMLButtonElement;
    expect(working).not.toBeNull();
    expect(working.disabled).toBe(true);
    expect(el.textContent).toContain("Connecting");
  });

  it("the pencil opens the edit dialog seeded with the gateway", () => {
    library.gateways = [gw({ label: "prod" })];
    const el = render();
    const pencil = el.querySelector('[aria-label="Rename gateway prod"]') as HTMLButtonElement;
    expect(pencil).not.toBeNull();
    pencil.click();
    flushSync();
    expect(dialog.open).toBe(true);
    expect(dialog.choice).toBe("gateway");
    expect(dialog.editingGateway?.id).toBe("gw-test0001");
    // The devserver edit slot stays clear: the gateway branch renders.
    expect(dialog.editing).toBeNull();
  });

  it("select mode reveals a checkbox feeding the gateway selection", () => {
    library.gateways = [gw({ label: "prod" })];
    const el = render();
    expect(el.querySelector('input[type="checkbox"]')).toBeNull();
    setSelectMode(true);
    flushSync();
    const check = el.querySelector('input[aria-label="Select prod"]') as HTMLInputElement;
    expect(check).not.toBeNull();
    check.click();
    flushSync();
    expect(isSelected("gateway", "gw-test0001")).toBe(true);
  });

  it("the plug drives the connect action and the badge flips live", async () => {
    await addGateway({ url: "https://live-gw.example", label: "live" });
    const el = render();
    (el.querySelector('[aria-label="Connect gateway live"]') as HTMLButtonElement).click();
    await settle();
    flushSync();
    expect(el.querySelector(".status-dot.live")).not.toBeNull();
    expect(el.querySelector('[aria-label="Disconnect gateway live"]')).not.toBeNull();
  });
});
