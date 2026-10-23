// @vitest-environment jsdom

import { mount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import App from "../App.svelte";
import { api } from "../api/client";
import { installDemoWorkspace } from "../demo/install";
import { teardownDemoApp } from "../demo/teardown";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { allCommands } from "../state/commands";
import "../state/commands/install";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());

globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as typeof requestAnimationFrame;
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
Object.defineProperty(document, "fonts", { configurable: true, value: { load: vi.fn(async () => [{}]), ready: Promise.resolve() } });
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }),
});

const mounted: Array<Record<string, unknown>> = [];
let timers: TimerTrack | null = null;

afterEach(async () => {
  vi.useRealTimers();
  await teardownDemoApp({ mounted, timers });
  timers = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function choose(color: string): void {
  const command = allCommands().find((entry) => entry.id === "app.pane.focusColor." + color);
  expect(command).toBeDefined();
  command!.run();
}

test("a page exit during extension load flushes the painted layout", async () => {
  timers = trackTimers();
  const demo = installDemoWorkspace({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1_700_000_000_000, fileCount: 0, textCount: 0 },
    files: [],
  });
  const hash = new URLSearchParams();
  hash.set("s", JSON.stringify({ k: "s", d: "r", a: { k: "l", t: [] }, b: { k: "l", t: [] }, wc: "p" }));
  history.replaceState({}, "", "/work/?w=w-focus-exit#" + hash.toString());
  let started!: () => void;
  let release!: (value: Awaited<ReturnType<typeof api.extensions>>) => void;
  const extensionStarted = new Promise<void>((resolve) => { started = resolve; });
  vi.spyOn(api, "extensions").mockImplementationOnce(() => {
    started();
    return new Promise((resolve) => { release = resolve; });
  });
  const save = vi.spyOn(api, "putSession");
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(App, { target }));
  await extensionStarted;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const address = location.href;
  const saves = save.mock.calls.length;
  try {
    choose("orange");
    expect(location.href).toBe(address);
    await vi.advanceTimersByTimeAsync(750);
    expect(save).toHaveBeenCalledTimes(saves);
    window.dispatchEvent(new Event("pagehide"));
    const saved = new URLSearchParams(location.hash.slice(1)).get("s");
    expect(JSON.parse(saved ?? "null")).toMatchObject({ wc: "o" });
    expect(sessionStorage.getItem("chan.layout.ownReload:w-focus-exit")).toBe("1");
    expect(demo.getSession("w-focus-exit")).toMatchObject({ layout: { wc: "o" } });
  } finally {
    release([]);
  }
});
