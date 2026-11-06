// The gateway form's WireGuard file: it rides as `wireguard` on add and on
// update, a blank field rides as absent (the registry's "clear", the same
// way a blank label does), the field seeds from the edited gateway, and the
// registry's 400 for a bad path or file is the form's error, verbatim.

import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import GatewayForm from "./GatewayForm.svelte";
import { backend } from "../api/backend";
import { ApiError, type GatewayEntry } from "../api/library";
import { library } from "../state/library.svelte";

vi.mock("../api/backend", async () => {
  const { mockApi } = await import("../api/mock");
  return { backend: mockApi };
});

const URL_ = "https://gw.chan.app";
const FILE = "~/.config/chan/gateway.conf";
const STORED = "/home/u/wg/chan.conf";

function gw(over: Partial<GatewayEntry> = {}): GatewayEntry {
  return {
    id: "gw-test0001",
    url: URL_,
    label: "",
    enabled: true,
    status: "disconnected",
    pending_signin: false,
    devserver_count: 0,
    last_error: null,
    wireguard: null,
    ...over,
  };
}

let target: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;

function render(editing: GatewayEntry | null = null): {
  el: HTMLElement;
  onsaved: ReturnType<typeof vi.fn>;
} {
  const onsaved = vi.fn();
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(GatewayForm, { target, props: { editing, onsaved } });
  return { el: target, onsaved };
}

function field(el: HTMLElement, placeholder: string): HTMLInputElement {
  const input = el.querySelector(`input[placeholder="${placeholder}"]`);
  if (!input) throw new Error(`no field with placeholder "${placeholder}"`);
  return input as HTMLInputElement;
}

const urlField = (el: HTMLElement) => field(el, "https://gateway.example.com");
const nameField = (el: HTMLElement) => field(el, "Defaults to the URL host");
const fileField = (el: HTMLElement) => field(el, FILE);

function setInput(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function btn(el: HTMLElement, text: string): HTMLButtonElement {
  const b = [...el.querySelectorAll("button")].find((x) => x.textContent?.includes(text));
  if (!b) throw new Error(`no button containing "${text}"`);
  return b as HTMLButtonElement;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

/** The body the live client would put on the wire for this call: `req`
 * serializes the input with JSON.stringify, which drops an undefined key. */
function wireBody(input: unknown): string {
  return JSON.stringify(input);
}

afterEach(async () => {
  if (app) unmount(app);
  target?.remove();
  target = null;
  app = null;
  library.gateways = [];
  vi.restoreAllMocks();
  const { resetMockGateways } = await import("../api/mock");
  resetMockGateways();
});

describe("GatewayForm WireGuard file", () => {
  it("add sends the file as `wireguard` beside the URL", async () => {
    const add = vi.spyOn(backend, "addGateway").mockResolvedValue(gw({ id: "gw-new", wireguard: FILE }));
    const { el, onsaved } = render();
    setInput(urlField(el), URL_);
    setInput(fileField(el), `  ${FILE}  `);
    btn(el, "Add gateway").click();
    await settle();
    expect(add).toHaveBeenCalledTimes(1);
    expect(wireBody(add.mock.calls[0][0])).toBe(wireBody({ url: URL_, wireguard: FILE }));
    expect(onsaved).toHaveBeenCalledExactlyOnceWith("gw-new");
  });

  it("add with a blank file sends no `wireguard` key, like a blank label", async () => {
    const add = vi.spyOn(backend, "addGateway").mockResolvedValue(gw({ id: "gw-new" }));
    const { el } = render();
    setInput(urlField(el), URL_);
    setInput(nameField(el), "prod");
    setInput(fileField(el), "   ");
    btn(el, "Add gateway").click();
    await settle();
    expect(wireBody(add.mock.calls[0][0])).toBe(wireBody({ url: URL_, label: "prod" }));
  });

  it("edit seeds the field from the gateway and sends a new file on update", async () => {
    const update = vi.spyOn(backend, "updateGateway").mockResolvedValue(gw({ wireguard: FILE }));
    const { el, onsaved } = render(gw({ label: "prod" }));
    expect(fileField(el).value).toBe("");
    expect(fileField(el).disabled, "the file is editable where the URL is not").toBe(false);
    expect(urlField(el).disabled).toBe(true);
    setInput(fileField(el), FILE);
    btn(el, "Save changes").click();
    await settle();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toBe("gw-test0001");
    expect(wireBody(update.mock.calls[0][1])).toBe(wireBody({ url: URL_, label: "prod", wireguard: FILE }));
    expect(onsaved).toHaveBeenCalledExactlyOnceWith("gw-test0001");
  });

  it("edit blanked clears: the stored file seeds the field and leaves the body when erased", async () => {
    const update = vi.spyOn(backend, "updateGateway").mockResolvedValue(gw());
    const { el } = render(gw({ wireguard: STORED }));
    expect(fileField(el).value).toBe(STORED);
    setInput(fileField(el), "");
    btn(el, "Save changes").click();
    await settle();
    expect(wireBody(update.mock.calls[0][1])).toBe(wireBody({ url: URL_ }));
  });

  it("Enter in the file field submits", async () => {
    const add = vi.spyOn(backend, "addGateway").mockResolvedValue(gw({ id: "gw-new" }));
    const { el } = render();
    setInput(urlField(el), URL_);
    setInput(fileField(el), FILE);
    fileField(el).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("the registry's 400 for a bad file is the form's error, verbatim", async () => {
    const reason = "WireGuard: /home/u/wg/chan.conf: line 3: Address: not an IP address";
    vi.spyOn(backend, "addGateway").mockRejectedValue(
      new ApiError(400, JSON.stringify({ error: reason })),
    );
    const { el, onsaved } = render();
    setInput(urlField(el), URL_);
    setInput(fileField(el), STORED);
    btn(el, "Add gateway").click();
    await settle();
    const alert = el.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent!.trim()).toBe(reason);
    expect(onsaved).not.toHaveBeenCalled();
  });

  it("a relative path is refused by the registry grammar on update too", async () => {
    // No spy: the row lives in the mock registry, which shares the real one's
    // path grammar and 400 sentence.
    const stored = await backend.addGateway({ url: URL_, label: "prod" });
    const { el, onsaved } = render(stored);
    setInput(fileField(el), "wg/chan.conf");
    btn(el, "Save changes").click();
    await settle();
    expect(el.querySelector('[role="alert"]')!.textContent!.trim()).toBe(
      "WireGuard: the file path must be absolute: wg/chan.conf",
    );
    expect(onsaved).not.toHaveBeenCalled();
  });

  it("the field explains the file's rules under the input", () => {
    const { el } = render();
    const hint = el.querySelector(".field-hint");
    expect(hint).not.toBeNull();
    // The template wraps the sentence, so read it as the browser lays it out.
    const text = hint!.textContent!.replace(/\s+/g, " ").trim();
    expect(text).toContain("wg-quick");
    expect(text).toContain("chmod 600");
    expect(text).toContain("takes effect as soon as it is saved");
    expect(text).toContain("changing the path restarts that gateway's tunnel");
  });
});
