// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import Workspace from "./Workspace.svelte";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { demoSocketFactory } from "../demo/socket";
import { setSocketFactory } from "../api/transport";
import { refreshTree, refreshWorkspace } from "../state/store.svelte";
import { cancelPaneMode, enterPaneMode, layout, type LeafNode, type Tab } from "../state/tabs.svelte";
import { installTerminalDom, resetTerminals, terminalTab, xterm } from "../__tests__/terminalTab";

installTerminalDom();

const PANE = "menu-focus-pane";
const mounted: Array<Record<string, unknown>> = [];
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0) as unknown as number) as typeof requestAnimationFrame;
  xterm.textareaFocus = true;
  installDemoWorkspace({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1, fileCount: 0, textCount: 0 },
    files: [],
  });
  setSocketFactory((url) => demoSocketFactory(url));
  await refreshWorkspace();
  await refreshTree();
});

afterEach(async () => {
  for (const component of mounted.splice(0)) unmount(component);
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetTerminals();
  cancelPaneMode();
  await settle(2);
  uninstallDemoWorkspace();
  document.body.innerHTML = "";
});

async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function mountPane(withTerminal = true): Promise<{ target: HTMLElement; surface: HTMLElement }> {
  const tab = withTerminal ? terminalTab({ id: "menu-focus-terminal" }) : null;
  const pane: LeafNode = { kind: "leaf", id: PANE, tabs: tab ? [tab] : [], activeTabId: tab?.id ?? null };
  layout.nodes = { [PANE]: pane };
  layout.rootId = PANE;
  layout.activePaneId = PANE;
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(Workspace, { target }));
  if (tab) await vi.waitFor(() => expect(xterm.terminals.length).toBeGreaterThan(0));
  await settle();
  const surface = tab ? xterm.terminals.at(-1)?.textarea : target.querySelector<HTMLElement>(".welcome");
  if (!surface) throw new Error("the focused surface did not mount");
  surface.focus();
  expect(document.activeElement).toBe(surface);
  return { target, surface };
}

async function mountSplitPane(otherTabs: Tab[] = []): Promise<{ target: HTMLElement; surface: HTMLElement; other: HTMLElement }> {
  const tab = terminalTab({ id: "menu-focus-terminal" });
  const left: LeafNode = { kind: "leaf", id: PANE, tabs: [tab], activeTabId: tab.id };
  const right: LeafNode = { kind: "leaf", id: "menu-focus-other", tabs: otherTabs, activeTabId: otherTabs[0]?.id ?? null };
  layout.nodes = {
    [PANE]: left,
    [right.id]: right,
    "menu-focus-split": { kind: "split", id: "menu-focus-split", direction: "row", ratio: 0.5, a: PANE, b: right.id },
  };
  layout.rootId = "menu-focus-split";
  layout.activePaneId = PANE;
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(Workspace, { target }));
  await vi.waitFor(() => expect(xterm.terminals.length).toBeGreaterThan(0));
  await settle();
  const surface = xterm.terminals.at(-1)?.textarea;
  const other = target.querySelector<HTMLElement>(`[data-pane-id="${right.id}"]`);
  if (!surface || !other) throw new Error("the split pane did not mount");
  surface.focus();
  expect(document.activeElement).toBe(surface);
  return { target, surface, other };
}

/// jsdom omits the browser's mousedown focus default. Model it once, after
/// the component has had the chance to prevent the press.
function pressWithBrowserFocus(target: HTMLElement, button: number): MouseEvent {
  const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button });
  target.dispatchEvent(event);
  if (!event.defaultPrevented) {
    const focusable = target.closest<HTMLElement>("button, input, textarea, select, a[href], [tabindex]:not([tabindex='-1'])");
    if (focusable) focusable.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  }
  return event;
}

function rightClick(target: HTMLElement): { press: MouseEvent; menu: MouseEvent } {
  const press = pressWithBrowserFocus(target, 2);
  const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 });
  target.dispatchEvent(menu);
  return { press, menu };
}

function menu(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".hamburger-menu");
}

function commandsRow(): HTMLButtonElement {
  const row = [...document.body.querySelectorAll<HTMLButtonElement>(".hamburger-menu button")].find(
    (button) => button.querySelector(".menu-row-label")?.textContent?.trim() === "Commands",
  );
  if (!row) throw new Error("the pane menu has no Commands row");
  return row;
}

function recordCommands(): Array<{ name: string; focus: Element | null }> {
  const seen: Array<{ name: string; focus: Element | null }> = [];
  const listener = (event: Event) => seen.push({
    name: (event as CustomEvent<{ name: string }>).detail.name,
    focus: document.activeElement,
  });
  window.addEventListener("chan:command", listener);
  cleanups.push(() => window.removeEventListener("chan:command", listener));
  return seen;
}

describe("pane menu focus", () => {
  test("the strip stretch keeps terminal focus when its menu opens and Escape closes it", async () => {
    const { target, surface } = await mountPane();
    const { menu: context } = rightClick(target.querySelector<HTMLElement>(".tabs .dead-zone")!);
    await settle();
    expect(context.defaultPrevented).toBe(true);
    expect(menu()).not.toBeNull();
    expect(document.activeElement, "the menu opens over the terminal").toBe(surface);
    surface.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle();
    expect(menu()).toBeNull();
    expect(document.activeElement, "Escape leaves the keyboard on the terminal").toBe(surface);
  });

  test("an outside click closes the menu over the terminal", async () => {
    const { target, surface } = await mountPane();
    rightClick(target.querySelector<HTMLElement>(".tabs .dead-zone")!);
    await settle();
    expect(document.activeElement, "the menu opens over the terminal").toBe(surface);
    pressWithBrowserFocus(surface, 0);
    await settle();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(surface);
  });

  test("Commands opens the launcher from the terminal surface", async () => {
    const { target, surface } = await mountPane();
    const seen = recordCommands();
    rightClick(target.querySelector<HTMLElement>(".tabs .dead-zone")!);
    await settle();
    expect(document.activeElement, "the menu opens over the terminal").toBe(surface);
    const row = commandsRow();
    row.focus();
    row.click();
    await settle();
    expect(seen.map((entry) => entry.name)).toEqual(["app.launcher.toggle"]);
    expect(seen[0]?.focus, "Commands hands the launcher the terminal opener").toBe(surface);
    expect(menu()).toBeNull();
  });

  test("a right-click on the side toggle opens no chan menu and keeps terminal focus", async () => {
    const { target, surface } = await mountPane();
    const { menu: context } = rightClick(target.querySelector<HTMLElement>(".tabs .side-toggle")!);
    await settle();
    expect(context.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(surface);
  });

  test("the empty side's body keeps welcome focus under its menu", async () => {
    const { target, surface } = await mountPane(false);
    const { menu: context } = rightClick(target.querySelector<HTMLElement>(".placeholder")!);
    await settle();
    expect(context.defaultPrevented).toBe(true);
    expect(menu()).not.toBeNull();
    expect(document.activeElement).toBe(surface);
  });

  test("another pane's strip menu keeps the original terminal as its opener", async () => {
    const { surface, other } = await mountSplitPane();
    const seen = recordCommands();
    const { menu: context } = rightClick(other.querySelector<HTMLElement>(".tabs .dead-zone")!);
    await settle();
    expect(context.defaultPrevented).toBe(true);
    expect(menu()).not.toBeNull();
    expect(document.activeElement).toBe(surface);
    commandsRow().click();
    await settle();
    expect(seen[0]?.focus).toBe(surface);
  });

  test.each([
    ["dashboard", { kind: "dashboard", id: "other-dashboard", title: "Dashboard" } as Tab],
    ["extension", { kind: "extension", id: "other-extension", title: "Extension", extensionId: "missing" } as Tab],
  ])("a right press on a %s pane's browser-menu body keeps the original terminal", async (_name, tab) => {
    const { surface, other } = await mountSplitPane([tab]);
    const { menu: context } = rightClick(other.querySelector<HTMLElement>(".editor-wrap")!);
    await settle();
    expect(context.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(surface);
  });

  test("a right press on the Hybrid Nav preview keeps its pre-click holder", async () => {
    const { target } = await mountPane(false);
    enterPaneMode();
    await settle();
    const holder = document.createElement("textarea");
    document.body.append(holder);
    holder.focus();
    const { menu: context } = rightClick(target.querySelector<HTMLElement>(".pane-mode-preview")!);
    await settle();
    expect(context.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(holder);
  });
});
