// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { expect, test, vi, afterEach } from "vitest";

const bridgeScript = readFileSync("../../../desktop/src-tauri/src/privacy_bridge.js", "utf8");
const connectingScript = readFileSync("../../../desktop/src/connecting.js", "utf8");
const connectingHtml = readFileSync("../../../desktop/src/connecting.html", "utf8");
type Settings = { enabled: boolean; mask_terminal_secrets: boolean; revision: number };
type Bridge = { state: Settings; ready: boolean; error: string; set(patch: Partial<Settings>): Promise<void>; refresh(): Promise<void> };
const off = { enabled: false, mask_terminal_secrets: false, revision: 1 };
const on = { ...off, enabled: true, revision: 2 };
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; sessionStorage.removeItem("chan.connecting.reveals.v1"); });

test("every navigation conceals until read; a stale read cannot undo a newer event", async () => {
  let answer!: (settings: Settings) => void;
  let changed!: (event: { payload: Settings }) => void;
  const host = Object.assign(new EventTarget(), {
    __TAURI__: {
      core: { invoke: vi.fn(() => new Promise<Settings>((resolve) => { answer = resolve; })) },
      event: { listen: vi.fn((_name, callback) => { changed = callback; return Promise.resolve(() => {}); }) },
    },
    __CHAN_PRIVACY__: undefined as Bridge | undefined,
  });
  new Function("window", bridgeScript)(host);
  expect(host.__CHAN_PRIVACY__?.state.enabled).toBe(true);
  expect(host.__CHAN_PRIVACY__?.ready).toBe(false);
  await vi.waitFor(() => expect(answer).toBeDefined());
  changed({ payload: on });
  answer(off);
  await Promise.resolve();
  await Promise.resolve();
  expect(host.__CHAN_PRIVACY__?.state).toEqual(on);
  expect(host.__CHAN_PRIVACY__?.ready).toBe(true);
  changed({ payload: { ...off, revision: 3 } });
  expect(host.__CHAN_PRIVACY__?.state.enabled).toBe(false);
});

test("failed native subscription conceals fields and Retry restores live updates", async () => {
  let changed!: (event: { payload: Settings }) => void;
  const listen = vi.fn().mockRejectedValueOnce(new Error("temporarily unavailable"))
    .mockImplementation(async (_name, callback) => { changed = callback; return () => {}; });
  const host = Object.assign(new EventTarget(), {
    __TAURI__: { core: { invoke: vi.fn(async () => off) }, event: { listen } },
    __CHAN_PRIVACY__: undefined as Bridge | undefined,
  });
  new Function("window", bridgeScript)(host);
  await vi.waitFor(() => expect(host.__CHAN_PRIVACY__?.error).toContain("unavailable"));
  expect(host.__CHAN_PRIVACY__?.state.enabled).toBe(true);
  expect(host.__CHAN_PRIVACY__?.ready).toBe(false);
  await host.__CHAN_PRIVACY__!.refresh();
  expect(host.__CHAN_PRIVACY__?.state.enabled).toBe(false);
  changed({ payload: on });
  expect(host.__CHAN_PRIVACY__?.state.enabled).toBe(true);
});

test("connection headers and retries conceal addresses and errors and follow live changes", async () => {
  vi.useFakeTimers();
  document.body.innerHTML = connectingHtml.match(/<body[^>]*>([\s\S]*)<\/body>/)![1].replace(/<script[\s\S]*?<\/script>/g, "");
  const target = "https://private.example/?t=private-token";
  const host = Object.assign(new EventTarget(), {
    __TAURI__: { core: { invoke: vi.fn(async () => ({ reachable: false, detail: "Cannot reach private.example" })) } },
    __CHAN_CONNECTING__: { url: target, target },
    __CHAN_PRIVACY__: { state: on, ready: true },
  });
  new Function("window", "location", connectingScript)(host, { search: "" });
  await vi.advanceTimersByTimeAsync(42000);
  expect(document.body.innerHTML).not.toContain("private.example");
  expect(document.body.innerHTML).not.toContain("private-token");
  expect(document.body.classList.contains("is-gaveup")).toBe(true);
  expect(document.querySelector("#actions")?.hasAttribute("hidden")).toBe(false);
  (document.querySelector("#url button") as HTMLButtonElement).click();
  expect(document.querySelector("#url")?.textContent).toContain(target);
  expect(document.querySelector("#log")?.textContent).not.toContain("private.example");
  expect(document.querySelector("#url")?.getAttribute("title")).toBeNull();
  host.__CHAN_PRIVACY__.state = { ...off, revision: 3 };
  host.dispatchEvent(new CustomEvent("chan:privacy-change"));
  expect(document.querySelector("#log")?.textContent).toContain("private.example");
  host.__CHAN_PRIVACY__.state = { ...on, revision: 4 };
  host.dispatchEvent(new CustomEvent("chan:privacy-change"));
  expect(document.body.innerHTML).not.toContain("private.example");
});
