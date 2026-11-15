// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";

const host = vi.hoisted(() => ({ remote: true }));
vi.mock("../state/linkHealth.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/linkHealth.svelte")>()),
  linkIsRemote: () => host.remote,
}));
vi.mock("../api/libraryCommand", () => ({ loadScopedLibrarySnapshot: vi.fn() }));

import WindowTabBar from "./WindowTabBar.svelte";
import { LAUNCHER_SHOWN_ATTR } from "../state/focusGuard";
import { linkHealth, resetLinkHealthForTests } from "../state/linkHealth.svelte";
import { NO_TITLEBAR_CHROME, windowTabBar } from "../state/windowTabBar.svelte";
import { resetLayout, terminalTab } from "../__tests__/tabs";
import { overlayStack, ui } from "../state/store.svelte";
import { closePaneTree, openPaneTree, paneTree } from "../state/paneTree.svelte";
import { LINK_INDICATOR_LABEL_CH } from "./linkIndicatorMath";

type DesktopWindow = Window & { __TAURI_INTERNALS__?: unknown };

let view: Record<string, unknown> | null = null;

afterEach(async () => {
  if (view) await unmount(view);
  view = null;
  resetLinkHealthForTests();
  windowTabBar.chrome = NO_TITLEBAR_CHROME;
  windowTabBar.title = "";
  document.documentElement.removeAttribute(LAUNCHER_SHOWN_ATTR);
  document.body.replaceChildren();
  host.remote = true;
  ui.disconnectBlocking = false;
  overlayStack.ids = [];
  closePaneTree();
  resetLayout();
  delete (window as DesktopWindow).__TAURI_INTERNALS__;
});

async function render(): Promise<HTMLElement> {
  const target = document.body.appendChild(document.createElement("div"));
  view = mount(WindowTabBar, { target }) as Record<string, unknown>;
  await tick();
  return target.querySelector<HTMLElement>(".window-tab-bar")!;
}

test("remote tmux bar keeps the indicator after the title and badge and before the right inset", async () => {
  resetLayout([terminalTab({ id: "tmux", terminalSessionId: "s0", tmuxPane: { connection: 1, pane: "%0" } })]);
  windowTabBar.title = "Terminal Window 1";
  const bar = await render();
  const button = bar.querySelector<HTMLButtonElement>(".link-indicator");
  expect(button?.getAttribute("data-state")).toBe("unknown");
  expect(button?.parentElement).toBe(bar);
  expect(bar.querySelector(".bar-title")?.textContent).toBe("Terminal Window 1");
  expect(bar.querySelector(".title-end")!.compareDocumentPosition(button!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(bar.querySelector(".tmux-badge")!.compareDocumentPosition(button!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(button?.nextElementSibling?.classList.contains("inset")).toBe(true);
});

test("desktop link button and its descendants do not drag while the band does", async () => {
  (window as DesktopWindow).__TAURI_INTERNALS__ = { invoke: async () => null };
  const bar = await render();
  const button = bar.querySelector<HTMLButtonElement>(".link-indicator")!;
  expect(bar.hasAttribute("data-tauri-drag-region")).toBe(true);
  expect(button.hasAttribute("data-tauri-drag-region")).toBe(false);
  for (const descendant of button.querySelectorAll("*")) {
    expect(descendant.hasAttribute("data-tauri-drag-region")).toBe(false);
  }
});

test("local bar is quiet while healthy and shows a slow link", async () => {
  host.remote = false;
  linkHealth.state = "ok";
  const bar = await render();
  expect(bar.querySelector(".link-indicator")).toBeNull();
  linkHealth.state = "slow";
  linkHealth.rttMs = 850;
  await tick();
  expect(bar.querySelector(".link-indicator")?.textContent).toContain("850 ms");
});

test("Windows controls stay in their layer to the right of the indicator and inset", async () => {
  windowTabBar.chrome = { ...NO_TITLEBAR_CHROME, active: true, insetRight: 138, drawControls: true };
  const bar = await render();
  const button = bar.querySelector<HTMLButtonElement>(".link-indicator")!;
  const inset = button.nextElementSibling as HTMLElement;
  expect(inset.classList.contains("inset")).toBe(true);
  expect(inset.style.width).toBe("138px");
  expect(bar.querySelector(".window-controls")).toBeNull();
  expect(bar.parentElement?.querySelectorAll(".window-controls .window-control")).toHaveLength(3);
});

test("covered band does not draw the indicator", async () => {
  const bar = await render();
  expect(bar.querySelector(".link-indicator")).not.toBeNull();
  document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, "");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  expect(bar.querySelector(".link-indicator")).toBeNull();
  document.documentElement.removeAttribute(LAUNCHER_SHOWN_ATTR);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  expect(bar.querySelector(".link-indicator"), "the window owns the band again").not.toBeNull();
});

test("reconnecting cover keeps one indicator and a title in the draggable band", async () => {
  (window as DesktopWindow).__TAURI_INTERNALS__ = { invoke: async () => null };
  windowTabBar.chrome = { ...NO_TITLEBAR_CHROME, active: true, insetLeft: 78 };
  windowTabBar.title = "Work Window 2";
  linkHealth.state = "down";
  const bar = await render();
  ui.disconnectBlocking = true;
  await tick();
  expect(bar.hasAttribute("data-tauri-drag-region")).toBe(true);
  expect(bar.querySelector(".tree-button")?.classList.contains("covered")).toBe(true);
  expect(bar.querySelector(".slot")?.classList.contains("covered")).toBe(true);
  expect(bar.querySelector(".covered-band")?.textContent).toContain("Work Window 2");
  expect(bar.querySelector<HTMLElement>(".covered-band")?.style.left).toBe("78px");
  expect(bar.querySelector<HTMLElement>(".covered-band")?.style.right).toBe("calc(50px + var(--link-indicator-label-width))");
  expect(bar.querySelector<HTMLElement>(".covered-band")?.style.getPropertyValue("--link-indicator-label-width")).toBe(`${LINK_INDICATOR_LABEL_CH}ch`);
  expect(bar.querySelectorAll(".link-indicator")).toHaveLength(1);
  expect(bar.querySelector(".link-indicator")?.textContent).toContain("reconnecting");
});

test("Windows reconnecting band keeps its controls and has no launcher menus", async () => {
  (window as DesktopWindow).__TAURI_INTERNALS__ = { invoke: async () => null };
  windowTabBar.chrome = { ...NO_TITLEBAR_CHROME, active: true, insetRight: 138, drawControls: true, menus: [{ id: "file", label: "File" }] };
  windowTabBar.title = "Work Window 2";
  linkHealth.state = "down";
  const bar = await render();
  ui.disconnectBlocking = true;
  await tick();
  expect(bar.querySelector(".covered-band")?.textContent).toContain("Work Window 2");
  expect(bar.querySelector<HTMLElement>(".covered-band")?.style.right).toBe("calc(188px + var(--link-indicator-label-width))");
  expect(bar.querySelector(".window-menu")).toBeNull();
  expect(bar.parentElement?.querySelectorAll(".window-controls .window-control")).toHaveLength(3);
  expect(bar.querySelector(".link-indicator")?.textContent).toContain("reconnecting");
});

test("an overlay above the panes keeps the reconnect cover over the whole band", async () => {
  windowTabBar.title = "Work Window 2";
  linkHealth.state = "down";
  const bar = await render();
  overlayStack.ids = ["settings"];
  ui.disconnectBlocking = true;
  await tick();
  expect(bar.querySelector(".tree-button")?.classList.contains("covered")).toBe(false);
  expect(bar.querySelector(".slot")?.classList.contains("covered")).toBe(false);
  expect(bar.querySelector(".covered-band")).toBeNull();
});

test("launcher wins on macOS when it and reconnect cover are both up", async () => {
  windowTabBar.chrome = { ...NO_TITLEBAR_CHROME, active: true, insetLeft: 78 };
  windowTabBar.title = "Work Window 2";
  linkHealth.state = "down";
  const bar = await render();
  ui.disconnectBlocking = true;
  document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, "");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  expect(bar.querySelector(".window-title"), "macOS keeps the title in native chrome").toBeNull();
  expect(bar.querySelector(".link-indicator"), "launcher owns the band").toBeNull();
  expect(bar.querySelector(".window-menu")).toBeNull();
});

test("launcher wins on Windows when it and reconnect cover are both up", async () => {
  windowTabBar.chrome = { ...NO_TITLEBAR_CHROME, active: true, insetRight: 138, drawControls: true, menus: [{ id: "file", label: "File" }] };
  windowTabBar.title = "Work Window 2";
  linkHealth.state = "down";
  const bar = await render();
  ui.disconnectBlocking = true;
  document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, "");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  expect(bar.querySelector(".window-menu")?.textContent).toBe("File");
  expect(bar.querySelector(".window-title")?.textContent).toBe("Work Window 2");
  expect(bar.querySelector(".link-indicator")).toBeNull();
});

test("tmux badge hides and an open pane tree closes under the reconnect cover", async () => {
  resetLayout([terminalTab({ id: "tmux", terminalSessionId: "s0", tmuxPane: { connection: 1, pane: "%0" } })]);
  const bar = await render();
  openPaneTree();
  await tick();
  expect(paneTree.open).toBe(true);
  ui.disconnectBlocking = true;
  await tick();
  expect(bar.querySelector(".tmux-badge")?.classList.contains("covered")).toBe(true);
  expect(paneTree.open).toBe(false);
});
