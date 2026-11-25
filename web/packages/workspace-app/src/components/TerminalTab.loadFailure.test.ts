// @vitest-environment jsdom
//
// A terminal whose core fails to load shows its own error where the terminal
// would be, with Retry when the next load can pass and Reload when the
// failure stays for the page's life, and never opens another terminal in its
// place. TerminalTab runs over the real loader and the real widget: the page's
// fetch serves the vendored core, refuses it or holds it, and the compiler and
// instantiation are the engine's own unless a case makes one fail. The loader
// keeps its kit for the page's life, so each case opens a page of its own: a
// fresh module graph, with the socket stand-in and the software canvas.
//
// What each case reads is what the user and the server would see: the error
// and its action, the sockets dialed (each one a PTY spawned or attached),
// the instances made, the canvases in the terminal's area and the console
// report.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { ABI } from "@chan/ghostty-web-ng/vt";
import { takeShownLoadFailures } from "../../vitest.setup";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../api/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/desktop")>()),
  reloadWindow: vi.fn(async () => {}),
}));

const CORE = readFileSync("../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm");
const SESSION = "sess-live";

/// The engine's own, kept before any case spies on them.
const instantiate = WebAssembly.instantiate.bind(WebAssembly) as (
  module: WebAssembly.Module,
  imports?: WebAssembly.Imports,
) => Promise<WebAssembly.Instance>;

type Page = Awaited<ReturnType<typeof openPage>>;
let page: Page | null = null;

/// A fresh page: every module the terminal loads, with nothing cached.
async function openPage() {
  vi.resetModules();
  const svelte = await import("svelte");
  const harness = await import("../__tests__/terminalTab");
  const widget = await import("../__tests__/ghosttyTab");
  const { terminalPreferences } = await import("../__tests__/standalone");
  const store = await import("../state/store.svelte");
  const tabs = await import("../state/tabs.svelte");
  const { api } = await import("../api/client");
  const { reloadWindow } = await import("../api/desktop");
  const { default: TerminalTab } = await import("./TerminalTab.svelte");
  harness.installTerminalDom();
  widget.installSoftwareCanvas();
  store.__testSetStandalonePreferences(terminalPreferences());
  const mounts: Array<Record<string, unknown>> = [];
  return {
    svelte,
    harness,
    store,
    tabs,
    api,
    reloadWindow: vi.mocked(reloadWindow),
    mounts,
    /// Mount a terminal for a seated tab in a focused pane.
    open(tab: import("../state/tabs.svelte").TerminalTab) {
      const mounted = widget.mountGhostty(TerminalTab, tab);
      mounts.push(mounted.component);
      return mounted;
    },
  };
}

/// The page's fetch of the core: served unless a case queued an answer for
/// the next request.
function serveCore() {
  const answers: Array<() => Promise<Response>> = [];
  const fetch = vi.fn((input: RequestInfo | URL) => {
    if (!String(input).includes("ghostty-vt")) return Promise.resolve(new Response(null, { status: 404 }));
    return answers.shift()?.() ?? Promise.resolve(new Response(CORE));
  });
  vi.stubGlobal("fetch", fetch);
  return {
    /// How many times the page asked for the core.
    requests: () => fetch.mock.calls.filter(([input]) => String(input).includes("ghostty-vt")).length,
    failNext(error: Error = new TypeError("Failed to fetch")): void {
      answers.push(() => Promise.reject(error));
    },
    /// Hold the next request; the returned call answers it, served or failed.
    holdNext(): (outcome: "serve" | "fail") => void {
      let answer!: (outcome: "serve" | "fail") => void;
      const held = new Promise<Response>((resolve, reject) => {
        answer = (outcome) =>
          outcome === "serve" ? resolve(new Response(CORE)) : reject(new TypeError("Failed to fetch"));
      });
      answers.push(() => held);
      return answer;
    },
  };
}

/// Instantiates the core with its build info reporting another major, which
/// the binding refuses.
async function instanceReportingMajor(module: WebAssembly.Module, major: number): Promise<WebAssembly.Instance> {
  const instance = await instantiate(module, {});
  const exports = { ...(instance.exports as Record<string, unknown>) };
  const memory = exports.memory as WebAssembly.Memory;
  const real = exports.ghostty_build_info as (data: number, out: number) => number;
  exports.ghostty_build_info = (data: number, out: number) => {
    if (data !== ABI.GhosttyBuildInfo.VERSION_MAJOR) return real(data, out);
    new DataView(memory.buffer).setUint32(out, major, true);
    return ABI.GhosttyResult.SUCCESS;
  };
  return { exports } as unknown as WebAssembly.Instance;
}

/// The error shown in the terminal's own area, if any.
function loadError(target: HTMLElement): HTMLElement | null {
  return target.querySelector<HTMLElement>(".terminal-main [role=alert]");
}

async function shownLoadError(target: HTMLElement): Promise<HTMLElement> {
  return vi.waitFor(() => {
    const error = loadError(target);
    expect(error, "the terminal's load error").not.toBeNull();
    return error!;
  });
}

function actions(error: HTMLElement): string[] {
  return [...error.querySelectorAll("button")].map((button) => (button.textContent ?? "").trim());
}

function action(error: HTMLElement, name: string): HTMLButtonElement {
  const button = [...error.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === name);
  if (!button) throw new Error(`the load error offers no ${name}: ${actions(error).join(", ")}`);
  return button;
}

function terminalArea(target: HTMLElement): HTMLElement {
  return target.querySelector<HTMLElement>(".terminal-host")!;
}

/// The ResizeObservers watching the terminal's area: start() wires one per
/// terminal it opens.
function areaWatchers(p: Page, target: HTMLElement): number {
  const area = terminalArea(target);
  return p.harness.resizeObservers.filter((observer) => observer.targets.includes(area)).length;
}

let warn: MockInstance<typeof console.warn>;

/// The console reports of a failed load.
function loadReports(): unknown[][] {
  return warn.mock.calls.filter(([first]) => typeof first === "string" && first.startsWith("[chan] ghostty-web failed to load"));
}

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  if (page) {
    for (const component of page.mounts.splice(0)) page.svelte.unmount(component);
    page.harness.resetTerminals();
    page.store.__testSetStandalonePreferences(null);
    page = null;
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a terminal whose core fails to load", () => {
  test("a failed fetch shows the terminal's own error with Retry, and opens and dials nothing", async () => {
    const core = serveCore();
    core.failNext(new TypeError("Failed to fetch"));
    page = await openPage();
    const [tab] = page.harness.seatTerminals([page.harness.terminalTab()]);
    const { target } = page.open(tab!);

    const error = await shownLoadError(target);
    expect(actions(error), "the next load can pass").toEqual(["Retry"]);
    expect(error.textContent, "the error says why").toContain("Failed to fetch");
    expect(page.harness.xterm.terminals, "no other terminal opened in its place").toHaveLength(0);
    expect(terminalArea(target).querySelector("canvas"), "no terminal in its area").toBeNull();
    expect(page.harness.TerminalSocket.all, "no PTY was dialed").toHaveLength(0);
    expect(areaWatchers(page, target), "nothing wired for a terminal").toBe(0);
    expect(loadReports(), "the failure is reported once").toHaveLength(1);
    await vi.waitFor(() => expect(document.activeElement, "the focused pane's action holds the keyboard").toBe(action(error, "Retry")));
    // The tab around the error still works.
    expect(await page.harness.openTerminalMenu(tab!)).toEqual(expect.arrayContaining(["Details", "Close tab"]));
    expect(takeShownLoadFailures(), "one error shown").toBe(1);
  });

  test("Retry after a failed fetch opens the terminal on Ghostty, with one PTY and one set of wiring", async () => {
    const core = serveCore();
    core.failNext();
    const compile = vi.spyOn(WebAssembly, "compile");
    page = await openPage();
    const [tab] = page.harness.seatTerminals([page.harness.terminalTab()]);
    const { target } = page.open(tab!);
    const error = await shownLoadError(target);

    action(error, "Retry").click();
    await vi.waitFor(() => expect(page!.harness.TerminalSocket.all, "the retry dialed its PTY").toHaveLength(1));
    expect(loadError(target), "the error is gone").toBeNull();
    expect(terminalArea(target).querySelectorAll("canvas"), "one terminal in its area").toHaveLength(1);
    expect(page.harness.xterm.terminals, "no other terminal").toHaveLength(0);
    expect(core.requests(), "the retry fetched the core again").toBe(2);
    expect(compile, "and compiled it once").toHaveBeenCalledTimes(1);
    expect(areaWatchers(page, target), "wired once").toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(page.harness.TerminalSocket.all, "still one PTY").toHaveLength(1);
    expect(takeShownLoadFailures(), "one error shown").toBe(1);
  });

  test("a live session survives its view's failure, and Retry attaches to it rather than spawning another", async () => {
    const core = serveCore();
    core.failNext();
    page = await openPage();
    const closeTerminal = vi.spyOn(page.api, "closeTerminal").mockResolvedValue(undefined);
    const [tab] = page.harness.seatTerminals([page.harness.terminalTab({ terminalSessionId: SESSION })]);
    const { target } = page.open(tab!);
    const error = await shownLoadError(target);
    expect(page.harness.TerminalSocket.all, "nothing dialed while the view failed").toHaveLength(0);
    expect(tab!.terminalSessionId, "the tab keeps its session").toBe(SESSION);

    action(error, "Retry").click();
    await vi.waitFor(() => expect(page!.harness.TerminalSocket.all).toHaveLength(1));
    const url = new URL(page.harness.TerminalSocket.all[0]!.url);
    expect(url.searchParams.get("session"), "the retry attaches to the live session").toBe(SESSION);
    expect(closeTerminal, "the live session was never ended").not.toHaveBeenCalled();
    expect(takeShownLoadFailures(), "one error shown").toBe(1);
  });

  test("a failed compile shows Reload, which reloads the window, and the next terminal fails the same way without fetching again", async () => {
    const core = serveCore();
    vi.spyOn(WebAssembly, "compile").mockRejectedValue(new WebAssembly.CompileError("unsupported SIMD"));
    page = await openPage();
    const [first, second] = page.harness.seatTerminals([
      page.harness.terminalTab({ id: "term-1" }),
      page.harness.terminalTab({ id: "term-2" }),
    ]);
    const { target } = page.open(first!);
    const error = await shownLoadError(target);
    expect(actions(error), "only a reload can help").toEqual(["Reload window"]);
    expect(error.textContent, "the error says why").toContain("unsupported SIMD");
    expect(page.harness.xterm.terminals, "no other terminal opened in its place").toHaveLength(0);
    expect(page.harness.TerminalSocket.all, "no PTY was dialed").toHaveLength(0);

    action(error, "Reload window").click();
    expect(page.reloadWindow, "the window reloads").toHaveBeenCalledTimes(1);

    const next = page.open(second!);
    expect(actions(await shownLoadError(next.target)), "the next terminal").toEqual(["Reload window"]);
    expect(core.requests(), "the failure was kept").toBe(1);
    expect(page.harness.xterm.terminals).toHaveLength(0);
    expect(takeShownLoadFailures(), "two errors shown").toBe(2);
  });

  test("a terminal whose own instance cannot be made shows Retry, and Retry makes it from the module compiled before", async () => {
    const core = serveCore();
    const compile = vi.spyOn(WebAssembly, "compile");
    let instances = 0;
    const made = vi.spyOn(WebAssembly, "instantiate").mockImplementation(((module: WebAssembly.Module) => {
      instances += 1;
      // The loader's check instance passes; the terminal's own is the second.
      if (instances === 2) {
        return Promise.reject(new RangeError("WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory for new instance"));
      }
      return instantiate(module, {});
    }) as typeof WebAssembly.instantiate);
    page = await openPage();
    const [tab] = page.harness.seatTerminals([page.harness.terminalTab()]);
    const { target } = page.open(tab!);
    const error = await shownLoadError(target);
    expect(actions(error), "the next instance can pass").toEqual(["Retry"]);
    expect(error.textContent).toContain("Out of memory");
    expect(page.harness.xterm.terminals, "no other terminal opened in its place").toHaveLength(0);
    expect(page.harness.TerminalSocket.all, "no PTY was dialed").toHaveLength(0);

    action(error, "Retry").click();
    await vi.waitFor(() => expect(page!.harness.TerminalSocket.all, "the retry dialed its PTY").toHaveLength(1));
    expect(terminalArea(target).querySelectorAll("canvas")).toHaveLength(1);
    expect(made, "one more instance, for the terminal").toHaveBeenCalledTimes(3);
    expect(core.requests(), "no second fetch").toBe(1);
    expect(compile, "no second compile").toHaveBeenCalledTimes(1);
    expect(takeShownLoadFailures(), "one error shown").toBe(1);
  });

  test("a core the binding refuses shows Reload", async () => {
    serveCore();
    vi.spyOn(WebAssembly, "instantiate").mockImplementation(((module: WebAssembly.Module) =>
      instanceReportingMajor(module, 2)) as typeof WebAssembly.instantiate);
    page = await openPage();
    const [tab] = page.harness.seatTerminals([page.harness.terminalTab()]);
    const { target } = page.open(tab!);
    const error = await shownLoadError(target);
    expect(actions(error), "only a corrected build can help").toEqual(["Reload window"]);
    expect(error.textContent, "the error names the core").toContain("libghostty-vt 2.x");
    expect(page.harness.xterm.terminals, "no other terminal opened in its place").toHaveLength(0);
    expect(page.harness.TerminalSocket.all, "no PTY was dialed").toHaveLength(0);
    expect(takeShownLoadFailures(), "one error shown").toBe(1);
  });
});

describe("a terminal closed or restarted while its core loads", () => {
  test("closing the tab while the core loads makes no instance for it and dials nothing", async () => {
    const core = serveCore();
    const release = core.holdNext();
    const made = vi.spyOn(WebAssembly, "instantiate");
    page = await openPage();
    const [tab] = page.harness.seatTerminals([page.harness.terminalTab()]);
    page.open(tab!);
    await vi.waitFor(() => expect(core.requests(), "the load is in flight").toBe(1));

    expect(await page.tabs.closeTabsInPane(page.harness.TERMINAL_PANE, { force: true })).toBe(true);
    page.svelte.unmount(page.mounts.pop()!);
    release("serve");
    await vi.waitFor(() => expect(made, "the loader checked the core").toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(made, "no instance for the closed terminal").toHaveBeenCalledTimes(1);
    expect(page.harness.TerminalSocket.all, "no PTY was dialed").toHaveLength(0);
    expect(page.harness.xterm.terminals).toHaveLength(0);
    expect(loadReports(), "nothing failed").toHaveLength(0);
    expect(takeShownLoadFailures()).toBe(0);
  });

  test("a load that fails after its tab closed reports nothing", async () => {
    const core = serveCore();
    const release = core.holdNext();
    page = await openPage();
    const [tab] = page.harness.seatTerminals([page.harness.terminalTab()]);
    page.open(tab!);
    await vi.waitFor(() => expect(core.requests(), "the load is in flight").toBe(1));

    page.svelte.unmount(page.mounts.pop()!);
    release("fail");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(loadReports(), "no report for a terminal nobody shows").toHaveLength(0);
    expect(page.harness.xterm.terminals).toHaveLength(0);
    expect(page.harness.TerminalSocket.all).toHaveLength(0);
    expect(takeShownLoadFailures()).toBe(0);
  });

  test("restarting while the core loads opens one terminal on one instance, with one PTY", async () => {
    const core = serveCore();
    const release = core.holdNext();
    const made = vi.spyOn(WebAssembly, "instantiate");
    page = await openPage();
    const [tab] = page.harness.seatTerminals([page.harness.terminalTab()]);
    const { target } = page.open(tab!);
    await vi.waitFor(() => expect(core.requests(), "the load is in flight").toBe(1));

    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.terminal.restart" } }));
    await page.svelte.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release("serve");
    await vi.waitFor(() => expect(page!.harness.TerminalSocket.all, "the terminal dialed its PTY").toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(page.harness.TerminalSocket.all, "one PTY").toHaveLength(1);
    expect(terminalArea(target).querySelectorAll("canvas"), "one terminal").toHaveLength(1);
    expect(made, "the check and one instance for the terminal").toHaveBeenCalledTimes(2);
    expect(areaWatchers(page, target), "wired once").toBe(1);
    expect(loadError(target)).toBeNull();
    expect(page.harness.xterm.terminals).toHaveLength(0);
    expect(takeShownLoadFailures()).toBe(0);
  });

  // A view that failed to load never dialed, so no socket carries the close
  // frame; the session still ends with its tab.
  test("closing a terminal whose view failed to load ends its live session", async () => {
    const core = serveCore();
    core.failNext();
    page = await openPage();
    const closeTerminal = vi.spyOn(page.api, "closeTerminal").mockResolvedValue(undefined);
    const [tab] = page.harness.seatTerminals([page.harness.terminalTab({ terminalSessionId: SESSION })]);
    const { target } = page.open(tab!);
    await vi.waitFor(() => expect(loadError(target) ?? page!.harness.TerminalSocket.all[0]).toBeTruthy());

    expect(await page.tabs.closeTabsInPane(page.harness.TERMINAL_PANE, { force: true })).toBe(true);

    const closeFrames = page.harness.TerminalSocket.all.flatMap((socket) =>
      page!.harness.sentFrames(socket).filter((frame) => frame.type === "close"),
    );
    const routeCloses = closeTerminal.mock.calls.filter(([id]) => id === SESSION);
    expect(closeFrames.length + routeCloses.length, "the server is told once to end the session").toBe(1);
    takeShownLoadFailures();
  });
});
