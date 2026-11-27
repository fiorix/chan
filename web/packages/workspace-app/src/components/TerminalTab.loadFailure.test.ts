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
// What each case reads is what the user and the server would see: the error,
// what it says and its actions, where the keyboard is, the sockets dialed
// (each one a PTY spawned or attached), the instances made, the canvases in
// the terminal's area and the console report.

import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { ABI } from "@chan/ghostty-web-ng/vt";
import { takeShownLoadFailures } from "../../vitest.setup";

vi.mock("../api/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/desktop")>()),
  reloadWindow: vi.fn(async () => {}),
}));

const CORE = readFileSync("../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm");
const SESSION = "sess-live";

// What the error says: what failed, then what still holds and the way past it.
const FAILED = "The terminal view could not load.";
const NO_SHELL = "No shell was started.";
const SHELL_RUNS = "The failure did not end its shell; Retry attaches to it.";
const FINAL = "This window will not load the terminal again until it is reloaded.";
const FINAL_SHELL_RUNS = "The failure did not end its shell; the reload attaches to it.";

/// The engine's own, kept before any case spies on them.
const instantiate = WebAssembly.instantiate.bind(WebAssembly) as (
  module: WebAssembly.Module,
  imports?: WebAssembly.Imports,
) => Promise<WebAssembly.Instance>;

type Page = Awaited<ReturnType<typeof openPage>>;
let page: Page | null = null;

/// A fresh page: every module the terminal loads, with nothing cached, and
/// the terminal settings `terminal` names.
async function openPage(terminal: Parameters<typeof import("../__tests__/standalone").terminalPreferences>[0] = {}) {
  vi.resetModules();
  const svelte = await import("svelte");
  const harness = await import("../__tests__/terminalTab");
  const widget = await import("../__tests__/ghosttyTab");
  const { terminalPreferences } = await import("../__tests__/standalone");
  const store = await import("../state/store.svelte");
  const tabs = await import("../state/tabs.svelte");
  const confirm = await import("../state/confirm.svelte");
  const { api } = await import("../api/client");
  const { reloadWindow } = await import("../api/desktop");
  const { terminalStatusProps } = await import("../__tests__/terminalStatusProps.svelte");
  const { default: TerminalTab } = await import("./TerminalTab.svelte");
  harness.installTerminalDom();
  widget.installSoftwareCanvas();
  store.__testSetStandalonePreferences(terminalPreferences(terminal));
  // The mocked modules outlive the page's module graph, and so do their
  // calls.
  vi.mocked(reloadWindow).mockClear();
  const mounts: Array<Record<string, unknown>> = [];
  return {
    svelte,
    harness,
    store,
    tabs,
    confirm,
    api,
    reloadWindow: vi.mocked(reloadWindow),
    mounts,
    /// Hold the next load of the terminal's font; `release` answers it with
    /// the face loaded.
    holdNextFont() {
      let release!: () => void;
      let asked = false;
      vi.mocked(document.fonts.load).mockImplementationOnce(() => {
        asked = true;
        return new Promise<FontFace[]>((resolve) => (release = () => resolve([{} as FontFace])));
      });
      return { asked: () => asked, release: () => release() };
    },
    /// Mount a terminal for a seated tab in a focused pane.
    open(tab: import("../state/tabs.svelte").TerminalTab) {
      const mounted = widget.mountGhostty(TerminalTab, tab);
      mounts.push(mounted.component);
      return mounted;
    },
    /// Mount a terminal whose placement a case changes, as the pane tree
    /// changes it: `focused` is the pane's focus on its active tab.
    place(tab: import("../state/tabs.svelte").TerminalTab, place: { active: boolean; focused: boolean }) {
      const props = terminalStatusProps(tab);
      Object.assign(props, place);
      const target = document.createElement("div");
      document.body.append(target);
      mounts.push(svelte.mount(TerminalTab, { target, props }) as Record<string, unknown>);
      return { target, props };
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

/// The specifiers `keepFailedImport` failed, unmocked after each case.
const keptFailures: string[] = [];

/// An engine that keeps a failed module import for the page's life, as
/// WebKit does: from now on every import of `specifier` rejects, answered
/// from the failure the engine keeps even once the file is served again,
/// while the module under another URL still loads. Installed after the page
/// opened, so a module it imported up front stays loaded. Returns how many
/// times the page asked for `specifier`.
function keepFailedImport(specifier: string): () => number {
  let asked = 0;
  keptFailures.push(specifier);
  vi.doMock(specifier, () => {
    asked += 1;
    throw new TypeError("Importing a module script failed.");
  });
  return () => asked;
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

/// The ways out the error offers a terminal tab: Retry when the next load can
/// pass, Reload window always, and Close.
function waysOut(p: Page, tab: import("../state/tabs.svelte").TerminalTab, retry: boolean): string[] {
  return [...(retry ? ["Retry"] : []), "Reload window", `Close ${p.tabs.tabLabel(tab)}`];
}

/// What a screen reader reads after an action's name: the text of the
/// elements its aria-describedby names.
function description(button: HTMLElement): string {
  return (button.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? `<no element ${id}>`)
    .join(" ");
}

/// Whether the keyboard is on an element inside the error.
function errorHoldsKeyboard(error: HTMLElement): boolean {
  return document.activeElement !== null && error.contains(document.activeElement);
}

/// Whether the keyboard is on one of the error's actions.
function actionHoldsKeyboard(error: HTMLElement): boolean {
  return [...error.querySelectorAll("button")].some((button) => button === document.activeElement);
}

/// Counts the listeners the page's terminals hold on the loader's next
/// passing load: each one subscribed and not yet released. Installed after
/// `openPage`, on the loader of that page's module graph.
async function loadListeners(): Promise<() => number> {
  const backend = await import("../terminal/backend");
  const subscribe = backend.onGhosttyKitLoaded;
  let held = 0;
  vi.spyOn(backend, "onGhosttyKitLoaded").mockImplementation((listener) => {
    const release = subscribe(listener);
    let released = false;
    held += 1;
    return () => {
      if (!released) held -= 1;
      released = true;
      release();
    };
  });
  return () => held;
}

/// The tabs seated in the terminal's pane.
function seated(p: Page): string[] {
  const pane = p.tabs.activeLayout().nodes[p.harness.TERMINAL_PANE] as { tabs: Array<{ id: string }> };
  return pane.tabs.map((tab) => tab.id);
}

function terminalArea(target: HTMLElement): HTMLElement {
  return target.querySelector<HTMLElement>(".terminal-host")!;
}

type TabStop = { attribute: string | null; tabIndex: number };

/// The terminal's area and its one input as a Tab walk reads them: by the
/// tabindex attribute and by `tabIndex`.
function tabStops(target: HTMLElement): { host: TabStop; input: TabStop } {
  const host = terminalArea(target);
  const inputs = host.querySelectorAll("textarea");
  expect(inputs, "one terminal input in its area").toHaveLength(1);
  const stop = (el: HTMLElement): TabStop => ({ attribute: el.getAttribute("tabindex"), tabIndex: el.tabIndex });
  return { host: stop(host), input: stop(inputs[0]!) };
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

// The first page a file opens pays the cold transform of the terminal's
// module graph and the widget's, which under host load comes near the 30 s
// case timeout. The warm-up pays it once, under a budget of its own, so each
// case's timeout bounds only that case; every case still opens a fresh page.
const WARM_UP_MS = 180_000;

beforeAll(async () => {
  const warm = await openPage();
  await import("@chan/ghostty-web-ng");
  warm.harness.resetTerminals();
  warm.store.__testSetStandalonePreferences(null);
}, WARM_UP_MS);

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
  for (const specifier of keptFailures.splice(0)) vi.doUnmock(specifier);
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
    expect(actions(error), "the next load can pass").toEqual(waysOut(page, tab!, true));
    expect(error.textContent, "the error says why").toContain("Failed to fetch");
    expect(terminalArea(target).children, "no terminal opened in its place").toHaveLength(0);
    expect(terminalArea(target).querySelector("canvas"), "no terminal in its area").toBeNull();
    expect(page.harness.TerminalSocket.all, "no PTY was dialed").toHaveLength(0);
    expect(areaWatchers(page, target), "nothing wired for a terminal").toBe(0);
    expect(loadReports(), "the failure is reported once").toHaveLength(1);
    await vi.waitFor(() => expect(document.activeElement, "the focused pane's action holds the keyboard").toBe(action(error, "Retry")));
    expect(error.hasAttribute("tabindex"), "a card with Retry is no focus target of its own").toBe(false);
    // The tab around the error still works.
    expect(await page.harness.openTerminalMenu(tab!)).toEqual(expect.arrayContaining(["Details", "Close tab"]));
    expect(takeShownLoadFailures(), "one error shown").toBe(1);
  });

  test("Retry after a failed fetch opens the terminal, with one PTY and one set of wiring", async () => {
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
    expect(error.textContent, "the error says the failure did not end the shell, and Retry attaches to it").toContain(SHELL_RUNS);
    expect(error.textContent).not.toContain(NO_SHELL);
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
    expect(actions(error), "only a reload can help").toEqual(waysOut(page, first!, false));
    expect(error.textContent, "the error says why").toContain("unsupported SIMD");
    expect(terminalArea(target).children, "no terminal opened in its place").toHaveLength(0);
    expect(page.harness.TerminalSocket.all, "no PTY was dialed").toHaveLength(0);

    action(error, "Reload window").click();
    expect(page.reloadWindow, "the window reloads").toHaveBeenCalledTimes(1);

    const next = page.open(second!);
    expect(actions(await shownLoadError(next.target)), "the next terminal").toEqual(waysOut(page, second!, false));
    expect(core.requests(), "the failure was kept").toBe(1);
    expect(terminalArea(next.target).children, "no terminal opened in its place").toHaveLength(0);
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
    expect(actions(error), "the next instance can pass").toEqual(waysOut(page, tab!, true));
    expect(error.textContent).toContain("Out of memory");
    expect(terminalArea(target).children, "no terminal opened in its place").toHaveLength(0);
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
    expect(actions(error), "only a corrected build can help").toEqual(waysOut(page, tab!, false));
    expect(error.textContent, "the error names the core").toContain("libghostty-vt 2.x");
    expect(terminalArea(target).children, "no terminal opened in its place").toHaveLength(0);
    expect(page.harness.TerminalSocket.all, "no PTY was dialed").toHaveLength(0);
    expect(takeShownLoadFailures(), "one error shown").toBe(1);
  });
});

describe("what a terminal's load error says and offers", () => {
  test("a fresh tab's error is the tab's failure card: what failed, that no shell was started, and Retry, Reload window and Close", async () => {
    const core = serveCore();
    core.failNext(new TypeError("Failed to fetch"));
    page = await openPage();
    const [tab] = page.harness.seatTerminals([page.harness.terminalTab()]);
    const { target } = page.open(tab!);
    const error = await shownLoadError(target);

    expect(error.classList.contains("pane-failed"), "the card every failed tab body shows").toBe(true);
    expect(actions(error)).toEqual(waysOut(page, tab!, true));
    const text = error.textContent ?? "";
    expect(text, "what failed").toContain(FAILED);
    expect(text, "no shell to lose").toContain(NO_SHELL);
    expect(text, "no cause the page does not know").not.toContain("engine");
    const retry = action(error, "Retry");
    expect(description(retry), "the action names what it answers").toBe(`${FAILED} Failed to fetch ${NO_SHELL}`);
    expect(description(action(error, "Reload window"))).toBe(description(retry));

    action(error, "Reload window").click();
    expect(page.reloadWindow, "Reload window reloads the window").toHaveBeenCalledTimes(1);
    expect(core.requests(), "and loads nothing in this page").toBe(1);
    expect(page.harness.TerminalSocket.all).toHaveLength(0);

    action(error, `Close ${page.tabs.tabLabel(tab!)}`).click();
    await vi.waitFor(() => expect(seated(page!), "Close closes the tab").not.toContain(tab!.id));
    expect(page.harness.TerminalSocket.all, "and dials nothing").toHaveLength(0);
    expect(takeShownLoadFailures(), "one error shown").toBe(1);
  });

  test("a final failure says this window will not load the terminal again until it is reloaded, and its Reload window waits to be chosen", async () => {
    serveCore();
    vi.spyOn(WebAssembly, "compile").mockRejectedValue(new WebAssembly.CompileError("unsupported SIMD"));
    page = await openPage();
    const [fresh, live] = page.harness.seatTerminals([
      page.harness.terminalTab({ id: "term-1" }),
      page.harness.terminalTab({ id: "term-2", terminalSessionId: SESSION }),
    ]);
    const { target } = page.open(fresh!);
    const error = await shownLoadError(target);
    expect(actions(error)).toEqual(waysOut(page, fresh!, false));
    expect(error.textContent).toContain(FAILED);
    expect(error.textContent).toContain(`${FINAL} ${NO_SHELL}`);
    expect(error.textContent, "no cause the page does not know").not.toContain("engine");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(actionHoldsKeyboard(error), "a typed-ahead Enter or Space must not reload the window").toBe(false);
    expect(description(action(error, "Reload window"))).toBe(`${FAILED} unsupported SIMD ${FINAL} ${NO_SHELL}`);

    const next = await shownLoadError(page.open(live!).target);
    expect(next.textContent, "a live session's reload attaches to it").toContain(`${FINAL} ${FINAL_SHELL_RUNS}`);
    expect(page.reloadWindow).not.toHaveBeenCalled();
    expect(takeShownLoadFailures(), "two errors shown").toBe(2);
  });

  test("a final failure in the focused pane takes the keyboard from the surface it came from and rests it on the card, not on an action", async () => {
    serveCore();
    vi.spyOn(WebAssembly, "compile").mockRejectedValue(new WebAssembly.CompileError("unsupported SIMD"));
    page = await openPage();
    // The editor the user opened the terminal from keeps the keyboard until
    // something takes it.
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    editor.tabIndex = 0;
    document.body.append(editor);
    editor.focus();
    expect(document.activeElement, "the editor holds the keyboard at the mount").toBe(editor);
    const [tab] = page.harness.seatTerminals([page.harness.terminalTab()]);
    const { target, props } = page.place(tab!, { active: true, focused: true });
    const error = await shownLoadError(target);
    expect(actions(error), "a final failure").toEqual(waysOut(page, tab!, false));

    await vi.waitFor(() => expect(document.activeElement, "the card itself holds the keyboard").toBe(error));
    expect(actionHoldsKeyboard(error), "no action holds it").toBe(false);
    expect(error.getAttribute("tabindex"), "and it holds it outside the Tab order").toBe("-1");

    props.focused = false;
    page.svelte.flushSync();
    expect(errorHoldsKeyboard(error), "another pane took focus").toBe(false);
    expect(takeShownLoadFailures(), "one error shown").toBe(1);
  });

  test("a failure under an open dialog leaves the keyboard with the dialog", async () => {
    const core = serveCore();
    const answer = core.holdNext();
    page = await openPage();
    const [tab] = page.harness.seatTerminals([page.harness.terminalTab()]);
    const { target } = page.open(tab!);
    await vi.waitFor(() => expect(core.requests(), "the core is asked for").toBe(1));
    // A confirm opens while the core loads and owns the keyboard; its
    // button holds it.
    const dialogButton = document.createElement("button");
    document.body.append(dialogButton);
    const confirmed = page.confirm.uiConfirm({ title: "Close?", message: "Close the tab?", confirmLabel: "Close" });
    dialogButton.focus();

    answer("fail");
    const error = await shownLoadError(target);
    expect(actions(error), "a retryable failure").toEqual(waysOut(page, tab!, true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.activeElement, "the dialog keeps the keyboard").toBe(dialogButton);

    page.confirm.resolveConfirm(false);
    await confirmed;
    expect(takeShownLoadFailures(), "one error shown").toBe(1);
  });

  test("the error's action gives up the keyboard when its tab stops being the focused pane's active tab", async () => {
    const core = serveCore();
    core.failNext();
    page = await openPage();
    const [tab] = page.harness.seatTerminals([page.harness.terminalTab()]);
    const { target, props } = page.place(tab!, { active: true, focused: true });
    const error = await shownLoadError(target);
    await vi.waitFor(() => expect(document.activeElement, "the focused pane's Retry holds the keyboard").toBe(action(error, "Retry")));

    props.focused = false;
    page.svelte.flushSync();
    expect(errorHoldsKeyboard(error), "another pane took focus").toBe(false);

    props.focused = true;
    page.svelte.flushSync();
    await vi.waitFor(() => expect(document.activeElement, "the pane's focus is back").toBe(action(error, "Retry")));

    props.active = false;
    props.focused = false;
    page.svelte.flushSync();
    expect(errorHoldsKeyboard(error), "another tab of the pane is shown").toBe(false);
    expect(takeShownLoadFailures(), "one error shown").toBe(1);
  });
});

describe("a terminal whose view fails after the core loads", () => {
  test("a widget that cannot open releases what was built and shows the error with Retry, and Retry opens it", async () => {
    serveCore();
    let instances = 0;
    const made = vi.spyOn(WebAssembly, "instantiate").mockImplementation((async (module: WebAssembly.Module) => {
      instances += 1;
      const instance = await instantiate(module, {});
      // The loader's check instance passes, and so does the terminal's own;
      // the widget's open() then fails to allocate its terminal in it.
      if (instances !== 2) return instance;
      const exports = { ...(instance.exports as Record<string, unknown>) };
      exports.ghostty_terminal_new = () => {
        throw new RangeError("Out of memory: terminal");
      };
      return { exports } as unknown as WebAssembly.Instance;
    }) as typeof WebAssembly.instantiate);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => void rejections.push(reason);
    const runner = globalThis as unknown as {
      process: {
        on: (event: "unhandledRejection", fn: (reason: unknown) => void) => void;
        off: (event: "unhandledRejection", fn: (reason: unknown) => void) => void;
      };
    };
    runner.process.on("unhandledRejection", onRejection);
    try {
      page = await openPage();
      const [tab] = page.harness.seatTerminals([page.harness.terminalTab()]);
      const { target } = page.open(tab!);

      const error = await shownLoadError(target);
      expect(actions(error), "the next open can pass").toEqual(waysOut(page, tab!, true));
      expect(error.textContent, "the error says why").toContain("Out of memory: terminal");
      expect(error.textContent).toContain(NO_SHELL);
      expect(terminalArea(target).querySelector("canvas"), "nothing left in its area").toBeNull();
      expect(areaWatchers(page, target), "nothing left wired").toBe(0);
      expect(page.harness.TerminalSocket.all, "no PTY was dialed").toHaveLength(0);
      expect(loadReports(), "the failure is reported once").toHaveLength(1);
      // The terminal that failed is gone: the pane's focus goes to Retry, not to it.
      await vi.waitFor(() => expect(document.activeElement, "Retry holds the keyboard").toBe(action(error, "Retry")));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rejections, "nothing rejected unhandled").toEqual([]);

      action(error, "Retry").click();
      await vi.waitFor(() => expect(page!.harness.TerminalSocket.all, "the retry dialed its PTY").toHaveLength(1));
      expect(loadError(target), "the error is gone").toBeNull();
      expect(terminalArea(target).querySelectorAll("canvas"), "one terminal in its area").toHaveLength(1);
      expect(areaWatchers(page, target), "wired once").toBe(1);
      expect(made, "a fresh instance for the retried terminal").toHaveBeenCalledTimes(3);
      expect(rejections).toEqual([]);
      expect(takeShownLoadFailures(), "one error shown").toBe(1);
    } finally {
      runner.process.off("unhandledRejection", onRejection);
    }
  });

  test("a wiring step that fails after the widget opened releases the opened terminal, and Retry opens one", async () => {
    serveCore();
    page = await openPage();
    // The terminal's area watcher refuses the host once: a step start()
    // wires after the widget's open() has put its canvas in the area.
    const Watcher = globalThis.ResizeObserver;
    let refused = 0;
    vi.stubGlobal(
      "ResizeObserver",
      class extends Watcher {
        observe(target: Element) {
          if (refused === 0 && target instanceof HTMLElement && target.classList.contains("terminal-host")) {
            refused += 1;
            throw new Error("the area watcher refused the host");
          }
          super.observe(target);
        }
      },
    );
    const [tab] = page.harness.seatTerminals([page.harness.terminalTab()]);
    const { target } = page.open(tab!);

    const error = await shownLoadError(target);
    expect(refused, "the step failed once").toBe(1);
    expect(actions(error), "the next open can pass").toEqual(waysOut(page, tab!, true));
    expect(error.textContent, "the error says why").toContain("the area watcher refused the host");
    expect(terminalArea(target).querySelector("canvas"), "the opened terminal left its area").toBeNull();
    expect(page.harness.TerminalSocket.all, "no PTY was dialed").toHaveLength(0);

    action(error, "Retry").click();
    await vi.waitFor(() => expect(page!.harness.TerminalSocket.all, "the retry dialed its PTY").toHaveLength(1));
    expect(loadError(target), "the error is gone").toBeNull();
    expect(terminalArea(target).querySelectorAll("canvas"), "one terminal in its area").toHaveLength(1);
    expect(areaWatchers(page, target), "wired once").toBe(1);
    expect(takeShownLoadFailures(), "one error shown").toBe(1);
  });

  test("Retry in a pane that is no longer the active one opens the new terminal out of the Tab order", async () => {
    serveCore();
    page = await openPage();
    // As above: the area watcher refuses the host once, after the first
    // widget opened in it.
    const Watcher = globalThis.ResizeObserver;
    let refused = 0;
    vi.stubGlobal(
      "ResizeObserver",
      class extends Watcher {
        observe(target: Element) {
          if (refused === 0 && target instanceof HTMLElement && target.classList.contains("terminal-host")) {
            refused += 1;
            throw new Error("the area watcher refused the host");
          }
          super.observe(target);
        }
      },
    );
    const [tab] = page.harness.seatTerminals([page.harness.terminalTab()]);
    const { target, props } = page.place(tab!, { active: true, focused: true });
    const error = await shownLoadError(target);
    expect(refused, "the first terminal opened and its wiring failed once").toBe(1);
    expect(terminalArea(target).getAttribute("tabindex"), "the terminal that failed left its area in the Tab order")
      .toBe("0");

    // Another pane becomes the active one while the error is shown, and the
    // error's Retry, which stays in the Tab order, is pressed from the
    // keyboard there.
    props.focused = false;
    page.svelte.flushSync();
    action(error, "Retry").click();
    await vi.waitFor(() => expect(page!.harness.TerminalSocket.all, "the retry dialed its PTY").toHaveLength(1));
    expect(loadError(target), "the error is gone").toBeNull();
    expect(tabStops(target), "the new terminal, in a pane that is not active, is out of the Tab order").toEqual({
      host: { attribute: "-1", tabIndex: -1 },
      input: { attribute: "-1", tabIndex: -1 },
    });

    props.focused = true;
    page.svelte.flushSync();
    expect(tabStops(target), "its pane made active again puts the new terminal in the Tab order").toEqual({
      host: { attribute: "0", tabIndex: 0 },
      input: { attribute: "0", tabIndex: 0 },
    });
    expect(takeShownLoadFailures(), "one error shown").toBe(1);
  });
});

// Find searches the terminal's screen, so with no terminal shown its bar
// stays closed.
describe("find with no terminal shown", () => {
  /// The find bar's input, if the bar is open.
  function findBar(target: HTMLElement): HTMLInputElement | null {
    return target.querySelector<HTMLInputElement>(".terminal-find input.find");
  }

  async function askForFind(): Promise<void> {
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.find.open" } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  test("over the error of a widget that could not open, the bar stays closed", async () => {
    serveCore();
    let instances = 0;
    vi.spyOn(WebAssembly, "instantiate").mockImplementation((async (module: WebAssembly.Module) => {
      instances += 1;
      const instance = await instantiate(module, {});
      // The loader's check instance passes, and so does the terminal's own;
      // the widget's open() then fails to allocate its terminal in it.
      if (instances !== 2) return instance;
      const exports = { ...(instance.exports as Record<string, unknown>) };
      exports.ghostty_terminal_new = () => {
        throw new RangeError("Out of memory: terminal");
      };
      return { exports } as unknown as WebAssembly.Instance;
    }) as typeof WebAssembly.instantiate);
    page = await openPage();
    const [tab] = page.harness.seatTerminals([page.harness.terminalTab()]);
    const { target } = page.open(tab!);
    await shownLoadError(target);

    await askForFind();

    expect(findBar(target), "no find bar over the error").toBeNull();
    expect(loadError(target), "the error stays").not.toBeNull();
    expect(takeShownLoadFailures(), "one error shown").toBe(1);
  });

  test("while the terminal waits on its font, the bar stays closed", async () => {
    serveCore();
    page = await openPage({ font: "source-code-pro" });
    const font = page.holdNextFont();
    const [tab] = page.harness.seatTerminals([page.harness.terminalTab()]);
    const { target } = page.open(tab!);
    await vi.waitFor(() => expect(font.asked(), "the terminal waits on its font").toBe(true));

    await askForFind();

    expect(findBar(target), "no find bar before the terminal").toBeNull();
    font.release();
    await vi.waitFor(() => expect(page!.harness.TerminalSocket.all, "the terminal opened").toHaveLength(1));
  });
});

describe("terminals that failed one load together", () => {
  test("one Retry answers a failed fetch the terminals shared: the others retry once the load passes", async () => {
    const core = serveCore();
    core.failNext();
    const made = vi.spyOn(WebAssembly, "instantiate");
    page = await openPage();
    const [first, second] = page.harness.seatTerminals([
      page.harness.terminalTab({ id: "term-1" }),
      page.harness.terminalTab({ id: "term-2" }),
    ]);
    const a = page.open(first!);
    const b = page.place(second!, { active: true, focused: false });
    const errorA = await shownLoadError(a.target);
    await shownLoadError(b.target);
    expect(core.requests(), "one fetch failed both").toBe(1);

    action(errorA, "Retry").click();
    await vi.waitFor(() => expect(page!.harness.TerminalSocket.all, "both terminals dialed").toHaveLength(2));
    expect(loadError(b.target), "the other terminal's error is gone").toBeNull();
    expect(terminalArea(b.target).querySelectorAll("canvas"), "and it opened").toHaveLength(1);
    expect(core.requests(), "on the one load the Retry made").toBe(2);
    expect(b.target.contains(document.activeElement), "the unfocused pane's terminal takes no keyboard").toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(page.harness.TerminalSocket.all, "one PTY each").toHaveLength(2);
    expect(made, "the check and one instance each").toHaveBeenCalledTimes(3);
    expect(takeShownLoadFailures(), "two errors shown").toBe(2);
  });

  test("a terminal the passing load retried that fails again waits for its own Retry", async () => {
    const core = serveCore();
    core.failNext();
    let instances = 0;
    const made = vi.spyOn(WebAssembly, "instantiate").mockImplementation(((module: WebAssembly.Module) => {
      instances += 1;
      // The check and the first terminal's instance pass; any later one fails.
      if (instances > 2) return Promise.reject(new RangeError("Out of memory: Cannot allocate Wasm memory for new instance"));
      return instantiate(module, {});
    }) as typeof WebAssembly.instantiate);
    page = await openPage();
    const [first, second] = page.harness.seatTerminals([
      page.harness.terminalTab({ id: "term-1" }),
      page.harness.terminalTab({ id: "term-2" }),
    ]);
    const a = page.open(first!);
    const b = page.place(second!, { active: true, focused: false });
    const errorA = await shownLoadError(a.target);
    await shownLoadError(b.target);

    action(errorA, "Retry").click();
    await vi.waitFor(() => expect(made, "the other terminal retried").toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const failed = [a.target, b.target].filter((target) => loadError(target) !== null);
    expect(failed, "one terminal opened and one shows its error again").toHaveLength(1);
    expect(loadError(failed[0]!)!.textContent).toContain("Out of memory");
    expect(made, "and nothing retries it until asked").toHaveBeenCalledTimes(3);
    expect(page.harness.TerminalSocket.all, "one PTY").toHaveLength(1);
    expect(core.requests()).toBe(2);
    expect(takeShownLoadFailures(), "two errors, then one again").toBe(3);
  });

  test("a terminal closed over its load error leaves the loader no listener of its own", async () => {
    const core = serveCore();
    core.failNext();
    page = await openPage();
    const listening = await loadListeners();
    const [first, second] = page.harness.seatTerminals([
      page.harness.terminalTab({ id: "term-1" }),
      page.harness.terminalTab({ id: "term-2" }),
    ]);
    const a = page.open(first!);
    const b = page.place(second!, { active: true, focused: false });
    const errorA = await shownLoadError(a.target);
    await shownLoadError(b.target);
    expect(listening(), "each failed terminal waits on the next passing load").toBe(2);

    // The pane drops the closed tab's view.
    page.svelte.unmount(page.mounts.pop()!);
    expect(listening(), "the closed terminal waits on nothing").toBe(1);

    action(errorA, "Retry").click();
    await vi.waitFor(() => expect(page!.harness.TerminalSocket.all, "the open terminal dialed").toHaveLength(1));
    expect(loadError(a.target), "and opened").toBeNull();
    expect(takeShownLoadFailures(), "two errors shown").toBe(2);
  });
});

describe("a terminal on an engine that keeps a failed module import", () => {
  test("Retry after the widget's chunk failed once attaches every failed terminal to its shell in the same page", async () => {
    const core = serveCore();
    page = await openPage();
    const askedForWidget = keepFailedImport("@chan/ghostty-web-ng");
    const closeTerminal = vi.spyOn(page.api, "closeTerminal").mockResolvedValue(undefined);
    const [first, second] = page.harness.seatTerminals([
      page.harness.terminalTab({ id: "term-1", terminalSessionId: "sess-a" }),
      page.harness.terminalTab({ id: "term-2", terminalSessionId: "sess-b" }),
    ]);
    const a = page.open(first!);
    const b = page.place(second!, { active: true, focused: false });
    const errorA = await shownLoadError(a.target);
    await shownLoadError(b.target);
    expect(actions(errorA), "a failed import can pass at the next try").toEqual(waysOut(page, first!, true));
    expect(errorA.textContent).toContain(SHELL_RUNS);
    expect(askedForWidget(), "one failed import failed both").toBe(1);
    expect(core.requests(), "and the core was not asked for").toBe(0);

    action(errorA, "Retry").click();
    await vi.waitFor(() => expect(page!.harness.TerminalSocket.all, "both terminals dialed").toHaveLength(2));
    expect([a.target, b.target].map(loadError), "the errors are gone").toEqual([null, null]);
    for (const target of [a.target, b.target]) {
      expect(terminalArea(target).querySelectorAll("canvas"), "a terminal in each area").toHaveLength(1);
    }
    const attached = page.harness.TerminalSocket.all.map((socket) => new URL(socket.url).searchParams.get("session"));
    expect(attached.sort(), "each attached to its own shell").toEqual(["sess-a", "sess-b"]);
    expect(askedForWidget(), "the retry did not ask again at the URL the engine failed").toBe(1);
    expect(page.reloadWindow, "nor reload the window").not.toHaveBeenCalled();
    expect(closeTerminal, "no shell was ended").not.toHaveBeenCalled();
    expect(takeShownLoadFailures(), "two errors shown").toBe(2);
  });

  test("a terminal opens with the module of the core's URL kept failed: a spawn imports no module for it", async () => {
    const core = serveCore();
    page = await openPage();
    const askedForCoreUrl = keepFailedImport("@chan/ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm?url");
    const [tab] = page.harness.seatTerminals([page.harness.terminalTab({ terminalSessionId: SESSION })]);
    const { target } = page.open(tab!);

    await vi.waitFor(() => expect(page!.harness.TerminalSocket.all, "the terminal dialed").toHaveLength(1));
    expect(loadError(target), "no error").toBeNull();
    expect(terminalArea(target).querySelectorAll("canvas"), "a terminal in its area").toHaveLength(1);
    expect(askedForCoreUrl(), "no module asked for").toBe(0);
    expect(core.requests(), "the core fetched once").toBe(1);
    expect(takeShownLoadFailures(), "no error shown").toBe(0);
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
    expect(loadReports(), "nothing failed").toHaveLength(0);
    expect(takeShownLoadFailures()).toBe(0);
  });

  test("closing the tab while its font loads asks for no core and makes nothing", async () => {
    const core = serveCore();
    const made = vi.spyOn(WebAssembly, "instantiate");
    page = await openPage({ font: "source-code-pro" });
    const font = page.holdNextFont();
    const [tab] = page.harness.seatTerminals([page.harness.terminalTab()]);
    page.open(tab!);
    await vi.waitFor(() => expect(font.asked(), "the terminal waits on its font").toBe(true));

    expect(await page.tabs.closeTabsInPane(page.harness.TERMINAL_PANE, { force: true })).toBe(true);
    page.svelte.unmount(page.mounts.pop()!);
    font.release();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(core.requests(), "no core fetched for a closed terminal").toBe(0);
    expect(made, "and no instance").not.toHaveBeenCalled();
    expect(page.harness.TerminalSocket.all).toHaveLength(0);
    expect(loadReports()).toHaveLength(0);
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
    expect(takeShownLoadFailures()).toBe(0);
  });

  test("restarting while the terminal's own instance is made opens one terminal, on the restarted load once its font loads", async () => {
    serveCore();
    let instances = 0;
    let own: WebAssembly.Instance | null = null;
    let settleOwn!: (instance: WebAssembly.Instance) => void;
    const ownSettled = new Promise<WebAssembly.Instance>((resolve) => (settleOwn = resolve));
    const made = vi.spyOn(WebAssembly, "instantiate").mockImplementation(((module: WebAssembly.Module) => {
      instances += 1;
      // The loader's check instance passes; the terminal's own, the second,
      // is made at once and handed over when the case settles it.
      if (instances !== 2) return instantiate(module, {});
      void instantiate(module, {}).then((instance) => (own = instance));
      return ownSettled;
    }) as typeof WebAssembly.instantiate);
    page = await openPage({ font: "source-code-pro" });
    const [tab] = page.harness.seatTerminals([page.harness.terminalTab()]);
    const { target } = page.open(tab!);
    await vi.waitFor(() => expect(own, "the terminal's own instance is being made").not.toBeNull());
    const font = page.holdNextFont();

    // Settled in the restart's turn: the start the instance was made for
    // resumes after the restart's teardown, while the restarted start waits
    // on its font.
    settleOwn(own!);
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.terminal.restart" } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(page.harness.TerminalSocket.all, "the start the restart overtook dialed nothing").toHaveLength(0);
    expect(terminalArea(target).querySelector("canvas"), "and opened nothing").toBeNull();
    expect(font.asked(), "the restarted load waits on its font").toBe(true);

    font.release();
    await vi.waitFor(() => expect(page!.harness.TerminalSocket.all, "the restarted terminal dialed its PTY").toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(page.harness.TerminalSocket.all, "one PTY").toHaveLength(1);
    const url = new URL(page.harness.TerminalSocket.all[0]!.url);
    expect(url.searchParams.get("ack"), "the PTY of a Ghostty terminal").toBe("1");
    expect(terminalArea(target).querySelectorAll("canvas"), "one terminal").toHaveLength(1);
    expect(areaWatchers(page, target), "wired once").toBe(1);
    expect(made, "the check, the overtaken instance and the restarted terminal's").toHaveBeenCalledTimes(3);
    expect(loadError(target)).toBeNull();
    expect(takeShownLoadFailures()).toBe(0);
  });

  test("closing a terminal with a live session while its core loads ends the session once and attaches nothing", async () => {
    const core = serveCore();
    const release = core.holdNext();
    const made = vi.spyOn(WebAssembly, "instantiate");
    page = await openPage();
    const closeTerminal = vi.spyOn(page.api, "closeTerminal").mockResolvedValue(undefined);
    const [tab] = page.harness.seatTerminals([page.harness.terminalTab({ terminalSessionId: SESSION })]);
    page.open(tab!);
    await vi.waitFor(() => expect(core.requests(), "the load is in flight").toBe(1));

    expect(await page.tabs.closeTabsInPane(page.harness.TERMINAL_PANE, { force: true })).toBe(true);
    page.svelte.unmount(page.mounts.pop()!);
    release("serve");
    await vi.waitFor(() => expect(made, "the loader checked the core").toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(closeTerminal.mock.calls, "the route ended the live session, once").toEqual([[SESSION]]);
    expect(made, "no instance for the closed terminal").toHaveBeenCalledTimes(1);
    expect(page.harness.TerminalSocket.all, "nothing attached to it").toHaveLength(0);
    expect(loadReports(), "nothing failed").toHaveLength(0);
    expect(takeShownLoadFailures()).toBe(0);
  });

  test("restarting a terminal with a live session while its core loads ends that session and opens one terminal on a fresh PTY", async () => {
    const core = serveCore();
    const release = core.holdNext();
    const made = vi.spyOn(WebAssembly, "instantiate");
    page = await openPage();
    const closeTerminal = vi.spyOn(page.api, "closeTerminal").mockResolvedValue(undefined);
    const [tab] = page.harness.seatTerminals([page.harness.terminalTab({ terminalSessionId: SESSION })]);
    const { target } = page.open(tab!);
    await vi.waitFor(() => expect(core.requests(), "the load is in flight").toBe(1));

    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.terminal.restart" } }));
    await vi.waitFor(() => expect(page!.confirm.confirmState.open, "a running shell asks first").toBe(true));
    page.confirm.resolveConfirm(true);
    await vi.waitFor(() => expect(closeTerminal, "the route ends the live session").toHaveBeenCalled());
    expect(page.harness.TerminalSocket.all, "nothing dialed while the core loads").toHaveLength(0);
    release("serve");
    await vi.waitFor(() => expect(page!.harness.TerminalSocket.all, "the restarted terminal dialed its PTY").toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(closeTerminal.mock.calls, "the live session was ended once").toEqual([[SESSION]]);
    expect(page.harness.TerminalSocket.all, "one PTY").toHaveLength(1);
    const url = new URL(page.harness.TerminalSocket.all[0]!.url);
    expect(url.searchParams.get("session"), "a fresh shell, not the ended session").toBeNull();
    expect(url.searchParams.get("ack")).toBe("1");
    expect(terminalArea(target).querySelectorAll("canvas"), "one terminal").toHaveLength(1);
    expect(made, "the check and one instance for the terminal").toHaveBeenCalledTimes(2);
    expect(areaWatchers(page, target), "wired once").toBe(1);
    expect(loadError(target)).toBeNull();
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

describe("terminals that open while one load is in flight", () => {
  test("they share the load: one fetch and one compile, then an instance, a terminal and a PTY each", async () => {
    const core = serveCore();
    const release = core.holdNext();
    const compile = vi.spyOn(WebAssembly, "compile");
    const made = vi.spyOn(WebAssembly, "instantiate");
    page = await openPage();
    const [first, second] = page.harness.seatTerminals([
      page.harness.terminalTab({ id: "term-1" }),
      page.harness.terminalTab({ id: "term-2" }),
    ]);
    const a = page.open(first!);
    await vi.waitFor(() => expect(core.requests(), "the first terminal's load is in flight").toBe(1));
    const b = page.place(second!, { active: true, focused: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(core.requests(), "the second terminal waits on the same load").toBe(1);
    expect(page.harness.TerminalSocket.all, "nothing dialed while it loads").toHaveLength(0);

    release("serve");
    await vi.waitFor(() => expect(page!.harness.TerminalSocket.all, "both terminals dialed").toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(page.harness.TerminalSocket.all, "one PTY each").toHaveLength(2);
    for (const socket of page.harness.TerminalSocket.all) {
      expect(new URL(socket.url).searchParams.get("ack"), "each the PTY of a Ghostty terminal").toBe("1");
    }
    for (const target of [a.target, b.target]) {
      expect(terminalArea(target).querySelectorAll("canvas"), "a terminal in each area").toHaveLength(1);
      expect(areaWatchers(page, target), "each wired once").toBe(1);
      expect(loadError(target)).toBeNull();
    }
    expect(core.requests(), "one fetch").toBe(1);
    expect(compile, "one compile").toHaveBeenCalledTimes(1);
    expect(made, "the check and one instance each").toHaveBeenCalledTimes(3);
    expect(b.target.contains(document.activeElement), "the unfocused pane's terminal takes no keyboard").toBe(false);
    expect(takeShownLoadFailures()).toBe(0);
  });
});
