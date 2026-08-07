// Gateway roster rows on the Computers screen (desktop surface): synthesized
// registry-read-only rows. No checkbox in select mode (the GATEWAY is what
// gets selected, on the Gateways screen), the identity block is static (no
// edit form), and the owning gateway replaces the address ("via <gateway>").
// The live-connection controls stay: they operate the conn, not the registry.
// Plain rows keep their full affordances alongside.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Library from "./Library.svelte";
import { library, loadLibrary, stopWatching } from "../state/library.svelte";
import { mockApi } from "../api/mock";
import { cancelConfirm, confirm, resolveConfirm } from "../state/confirm.svelte";
import { setSelectMode } from "../state/selection.svelte";
import type { DevserverEntry, GatewayEntry } from "../api/library";

vi.mock("../api/backend", async () => {
  const { mockApi } = await import("../api/mock");
  return { backend: mockApi };
});

const ROSTER_ID = `gw:gw-1a2b3c4d:alice:${"ab".repeat(32)}`;

function rosterRow(over: Partial<DevserverEntry> = {}): DevserverEntry {
  return {
    id: ROSTER_ID,
    url: "",
    host: "gw.chan.app",
    port: 443,
    label: "laptop",
    script: "",
    has_token: false,
    library_id: null,
    status: "disconnected",
    pending_signin: false,
    auto_hide_control: false,
    os: "",
    pretty_name: null,
    gateway_id: "gw-1a2b3c4d",
    gateway_url: "https://gw.chan.app",
    shared: false,
    native_trust_required: false,
    ...over,
  };
}

function hubGateway(): GatewayEntry {
  return {
    id: "gw-1a2b3c4d",
    url: "https://gw.chan.app",
    label: "hub",
    enabled: true,
    status: "connected",
    pending_signin: false,
    devserver_count: 1,
    last_error: null,
  };
}

let target: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;

function mountList(): HTMLElement {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(Library, { target });
  return target;
}

beforeEach(async () => {
  await loadLibrary();
  library.devservers = [...library.devservers, rosterRow()];
  library.gateways = [hubGateway()];
});

afterEach(() => {
  if (app) unmount(app);
  stopWatching();
  target?.remove();
  target = null;
  app = null;
  setSelectMode(false);
  library.gateways = [];
  cancelConfirm();
  vi.restoreAllMocks();
});

describe("gateway roster rows in the Computers list", () => {
  it("select mode checks plain rows but never a roster row", () => {
    setSelectMode(true);
    const el = mountList();
    // The seeded plain devserver keeps its checkbox...
    expect(el.querySelector('input[aria-label="Select prod"]')).not.toBeNull();
    // ...the synthesized roster row gets none.
    expect(el.querySelector('input[aria-label="Select laptop"]')).toBeNull();
  });

  it("renders a static identity with the via-gateway note in place of the address", () => {
    const el = mountList();
    // No edit affordance on the roster row; the plain row keeps its own.
    expect(el.querySelector('[aria-label="Edit config for laptop"]')).toBeNull();
    expect(el.querySelector('[aria-label="Edit config for prod"]')).not.toBeNull();
    // The owning gateway's label replaces the address row.
    const card = [...el.querySelectorAll("section.machine")].find((m) =>
      m.textContent?.includes("laptop"),
    )!;
    expect(card).toBeTruthy();
    expect(card.textContent).toContain("via hub");
  });

  it("falls back to the gateway_url host when the gateway left the registry", () => {
    library.gateways = [];
    const el = mountList();
    const card = [...el.querySelectorAll("section.machine")].find((m) =>
      m.textContent?.includes("laptop"),
    )!;
    expect(card.textContent).toContain("via gw.chan.app");
  });

  it("keeps the live-connection controls on a roster row", () => {
    const el = mountList();
    expect(el.querySelector('[aria-label="Connect laptop"]')).not.toBeNull();
  });

  it("keeps the disconnect control while a roster row is connected", () => {
    library.devservers = library.devservers.map(
      (d): DevserverEntry => (d.id === ROSTER_ID ? { ...d, status: "connected" } : d),
    );
    const el = mountList();
    expect(el.querySelector('[aria-label="Disconnect laptop"]')).not.toBeNull();
    flushSync();
    // Still no edit affordance while connected.
    expect(el.querySelector('[aria-label="Edit config for laptop"]')).toBeNull();
  });

  it("prompts shared rows and grants, re-lists, then connects in order", async () => {
    library.devservers = library.devservers.map((d) =>
      d.id === ROSTER_ID ? { ...d, shared: true, native_trust_required: true } : d,
    );
    const calls: string[] = [];
    vi.spyOn(mockApi, "grantDevserverNativeTrust").mockImplementation(async () => {
      calls.push("put");
    });
    vi.spyOn(mockApi, "connectDevserver").mockImplementation(async () => {
      calls.push("connect");
    });
    vi.spyOn(mockApi, "listDevservers").mockImplementation(async () => {
      calls.push("list");
      return library.devservers.map((d) =>
        d.id === ROSTER_ID
          ? {
              ...d,
              native_trust_required: false,
              status: calls.includes("connect") ? "connected" : d.status,
            }
          : d,
      );
    });

    const el = mountList();
    (el.querySelector('[aria-label="Connect laptop"]') as HTMLButtonElement).click();
    expect(confirm.open).toBe(true);
    expect(confirm.confirmLabel).toBe("Grant native access");
    expect(confirm.message).toContain("read and write your clipboard");
    expect(confirm.message).toContain("read files you select");
    expect(confirm.message).toContain("open links in your system browser");
    expect(calls).toEqual([]);

    await resolveConfirm();
    expect(calls).toEqual(["put", "list", "connect", "list"]);
  });

  it("cancel and PUT failure never start connect or pending UI", async () => {
    library.devservers = library.devservers.map((d) =>
      d.id === ROSTER_ID ? { ...d, shared: true, native_trust_required: true } : d,
    );
    const grant = vi.spyOn(mockApi, "grantDevserverNativeTrust");
    const connect = vi.spyOn(mockApi, "connectDevserver");
    let el = mountList();
    (el.querySelector('[aria-label="Connect laptop"]') as HTMLButtonElement).click();
    cancelConfirm();
    expect(grant).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(el.textContent).not.toContain("Connecting…");

    if (app) unmount(app);
    app = null;
    target?.remove();
    target = null;
    grant.mockRejectedValueOnce(new Error("PUT refused"));
    el = mountList();
    (el.querySelector('[aria-label="Connect laptop"]') as HTMLButtonElement).click();
    await resolveConfirm();
    expect(grant).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
    expect(el.textContent).not.toContain("Connecting…");
  });

  it("trusted shared rows skip the prompt and expose revoke", async () => {
    library.devservers = library.devservers.map((d) =>
      d.id === ROSTER_ID ? { ...d, shared: true, native_trust_required: false } : d,
    );
    const connect = vi.spyOn(mockApi, "connectDevserver").mockResolvedValue();
    const revoke = vi.spyOn(mockApi, "revokeDevserverNativeTrust").mockResolvedValue();
    vi.spyOn(mockApi, "listDevservers").mockImplementation(async () =>
      library.devservers.map((d) =>
        d.id === ROSTER_ID ? { ...d, native_trust_required: revoke.mock.calls.length > 0 } : d,
      ),
    );
    const el = mountList();
    expect(el.querySelector('[aria-label="Revoke native access for laptop"]')).not.toBeNull();

    (el.querySelector('[aria-label="Connect laptop"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    expect(confirm.open).toBe(false);

    (el.querySelector('[aria-label="Revoke native access for laptop"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(library.devservers.find((d) => d.id === ROSTER_ID)?.native_trust_required).toBe(true),
    );
  });
});
