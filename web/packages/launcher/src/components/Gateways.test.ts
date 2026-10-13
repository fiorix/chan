// The Gateways screen: badges render from the store, the plug/unplug controls
// mirror the Library card idiom (spinner, sign-in narration, lost dot), select
// mode reveals gateway checkboxes feeding the global selection, and the dashed
// Add gateway opens the URL-only form.

import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Gateways from "./Gateways.svelte";
import { addGateway, library } from "../state/library.svelte";
import * as libraryActions from "../state/library.svelte";
import { clearNotices, notices } from "../state/notices.svelte";
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
  library.error = null;
  clearNotices();
  vi.restoreAllMocks();
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

  it.each([false, true])("the spinner is enabled with pending_signin=%s", (pending_signin) => {
    library.gateways = [gw({ label: "prod", status: "connecting", pending_signin })];
    const el = render();
    const control = el.querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    expect(control.disabled, "a connecting control must remain enabled").toBe(false);
    expect(control.title).toBe("Cancel connection");
    expect(control.getAttribute("aria-label")).toBe("Cancel connection to prod");
    expect(control.querySelector("svg.spin")).not.toBeNull();
    expect(el.textContent).toContain(
      pending_signin ? "Waiting for sign-in in your browser..." : "Connecting",
    );
  });

  it.each([false, true])("the spinner cancels with pending_signin=%s", async (pending_signin) => {
    const connect = vi.spyOn(libraryActions, "connectGateway").mockResolvedValue(undefined);
    const disconnect = vi.spyOn(libraryActions, "disconnectGateway").mockResolvedValue(undefined);
    library.gateways = [gw({ label: "prod", status: "connecting", pending_signin })];
    const el = render();
    const control = el.querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.click();
    expect(disconnect, "a spinner activation must call Disconnect once").toHaveBeenCalledExactlyOnceWith("gw-test0001");
    expect(connect).not.toHaveBeenCalled();
    await disconnect.mock.results[0].value;
    expect(library.error).toBeNull();
    expect(notices.items, "the user's cancel must not raise a notice").toEqual([]);
  });

  it("a rejected cancel reports through the notice path", async () => {
    const disconnect = vi.spyOn(libraryActions, "disconnectGateway")
      .mockRejectedValue(new Error("disconnect refused"));
    library.gateways = [gw({ label: "prod", status: "connecting", pending_signin: true })];
    const el = render();
    (el.querySelector(".gateway-actions button:last-child") as HTMLButtonElement).click();
    expect(disconnect, "a rejected cancel must reach Disconnect").toHaveBeenCalledExactlyOnceWith("gw-test0001");
    await expect(disconnect.mock.results[0].value).rejects.toThrow("disconnect refused");
    expect(library.error).toBe("disconnect refused");
    expect(notices.items).toMatchObject([{ kind: "error", message: "disconnect refused" }]);
  });

  it.each([false, true])("Connect keeps focus when pending_signin becomes %s", async (pending_signin) => {
    const connect = vi.spyOn(libraryActions, "connectGateway").mockResolvedValue(undefined);
    library.gateways = [gw({ label: "prod" })];
    const el = render();
    const control = el.querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.focus();
    expect(document.activeElement).toBe(control);
    control.click();
    expect(connect).toHaveBeenCalledExactlyOnceWith("gw-test0001");
    await connect.mock.results[0].value;
    library.gateways = [gw({ label: "prod", status: "connecting", pending_signin })];
    flushSync();
    expect(document.activeElement, "focus must stay on Connect as it becomes Cancel").toBe(control);
    expect(el.querySelector('[aria-label="Cancel connection to prod"]')).toBe(control);
  });

  it.each([false, true])("Cancel keeps focus and becomes Connect after pending_signin=%s", async (pending_signin) => {
    const connect = vi.spyOn(libraryActions, "connectGateway").mockResolvedValue(undefined);
    library.gateways = [gw({ label: "prod", status: "connecting", pending_signin })];
    const el = render();
    const control = el.querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.focus();
    library.gateways = [gw({ label: "prod", enabled: false })];
    flushSync();
    expect(document.activeElement, "focus must stay on Cancel as it becomes Connect").toBe(control);
    expect(el.querySelector('[aria-label="Connect gateway prod"]')).toBe(control);
    expect(control.title).toBe("Connect");
    expect(control.disabled).toBe(false);
    control.click();
    expect(connect).toHaveBeenCalledExactlyOnceWith("gw-test0001");
    await connect.mock.results[0].value;
  });

  it("a double click across Connect becoming Cancel leaves the attempt connecting", async () => {
    const connect = vi.spyOn(libraryActions, "connectGateway").mockResolvedValue(undefined);
    const disconnect = vi.spyOn(libraryActions, "disconnectGateway").mockResolvedValue(undefined);
    library.gateways = [gw({ label: "prod" })];
    const el = render();
    const control = el.querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await connect.mock.results[0].value;
    library.gateways = [gw({ label: "prod", status: "connecting" })];
    flushSync();
    control.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    expect(disconnect, "the second click of a double click must not cancel").not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledExactlyOnceWith("gw-test0001");
    expect(library.gateways).toEqual([gw({ label: "prod", status: "connecting" })]);
    expect(el.querySelector('[aria-label="Cancel connection to prod"]')).toBe(control);
  });

  it("a later single click on Cancel disconnects once", async () => {
    const connect = vi.spyOn(libraryActions, "connectGateway").mockResolvedValue(undefined);
    const disconnect = vi.spyOn(libraryActions, "disconnectGateway").mockResolvedValue(undefined);
    library.gateways = [gw({ label: "prod" })];
    const el = render();
    const control = el.querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await connect.mock.results[0].value;
    library.gateways = [gw({ label: "prod", status: "connecting", pending_signin: true })];
    flushSync();
    control.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(disconnect, "a single click on Cancel must disconnect").toHaveBeenCalledExactlyOnceWith("gw-test0001");
    await disconnect.mock.results[0].value;
  });

  it("a keyboard click on Cancel disconnects once", async () => {
    const disconnect = vi.spyOn(libraryActions, "disconnectGateway").mockResolvedValue(undefined);
    library.gateways = [gw({ label: "prod", status: "connecting", pending_signin: true })];
    const el = render();
    const control = el.querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    expect(disconnect, "a keyboard click on Cancel must disconnect").toHaveBeenCalledExactlyOnceWith("gw-test0001");
    await disconnect.mock.results[0].value;
  });

  it.each(["connected", "unreachable"] as const)("%s still disconnects", async (status) => {
    const connect = vi.spyOn(libraryActions, "connectGateway").mockResolvedValue(undefined);
    const disconnect = vi.spyOn(libraryActions, "disconnectGateway").mockResolvedValue(undefined);
    library.gateways = [gw({ label: "prod", status })];
    const el = render();
    (el.querySelector('[aria-label="Disconnect gateway prod"]') as HTMLButtonElement).click();
    expect(disconnect).toHaveBeenCalledExactlyOnceWith("gw-test0001");
    expect(connect).not.toHaveBeenCalled();
    await disconnect.mock.results[0].value;
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
