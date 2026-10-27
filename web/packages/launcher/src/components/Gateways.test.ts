// The Gateways screen: badges render from the store, the connect/disconnect
// control offers a spinning cancel while connecting, and sign-in narration
// and the lost dot describe the connection. Select mode reveals gateway
// checkboxes feeding the global selection; the deck's Add gateway card turns
// over to the URL-only form.

import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, unmount, flushSync, tick } from "svelte";
import Gateways from "./Gateways.svelte";
import { addGateway, library } from "../state/library.svelte";
import * as libraryActions from "../state/library.svelte";
import { backend } from "../api/backend";
import { clearNotices, notices } from "../state/notices.svelte";
import { dialog, closeDialog } from "../state/dialog.svelte";
import { resetDeck } from "../state/deck.svelte";
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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
  resetDeck();
  const { resetMockGateways } = await import("../api/mock");
  resetMockGateways();
});

describe("Gateways screen", () => {
  it("tells the empty state on the Add gateway card", () => {
    library.gateways = [];
    const el = render();
    expect(el.textContent).toContain("No gateways yet");
    const add = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Add gateway"),
    );
    expect(add).toBeTruthy();
  });

  it("Add gateway turns its card over to the gateway form, not a dialog", async () => {
    library.gateways = [];
    const el = render();
    const add = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Add gateway"),
    ) as HTMLButtonElement;
    add.click();
    flushSync();
    await tick();
    await tick();
    expect(dialog.open).toBe(false);
    const form = el.querySelector(".add-deck-card .gateway-form");
    expect(form).not.toBeNull();
    expect(document.activeElement).toBe(form!.querySelector("input[type=text]"));
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
    expect(control.title).toBe("Cancel connection (c)");
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
    expect(control.title).toBe("Connect (c)");
    expect(control.disabled).toBe(false);
    control.click();
    expect(connect).toHaveBeenCalledExactlyOnceWith("gw-test0001");
    await connect.mock.results[0].value;
  });

  it.each(["connect", "refresh"] as const)("a repeated activation during %s sends Connect once", async (phase) => {
    const id = `gw-inflight-${phase}`;
    const row = gw({ id, label: "prod" });
    const connecting = gw({ id, label: "prod", status: "connecting", pending_signin: true });
    const connected = deferred<void>();
    const refreshed = deferred<GatewayEntry[]>();
    const refreshing = deferred<void>();
    const connect = vi.spyOn(backend, "connectGateway").mockReturnValue(connected.promise);
    vi.spyOn(backend, "listGateways").mockImplementation(() => {
      refreshing.resolve();
      return refreshed.promise;
    });
    const action = vi.spyOn(libraryActions, "connectGateway");
    library.gateways = [row];
    const el = render();
    const control = el.querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    try {
      control.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      if (phase === "refresh") {
        connected.resolve();
        await refreshing.promise;
      }
      control.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      expect(connect, "an in-flight Connect must suppress the second request").toHaveBeenCalledExactlyOnceWith(id);
      const returned: unknown[] = [];
      void action.mock.results[1].value.then((value: unknown) => returned.push(value));
      await Promise.resolve();
      expect(returned, "an ignored Connect resolves undefined without waiting for the first call").toEqual([undefined]);
      expect(library.gateways, "only the backend refresh may change the row").toEqual([row]);
      expect(control.title).toBe("Connect (c)");
    } finally {
      connected.resolve();
      refreshed.resolve([connecting]);
      await Promise.all(action.mock.results.map((result) => result.value));
    }
    flushSync();
    expect(library.gateways).toEqual([connecting]);
    expect(el.querySelector('[aria-label="Cancel connection to prod"]')).toBe(control);
  });

  it("a failed Connect permits a new activation", async () => {
    const id = "gw-inflight-failure";
    const connect = vi.spyOn(backend, "connectGateway")
      .mockRejectedValueOnce(new Error("connect refused"))
      .mockResolvedValue(undefined);
    vi.spyOn(backend, "listGateways").mockResolvedValue([
      gw({ id, label: "prod", status: "connecting", pending_signin: true }),
    ]);
    const action = vi.spyOn(libraryActions, "connectGateway");
    library.gateways = [gw({ id, label: "prod" })];
    const el = render();
    const control = el.querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await expect(action.mock.results[0].value).rejects.toThrow("connect refused");
    expect(library.error).toBe("connect refused");
    control.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await action.mock.results[1].value;
    expect(connect, "a failed Connect must release the next activation").toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenLastCalledWith(id);
    flushSync();
    expect(el.querySelector('[aria-label="Cancel connection to prod"]')).toBe(control);
  });

  it("a completed Connect refresh permits a new activation", async () => {
    const id = "gw-inflight-complete";
    const connect = vi.spyOn(backend, "connectGateway").mockResolvedValue(undefined);
    const row = gw({ id, label: "prod" });
    vi.spyOn(backend, "listGateways").mockResolvedValue([row]);
    const action = vi.spyOn(libraryActions, "connectGateway");
    library.gateways = [row];
    const el = render();
    const control = el.querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await action.mock.results[0].value;
    flushSync();
    control.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await action.mock.results[1].value;
    expect(connect, "a completed refresh must release the next activation").toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenLastCalledWith(id);
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

  it.each(["connecting", "connected"] as const)("a double click across %s becoming Connect does not reconnect", async (status) => {
    const connect = vi.spyOn(libraryActions, "connectGateway").mockResolvedValue(undefined);
    const disconnect = vi.spyOn(libraryActions, "disconnectGateway").mockResolvedValue(undefined);
    library.gateways = [gw({ label: "prod", status, pending_signin: status === "connecting" })];
    const el = render();
    const control = el.querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(disconnect).toHaveBeenCalledExactlyOnceWith("gw-test0001");
    await disconnect.mock.results[0].value;
    library.gateways = [gw({ label: "prod", enabled: false })];
    flushSync();
    expect(el.querySelector('[aria-label="Connect gateway prod"]')).toBe(control);
    expect(control.title).toBe("Connect (c)");
    control.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    expect(connect, "the second click must not reconnect after the row update").not.toHaveBeenCalled();
    expect(disconnect, "the sequence must disconnect exactly once").toHaveBeenCalledExactlyOnceWith("gw-test0001");
  });

  it("a third click of one sequence on Cancel calls neither action", () => {
    const connect = vi.spyOn(libraryActions, "connectGateway").mockResolvedValue(undefined);
    const disconnect = vi.spyOn(libraryActions, "disconnectGateway").mockResolvedValue(undefined);
    library.gateways = [gw({ label: "prod", status: "connecting", pending_signin: true })];
    const el = render();
    const control = el.querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 3 }));
    expect(disconnect, "the third click of the sequence must be ignored").not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("a second gateway connects while the first request is in flight", async () => {
    const held = deferred<void>();
    const first = gw({ id: "gw-inflight-a", label: "a" });
    const second = gw({ id: "gw-inflight-b", label: "b", url: "https://b.example" });
    const connect = vi.spyOn(backend, "connectGateway")
      .mockImplementation((id: string) => id === first.id ? held.promise : Promise.resolve());
    vi.spyOn(backend, "listGateways").mockResolvedValue([first, second]);
    const action = vi.spyOn(libraryActions, "connectGateway");
    library.gateways = [first, second];
    const el = render();
    const controls = [...el.querySelectorAll(".gateway-actions button:last-child")] as HTMLButtonElement[];
    try {
      expect(controls).toHaveLength(2);
      controls[0].dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      expect(connect).toHaveBeenCalledExactlyOnceWith(first.id);
      controls[1].dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      expect(connect, "another gateway must connect while the first request is held").toHaveBeenCalledTimes(2);
      expect(connect).toHaveBeenLastCalledWith(second.id);
      await action.mock.results[1].value;
    } finally {
      held.resolve();
      await Promise.all(action.mock.results.map((result) => result.value));
    }
  });

  it.each(["disconnected", "connecting", "connected", "unreachable"] as const)("held Enter does not activate the %s row again", async (status) => {
    const connect = vi.spyOn(libraryActions, "connectGateway").mockResolvedValue(undefined);
    const disconnect = vi.spyOn(libraryActions, "disconnectGateway").mockResolvedValue(undefined);
    library.gateways = [gw({ label: "prod" })];
    const el = render();
    const control = el.querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.focus();
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
    control.click();
    expect(connect, "the first Enter press must connect").toHaveBeenCalledExactlyOnceWith("gw-test0001");
    await connect.mock.results[0].value;
    library.gateways = [gw({ label: "prod", status, pending_signin: status === "connecting" })];
    flushSync();
    expect(el.querySelector(".gateway-actions button:last-child")).toBe(control);
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", repeat: true, cancelable: true }));
    // Deliver the click even if keydown was prevented: the handler owns the guard.
    control.click();
    if (status === "disconnected") {
      expect(connect, "a repeat must not send a second Connect").toHaveBeenCalledTimes(1);
    } else {
      expect(disconnect, `a repeat must not activate ${status}`).not.toHaveBeenCalled();
    }
  });

  it("an Enter press after release reaches the store", async () => {
    const connect = vi.spyOn(libraryActions, "connectGateway").mockResolvedValue(undefined);
    library.gateways = [gw()];
    const control = render().querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
    control.click();
    await connect.mock.results[0].value;
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter" }));
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
    control.click();
    expect(connect, "a released key's next press must reach the store").toHaveBeenCalledTimes(2);
  });

  it("a count-zero click without a held key reaches the store", () => {
    const connect = vi.spyOn(libraryActions, "connectGateway").mockResolvedValue(undefined);
    library.gateways = [gw()];
    const control = render().querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.click();
    expect(connect, "a count-zero click with no key held must reach the store").toHaveBeenCalledExactlyOnceWith("gw-test0001");
  });

  it("release clears a repeat before a count-zero click", () => {
    const connect = vi.spyOn(libraryActions, "connectGateway").mockResolvedValue(undefined);
    library.gateways = [gw()];
    const control = render().querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", repeat: true }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter" }));
    control.click();
    expect(connect, "a released repeat must not suppress a count-zero click").toHaveBeenCalledExactlyOnceWith("gw-test0001");
  });

  it.each(["button", "window"])("%s blur clears a held Enter released outside", (where) => {
    const connect = vi.spyOn(libraryActions, "connectGateway").mockResolvedValue(undefined);
    library.gateways = [gw()];
    const control = render().querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.focus();
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", repeat: true }));
    if (where === "button") control.blur();
    else window.dispatchEvent(new Event("blur"));
    control.click();
    expect(connect, "focus loss must clear the repeat marker").toHaveBeenCalledTimes(1);
    control.focus();
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
    control.click();
    expect(connect, "focus loss must clear the held code").toHaveBeenCalledTimes(2);
  });

  it("an Enter repeat arriving after focus changes cannot activate", () => {
    const connect = vi.spyOn(libraryActions, "connectGateway").mockResolvedValue(undefined);
    library.gateways = [gw()];
    const control = render().querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.focus();
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", repeat: true }));
    control.click();
    expect(connect, "an already repeating key must not activate on focus arrival").not.toHaveBeenCalled();
  });

  it("a held Enter is remembered even when a keydown lacks repeat", () => {
    const connect = vi.spyOn(libraryActions, "connectGateway").mockResolvedValue(undefined);
    library.gateways = [gw()];
    const control = render().querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
    control.click();
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
    control.click();
    expect(connect, "the component's held record must reject a second keydown").toHaveBeenCalledTimes(1);
  });

  it("Space activates after an Enter repeat and the next Enter repeat is ignored", () => {
    const connect = vi.spyOn(libraryActions, "connectGateway").mockResolvedValue(undefined);
    library.gateways = [gw()];
    const control = render().querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", repeat: true }));
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: " ", code: "Space" }));
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", repeat: true }));
    control.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: " ", code: "Space" }));
    control.click();
    expect(connect, "Space release must still activate while Enter is held").toHaveBeenCalledTimes(1);
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", repeat: true }));
    control.click();
    expect(connect, "Space must not erase the held Enter guard").toHaveBeenCalledTimes(1);
  });

  it("another Enter code is a separate press", () => {
    const connect = vi.spyOn(libraryActions, "connectGateway").mockResolvedValue(undefined);
    library.gateways = [gw()];
    const control = render().querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", repeat: true }));
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "NumpadEnter" }));
    control.click();
    expect(connect, "a different Enter code is a new press").toHaveBeenCalledExactlyOnceWith("gw-test0001");
  });

  it("a pointer click is independent of a held Enter repeat", () => {
    const connect = vi.spyOn(libraryActions, "connectGateway").mockResolvedValue(undefined);
    library.gateways = [gw()];
    const control = render().querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", repeat: true }));
    control.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(connect, "a pointer click must remain independent of a repeating key").toHaveBeenCalledExactlyOnceWith("gw-test0001");
  });

  it("an unseen release loses one press and the next observed release recovers", () => {
    const connect = vi.spyOn(libraryActions, "connectGateway").mockResolvedValue(undefined);
    library.gateways = [gw()];
    const control = render().querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
    control.click();
    expect(connect).toHaveBeenCalledTimes(1);
    // No keyup or blur is delivered for the release before this real press.
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
    control.click();
    expect(connect, "an unseen release leaves one real press suppressed").toHaveBeenCalledTimes(1);
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter" }));
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
    control.click();
    expect(connect, "the next press after an observed release must recover").toHaveBeenCalledTimes(2);
  });

  it("a script click during a repeat is refused until release", () => {
    const connect = vi.spyOn(libraryActions, "connectGateway").mockResolvedValue(undefined);
    library.gateways = [gw()];
    const control = render().querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", repeat: true }));
    control.click();
    expect(connect, "a count-zero script click shares the held repeat marker").not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter" }));
    control.click();
    expect(connect, "release restores a script click").toHaveBeenCalledExactlyOnceWith("gw-test0001");
  });

  it("another keydown cannot clear an Enter repeat before release", () => {
    const connect = vi.spyOn(libraryActions, "connectGateway").mockResolvedValue(undefined);
    library.gateways = [gw()];
    const control = render().querySelector(".gateway-actions button:last-child") as HTMLButtonElement;
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", repeat: true }));
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a", code: "KeyA" }));
    control.click();
    expect(connect, "another keydown must not admit a count-zero click during an Enter repeat").not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter" }));
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
    control.click();
    expect(connect, "the next Enter press after release must activate").toHaveBeenCalledExactlyOnceWith("gw-test0001");
  });

  it("unmount removes the component's window listeners", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    render();
    const listeners = add.mock.calls.filter(([type]) => type === "keyup" || type === "blur");
    expect(listeners.map(([type]) => type).sort()).toEqual(["blur", "keyup"]);
    await unmount(app!);
    app = null;
    for (const [type, listener] of listeners) {
      expect(remove.mock.calls.some(([removedType, removedListener]) => removedType === type && removedListener === listener), `${type} listener must leave with the component`).toBe(true);
    }
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
