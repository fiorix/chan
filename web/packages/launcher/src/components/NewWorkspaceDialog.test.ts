import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import NewWorkspaceDialog from "./NewWorkspaceDialog.svelte";
import {
  dialog,
  openNewDialog,
  openEditDevserver,
  openEditGateway,
  closeDialog,
} from "../state/dialog.svelte";
import { addGateway, library } from "../state/library.svelte";
import type { DevserverEntry } from "../api/library";

// Pin the in-memory mock as the backend so the Browse… picker returns a canned
// path with no live server. The async-import factory dodges vi.mock's hoist trap.
vi.mock("../api/backend", async () => {
  const { mockApi } = await import("../api/mock");
  return { backend: mockApi };
});

let target: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;

function render(): HTMLElement {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(NewWorkspaceDialog, { target });
  return target;
}

function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// The polymorphic Address field is the only one whose placeholder shows the
// devserver bearer query.
function addressInput(el: HTMLElement): HTMLInputElement {
  return el.querySelector('input[placeholder*="?t="]') as HTMLInputElement;
}

function setInput(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function btn(el: HTMLElement, text: string): HTMLButtonElement {
  const b = [...el.querySelectorAll("button")].find((x) => x.textContent?.includes(text));
  if (!b) throw new Error(`no button containing "${text}"`);
  return b as HTMLButtonElement;
}

afterEach(() => {
  if (app) unmount(app);
  target?.remove();
  target = null;
  app = null;
  closeDialog();
});

describe("New workspace dialog -- local", () => {
  it("shows a folder-path input + the chan serve tip, no chooser", () => {
    openNewDialog("local");
    const el = render();
    // No in-dialog chooser any more (the two entry points open it pre-anchored).
    expect(el.querySelectorAll('[role="radio"]').length).toBe(0);
    expect(el.querySelector('input[type="text"]')).not.toBeNull();
    expect(el.textContent).toContain("Folder path");
    expect(el.textContent).toContain("New workspace");
    expect(el.textContent).toContain("chan serve <path>");
    expect(btn(el, "Create workspace")).toBeTruthy();
  });

  it("fills the folder path from the Browse… native picker", async () => {
    openNewDialog("local");
    const el = render();
    const browse = btn(el, "Browse…");
    browse.click();
    // The picker resolves through the action + the mock's tick; drain the full
    // microtask queue (a macrotask hop) before the bound input reflects it.
    await settle();
    flushSync();
    const input = el.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input.value).toBe("/Users/you/picked-folder");
  });
});

describe("New workspace dialog -- devserver", () => {
  it("shows Name + a single Address field + Connect script + auto-hide + the tip", () => {
    openNewDialog("devserver");
    const el = render();
    expect(el.textContent).toContain("Add devserver");
    expect(el.textContent).toContain("Address");
    expect(el.querySelector("textarea")).not.toBeNull();
    expect(el.textContent).toContain("Auto-hide control terminal on success");
    expect(el.textContent).toContain(
      "Tip: keep connection scripts in the foreground, e.g. ssh -N.",
    );
    // The single Address field replaces the old separate Host / Port / Token
    // inputs -- none of those remain.
    expect(el.querySelector('input[type="number"]')).toBeNull();
    expect(el.querySelector('input[type="password"]')).toBeNull();
    expect(el.textContent).not.toContain("Token");
    expect(el.textContent).not.toContain("Port");
  });

  it("auto-hide control-terminal checkbox is off by default for a new devserver", () => {
    openNewDialog("devserver");
    const el = render();
    const cb = el.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(cb).not.toBeNull();
    expect(cb!.checked).toBe(false);
  });

  it("parses a bare host:port and submits host + port (no token)", async () => {
    openNewDialog("devserver");
    const el = render();
    setInput(addressInput(el), "valid.example.com:8787");
    flushSync();
    btn(el, "Add devserver").click();
    await settle();
    flushSync();
    expect(el.querySelector('[role="alert"]')).toBeNull();
    const added = library.devservers.find((d) => d.host === "valid.example.com" && d.port === 8787);
    expect(added).toBeTruthy();
    expect(added!.has_token).toBe(false);
  });

  it("parses a full http(s) URL and pulls host + port + token out of it", async () => {
    openNewDialog("devserver");
    const el = render();
    setInput(addressInput(el), "https://proxy.example.com:9443?t=sekret");
    flushSync();
    btn(el, "Add devserver").click();
    await settle();
    flushSync();
    expect(el.querySelector('[role="alert"]')).toBeNull();
    const added = library.devservers.find(
      (d) => d.host === "proxy.example.com" && d.port === 9443,
    );
    expect(added).toBeTruthy();
    // The token rode in the URL query -- the mock reports one is stored.
    expect(added!.has_token).toBe(true);
  });

  it("does not treat token= as the devserver bearer query", async () => {
    openNewDialog("devserver");
    const el = render();
    setInput(addressInput(el), "https://old.example.com:9443?token=sekret");
    flushSync();
    btn(el, "Add devserver").click();
    await settle();
    flushSync();
    const added = library.devservers.find((d) => d.host === "old.example.com" && d.port === 9443);
    expect(added).toBeTruthy();
    expect(added!.has_token).toBe(false);
  });

  it("rejects an empty or unparseable address", () => {
    openNewDialog("devserver");
    const el = render();
    setInput(addressInput(el), "no-port-here");
    flushSync();
    btn(el, "Add devserver").click();
    flushSync();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("address");
  });

  it("rejects a malformed host (a typo'd double colon)", () => {
    openNewDialog("devserver");
    const el = render();
    setInput(addressInput(el), "host::8787");
    flushSync();
    btn(el, "Add devserver").click();
    flushSync();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("address");
  });

  it("gives the action row a clearing margin (the dialog-margin fix)", () => {
    openNewDialog("devserver");
    const el = render();
    expect(el.querySelector(".dialog-footer")).not.toBeNull();
  });
});

describe("New workspace dialog -- gateway", () => {
  afterEach(async () => {
    const { resetMockGateways } = await import("../api/mock");
    resetMockGateways();
  });

  function urlInput(el: HTMLElement): HTMLInputElement {
    return el.querySelector('input[placeholder="https://gateway.example.com"]') as HTMLInputElement;
  }

  it("shows the URL-only form: URL + optional name, no devserver plumbing", () => {
    openNewDialog("gateway");
    const el = render();
    expect(el.textContent).toContain("Add gateway");
    expect(el.textContent).toContain("Gateway URL");
    expect(urlInput(el)).not.toBeNull();
    // No polymorphic Address field, no connect script, no auto-hide checkbox.
    expect(el.querySelector('input[placeholder*="?t="]')).toBeNull();
    expect(el.querySelector("textarea")).toBeNull();
    expect(el.querySelector('input[type="checkbox"]')).toBeNull();
    expect(btn(el, "Add gateway")).toBeTruthy();
  });

  it("rejects a non-URL with one message and adds nothing", async () => {
    openNewDialog("gateway");
    const el = render();
    setInput(urlInput(el), "gateway.example.com");
    btn(el, "Add gateway").click();
    await settle();
    flushSync();
    expect(el.querySelector('.error[role="alert"]')?.textContent).toContain("gateway URL");
    expect(dialog.open).toBe(true);
    expect(library.gateways.some((g) => g.url.includes("gateway.example.com"))).toBe(false);
  });

  it("adds the gateway with its optional name and closes", async () => {
    openNewDialog("gateway");
    const el = render();
    setInput(urlInput(el), "https://gateway.example.com");
    setInput(
      el.querySelector('input[placeholder="Defaults to the URL host"]') as HTMLInputElement,
      "prod-gw",
    );
    btn(el, "Add gateway").click();
    await settle();
    flushSync();
    expect(dialog.open).toBe(false);
    expect(
      library.gateways.some(
        (g) => g.url === "https://gateway.example.com" && g.label === "prod-gw",
      ),
    ).toBe(true);
  });

  it("edit prefills the fields, fixes the URL, and Save changes renames", async () => {
    await addGateway({ url: "https://rename.example", label: "before" });
    const gw = library.gateways.find((g) => g.url === "https://rename.example")!;
    openEditGateway(gw);
    const el = render();
    expect(el.textContent).toContain("Edit gateway");
    // The URL is identity: prefilled but disabled (remove + re-add changes it).
    expect(urlInput(el).value).toBe("https://rename.example");
    expect(urlInput(el).disabled).toBe(true);
    const nameInput = el.querySelector(
      'input[placeholder="Defaults to the URL host"]',
    ) as HTMLInputElement;
    expect(nameInput.value).toBe("before");
    expect(nameInput.disabled).toBe(false);
    setInput(nameInput, "after");
    btn(el, "Save changes").click();
    await settle();
    flushSync();
    expect(dialog.open).toBe(false);
    const renamed = library.gateways.find((g) => g.id === gw.id)!;
    expect(renamed.label).toBe("after");
    expect(renamed.url).toBe("https://rename.example");
  });
});

describe("New workspace dialog -- edit", () => {
  it("prefills the Address as host:port without echoing the token", () => {
    const ds: DevserverEntry = {
      id: "ds-edit",
      url: "http://edit.example:8123",
      host: "edit.example",
      port: 8123,
      label: "staging",
      script: "",
      has_token: true,
      library_id: null,
      status: "disconnected",
      pending_signin: false,
      auto_hide_control: false,
      os: "",
      pretty_name: null,
      gateway_id: null,
      gateway_url: "",
      shared: false,
      native_trust_required: false,
    };
    openEditDevserver(ds);
    const el = render();
    expect(el.textContent).toContain("Save changes");
    // The Address seeds from the stored URL; the stored token is never echoed into it.
    expect(addressInput(el).value).toBe("http://edit.example:8123");
    // The Name seeds from the label.
    const nameInput = el.querySelector('input[placeholder*="dev2"]') as HTMLInputElement;
    expect(nameInput.value).toBe("staging");
    // No chooser in the edit form.
    expect(el.querySelectorAll('[role="radio"]').length).toBe(0);
  });

  it("opens read-only (OK, no Save, disabled inputs) for a connected devserver", () => {
    const ds: DevserverEntry = {
      id: "ds-live",
      url: "http://live.example:8200",
      host: "live.example",
      port: 8200,
      label: "live",
      script: "",
      has_token: false,
      library_id: "lib-abc",
      status: "connected",
      pending_signin: false,
      auto_hide_control: false,
      os: "macos",
      pretty_name: "macOS 15.1",
      gateway_id: null,
      gateway_url: "",
      shared: false,
      native_trust_required: false,
    };
    openEditDevserver(ds);
    const el = render();
    expect(el.textContent).toContain("read-only");
    expect(el.textContent).not.toContain("Save changes");
    expect(btn(el, "OK")).toBeTruthy();
    // The Address + Name fields and the Connect script are disabled while connected.
    expect(addressInput(el).disabled).toBe(true);
    expect((el.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(true);
  });
});
