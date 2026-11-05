// @vitest-environment jsdom
//
// The pane's right-click menu. It opens over the strip's empty stretch and
// over the body of a side with no tab, with the strip drawn or auto-hidden,
// in place of the browser's own menu. It lists Commands, Reload and, on the
// desktop only, Open Inspector, each with the chord this platform binds:
// Commands and Reload read the shortcut registry, overrides included, and
// Open Inspector the desktop key bridge's chord. A tab's body keeps its own
// menu, and Hybrid Nav's preview is left alone. Commands opens the launcher
// through the window's command bus, with focus handed back first to what held
// it as the menu opened.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import Pane from "./Pane.svelte";
import { cancelPaneMode, enterPaneMode, flipHybrid, layout, type LeafNode } from "../state/tabs.svelte";
import { persistStateToHash } from "../state/store.svelte";
import { workspace } from "../state/workspace.svelte";
import { assignOverride, clearOverride } from "../state/keymapOverrides.svelte";
import { demoWorkspaceInfo } from "../demo/data";
import { preferences } from "../__tests__/standalone";
import { terminalTab } from "../__tests__/tabs";

const mounted: Array<Record<string, unknown>> = [];
const cleanups: Array<() => void> = [];

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
globalThis.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
})) as unknown as typeof matchMedia;
globalThis.requestAnimationFrame ??= ((callback: FrameRequestCallback) =>
  window.setTimeout(() => callback(performance.now()), 0)) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame ??= ((handle: number) =>
  window.clearTimeout(handle)) as typeof cancelAnimationFrame;
HTMLCanvasElement.prototype.getContext = (() => ({})) as unknown as HTMLCanvasElement["getContext"];

const AGENTS = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
  linux: "Mozilla/5.0 (X11; Linux x86_64)",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
} as const;
type Os = keyof typeof AGENTS;

const tauri = window as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string) => Promise<unknown> } };

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.innerHTML = "";
  cancelPaneMode();
  clearOverride("app.launcher.toggle");
  workspace.info = null;
  delete tauri.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  persistStateToHash();
});

/// Run as this OS's browser, or as chan-desktop on it. Returns the desktop's
/// invoke, which records the commands sent to the host.
function onPlatform(os: Os, desktop: boolean): ReturnType<typeof vi.fn> {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(AGENTS[os]);
  const invoke = vi.fn(async () => undefined);
  if (desktop) tauri.__TAURI_INTERNALS__ = { invoke };
  return invoke;
}

function setAutoHide(on: boolean): void {
  workspace.info = demoWorkspaceInfo(
    { metadata: { workspaceRoot: "/ws", label: "ws", generatedAt: 1, fileCount: 0, textCount: 0 }, files: [] },
    preferences({ pane_strip_auto_hide: on }),
  );
}

async function renderPane(pane: LeafNode): Promise<HTMLElement> {
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  layout.focusColor = "blue";
  cancelPaneMode();
  const target = document.createElement("div");
  document.body.append(target);
  const live = layout.nodes[pane.id];
  if (live?.kind !== "leaf") throw new Error("expected leaf");
  mounted.push(mount(Pane, { target, props: { pane: live } }) as Record<string, unknown>);
  await tick();
  return target;
}

const emptyPane = (id = "pane-empty"): LeafNode => ({ kind: "leaf", id, tabs: [], activeTabId: null });

function rightClick(el: Element): MouseEvent {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 });
  el.dispatchEvent(event);
  return event;
}

/// The open menu's rows: label and chord.
function rows(): Array<[string, string]> {
  return [...document.body.querySelectorAll(".hamburger-menu button")].map((button) => [
    button.querySelector(".menu-row-label")?.textContent?.trim() ?? "",
    button.querySelector(".menu-row-chord")?.textContent?.trim() ?? "",
  ]);
}

function row(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>(".hamburger-menu button")].find(
    (b) => b.querySelector(".menu-row-label")?.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no menu row ${label}: ${JSON.stringify(rows())}`);
  return found;
}

function stripHidden(target: HTMLElement): boolean {
  return target.querySelector(".tabs")!.classList.contains("auto-hidden");
}

describe("the pane menu's rows and chords", () => {
  test.each([
    ["mac", true, [["Commands", "Cmd+K"], ["Reload", "Cmd+R"], ["Open Inspector", "Cmd+Alt+I"]]],
    ["linux", true, [["Commands", "Ctrl+Alt+K"], ["Reload", "Ctrl+Shift+R"], ["Open Inspector", "Ctrl+Alt+I"]]],
    ["windows", true, [["Commands", "Ctrl+Alt+K"], ["Reload", "Ctrl+Shift+R"], ["Open Inspector", "Ctrl+Alt+I"]]],
    ["mac", false, [["Commands", "Ctrl+Alt+K"], ["Reload", "Cmd+R"]]],
    ["linux", false, [["Commands", "Ctrl+Alt+K"], ["Reload", "Ctrl+Shift+R"]]],
  ] as const)("on %s, desktop %s, an empty pane's body lists %j", async (os, desktop, expected) => {
    onPlatform(os, desktop);
    const target = await renderPane(emptyPane());
    const event = rightClick(target.querySelector(".placeholder")!);
    await tick();
    expect(event.defaultPrevented, "chan's menu replaces the browser's").toBe(true);
    expect(rows()).toEqual(expected);
  });

  test("Commands follows an override of the launcher's chord", async () => {
    onPlatform("mac", true);
    assignOverride("app.launcher.toggle", "Mod+Shift+K");
    const target = await renderPane(emptyPane());
    rightClick(target.querySelector(".placeholder")!);
    await tick();
    expect(rows()[0]).toEqual(["Commands", "Cmd+Shift+K"]);
  });

  test("Open Inspector asks the desktop to open its inspector", async () => {
    const invoke = onPlatform("linux", true);
    const target = await renderPane(emptyPane());
    rightClick(target.querySelector(".placeholder")!);
    await tick();
    row("Open Inspector").click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("open_devtools", undefined));
  });
});

describe("where the pane menu opens", () => {
  test.each([false, true])("over an empty pane's body with auto-hide %s", async (autoHide) => {
    onPlatform("linux", false);
    setAutoHide(autoHide);
    const target = await renderPane(emptyPane());
    expect(stripHidden(target)).toBe(autoHide);
    expect(rightClick(target.querySelector(".editor-wrap")!).defaultPrevented).toBe(true);
    await tick();
    expect(rows().map(([label]) => label)).toEqual(["Commands", "Reload"]);
  });

  test("over the empty side B of a pane whose side A holds a terminal, with the strip hidden", async () => {
    onPlatform("linux", false);
    setAutoHide(true);
    const target = await renderPane({ kind: "leaf", id: "pane-flip", tabs: [terminalTab({ id: "a1" })], activeTabId: "a1" });
    flipHybrid("pane-flip");
    await tick();
    expect(target.querySelector(".pane-card-inner")?.getAttribute("data-side-label")).toBe("B");
    expect(stripHidden(target), "an empty side B draws no strip").toBe(true);
    expect(rightClick(target.querySelector(".placeholder")!).defaultPrevented).toBe(true);
    await tick();
    expect(rows().map(([label]) => label)).toEqual(["Commands", "Reload"]);
  });

  test.each([
    ["an empty pane", emptyPane()],
    ["a pane with a tab", { kind: "leaf", id: "pane-full", tabs: [terminalTab({ id: "t1" })], activeTabId: "t1" } as LeafNode],
  ])("over the strip's empty stretch of %s", async (_name, pane) => {
    onPlatform("linux", false);
    const target = await renderPane(pane);
    expect(rightClick(target.querySelector(".tabs .dead-zone")!).defaultPrevented).toBe(true);
    await tick();
    expect(rows().map(([label]) => label)).toEqual(["Commands", "Reload"]);
  });

  test("not over a tab's body, which keeps its own menu or the browser's", async () => {
    onPlatform("linux", false);
    const target = await renderPane({ kind: "leaf", id: "pane-tab", tabs: [terminalTab({ id: "t2" })], activeTabId: "t2" });
    expect(rightClick(target.querySelector(".editor-wrap")!).defaultPrevented).toBe(false);
    await tick();
    expect(document.body.querySelector(".hamburger-menu")).toBeNull();
  });

  test("not over Hybrid Nav's preview", async () => {
    onPlatform("linux", false);
    const target = await renderPane(emptyPane());
    enterPaneMode();
    await tick();
    expect(target.querySelector(".pane-mode-preview")).not.toBeNull();
    expect(rightClick(target.querySelector(".editor-wrap")!).defaultPrevented).toBe(false);
    await tick();
    expect(document.body.querySelector(".hamburger-menu")).toBeNull();
  });
});

describe("Commands", () => {
  /// Record each command the window's bus carries and what held focus then.
  function recordCommands(): Array<{ name: string; focus: Element | null }> {
    const seen: Array<{ name: string; focus: Element | null }> = [];
    const listener = (e: Event) =>
      seen.push({ name: (e as CustomEvent<{ name: string }>).detail.name, focus: document.activeElement });
    window.addEventListener("chan:command", listener);
    cleanups.push(() => window.removeEventListener("chan:command", listener));
    return seen;
  }

  test("opens the launcher from what held focus as the menu opened, and closes the menu", async () => {
    onPlatform("mac", true);
    const opener = document.createElement("textarea");
    document.body.append(opener);
    opener.focus();
    const target = await renderPane(emptyPane());
    const seen = recordCommands();
    rightClick(target.querySelector(".placeholder")!);
    await tick();
    // A pointer press on the row moves focus there before its click.
    const commands = row("Commands");
    commands.focus();
    commands.click();
    await tick();
    expect(seen.map((s) => s.name)).toEqual(["app.launcher.toggle"]);
    expect(seen[0]!.focus, "the launcher opens with its opener focused").toBe(opener);
    expect(document.body.querySelector(".hamburger-menu")).toBeNull();
  });

  test("in a lone empty pane opens the launcher from the welcome, which holds focus there", async () => {
    onPlatform("linux", false);
    const target = await renderPane(emptyPane());
    await tick();
    const welcome = target.querySelector<HTMLElement>(".welcome");
    expect(document.activeElement, "the welcome takes the keyboard on mount").toBe(welcome);
    const seen = recordCommands();
    rightClick(welcome!);
    await tick();
    const commands = row("Commands");
    commands.focus();
    commands.click();
    await tick();
    expect(seen.map((s) => s.name)).toEqual(["app.launcher.toggle"]);
    expect(seen[0]!.focus).toBe(welcome);
  });

  test("lets go of the row when nothing held focus as the menu opened", async () => {
    onPlatform("linux", false);
    // A pane beside another shows no welcome, so nothing takes focus.
    const target = await renderPane(emptyPane("pane-left"));
    layout.nodes["pane-right"] = emptyPane("pane-right");
    layout.nodes["split"] = { kind: "split", id: "split", direction: "row", ratio: 0.5, a: "pane-left", b: "pane-right" };
    layout.rootId = "split";
    await tick();
    expect(target.querySelector(".welcome")).toBeNull();
    (document.activeElement as HTMLElement | null)?.blur();
    const seen = recordCommands();
    rightClick(target.querySelector(".placeholder")!);
    await tick();
    const commands = row("Commands");
    commands.focus();
    commands.click();
    await tick();
    expect(seen.map((s) => s.name)).toEqual(["app.launcher.toggle"]);
    expect(seen[0]!.focus, "the launcher never records the row that goes with the menu").toBe(document.body);
  });
});
