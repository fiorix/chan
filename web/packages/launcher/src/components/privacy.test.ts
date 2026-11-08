import { afterEach, expect, test, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { privacy, setPrivacy } from "@chan/web-shared/privacy";
import DevserverForm from "./DevserverForm.svelte";
import GatewayForm from "./GatewayForm.svelte";
import Gateways from "./Gateways.svelte";
import Library from "./Library.svelte";
import { library } from "../state/library.svelte";
import type { DevserverEntry, GatewayEntry } from "../api/library";

vi.mock("../api/backend", async () => ({ backend: (await import("../api/mock")).mockApi }));

const computer: DevserverEntry = {
  id: "private-test", url: "http://127.0.0.1:8787/?t=secret-test-token", host: "127.0.0.1", port: 8787,
  label: "private-machine", script: "ssh private-host -L 8787:localhost:8787", has_token: true,
  library_id: null, status: "disconnected", pending_signin: false, auto_hide_control: false,
  os: "linux", pretty_name: null, gateway_id: null, gateway_url: "", shared: false, native_trust_required: false,
};
const gateway: GatewayEntry = {
  id: "private-gateway", url: "https://private-gateway.example", label: "private-gateway-name", enabled: true,
  status: "disconnected", pending_signin: false, devserver_count: 0, last_error: null, wireguard: "/private/path.conf",
};
let components: ReturnType<typeof mount>[] = [];
afterEach(async () => {
  for (const component of components) await unmount(component);
  components = [];
  document.body.innerHTML = "";
  library.gateways = [];
  library.devservers = [];
  await setPrivacy({ enabled: false });
});

test("Computers cards conceal names, addresses, errors and hover text without hiding actions", async () => {
  library.workspaces = [];
  library.windows = [];
  library.devservers = [computer];
  library.gateways = [{ ...gateway, last_error: "Cannot connect to private-gateway.example" }];
  await setPrivacy({ enabled: true });
  components.push(mount(Library, { target: document.body }));
  components.push(mount(Gateways, { target: document.body }));
  flushSync();
  for (const value of [computer.label, computer.host, gateway.url, gateway.label, gateway.wireguard!, "Cannot connect to private-gateway.example"]) {
    expect(document.body.innerHTML).not.toContain(value);
  }
  expect(document.querySelector('[aria-label="Connect computer"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Edit computer config"]')).not.toBeNull();
  (document.querySelector('[aria-label="Reveal gateway name"]') as HTMLButtonElement).click();
  flushSync();
  expect(document.body.textContent).toContain(gateway.label);
  expect(document.body.innerHTML).not.toContain(gateway.url);
  expect(document.body.innerHTML).not.toContain(computer.host);
});

test("computer and gateway forms conceal individual fields live without losing their values", async () => {
  await setPrivacy({ enabled: false });
  components.push(mount(DevserverForm, { target: document.body, props: { editing: computer, onsaved: vi.fn() } }));
  components.push(mount(GatewayForm, { target: document.body, props: { editing: gateway, onsaved: vi.fn() } }));
  flushSync();
  expect(document.querySelectorAll("input").length).toBeGreaterThan(3);
  await setPrivacy({ enabled: true });
  flushSync();
  for (const value of [computer.label, computer.url, computer.script, gateway.url, gateway.label, gateway.wireguard!]) {
    expect(document.body.innerHTML).not.toContain(value);
  }
  (document.querySelector('[aria-label="Reveal computer address"]') as HTMLButtonElement).click();
  flushSync();
  expect(document.querySelector<HTMLInputElement>('input[placeholder^="127.0.0.1"]')?.value).toBe(computer.url);
  expect(document.querySelector("textarea")).toBeNull();
  expect(document.body.innerHTML).not.toContain(gateway.url);
  await setPrivacy({ enabled: false });
  flushSync();
  expect(document.querySelector("textarea")?.value).toBe(computer.script);
  expect(privacy.enabled).toBe(false);
});
