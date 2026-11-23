// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));
vi.mock("../terminal/ghosttyCompat", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyCompatModule(importOriginal));

import TerminalTab from "./TerminalTab.svelte";
import {
  attach,
  installTerminalDom,
  receive,
  resetTerminals,
  seatTerminals,
  terminalTab,
  TERMINAL_PANE,
  TerminalSocket,
} from "../__tests__/terminalTab";

import { openedGhostty } from "../__tests__/ghosttyTab";

installTerminalDom();

const mounted: Array<Record<string, unknown>> = [];

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  resetTerminals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const pastRecovery = () => new Promise((resolve) => setTimeout(resolve, 300));

async function openTerminal(active: boolean) {
  const [tab] = seatTerminals([terminalTab()]);
  const props = $state({ tab: tab!, paneId: TERMINAL_PANE, side: "a" as const, active, focused: false });
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(TerminalTab, { target, props }));
  const term = await openedGhostty(target);
  await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(1));
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  await pastRecovery();
  return { props, term, socket };
}

test("revealing an unfocused tab repaints every row without a resize or focus change", async () => {
  const { props, term } = await openTerminal(false);
  const grid = { cols: term.cols, rows: term.rows };
  const canvas = term.element!.querySelector("canvas")!;
  const clears = vi.spyOn(canvas.getContext("2d")!, "clearRect");
  const width = canvas.width / devicePixelRatio;
  const height = canvas.height / devicePixelRatio / grid.rows;

  props.active = true;
  flushSync();
  await tick();

  expect(props.focused, "the pane still has no keyboard focus").toBe(false);
  expect({ cols: term.cols, rows: term.rows }, "the grid did not change").toEqual(grid);
  await vi.waitFor(() => {
    for (let row = 0; row < grid.rows; row++) {
      expect(clears.mock.calls, `showing row ${row} repaints it`).toContainEqual([0, row * height, width, height]);
    }
  });
});
