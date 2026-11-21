// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../api/libraryCommand", () => ({ loadScopedLibrarySnapshot: vi.fn() }));

import WindowTabBar from "./WindowTabBar.svelte";
import { LAUNCHER_SHOWN_ATTR } from "../state/keyboardOwner.svelte";
import { NO_TITLEBAR_CHROME, windowTabBar } from "../state/windowTabBar.svelte";
import { resetLayout, terminalTab } from "../__tests__/tabs";
import { overlayStack, ui } from "../state/store.svelte";
import { closePaneTree, openPaneTree, paneTree } from "../state/paneTree.svelte";

type DesktopWindow = Window & { __TAURI_INTERNALS__?: unknown };

let view: Record<string, unknown> | null = null;

afterEach(async () => {
  if (view) await unmount(view);
  view = null;
  windowTabBar.chrome = NO_TITLEBAR_CHROME;
  windowTabBar.title = "";
  document.documentElement.removeAttribute(LAUNCHER_SHOWN_ATTR);
  document.body.replaceChildren();
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

test("the reconnecting cover keeps the title in the draggable band, clear of the traffic lights", async () => {
  (window as DesktopWindow).__TAURI_INTERNALS__ = { invoke: async () => null };
  windowTabBar.chrome = { ...NO_TITLEBAR_CHROME, active: true, insetLeft: 78 };
  windowTabBar.title = "Work Window 2";
  const bar = await render();
  ui.disconnectBlocking = true;
  await tick();
  expect(bar.hasAttribute("data-tauri-drag-region")).toBe(true);
  expect(bar.querySelector(".tree-button")?.classList.contains("covered")).toBe(true);
  expect(bar.querySelector(".slot")?.classList.contains("covered")).toBe(true);
  expect(bar.querySelector(".covered-band")?.textContent).toContain("Work Window 2");
  expect(bar.querySelector<HTMLElement>(".covered-band")?.style.left).toBe("78px");
  expect(bar.querySelector<HTMLElement>(".covered-band")?.style.right, "no room kept past the title").toBe("8px");
});

test("an outage leaves the band interactive until the cover blocks", async () => {
  ui.disconnectBlocking = false;
  const bar = await render();
  expect(bar.querySelector(".tree-button")?.classList.contains("covered")).toBe(false);
  expect(bar.querySelector(".slot")?.classList.contains("covered")).toBe(false);
  expect(bar.querySelector(".covered-band")).toBeNull();
  ui.disconnectBlocking = true;
  await tick();
  expect(bar.querySelector(".tree-button")?.classList.contains("covered")).toBe(true);
});

test("Windows reconnecting band keeps its controls and has no launcher menus", async () => {
  (window as DesktopWindow).__TAURI_INTERNALS__ = { invoke: async () => null };
  windowTabBar.chrome = { ...NO_TITLEBAR_CHROME, active: true, insetRight: 138, drawControls: true, menus: [{ id: "file", label: "File" }] };
  windowTabBar.title = "Work Window 2";
  const bar = await render();
  ui.disconnectBlocking = true;
  await tick();
  expect(bar.querySelector(".covered-band")?.textContent).toContain("Work Window 2");
  expect(bar.querySelector<HTMLElement>(".covered-band")?.style.right).toBe("146px");
  expect(bar.querySelector(".window-menu")).toBeNull();
  expect(bar.parentElement?.querySelectorAll(".window-controls .window-control")).toHaveLength(3);
});

test("an overlay above the panes keeps the reconnect cover over the whole band", async () => {
  windowTabBar.title = "Work Window 2";
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
  const bar = await render();
  ui.disconnectBlocking = true;
  document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, "");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  expect(bar.querySelector(".window-title"), "macOS keeps the title in native chrome").toBeNull();
  expect(bar.querySelector(".window-menu")).toBeNull();
});

test("launcher wins on Windows when it and reconnect cover are both up", async () => {
  windowTabBar.chrome = { ...NO_TITLEBAR_CHROME, active: true, insetRight: 138, drawControls: true, menus: [{ id: "file", label: "File" }] };
  windowTabBar.title = "Work Window 2";
  const bar = await render();
  ui.disconnectBlocking = true;
  document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, "");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  expect(bar.querySelector(".window-menu")?.textContent).toBe("File");
  expect(bar.querySelector(".window-title")?.textContent).toBe("Work Window 2");
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
