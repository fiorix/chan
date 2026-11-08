// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { HttpError } from "@chan/web-shared/api";

const mocks = vi.hoisted(() => ({
  discovery: vi.fn(),
  listTokens: vi.fn(),
  listOwnedDevservers: vi.fn(),
  listIncomingShares: vi.fn(),
}));

vi.mock("../lib/api", async () => ({
  HttpError: (await import("@chan/web-shared/api")).HttpError,
  api: mocks,
}));

let svelte: typeof import("svelte");

const URL = "https://proxy.example.test/v1/tunnel";
const mounted: Array<Record<string, unknown>> = [];
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
const runner = globalThis as unknown as {
  process: {
    on: (event: "unhandledRejection", callback: (reason: unknown) => void) => void;
    off: (event: "unhandledRejection", callback: (reason: unknown) => void) => void;
  };
};

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await svelte.tick();
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountView(mod: string, props: Record<string, unknown> = {}): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  const Component = (await import(mod)).default;
  mounted.push(svelte.mount(Component, { target, props }) as Record<string, unknown>);
  await flush();
  return target;
}

function text(target: HTMLElement, selector: string): string {
  const region = target.querySelector(selector);
  expect(region, selector).not.toBeNull();
  return region!.textContent ?? "";
}

function expectCommand(value: string, url = URL): void {
  expect(value).toContain("export CHAN_TUNNEL_TOKEN=<token>");
  expect(value).toContain(`chan devserver start --tunnel-url ${url}`);
  expect(value).toContain("chan devserver run");
  expect(value).not.toContain("--tunnel-token");
}

beforeEach(async () => {
  vi.resetModules();
  svelte = await import("svelte");
  vi.clearAllMocks();
  unhandled.length = 0;
  runner.process.on("unhandledRejection", onUnhandled);
  mocks.discovery.mockResolvedValue({ tunnel_url: URL });
  mocks.listTokens.mockResolvedValue([]);
  mocks.listOwnedDevservers.mockResolvedValue([]);
  mocks.listIncomingShares.mockResolvedValue([]);
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await svelte.unmount(component);
  document.body.innerHTML = "";
  runner.process.off("unhandledRejection", onUnhandled);
});

test("the empty devserver hint carries this gateway's endpoint", async () => {
  const target = await mountView("./Devservers.svelte", { devservers: [] });
  expectCommand(text(target, ".empty p.muted"));
});

test("the always-visible intro carries this gateway's endpoint", async () => {
  mocks.listOwnedDevservers.mockResolvedValue([{ devserver_id: "dev1", label: "laptop", grant_count: 0 }]);
  const target = await mountView("./Devservers.svelte", { devservers: [{ devserver_id: "dev1", status: "online" }] });
  expect(target.querySelector(".empty")).toBeNull();
  expectCommand(text(target, ".block > p"));
});

test("an offline row points to the complete command above", async () => {
  mocks.listOwnedDevservers.mockResolvedValue([{ devserver_id: "dev1", label: "laptop", grant_count: 0 }]);
  const target = await mountView("./Devservers.svelte", { devservers: [] });
  const row = text(target, ".card.offline .meta");
  expect(row).toContain("command above");
  expect(row).not.toContain("--tunnel-token");
  expectCommand(text(target, ".block > p"));
});

test("the Tokens hint carries the environment token and endpoint", async () => {
  const target = await mountView("./Tokens.svelte");
  expectCommand(text(target, ".page > p.muted"));
});

test("both views share one discovery request per page load", async () => {
  const devservers = await mountView("./Devservers.svelte", { devservers: [] });
  const tokens = await mountView("./Tokens.svelte");
  expectCommand(text(devservers, ".block > p"));
  expectCommand(text(tokens, ".page > p.muted"));
  expect(mocks.discovery).toHaveBeenCalledTimes(1);
});

test("pending discovery uses the placeholder until the endpoint arrives", async () => {
  let resolve: (value: { tunnel_url: string }) => void = () => {};
  mocks.discovery.mockReturnValue(new Promise((done) => { resolve = done; }));
  const devservers = await mountView("./Devservers.svelte", { devservers: [] });
  const tokens = await mountView("./Tokens.svelte");
  for (const value of [text(devservers, ".block > p"), text(devservers, ".empty p.muted"), text(tokens, ".page > p.muted")]) {
    expectCommand(value, "<this gateway's tunnel URL>");
    expect(value).toContain("gateway did not report its tunnel URL");
  }
  resolve({ tunnel_url: URL });
  await flush();
  expectCommand(text(devservers, ".block > p"));
  expectCommand(text(tokens, ".page > p.muted"));
  expect(mocks.discovery).toHaveBeenCalledTimes(1);
});

test("failed discovery leaves placeholders and no unhandled rejection", async () => {
  mocks.discovery.mockRejectedValue(new HttpError(503, "unavailable"));
  const devservers = await mountView("./Devservers.svelte", { devservers: [] });
  const tokens = await mountView("./Tokens.svelte");
  for (const value of [text(devservers, ".block > p"), text(devservers, ".empty p.muted"), text(tokens, ".page > p.muted")]) {
    expectCommand(value, "<this gateway's tunnel URL>");
    expect(value).toContain("gateway did not report its tunnel URL");
  }
  expect(unhandled).toEqual([]);
  expect(mocks.discovery).toHaveBeenCalledTimes(1);
});
